import { HttpError } from '../http-error.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import type { SecretMasker } from '../secrets.js';
import { createSecretMasker } from '../secrets.js';
import type { AccessTokenProvider } from './token-provider.js';

export type GatewayMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface GatewayRequest {
  service: string;
  method: GatewayMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Extra route-specific headers (e.g. x-app-version, X-Entity-Type). */
  headers?: Record<string, string>;
}

export interface AccessTokenGatewayClientOptions {
  tokenProvider: AccessTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
}

function isExpiredAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    body.includes('UNAUTHENTICATED') ||
    body.includes('authenticationError')
  );
}

/**
 * Generic access-token gateway client.
 *
 * Sends the Postman app's `POST {bifrost}/ws/proxy` envelope
 * (`{ service, method, path, query?, body? }`) authenticated with
 * `x-access-token` read live from the {@link AccessTokenProvider} (so a
 * re-minted token propagates without reconstruction), plus `x-entity-team-id`
 * only in org-mode. This is the single place token refresh is wired: a 401 /
 * UNAUTHENTICATED / authenticationError triggers one single-flight re-mint and
 * one retry; a second failure surfaces an HttpError with secrets redacted.
 */
export class AccessTokenGatewayClient {
  private readonly tokenProvider: AccessTokenProvider;
  private readonly bifrostBaseUrl: string;
  private teamId: string;
  private orgMode: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly secretMasker: SecretMasker;

  constructor(options: AccessTokenGatewayClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.teamId = String(options.teamId || '').trim();
    this.orgMode = options.orgMode ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.tokenProvider.current()]);
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.tokenProvider.current(),
      ...(extra || {})
    };
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    return headers;
  }

  private async send(request: GatewayRequest): Promise<Response> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    return this.fetchImpl(url, {
      method: 'POST',
      headers: this.buildHeaders(request.headers),
      body: JSON.stringify({
        service: request.service,
        method: request.method,
        path: request.path,
        ...(request.query !== undefined ? { query: request.query } : {}),
        ...(request.body !== undefined ? { body: request.body } : {})
      })
    });
  }

  /** Send a gateway request, refreshing the token once on an auth failure. */
  async request(request: GatewayRequest): Promise<Response> {
    let response = await this.send(request);
    if (response.ok) {
      return response;
    }

    const body = await response.text().catch(() => '');
    if (isExpiredAuthError(response.status, body) && this.tokenProvider.canRefresh()) {
      await this.tokenProvider.refresh();
      response = await this.send(request);
      if (response.ok) {
        return response;
      }
      const retryBody = await response.text().catch(() => '');
      throw this.toHttpError(request, response, retryBody);
    }

    throw this.toHttpError(request, response, body);
  }

  /** Send a gateway request and parse the JSON body, or null when empty. */
  async requestJson<T = Record<string, unknown>>(
    request: GatewayRequest
  ): Promise<T | null> {
    const response = await this.request(request);
    const text = await response.text().catch(() => '');
    if (!text.trim()) {
      return null;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private toHttpError(
    request: GatewayRequest,
    response: Response,
    body: string
  ): HttpError {
    return new HttpError({
      method: request.method.toUpperCase(),
      url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path})`,
      status: response.status,
      statusText: response.statusText,
      requestHeaders: this.buildHeaders(request.headers),
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }
}
