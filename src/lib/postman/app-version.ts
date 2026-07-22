const FLOOR_VERSION = '12.0.0';
const VERSION_URL = 'https://dl.pstmn.io/update/status?currentVersion=12.0.0&platform=osx_arm64';
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface PostmanAppVersionProviderOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface AppVersionProvider {
  resolve(): Promise<string | undefined>;
}

export class PostmanAppVersionProvider implements AppVersionProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private resolved?: Promise<string | undefined>;

  constructor(options: PostmanAppVersionProviderOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2000;
  }

  resolve(): Promise<string | undefined> {
    if (process.env.POSTMAN_GATEWAY_APP_VERSION === 'off') return Promise.resolve(undefined);
    this.resolved ??= this.lookup();
    return this.resolved;
  }

  private async lookup(): Promise<string> {
    try {
      const response = await this.fetchImpl(VERSION_URL, {
        method: 'GET',
        signal: AbortSignal.timeout(this.requestTimeoutMs)
      });
      if (!response.ok) return FLOOR_VERSION;
      const payload = await response.json() as { version?: unknown };
      const version = typeof payload.version === 'string' ? payload.version.trim() : '';
      return VERSION_PATTERN.test(version) ? version : FLOOR_VERSION;
    } catch {
      return FLOOR_VERSION;
    }
  }
}

export const postmanAppVersionProvider = new PostmanAppVersionProvider();
