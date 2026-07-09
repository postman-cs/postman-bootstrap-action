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

/** Minimal logger seam for {@link mintAccessTokenIfNeeded}. */
export interface MintLog {
  info: (message: string) => void;
  warning: (message: string) => void;
}

/**
 * Classify a failed eager mint into an actionable, operator-facing diagnosis.
 *
 * The mint endpoint (`POST /service-account-tokens`) rejects PERSONAL API keys
 * with the same 401 "Invalid or inactive API key" it uses for garbage keys
 * (live-verified), so on 401/403 this probes `GET /me` with the same PMAK to
 * split the two cases:
 *   - mint 401/403 + /me OK    -> the key authenticates but cannot mint: it is a
 *                                 personal API key or a service account without
 *                                 token-mint permission, named accordingly.
 *   - mint 401/403 + /me 401   -> the key itself is invalid, disabled, or expired.
 *   - mint 400 "service accounts not enabled" -> team-level feature gap.
 * The /me probe is read-only and best-effort: a network failure downgrades the
 * diagnosis to the raw mint error rather than masking it.
 */
async function describeMintFailure(
  mintError: unknown,
  apiKey: string,
  apiBaseUrl: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const raw = mintError instanceof Error ? mintError.message : String(mintError);
  const rejected = /HTTP 40[13]|PMAK rejected/.test(raw);
  if (!rejected) {
    return raw;
  }
  try {
    const me = await fetchImpl(`${apiBaseUrl}/me`, { headers: { 'x-api-key': apiKey } });
    if (me.ok) {
      const body = (await me.json().catch(() => undefined)) as
        | { user?: { username?: string | null; email?: string | null; teamId?: number } }
        | undefined;
      const user = body?.user;
      // Service-account identities carry null username/email (live-verified);
      // a real username/email means a human user's personal key.
      const looksPersonal = Boolean(user && (user.username || user.email));
      if (looksPersonal) {
        return (
          'Personal API key detected, cannot mint a service-account access token. ' +
          'POST /service-account-tokens only accepts a SERVICE-ACCOUNT API key; this postman-api-key belongs to a user account' +
          (user?.teamId ? ` (team ${user.teamId})` : '') +
          '. Create a service account in Team Settings and use its PMAK, or mint the token elsewhere and pass postman-access-token.'
        );
      }
      return (
        'The postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens' +
        (user?.teamId ? ` (team ${user.teamId})` : '') +
        '. The service account likely lacks permission to mint access tokens, or service accounts are restricted for this team. ' +
        'Check the service account role in Team Settings, or pass a pre-minted postman-access-token.'
      );
    }
    return (
      'The postman-api-key is invalid, disabled, or expired (rejected by both POST /service-account-tokens and GET /me). ' +
      'Generate a fresh service-account PMAK in Team Settings and update the secret.'
    );
  } catch {
    return raw;
  }
}

/**
 * Eagerly mint the short-lived service-account access token from the PMAK when
 * no postman-access-token was supplied. Mutates `inputs.postmanAccessToken` on
 * success so every downstream consumer sees the token exactly as if it had
 * been provided. Mint failure is a warning, not fatal: callers keep their own
 * missing-token guards, and the warning carries a live-probed diagnosis
 * (personal key vs invalid key vs permission gap vs feature disabled).
 */
export async function mintAccessTokenIfNeeded(
  inputs: { postmanAccessToken?: string; postmanApiKey?: string; postmanApiBase?: string },
  log: MintLog,
  setSecret?: (secret: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (inputs.postmanAccessToken || !inputs.postmanApiKey) {
    return;
  }
  const apiBaseUrl = String(
    inputs.postmanApiBase || POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl
  ).replace(/\/+$/, '');
  const provider = new AccessTokenProvider({
    apiKey: inputs.postmanApiKey,
    apiBaseUrl,
    fetchImpl,
    onToken: (token) => setSecret?.(token)
  });
  try {
    inputs.postmanAccessToken = await provider.refresh();
    log.info(
      'postman: no postman-access-token configured - minted a short-lived service-account access token from the postman-api-key.'
    );
  } catch (error) {
    const diagnosis = await describeMintFailure(error, inputs.postmanApiKey, apiBaseUrl, fetchImpl);
    log.warning(
      'postman: could not mint an access token from the postman-api-key. ' +
        diagnosis +
        ' Continuing without an access token - access-token-only functionality will be unavailable unless postman-access-token is provided.'
    );
  }
}