import { HttpError } from '../http-error.js';
import { normalizeGitRepoUrl } from './postman-assets-client.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';

export type InternalIntegrationBackend = 'bifrost';

export interface GovernanceAssociation {
  envUid: string;
  systemEnvId: string;
}

export interface SpecificationCollectionLink {
  collectionId: string;
  syncOptions?: {
    syncExamples: boolean;
  };
}

export interface InternalIntegrationAdapterOptions {
  accessToken: string;
  backend: string;
  bifrostBaseUrl?: string;
  fetchImpl?: typeof fetch;
  gatewayBaseUrl?: string;
  orgMode?: boolean;
  secretMasker?: SecretMasker;
  teamId: string;
  workerBaseUrl?: string;
}

export interface InternalIntegrationAdapter {
  assignWorkspaceToGovernanceGroup(
    workspaceId: string,
    domain: string,
    mappingJson: string
  ): Promise<void>;
  associateSystemEnvironments(
    workspaceId: string,
    associations: GovernanceAssociation[]
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
  private readonly accessToken: string;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gatewayBaseUrl: string;
  private readonly orgMode: boolean;
  private readonly secretMasker: SecretMasker;
  private readonly teamId: string;
  private readonly workerBaseUrl: string;

  constructor(options: InternalIntegrationAdapterOptions) {
    this.accessToken = String(options.accessToken || '').trim();
    this.bifrostBaseUrl = String(
      options.bifrostBaseUrl || 'https://bifrost-premium-https-v4.gw.postman.com'
    ).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gatewayBaseUrl = String(
      options.gatewayBaseUrl || 'https://gateway.postman.com'
    ).replace(/\/+$/, '');
    this.orgMode = options.orgMode ?? false;
    this.secretMasker =
      options.secretMasker ?? createSecretMasker([this.accessToken]);
    this.teamId = String(options.teamId || '').trim();
    this.workerBaseUrl = String(
      options.workerBaseUrl ||
        'https://catalog-admin.postman-account2009.workers.dev'
    ).replace(/\/+$/, '');
  }

  private async proxyRequest(
    service: string,
    method: string,
    requestPath: string,
    body?: unknown
  ): Promise<Response> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.accessToken
    };
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
        ...(body !== undefined ? { body } : {})
      })
    });
  }

  async assignWorkspaceToGovernanceGroup(
    workspaceId: string,
    domain: string,
    mappingJson: string
  ): Promise<void> {
    let mapping: Record<string, string>;
    try {
      mapping = JSON.parse(mappingJson || '{}');
    } catch {
      return;
    }

    const groupName = String(mapping[domain] || '').trim();
    if (!groupName) {
      return;
    }

    const listUrl = `${this.gatewayBaseUrl}/configure/workspace-groups`;
    const listResponse = await this.fetchImpl(listUrl, {
      headers: {
        'x-access-token': this.accessToken
      }
    });

    if (!listResponse.ok) {
      throw await HttpError.fromResponse(listResponse, {
        method: 'GET',
        requestHeaders: {
          'x-access-token': this.accessToken
        },
        secretValues: [this.accessToken],
        url: listUrl
      });
    }

    const groups = (await listResponse.json()) as {
      data?: Array<{ id: string; name: string }>;
    };
    const group = groups.data?.find((entry) => entry.name === groupName);
    if (!group?.id) {
      return;
    }

    const patchUrl = `${this.gatewayBaseUrl}/configure/workspace-groups/${group.id}`;
    const patchResponse = await this.fetchImpl(patchUrl, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken
      },
      body: JSON.stringify({
        workspaces: [workspaceId]
      })
    });

    if (!patchResponse.ok) {
      throw await HttpError.fromResponse(patchResponse, {
        method: 'PATCH',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.accessToken
        },
        secretValues: [this.accessToken],
        url: patchUrl
      });
    }
  }

  async associateSystemEnvironments(
    workspaceId: string,
    associations: GovernanceAssociation[]
  ): Promise<void> {
    if (associations.length === 0) {
      return;
    }

    const response = await this.fetchImpl(
      `${this.workerBaseUrl}/api/internal/system-envs/associate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          associations: associations.map((entry) => ({
            env_uid: entry.envUid,
            system_env_id: entry.systemEnvId
          }))
        })
      }
    );

    if (!response.ok) {
      throw await HttpError.fromResponse(response, {
        method: 'POST',
        requestHeaders: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        secretValues: [this.accessToken],
        url: `${this.workerBaseUrl}/api/internal/system-envs/associate`
      });
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

    throw await HttpError.fromResponse(response, {
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken,
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      secretValues: [this.accessToken],
      url: `${this.bifrostBaseUrl}/ws/proxy`
    });
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

    throw await HttpError.fromResponse(response, {
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken,
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      secretValues: [this.accessToken],
      url: `${this.bifrostBaseUrl}/ws/proxy`
    });
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

    throw await HttpError.fromResponse(response, {
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'x-access-token': this.accessToken,
        ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
      },
      secretValues: [this.accessToken],
      url: `${this.bifrostBaseUrl}/ws/proxy`
    });
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
