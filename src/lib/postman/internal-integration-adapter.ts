import { HttpError } from '../http-error.js';
import { normalizeGitRepoUrl } from './git-url.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import { getMemoizedSessionIdentity } from './credential-identity.js';
import { adviseFromHttpError, type ErrorAdviceContext } from './error-advice.js';
import type { AccessTokenProvider } from './token-provider.js';

export type InternalIntegrationBackend = 'bifrost';

export interface SpecificationCollectionLink {
  collectionId: string;
  syncOptions?: {
    syncExamples: boolean;
  };
}

export interface InternalIntegrationAdapterOptions {
  accessToken: string;
  /**
   * Optional live-token accessor. When present, every request reads the token
   * through `tokenProvider.current()` so a mid-run re-mint propagates without
   * reconstructing the adapter; `accessToken` remains the back-compat seed.
   */
  tokenProvider?: AccessTokenProvider;
  backend: string;
  bifrostBaseUrl?: string;
  fetchImpl?: typeof fetch;
  gatewayBaseUrl?: string;
  orgMode?: boolean;
  secretMasker?: SecretMasker;
  teamId: string;
}

export interface InternalIntegrationAdapter {
  configureTeamContext(teamId: string, orgMode: boolean): void;
  assignWorkspaceToGovernanceGroup(
    workspaceId: string,
    domain: string,
    mappingJson: string,
    governanceGroupName?: string
  ): Promise<void>;
  connectWorkspaceToRepository(
    workspaceId: string,
    repoUrl: string
  ): Promise<void>;
  linkCollectionsToSpecification(
    specificationId: string,
    collections: SpecificationCollectionLink[]
  ): Promise<void>;
  syncCollection(
    specificationId: string,
    collectionId: string
  ): Promise<void>;
}

class BifrostInternalIntegrationAdapter implements InternalIntegrationAdapter {
  private static readonly MINIMUM_POSTMAN_APP_VERSION = '12.0.0';
  private static readonly POSTMAN_APP_VERSION_URL = `https://dl.pstmn.io/update/status?currentVersion=${BifrostInternalIntegrationAdapter.MINIMUM_POSTMAN_APP_VERSION}&platform=osx_arm64`;

  private readonly accessToken: string;
  private readonly tokenProvider?: AccessTokenProvider;
  private appVersionPromise?: Promise<string>;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gatewayBaseUrl: string;
  private orgMode: boolean;
  private readonly secretMasker: SecretMasker;
  private teamId: string;

  constructor(options: InternalIntegrationAdapterOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.tokenProvider = options.tokenProvider;
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gatewayBaseUrl = String(
      options.gatewayBaseUrl || POSTMAN_ENDPOINT_PROFILES.prod.gatewayBaseUrl
    ).replace(/\/+$/, '');
    this.orgMode = options.orgMode ?? false;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.accessToken]);
    this.teamId = String(options.teamId || '').trim();
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.teamId = String(teamId || '').trim();
    this.orgMode = orgMode;
  }

  /** Live access token: the provider's current value when wired, else the seed. */
  private currentToken(): string {
    return this.tokenProvider ? this.tokenProvider.current() : this.accessToken;
  }

  private adviceContext(operation: string): ErrorAdviceContext {
    const session = getMemoizedSessionIdentity();
    return {
      operation,
      hasAccessToken: Boolean(this.currentToken()),
      sessionTeamId: session?.teamId,
      sessionRoles: session?.roles,
      sessionConsumerType: session?.consumerType,
      explicitTeamId: this.teamId || undefined,
      mask: this.secretMasker
    };
  }

  private async proxyRequest(
    service: string,
    method: string,
    requestPath: string,
    body?: unknown,
    options: { appVersion?: string; query?: Record<string, unknown> } = {}
  ): Promise<Response> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.currentToken()
    };
    if (options.appVersion) {
      headers['x-app-version'] = options.appVersion;
    }
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }

    return this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        service,
        method,
        path: requestPath,
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(body !== undefined ? { body } : {})
      })
    });
  }

  private resolvePostmanAppVersion(): Promise<string> {
    this.appVersionPromise ??= (async () => {
      try {
        const response = await this.fetchImpl(
          BifrostInternalIntegrationAdapter.POSTMAN_APP_VERSION_URL,
          { method: 'GET' }
        );
        if (!response.ok) {
          return BifrostInternalIntegrationAdapter.MINIMUM_POSTMAN_APP_VERSION;
        }
        const payload = (await response.json()) as { version?: unknown };
        const version = String(payload.version || '').trim();
        return version || BifrostInternalIntegrationAdapter.MINIMUM_POSTMAN_APP_VERSION;
      } catch {
        return BifrostInternalIntegrationAdapter.MINIMUM_POSTMAN_APP_VERSION;
      }
    })();

    return this.appVersionPromise;
  }

  async assignWorkspaceToGovernanceGroup(
    workspaceId: string,
    domain: string,
    mappingJson: string,
    governanceGroupName?: string
  ): Promise<void> {
    let groupName = String(governanceGroupName || '').trim();
    if (!groupName) {
      let mapping: Record<string, string>;
      try {
        mapping = JSON.parse(mappingJson || '{}');
      } catch {
        return;
      }
      groupName = String(mapping[domain] || '').trim();
    }
    if (!groupName) {
      return;
    }

    const appVersion = await this.resolvePostmanAppVersion();
    const listResponse = await this.proxyRequest(
      'ruleset',
      'get',
      '/configure/workspace-groups',
      undefined,
      { appVersion, query: { tag: 'governance' } }
    );

    if (!listResponse.ok) {
      const httpErr = await HttpError.fromResponse(listResponse, {
        method: 'GET',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.currentToken(),
          'x-app-version': appVersion,
          ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
        },
        secretValues: [this.currentToken()],
        url: `${this.bifrostBaseUrl}/ws/proxy`
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext('governance assignment'));
      throw advised ?? httpErr;
    }

    const groups = (await listResponse.json()) as {
      data?: Array<{ id: string; name: string }>;
      workspaceGroups?: Array<{ id: string; name: string }>;
    };
    const group = (groups.workspaceGroups ?? groups.data)?.find(
      (entry) => entry.name === groupName
    );
    if (!group?.id) {
      return;
    }

    const patchResponse = await this.proxyRequest(
      'ruleset',
      'patch',
      `/configure/workspace-groups/${group.id}`,
      {
        workspaces: {
          add: [workspaceId],
          remove: []
        },
        vulnerabilities: {
          add: [],
          remove: []
        }
      },
      { appVersion }
    );

    if (!patchResponse.ok) {
      const httpErr = await HttpError.fromResponse(patchResponse, {
        method: 'PATCH',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.currentToken(),
          'x-app-version': appVersion,
          ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
        },
        secretValues: [this.currentToken()],
        url: `${this.bifrostBaseUrl}/ws/proxy`
      });
      const advised = adviseFromHttpError(httpErr, this.adviceContext('governance assignment'));
      throw advised ?? httpErr;
    }
  }

  async connectWorkspaceToRepository(
    workspaceId: string,
    repoUrl: string
  ): Promise<void> {
    const payload = {
      service: 'workspaces',
      method: 'POST',
      path: `/workspaces/${workspaceId}/filesystem`,
      body: {
        path: '/',
        repo: repoUrl,
        versionControl: true
      }
    };

    const response = await this.proxyRequest(
      payload.service,
      payload.method,
      payload.path,
      payload.body
    );

    if (response.ok) return;

    if (response.status === 400) {
      const body = await response.text();
      // Handle both legacy ('invalidParamError' + 'already exists') and
      // current ('projectAlreadyConnected') Bifrost duplicate-link errors.
      const isDuplicate =
        (body.includes('invalidParamError') && body.includes('already exists')) ||
        body.includes('projectAlreadyConnected');
      if (isDuplicate) {
        const linkedUrl = await this.getWorkspaceGitRepoUrl(workspaceId);
        if (normalizeGitRepoUrl(linkedUrl) === normalizeGitRepoUrl(repoUrl)) {
          return;
        }
        throw new Error(
          `Bifrost link already exists for workspace ${workspaceId}, but linked to a different repo`
        );
      }
    }

    const httpErr = await HttpError.fromResponse(response, {
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.currentToken(),
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      secretValues: [this.currentToken()],
      url: `${this.bifrostBaseUrl}/ws/proxy`
    });
    const advised = adviseFromHttpError(httpErr, this.adviceContext('workspace repository linking'));
    throw advised ?? httpErr;
  }

  async linkCollectionsToSpecification(
    specificationId: string,
    collections: SpecificationCollectionLink[]
  ): Promise<void> {
    if (collections.length === 0) {
      return;
    }

    const response = await this.proxyRequest(
      'specification',
      'put',
      `/specifications/${specificationId}/collections`,
      collections.map((collection) => ({
        collectionId: collection.collectionId,
        ...(collection.syncOptions ? { syncOptions: collection.syncOptions } : {})
      }))
    );

    if (response.ok) {
      return;
    }

    const httpErr = await HttpError.fromResponse(response, {
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.currentToken(),
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      secretValues: [this.currentToken()],
      url: `${this.bifrostBaseUrl}/ws/proxy`
    });
    const advised = adviseFromHttpError(
      httpErr,
      this.adviceContext('collection-to-specification linking')
    );
    throw advised ?? httpErr;
  }

  async syncCollection(
    specificationId: string,
    collectionId: string
  ): Promise<void> {
    const response = await this.proxyRequest(
      'specification',
      'post',
      `/specifications/${specificationId}/collections/${collectionId}/sync`
    );

    if (response.ok) {
      return;
    }

    const httpErr = await HttpError.fromResponse(response, {
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.currentToken(),
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      secretValues: [this.currentToken()],
      url: `${this.bifrostBaseUrl}/ws/proxy`
    });
    const advised = adviseFromHttpError(httpErr, this.adviceContext('collection sync'));
    throw advised ?? httpErr;
  }

  private async getWorkspaceGitRepoUrl(workspaceId: string): Promise<string | null> {
    const response = await this.proxyRequest(
      'workspaces',
      'GET',
      `/workspaces/${workspaceId}/filesystem`
    );

    if (response.status === 404) return null;
    if (!response.ok) return null;

    const body = await response.text();
    if (!body.trim()) return null;

    try {
      const data = JSON.parse(body);
      const repo = data?.repo || data?.repository || data?.repoUrl;
      return typeof repo === 'string' ? repo : null;
    } catch {
      return null;
    }
  }
}

export function createInternalIntegrationAdapter(
  options: InternalIntegrationAdapterOptions
): InternalIntegrationAdapter {
  if (options.backend !== 'bifrost') {
    const masker =
      options.secretMasker ?? createSecretMasker([options.accessToken]);
    throw new Error(
      masker(`Unsupported integration backend: ${String(options.backend || '')}`)
    );
  }

  return new BifrostInternalIntegrationAdapter(options);
}
