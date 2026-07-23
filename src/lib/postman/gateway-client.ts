import { HttpError } from '../http-error.js';
import { fullJitterDelayMs, parseRetryAfterMs } from '../retry.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import type { SecretMasker } from '../secrets.js';
import { createSecretMasker } from '../secrets.js';
import type { AccessTokenProvider } from './token-provider.js';
import { postmanAppVersionProvider, type AppVersionProvider } from './app-version.js';

export type GatewayMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RetryEvent {
  class: 'http' | 'inner' | 'transport' | 'auth' | 'fallback' | 'poll';
  status?: number;
  attempt: number;
  delay: number;
}

export interface GatewayRequest {
  service: string;
  method: GatewayMethod;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Extra route-specific headers (e.g. x-app-version, X-Entity-Type). */
  headers?: Record<string, string>;
  /** Unsafe mutations must reconcile after an ambiguous response, not resend.
   * `rate-limit` retries only authoritative 429 backpressure, never transport/5xx. */
  retry?: 'safe' | 'rate-limit' | 'none';
  /** Cold `/_api` fallback eligibility. `'auto'` opts an unsafe mutation in
   * (only valid after the caller has reconciled and knows the create is
   * absent); safe requests always fall back, unsafe requests never do unless
   * `'auto'` is set. */
  fallback?: 'auto';
}

export interface AccessTokenGatewayClientOptions {
  tokenProvider: AccessTokenProvider;
  bifrostBaseUrl?: string;
  teamId?: string;
  orgMode?: boolean;
  fetchImpl?: typeof fetch;
  secretMasker?: SecretMasker;
  /** Max transient (5xx / network) retries per request (default 3). */
  maxRetries?: number;
  /** Cold fallback base URL for one last-ditch attempt after the primary
   * budget is exhausted on a transient failure (e.g. the app's `/_api` alias).
   * Only used when the request would otherwise throw a transient error; the
   * fallback is a single serial attempt, never hedged in parallel. Disabled
   * when unset or when POSTMAN_ITEM_CREATE_FALLBACK=off. */
  fallbackBaseUrl?: string;
  /** Base backoff in ms; attempt n waits baseDelayMs * 2^(n-1) (default 400). */
  retryBaseDelayMs?: number;
  /** Backoff ceiling in ms for jittered retries (default 5000). */
  retryMaxDelayMs?: number;
  /** Per-request wall-clock deadline in ms; a slow/hung proxy aborts and (for
   * safe requests) retries instead of blocking the run forever (default 30000). */
  requestTimeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable RNG for deterministic jitter in tests (default Math.random). */
  randomImpl?: () => number;
  appVersionProvider?: AppVersionProvider;
  onRetry?: (event: RetryEvent) => void;
}

function isExpiredAuthError(status: number, body: string): boolean {
  return (
    status === 401 ||
    body.includes('UNAUTHENTICATED') ||
    body.includes('authenticationError')
  );
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function innerEnvelopeStatus(envelope: Record<string, unknown>): number | undefined {
  for (const key of ['status', 'statusCode']) {
    const value = envelope[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/**
 * bifrost `/ws/proxy` can answer HTTP 200 while wrapping an inner
 * collection-service failure in the envelope (the outer transport succeeded even
 * though the inner RPC did not). Return the effective failure status when the
 * envelope carries an `error`, `success:false`, or an inner `status`/`statusCode`
 * >= 400 so a write is never silently reported as success and the transient
 * retry policy can still see a retryable inner 5xx. Returns null for clean bodies.
 */
function detectInnerError(body: string): number | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (!envelope) return null;
  const innerStatus = innerEnvelopeStatus(envelope);
  const error = envelope.error;
  const errorRecord = asRecord(error);
  const hasError =
    (error !== undefined &&
      error !== null &&
      !(errorRecord !== null && Object.keys(errorRecord).length === 0)) ||
    envelope.success === false ||
    (typeof innerStatus === 'number' && innerStatus >= 400);
  if (!hasError) return null;
  return typeof innerStatus === 'number' && innerStatus >= 400 ? innerStatus : 502;
}

/**
 * Transient downstream failures the gateway surfaces intermittently (Bifrost
 * proxy read timeouts, gateway 5xx). Retried with backoff. `ESOCKETTIMEDOUT`
 * is the recurring one — a downstream read timeout, not a request the server
 * durably accepted, so retrying is safe for the onboarding ops (all guarded by
 * reuse-or-create idempotency + run-scoped teardown).
 */
function isTransientGatewayError(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status >= 500) return true;
  void body;
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generic access-token gateway client.
 *
 * Sends the app's `POST {bifrost}/ws/proxy` envelope
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
  private readonly fallbackBaseUrl?: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly appVersionProvider: AppVersionProvider;
  private readonly onRetry?: (event: RetryEvent) => void;

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
    const fallbackEnv = typeof process !== 'undefined' ? process.env?.POSTMAN_ITEM_CREATE_FALLBACK : undefined;
    this.fallbackBaseUrl =
      fallbackEnv === 'off' ? undefined : options.fallbackBaseUrl?.replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 400;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.randomImpl = options.randomImpl ?? Math.random;
    this.appVersionProvider = options.appVersionProvider ?? postmanAppVersionProvider;
    this.onRetry = options.onRetry;
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  private buildHeaders(extra?: Record<string, string>, appVersion?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(extra || {})
    };
    headers['x-access-token'] = this.tokenProvider.current();
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }
    if (appVersion) headers['x-app-version'] = appVersion;
    return headers;
  }

  private async send(request: GatewayRequest, baseUrl?: string): Promise<Response> {
    const url = `${baseUrl ?? this.bifrostBaseUrl}/ws/proxy`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers: this.buildHeaders(request.headers, await this.appVersionProvider.resolve()),
        signal: controller.signal,
        body: JSON.stringify({
          service: request.service,
          method: request.method,
          path: request.path,
          ...(request.query !== undefined ? { query: request.query } : {}),
          ...(request.body !== undefined ? { body: request.body } : {})
        })
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendDirect(path: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(`${this.bifrostBaseUrl}${path}`, {
        method: 'GET',
        headers: this.buildHeaders(undefined, await this.appVersionProvider.resolve()),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a gateway request, refreshing the token once on an auth failure and
   * retrying transient failures with exponential backoff. Transient covers both
   * HTTP 5xx / Bifrost read timeouts AND transport-level rejections (fetch
   * throwing on a socket hangup or the per-request deadline aborting) — a
   * `retry: 'safe'` request retries either; a `retry: 'none'` mutation surfaces
   * the failure so the caller reconciles instead of blindly resending. An HTTP
   * 200 envelope carrying an inner collection-service error is treated as that
   * inner status. The auth-refresh-once path is independent of the retry budget.
   */
  /**
   * One cold, serial attempt against the fallback base URL after the primary
   * budget is exhausted on a transient failure. Never hedged in parallel with
   * the primary; only fires when the request would otherwise throw. Callers
   * with `retry: 'none'` still reconcile first — the fallback attempt here is
   * the resend, so it is only used for requests whose mutation is known
   * idempotent or already reconciled by the caller's adopt-on-ambiguous loop.
   */
  private async tryFallback(request: GatewayRequest): Promise<Response | null> {
    if (!this.fallbackBaseUrl) return null;
    try {
      return await this.send(request, this.fallbackBaseUrl);
    } catch {
      return null;
    }
  }

  /**
   * Run the fallback attempt and classify its response the same way the
   * primary path would. Returns the rebuilt success response, or null when the
   * fallback also failed transiently (caller then throws the original error).
   * Non-transient fallback failures (4xx, inner errors) surface as their own
   * HttpError since they are the freshest authoritative answer.
   */
  private fallbackEligible(request: GatewayRequest): boolean {
    if (!this.fallbackBaseUrl) return false;
    const retryMode = request.retry ?? (request.method === 'get' ? 'safe' : 'none');
    return retryMode === 'safe' || request.fallback === 'auto';
  }

  private async attemptFallback(request: GatewayRequest): Promise<Response | null> {
    if (!this.fallbackEligible(request)) return null;
    this.onRetry?.({ class: 'fallback', attempt: 1, delay: 0 });
    const response = await this.tryFallback(request);
    if (!response) return null;
    const body = await response.text().catch(() => '');
    if (response.ok) {
      const innerStatus = detectInnerError(body);
      if (innerStatus !== null) {
        if (isTransientGatewayError(innerStatus, body)) return null;
        throw this.toInnerHttpError(request, innerStatus, body);
      }
      return this.rebuildResponse(response, body);
    }
    if (isTransientGatewayError(response.status, body)) return null;
    throw this.toHttpError(request, response, body);
  }

  async request(request: GatewayRequest): Promise<Response> {
    // A PMAK-only run starts with no access token; mint one up front so the
    // gateway is the sole asset path (the PMAK is only ever the mint credential).
    if (!this.tokenProvider.current() && this.tokenProvider.canRefresh()) {
      await this.tokenProvider.refresh();
    }
    const retryMode = request.retry ?? (request.method === 'get' ? 'safe' : 'none');
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.send(request);
      } catch (error) {
        // Transport rejection (socket hangup, DNS, or the deadline aborting the
        // request). Safe requests retry within budget; otherwise re-throw so an
        // unsafe mutation is reconciled rather than blindly resent.
        if (retryMode === 'safe' && attempt < this.maxRetries) {
          const delay = this.retryDelayMs(attempt);
          attempt += 1;
          this.onRetry?.({ class: 'transport', attempt, delay });
          await this.sleepImpl(delay);
          continue;
        }
        const fallbackResponse = await this.attemptFallback(request);
        if (fallbackResponse) return fallbackResponse;
        throw error;
      }

      if (response.ok) {
        const okBody = await response.text().catch(() => '');
        const innerStatus = detectInnerError(okBody);
        if (innerStatus !== null) {
          const retryInner =
            (retryMode === 'safe' && isTransientGatewayError(innerStatus, okBody)) ||
            (retryMode === 'rate-limit' && innerStatus === 429);
          if (retryInner && attempt < this.maxRetries) {
            const delay = this.retryDelayMs(attempt);
            attempt += 1;
            this.onRetry?.({ class: 'inner', status: innerStatus, attempt, delay });
            await this.sleepImpl(delay);
            continue;
          }
          const fallbackResponse = await this.attemptFallback(request);
          if (fallbackResponse) return fallbackResponse;
          throw this.toInnerHttpError(request, innerStatus, okBody);
        }
        return this.rebuildResponse(response, okBody);
      }

      const body = await response.text().catch(() => '');
      if (isExpiredAuthError(response.status, body) && this.tokenProvider.canRefresh()) {
        this.onRetry?.({ class: 'auth', status: response.status, attempt: 1, delay: 0 });
        await this.tokenProvider.refresh();
        response = await this.send(request);
        if (response.ok) {
          const refreshedBody = await response.text().catch(() => '');
          const innerStatus = detectInnerError(refreshedBody);
          if (innerStatus !== null) {
            throw this.toInnerHttpError(request, innerStatus, refreshedBody);
          }
          return this.rebuildResponse(response, refreshedBody);
        }
        const retryBody = await response.text().catch(() => '');
        throw this.toHttpError(request, response, retryBody);
      }

      const retryResponse =
        (retryMode === 'safe' && isTransientGatewayError(response.status, body)) ||
        (retryMode === 'rate-limit' && response.status === 429);
      if (retryResponse && attempt < this.maxRetries) {
        const delay = this.retryDelayMs(
          attempt,
          parseRetryAfterMs(response.headers.get('retry-after'))
        );
        attempt += 1;
        this.onRetry?.({ class: 'http', status: response.status, attempt, delay });
        await this.sleepImpl(delay);
        continue;
      }

      const fallbackResponse = await this.attemptFallback(request);
      if (fallbackResponse) return fallbackResponse;
      throw this.toHttpError(request, response, body);
    }
  }

  /**
   * Full-jitter backoff (uniform in [0, min(cap, base * 2^attempt))) so
   * concurrent CI runners that fail together never retry in lockstep against
   * the shared gateway. A server-sent Retry-After beats the heuristic: it is
   * authoritative backpressure, honored verbatim (capped by the ceiling).
   */
  private retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs !== undefined) {
      return Math.min(this.retryMaxDelayMs, retryAfterMs);
    }
    return fullJitterDelayMs(attempt, this.retryBaseDelayMs, this.retryMaxDelayMs, this.randomImpl);
  }

  /**
   * The success path reads the body to inspect for an inner error, which
   * consumes the stream. Hand callers a fresh Response over the buffered text so
   * `requestJson` can still parse it.
   */
  private rebuildResponse(response: Response, body: string): Response {
    // Null-body statuses (204/205/304) reject ANY body in the Response
    // constructor, including the empty string a drained 204 produces.
    const nullBody = response.status === 204 || response.status === 205 || response.status === 304;
    return new Response(nullBody ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
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

  /**
   * Read an app-native Bifrost route that is not exposed through `/ws/proxy`.
   * Collection sync hydration uses this path in the Postman app and supports
   * org-mode service accounts that the v3 collection-root proxy rejects.
   */
  async requestDirectJson<T = Record<string, unknown>>(path: string): Promise<T | null> {
    if (!path.startsWith('/')) {
      throw new Error(`Direct Bifrost path must start with '/': ${path}`);
    }
    if (!this.tokenProvider.current() && this.tokenProvider.canRefresh()) {
      await this.tokenProvider.refresh();
    }

    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.sendDirect(path);
      } catch (error) {
        if (attempt < this.maxRetries) {
          const delay = this.retryDelayMs(attempt);
          attempt += 1;
          await this.sleepImpl(delay);
          continue;
        }
        throw error;
      }

      const body = await response.text().catch(() => '');
      if (response.ok) {
        if (!body.trim()) return null;
        try {
          return JSON.parse(body) as T;
        } catch {
          return null;
        }
      }

      if (isExpiredAuthError(response.status, body) && this.tokenProvider.canRefresh()) {
        await this.tokenProvider.refresh();
        response = await this.sendDirect(path);
        const refreshedBody = await response.text().catch(() => '');
        if (response.ok) {
          if (!refreshedBody.trim()) return null;
          try {
            return JSON.parse(refreshedBody) as T;
          } catch {
            return null;
          }
        }
        throw this.toDirectHttpError(path, response, refreshedBody);
      }

      if (
        isTransientGatewayError(response.status, body) &&
        attempt < this.maxRetries
      ) {
        const delay = this.retryDelayMs(
          attempt,
          parseRetryAfterMs(response.headers.get('retry-after'))
        );
        attempt += 1;
        await this.sleepImpl(delay);
        continue;
      }
      throw this.toDirectHttpError(path, response, body);
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

  private toInnerHttpError(
    request: GatewayRequest,
    status: number,
    body: string
  ): HttpError {
    return new HttpError({
      method: request.method.toUpperCase(),
      url: `${this.bifrostBaseUrl}/ws/proxy (${request.service}: ${request.method} ${request.path}) [inner]`,
      status,
      statusText: 'Inner Error',
      requestHeaders: this.buildHeaders(request.headers),
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }

  private toDirectHttpError(path: string, response: Response, body: string): HttpError {
    return new HttpError({
      method: 'GET',
      url: `${this.bifrostBaseUrl}${path}`,
      status: response.status,
      statusText: response.statusText,
      requestHeaders: this.buildHeaders(),
      responseBody: this.secretMasker(body),
      secretValues: [this.tokenProvider.current()]
    });
  }
}
