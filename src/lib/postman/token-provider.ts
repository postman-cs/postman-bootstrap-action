import { retry } from '../retry.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';

export interface AccessTokenProviderOptions {
  accessToken?: string;
  apiKey?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
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

/** Holds the live access token and renews it only through the token mint endpoint. */
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
        'postman: the access token is invalid or expired and no token-mint credential is available. Re-run postman-resolve-service-token-action and retry.'
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
      if (response.status === 400 && body.toLowerCase().includes('service accounts not enabled')) {
        throw new MintError(
          'postman: access-token mint failed because service accounts are not enabled for this team.',
          true
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new MintError(
          `postman: access-token mint failed because the postman-api-key was rejected (HTTP ${response.status}).`,
          true
        );
      }
      throw new MintError(
        `postman: access-token mint failed (service-account-tokens HTTP ${response.status}).`,
        false
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    const token = extractAccessToken(parsed);
    if (!token) {
      throw new MintError('postman: access-token mint succeeded but returned no token.', false);
    }
    return token;
  }
}

export interface MintLog {
  info: (message: string) => void;
  warning: (message: string) => void;
}

/** Mint an access token before constructing clients when only the key is supplied. */
export async function mintAccessTokenIfNeeded(
  inputs: { postmanAccessToken?: string; postmanApiKey?: string; postmanApiBase?: string },
  log: MintLog,
  setSecret?: (secret: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (inputs.postmanAccessToken || !inputs.postmanApiKey) return;
  const provider = new AccessTokenProvider({
    apiKey: inputs.postmanApiKey,
    apiBaseUrl: inputs.postmanApiBase,
    fetchImpl,
    onToken: (token) => setSecret?.(token)
  });
  try {
    inputs.postmanAccessToken = await provider.refresh();
    log.info('postman: minted a short-lived service-account access token from the postman-api-key.');
  } catch (error) {
    log.warning(
      `postman: could not mint an access token from the postman-api-key. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
