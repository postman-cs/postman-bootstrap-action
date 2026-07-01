import { retry } from '../retry.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';

export interface AccessTokenProviderOptions {
  /** Current access token (from action input or a prior mint). May be empty. */
  accessToken?: string;
  /** Service-account PMAK used to re-mint the access token. Empty disables refresh. */
  apiKey?: string;
  /** Public API base (e.g. https://api.getpostman.com); mint target host. */
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Max mint attempts per refresh (default 2). */
  maxAttempts?: number;
  /**
   * Called with each freshly minted token so the caller can register it with
   * the Actions log scrubber (core.setSecret) and a mutable masker. Re-minted
   * tokens are unmasked unless this records them.
   */
  onToken?: (token: string) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

class MintError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = 'MintError';
    this.permanent = permanent;
  }
}

function extractAccessToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.access_token;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const session = record.session;
  if (session && typeof session === 'object') {
    const token = (session as Record<string, unknown>).token;
    if (typeof token === 'string' && token.trim()) return token.trim();
  }
  return undefined;
}

/**
 * Holds the live access token and re-mints it on expiry.
 *
 * Clients must read the token through {@link current} on every request rather
 * than capturing it, so a refreshed token propagates to all in-flight clients.
 * {@link refresh} is single-flight: concurrent callers await one mint, mirroring
 * the app-version memoization in internal-integration-adapter.ts. The mint wire
 * shape mirrors postman-resolve-service-token-action (POST /service-account-tokens
 * with x-api-key + { apiKey }); the service-account PMAK is the renewal credential.
 */
export class AccessTokenProvider {
  private token: string;
  private readonly apiKey: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly onToken?: (token: string) => void;
  private readonly sleep?: (delayMs: number) => Promise<void>;
  private inflight?: Promise<string>;

  constructor(options: AccessTokenProviderOptions) {
    this.token = String(options.accessToken || '').trim();
    this.apiKey = String(options.apiKey || '').trim();
    this.apiBaseUrl = String(
      options.apiBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.onToken = options.onToken;
    this.sleep = options.sleep;
  }

  current(): string {
    return this.token;
  }

  /** True when a PMAK is present, so an expired token can be re-minted. */
  canRefresh(): boolean {
    return Boolean(this.apiKey);
  }

  refresh(): Promise<string> {
    this.inflight ??= this.mintWithRetry().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async mintWithRetry(): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        'postman: the access token expired and cannot be refreshed because no postman-api-key is present. ' +
          'Service-account access tokens expire after about 1 to 1.5 hours. ' +
          'Re-mint a fresh token (postman-resolve-service-token-action) and re-run.'
      );
    }
    const token = await retry(() => this.mintOnce(), {
      maxAttempts: this.maxAttempts,
      delayMs: 1000,
      backoffMultiplier: 2,
      ...(this.sleep ? { sleep: this.sleep } : {}),
      shouldRetry: (error) => !(error instanceof MintError && error.permanent)
    });
    this.token = token;
    this.onToken?.(token);
    return token;
  }

  private async mintOnce(): Promise<string> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/service-account-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey
      },
      body: JSON.stringify({ apiKey: this.apiKey })
    });

    const body = await response.text().catch(() => '');
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new MintError(
          `postman: re-mint failed because the postman-api-key was rejected (PMAK rejected, HTTP ${status}); ` +
            'confirm it is a valid, enabled service-account PMAK for the intended team.',
          true
        );
      }
      if (status === 400 && body.toLowerCase().includes('service accounts not enabled')) {
        throw new MintError(
          'postman: re-mint failed because service accounts are not enabled for this team; ' +
            'enable them in Team Settings or use a team where they are.',
          true
        );
      }
      throw new MintError(`postman: re-mint failed (service-account-tokens HTTP ${status}).`, false);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const token = extractAccessToken(parsed);
    if (!token) {
      throw new MintError('postman: re-mint succeeded but no access token was returned.', false);
    }
    return token;
  }
}
