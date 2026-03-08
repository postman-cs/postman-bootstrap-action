import { createSecretMasker, type SecretMasker } from '../secrets.js';

export type GitHubApiClientAuthMode =
  | 'github_token_first'
  | 'fallback_pat_first'
  | 'app_token';

export interface GitHubApiClientOptions {
  apiBase?: string;
  appToken?: string;
  authMode?: GitHubApiClientAuthMode;
  fallbackToken?: string;
  fetch?: typeof fetch;
  repository: string;
  secretMasker?: SecretMasker;
  token: string;
}

function buildErrorMessage(
  method: string,
  path: string,
  response: Response,
  body: string,
  masker: SecretMasker
): string {
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  const sanitizedBody = masker(body || '');
  return sanitizedBody
    ? masker(`${method} ${path} failed with ${status} - ${sanitizedBody}`)
    : masker(`${method} ${path} failed with ${status} - [REDACTED]`);
}

export class GitHubApiClient {
  private readonly apiBase: string;
  private readonly authMode: GitHubApiClientAuthMode;
  private readonly appToken: string;
  private readonly fallbackToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly owner: string;
  private readonly repo: string;
  private readonly repository: string;
  private readonly secretMasker: SecretMasker;
  private readonly token: string;

  constructor(options: GitHubApiClientOptions) {
    this.apiBase = String(options.apiBase || 'https://api.github.com').replace(
      /\/+$/,
      ''
    );
    this.appToken = String(options.appToken || '').trim();
    this.authMode = options.authMode || 'github_token_first';
    this.fallbackToken = String(options.fallbackToken || '').trim();
    this.fetchImpl = options.fetch ?? fetch;
    this.repository = options.repository;
    const [owner, repo] = options.repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.token = String(options.token || '').trim();
    this.secretMasker =
      options.secretMasker ??
      createSecretMasker([this.token, this.fallbackToken, this.appToken]);
  }

  getTokenOrder(): string[] {
    const ordered: string[] = [];

    if (this.authMode === 'app_token') {
      if (this.appToken) ordered.push(this.appToken);
      if (this.token && this.token !== this.appToken) ordered.push(this.token);
      if (
        this.fallbackToken &&
        this.fallbackToken !== this.appToken &&
        this.fallbackToken !== this.token
      ) {
        ordered.push(this.fallbackToken);
      }
      return ordered;
    }

    if (this.authMode === 'fallback_pat_first') {
      if (this.fallbackToken) ordered.push(this.fallbackToken);
      if (this.token && this.token !== this.fallbackToken) ordered.push(this.token);
      return ordered;
    }

    if (this.token) ordered.push(this.token);
    if (this.fallbackToken && this.fallbackToken !== this.token) {
      ordered.push(this.fallbackToken);
    }
    return ordered;
  }

  private isVariablesEndpoint(path: string): boolean {
    return path.startsWith(`/repos/${this.owner}/${this.repo}/actions/variables`);
  }

  private canUseFallback(path: string): boolean {
    return (
      this.isVariablesEndpoint(path) ||
      path.includes(`/repos/${this.owner}/${this.repo}/contents`) ||
      path.includes('/dispatches')
    );
  }

  private async requestWithToken(
    path: string,
    init: RequestInit,
    token: string
  ): Promise<Response> {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) {
      throw new Error(`Missing GitHub auth token for request ${path}`);
    }

    return this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${normalizedToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const orderedTokens = this.getTokenOrder();
    if (orderedTokens.length === 0) {
      throw new Error('No GitHub auth token configured');
    }

    const first = await this.requestWithToken(path, init, orderedTokens[0]);

    if (orderedTokens.length < 2 || !this.canUseFallback(path)) {
      return first;
    }

    // GitHub returns 404 (not 403) when GITHUB_TOKEN lacks permission to
    // read repo variables — this prevents information disclosure but means
    // the action silently treats existing variables as missing. Retry with
    // the fallback PAT for both 403 and variable-GET-404 cases.
    const isVariableGet404 =
      first.status === 404 &&
      (!init.method || init.method === 'GET') &&
      this.isVariablesEndpoint(path);

    if (first.status !== 403 && !isVariableGet404) {
      return first;
    }

    return this.requestWithToken(path, init, orderedTokens[1]);
  }

  async setRepositoryVariable(name: string, value: string): Promise<void> {
    if (!value) {
      throw new Error(`Repo variable ${name} is empty`);
    }

    const path = `/repos/${this.repository}/actions/variables`;
    const body = JSON.stringify({ name, value: String(value) });
    const createResponse = await this.request(path, {
      method: 'POST',
      body
    });

    if (createResponse.ok || createResponse.status === 201) {
      return;
    }

    if (createResponse.status === 409 || createResponse.status === 422) {
      const updatePath = `/repos/${this.repository}/actions/variables/${name}`;
      const updateResponse = await this.request(updatePath, {
        method: 'PATCH',
        body
      });
      if (updateResponse.ok) {
        return;
      }
      const text = await updateResponse.text().catch(() => '');
      throw new Error(
        buildErrorMessage('PATCH', updatePath, updateResponse, text, this.secretMasker)
      );
    }

    const text = await createResponse.text().catch(() => '');
    throw new Error(
      buildErrorMessage('POST', path, createResponse, text, this.secretMasker)
    );
  }

  async getRepositoryVariable(name: string): Promise<string> {
    const path = `/repos/${this.repository}/actions/variables/${name}`;
    const response = await this.request(path, {
      method: 'GET'
    });

    if (response.status === 404) {
      return '';
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        buildErrorMessage('GET', path, response, text, this.secretMasker)
      );
    }

    const data = (await response.json()) as { value?: string };
    return String(data.value || '');
  }
}
