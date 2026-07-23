import { HttpError } from '../http-error.js';
import { normalizeGitRepoUrl } from './git-url.js';
import { createSecretMasker, type SecretMasker } from '../secrets.js';
import { POSTMAN_ENDPOINT_PROFILES } from './base-urls.js';
import { getMemoizedSessionIdentity } from './credential-identity.js';
import { adviseFromHttpError, type ErrorAdviceContext } from './error-advice.js';
import type { AccessTokenProvider } from './token-provider.js';
import { postmanAppVersionProvider, type AppVersionProvider } from './app-version.js';
import { normalizeCollectionModelIdentity } from './collection-model-identity.js';

export type InternalIntegrationBackend = 'bifrost';

export interface SpecificationCollectionLink {
  collectionId: string;
  /** Exact local OpenAPI generation options retained on the relation. */
  options?: Record<string, unknown>;
  syncOptions?: {
    syncExamples: boolean;
  };
}

export interface SpecificationCollectionRelation {
  collectionId: string;
  state?: string;
  options?: Record<string, unknown>;
  syncOptions?: Record<string, unknown>;
}

export type FindWorkspaceForRepoResult =
  | { state: 'free' }
  | {
      state: 'linked-visible';
      workspace: { id: string; name: string } & Record<string, unknown>;
    }
  | { state: 'linked-invisible'; workspaceId: string }
  | { state: 'unknown'; reason: string };

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
  /** Injectable delay for lock-retry loops (tests). Defaults to setTimeout. */
  sleep?: (delayMs: number) => Promise<void>;
  teamId: string;
  appVersionProvider?: AppVersionProvider;
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
  /**
   * Probe whether `(repoUrl, path)` already owns a Bifrost filesystem link.
   * Never throws for probe/transport failures — returns `{ state: 'unknown' }`
   * so onboarding can proceed with existing workspace selection.
   */
  findWorkspaceForRepo(
    repoUrl: string,
    path?: string
  ): Promise<FindWorkspaceForRepoResult>;
  linkCollectionsToSpecification(
    specificationId: string,
    collections: SpecificationCollectionLink[]
  ): Promise<{ lockedRetries: number }>;
  listSpecificationCollectionRelations?(
    specificationId: string
  ): Promise<SpecificationCollectionRelation[]>;
  /**
   * Read-only bounded wait after link PUT: poll relation GET until the exact
   * expected collection IDs exist with recognized state (`in-sync` or
   * `out-of-sync`) and options/syncOptions objects. Never calls Spec Hub
   * collection sync and never retries the link write.
   */
  settleSpecificationCollectionRelations?(
    specificationId: string,
    expectedCollectionIds: string[]
  ): Promise<{ relations: SpecificationCollectionRelation[]; attempts: number }>;
  syncCollection(
    specificationId: string,
    collectionId: string
  ): Promise<void>;
}

class BifrostInternalIntegrationAdapter implements InternalIntegrationAdapter {
  /** Per-request wall-clock deadline (ms) so a hung Bifrost proxy aborts rather
   * than blocking the run forever. */
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  /** Concurrent dual-trigger previews share one spec; peer sync holds a 423 lock. */
  private static readonly SYNC_LOCKED_MAX_RETRIES = 6;
  /** Post-link relation readback: GET-only polls until expected IDs propagate. */
  private static readonly RELATION_SETTLE_MAX_ATTEMPTS = 12;
  private static readonly RELATION_SETTLE_DELAY_MS = 1000;
  /** Durable local-import link states; Spec Hub sync is forbidden on this path. */
  private static readonly RECOGNIZED_RELATION_STATES = new Set(['in-sync', 'out-of-sync']);

  private readonly accessToken: string;
  private readonly tokenProvider?: AccessTokenProvider;
  private readonly appVersionProvider: AppVersionProvider;
  private readonly bifrostBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly gatewayBaseUrl: string;
  private orgMode: boolean;
  private readonly secretMasker: SecretMasker;
  private readonly sleep: (delayMs: number) => Promise<void>;
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
    this.sleep =
      options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.teamId = String(options.teamId || '').trim();
    this.appVersionProvider = options.appVersionProvider ?? postmanAppVersionProvider;
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

  /**
   * fetch with a wall-clock deadline. A slow/hung proxy aborts instead of
   * blocking the run forever; callers surface the abort like any other transport
   * rejection.
   */
  private async fetchWithDeadline(
    input: Parameters<typeof fetch>[0],
    init: RequestInit = {}
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BifrostInternalIntegrationAdapter.REQUEST_TIMEOUT_MS
    );
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async proxyRequest(
    service: string,
    method: string,
    requestPath: string,
    body?: unknown,
    options: { query?: Record<string, unknown> } = {}
  ): Promise<Response> {
    const url = `${this.bifrostBaseUrl}/ws/proxy`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-access-token': this.currentToken()
    };
    const appVersion = await this.appVersionProvider.resolve();
    if (appVersion) {
      headers['x-app-version'] = appVersion;
    }
    if (this.teamId && this.orgMode) {
      headers['x-entity-team-id'] = this.teamId;
    }

    return this.fetchWithDeadline(url, {
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

    const listResponse = await this.proxyRequest(
      'ruleset',
      'get',
      '/configure/workspace-groups',
      undefined,
      { query: { tag: 'governance' } }
    );

    if (!listResponse.ok) {
      const httpErr = await HttpError.fromResponse(listResponse, {
        method: 'GET',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.currentToken(),
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
      }
    );

    if (!patchResponse.ok) {
      const httpErr = await HttpError.fromResponse(patchResponse, {
        method: 'PATCH',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.currentToken(),
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
        const linkedClause = linkedUrl
          ? `already linked to ${linkedUrl}`
          : 'already linked to a different repository';
        throw new Error(
          this.secretMasker(
            `Cannot link repository ${repoUrl} to workspace ${workspaceId}: Bifrost uniqueness conflict — that workspace is ${linkedClause}. Disconnect the existing repository link from that workspace or use the intended repository/workspace, then rerun.`
          ).replace(/[\r\n\u2028\u2029]+/g, ' ')
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

  async findWorkspaceForRepo(
    repoUrl: string,
    path = '/'
  ): Promise<FindWorkspaceForRepoResult> {
    const encodedRepo = encodeURIComponent(repoUrl);
    const encodedPath = encodeURIComponent(path);
    const requestPath = `/workspaces/filesystem?repo=${encodedRepo}&path=${encodedPath}`;

    let response: Response;
    try {
      response = await this.proxyRequest('workspaces', 'GET', requestPath);
    } catch (error) {
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : String(error)
      };
    }

    type FilesystemProbeBody = {
      data?: unknown;
      error?: { meta?: { workspaceId?: unknown }; status?: unknown };
      meta?: { workspaceId?: unknown };
    };
    let parsed: FilesystemProbeBody | null = null;
    if (bodyText.trim()) {
      try {
        parsed = JSON.parse(bodyText) as FilesystemProbeBody;
      } catch (error) {
        return {
          state: 'unknown',
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    }

    // Bifrost may wrap an invisible-owner envelope in an outer HTTP 200 body.
    // Detect this concrete owner-bearing shape before any 200 data/free
    // classification so admission fails closed instead of treating it as unknown.
    const wrappedInvisibleWorkspaceIdRaw = parsed?.error?.meta?.workspaceId;
    const wrappedInvisibleWorkspaceId =
      typeof wrappedInvisibleWorkspaceIdRaw === 'string'
        ? wrappedInvisibleWorkspaceIdRaw.trim()
        : '';
    if (wrappedInvisibleWorkspaceId) {
      return { state: 'linked-invisible', workspaceId: wrappedInvisibleWorkspaceId };
    }

    // The filesystem contract distinguishes only a successful 200 lookup.
    // Do not treat another 2xx response (or an empty 200 body) as an
    // unambiguously free link; proceeding on an ambiguous probe is safe, but
    // reporting it as free would lose the diagnostic distinction.
    if (response.status === 200) {
      if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'data')) {
        return {
          state: 'unknown',
          reason: 'Filesystem probe returned 200 without a data payload'
        };
      }
      const data = parsed?.data ?? null;
      if (data == null) {
        return { state: 'free' };
      }
      if (typeof data === 'object' && !Array.isArray(data)) {
        const workspace = data as Record<string, unknown>;
        const id = typeof workspace.id === 'string' ? workspace.id.trim() : '';
        if (id) {
          const name = typeof workspace.name === 'string' ? workspace.name : '';
          return {
            state: 'linked-visible',
            workspace: { ...workspace, id, name }
          };
        }
      }
      return {
        state: 'unknown',
        reason: 'Filesystem probe returned 200 with unrecognized workspace payload'
      };
    }

    if (response.status === 403) {
      const workspaceIdRaw =
        parsed?.error?.meta?.workspaceId ?? parsed?.meta?.workspaceId;
      const workspaceId =
        typeof workspaceIdRaw === 'string' ? workspaceIdRaw.trim() : '';
      if (workspaceId) {
        return { state: 'linked-invisible', workspaceId };
      }
      return {
        state: 'unknown',
        reason: 'Filesystem probe returned 403 without error.meta.workspaceId'
      };
    }

    return {
      state: 'unknown',
      reason: `Filesystem probe returned HTTP ${response.status}`
    };
  }

  async linkCollectionsToSpecification(
    specificationId: string,
    collections: SpecificationCollectionLink[]
  ): Promise<{ lockedRetries: number }> {
    if (collections.length === 0) {
      return { lockedRetries: 0 };
    }

    const body = collections.map((collection) => ({
      collectionId: collection.collectionId,
      ...(collection.options ? { options: collection.options } : {}),
      ...(collection.syncOptions ? { syncOptions: collection.syncOptions } : {})
    }));

    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      const response = await this.proxyRequest(
        'specification',
        'put',
        `/specifications/${specificationId}/collections`,
        body
      );

      if (response.ok) {
        return { lockedRetries: lockedAttempt };
      }

      const httpErr = await HttpError.fromResponse(response, {
        method: 'PUT',
        requestHeaders: {
          'Content-Type': 'application/json',
          'x-access-token': this.currentToken(),
          ...(this.teamId && this.orgMode ? { 'x-entity-team-id': this.teamId } : {})
        },
        secretValues: [this.currentToken()],
        url: `${this.bifrostBaseUrl}/ws/proxy`
      });

      if (
        httpErr.status === 423 &&
        lockedAttempt < BifrostInternalIntegrationAdapter.SYNC_LOCKED_MAX_RETRIES
      ) {
        await this.sleep(2000 * Math.pow(2, lockedAttempt));
        continue;
      }

      const advised = adviseFromHttpError(
        httpErr,
        this.adviceContext('collection-to-specification linking')
      );
      throw advised ?? httpErr;
    }
  }

  async listSpecificationCollectionRelations(
    specificationId: string
  ): Promise<SpecificationCollectionRelation[]> {
    const response = await this.proxyRequest(
      'specification',
      'get',
      `/specifications/${specificationId}/collections`,
      undefined,
      { query: { fields: 'syncOptions,options' } }
    );
    if (!response.ok) {
      const httpErr = await HttpError.fromResponse(response, {
        method: 'GET',
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
        this.adviceContext('specification collection relation readback')
      );
      throw advised ?? httpErr;
    }
    const json = (await response.json().catch(() => null)) as
      | { data?: unknown }
      | null;
    const rows = Array.isArray(json?.data) ? json.data : [];
    const out: SpecificationCollectionRelation[] = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const collectionId = String(
        record.collection ?? record.collectionId ?? record.id ?? record.uid ?? ''
      ).trim();
      if (!collectionId) continue;
      const options =
        record.options && typeof record.options === 'object' && !Array.isArray(record.options)
          ? (record.options as Record<string, unknown>)
          : undefined;
      const syncOptions =
        record.syncOptions &&
        typeof record.syncOptions === 'object' &&
        !Array.isArray(record.syncOptions)
          ? (record.syncOptions as Record<string, unknown>)
          : undefined;
      out.push({
        collectionId,
        ...(typeof record.state === 'string' ? { state: record.state } : {}),
        ...(options ? { options } : {}),
        ...(syncOptions ? { syncOptions } : {})
      });
    }
    return out;
  }

  async settleSpecificationCollectionRelations(
    specificationId: string,
    expectedCollectionIds: string[]
  ): Promise<{ relations: SpecificationCollectionRelation[]; attempts: number }> {
    const expected = [...new Set(expectedCollectionIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (expected.length === 0) {
      throw new Error(
        'LOCAL_OPENAPI_LINK_READBACK_FAILED: relation settle requires at least one expected collection id'
      );
    }
    const expectedByIdentity = new Map<string, string>();
    for (const id of expected) {
      const identity = normalizeCollectionModelIdentity(id);
      const prior = expectedByIdentity.get(identity);
      if (prior && prior !== id) {
        throw new Error(
          `LOCAL_OPENAPI_LINK_READBACK_FAILED: expected collection identity collision; ids=${prior},${id}`
        );
      }
      expectedByIdentity.set(identity, id);
    }

    const formatObserved = (relations: SpecificationCollectionRelation[]): string =>
      expected
        .map((id) => {
          const identity = normalizeCollectionModelIdentity(id);
          const candidates = relations.filter(
            (entry) => normalizeCollectionModelIdentity(entry.collectionId) === identity
          );
          const row = candidates.find((entry) => entry.collectionId === id) ?? candidates[0];
          if (!row) return `${id}:missing`;
          const state = row.state || '<empty>';
          const options = row.options && typeof row.options === 'object' && !Array.isArray(row.options)
            ? 'options'
            : 'options-missing';
          const syncOptions =
            row.syncOptions && typeof row.syncOptions === 'object' && !Array.isArray(row.syncOptions)
              ? 'syncOptions'
              : 'syncOptions-missing';
          return `${id}:${state}/${options}/${syncOptions}`;
        })
        .join(',');

    const isCompleteRelation = (row: SpecificationCollectionRelation | undefined): boolean => {
      if (!row) return false;
      if (!BifrostInternalIntegrationAdapter.RECOGNIZED_RELATION_STATES.has(String(row.state || ''))) {
        return false;
      }
      if (!row.options || typeof row.options !== 'object' || Array.isArray(row.options)) return false;
      if (!row.syncOptions || typeof row.syncOptions !== 'object' || Array.isArray(row.syncOptions)) {
        return false;
      }
      return true;
    };

    let lastRelations: SpecificationCollectionRelation[] = [];
    for (
      let attempt = 1;
      attempt <= BifrostInternalIntegrationAdapter.RELATION_SETTLE_MAX_ATTEMPTS;
      attempt += 1
    ) {
      if (attempt > 1) {
        await this.sleep(BifrostInternalIntegrationAdapter.RELATION_SETTLE_DELAY_MS);
      }
      lastRelations = await this.listSpecificationCollectionRelations(specificationId);
      const byId = new Map<string, SpecificationCollectionRelation>();
      for (const [identity, expectedId] of expectedByIdentity) {
        const candidates = lastRelations.filter(
          (row) => normalizeCollectionModelIdentity(row.collectionId) === identity
        );
        if (candidates.length > 1) {
          throw new Error(
            `LOCAL_OPENAPI_LINK_READBACK_FAILED: observed collection identity collision; id=${expectedId}`
          );
        }
        const row = candidates.find((candidate) => candidate.collectionId === expectedId) ?? candidates[0];
        if (row) byId.set(expectedId, row);
      }

      // Fail closed immediately on present-but-invalid rows (unknown/error state
      // or missing options objects). Keep polling only for missing propagation.
      for (const id of expected) {
        const row = byId.get(id);
        if (!row) continue;
        const state = String(row.state || '');
        if (!BifrostInternalIntegrationAdapter.RECOGNIZED_RELATION_STATES.has(state)) {
          throw new Error(
            `LOCAL_OPENAPI_LINK_READBACK_FAILED: unrecognized relation state; ids=${expected.join(',')} states=${formatObserved(lastRelations)}`
          );
        }
        if (!isCompleteRelation(row)) {
          throw new Error(
            `LOCAL_OPENAPI_LINK_READBACK_FAILED: relation fields incomplete; ids=${expected.join(',')} states=${formatObserved(lastRelations)}`
          );
        }
      }

      if (expected.every((id) => isCompleteRelation(byId.get(id)))) {
        return {
          relations: expected.map((id) => ({ ...byId.get(id)!, collectionId: id })),
          attempts: attempt
        };
      }
    }

    throw new Error(
      `LOCAL_OPENAPI_LINK_READBACK_FAILED: relation settle timed out after ${BifrostInternalIntegrationAdapter.RELATION_SETTLE_MAX_ATTEMPTS} attempts; ids=${expected.join(',')} states=${formatObserved(lastRelations)}`
    );
  }

  async syncCollection(
    specificationId: string,
    collectionId: string
  ): Promise<void> {
    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      const response = await this.proxyRequest(
        'specification',
        'post',
        `/specifications/${specificationId}/collections/${collectionId}/sync`
      );

      if (response.ok) {
        return;
      }

      const bodyText = await response.clone().text().catch(() => '');
      // Peer dual-trigger already finished sync for this collection. Treat as
      // success so concurrent preview runners converge without failing.
      if (
        response.status === 400 && /already in sync/i.test(bodyText)
      ) {
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

      // A per-spec lock does not prove this collection's sync was accepted.
      // Retry every 423 until this request succeeds or the bounded budget ends.
      if (
        httpErr.status === 423 &&
        lockedAttempt < BifrostInternalIntegrationAdapter.SYNC_LOCKED_MAX_RETRIES
      ) {
        await this.sleep(2000 * Math.pow(2, lockedAttempt));
        continue;
      }

      const advised = adviseFromHttpError(httpErr, this.adviceContext('collection sync'));
      throw advised ?? httpErr;
    }
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
