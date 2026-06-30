import { HttpError } from '../http-error.js';
import { AccessTokenGatewayClient } from './gateway-client.js';
import { normalizeGitRepoUrl } from './postman-assets-client.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

/** Pull the git repo URL out of a Bifrost filesystem payload (mirrors the PMAK client). */
function extractGitRepoUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const normalized = normalizeGitRepoUrl(value);
    return /^https:\/\/[^/]+\/[^/]+\/[^/]+$/.test(normalized) ? normalized : null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const repoUrl = extractGitRepoUrl(entry);
      if (repoUrl) return repoUrl;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ['repo', 'repository', 'repoUrl', 'repo_url', 'remoteUrl', 'remote_url', 'origin']) {
    const repoUrl = extractGitRepoUrl(record[key]);
    if (repoUrl) return repoUrl;
  }
  for (const nested of Object.values(record)) {
    const repoUrl = extractGitRepoUrl(nested);
    if (repoUrl) return repoUrl;
  }
  return null;
}

export interface PostmanGatewayAssetsClientOptions {
  gateway: AccessTokenGatewayClient;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Access-token-primary asset client over {@link AccessTokenGatewayClient}.
 *
 * Implements only the routes proven against the live gateway (scripts/live-gateway-probe.ts):
 * the OpenAPI spec lifecycle (create, get, generate-collection + task poll) and
 * workspace reads (visibility, list/find, git repo url). All of these answer the
 * Postman app `{meta, data}` envelope through the proxy. Operations the gateway
 * rejects (workspace create/visibility-PUT, spec file update, collection CRUD /
 * tagging / injectTests for spec-generated collection uids) are intentionally
 * absent so the routing facade falls back to the PMAK {@link PostmanAssetsClient}
 * for them, per the migration's no-regression contract.
 *
 * Method signatures mirror PostmanAssetsClient so the facade can prefer this
 * client per method and fall back to PMAK transparently.
 */
export class PostmanGatewayAssetsClient {
  private static readonly GENERATION_LOCKED_MAX_RETRIES = 5;
  private static readonly GENERATION_POLL_ATTEMPTS = 45;
  private static readonly GENERATION_POLL_DELAY_MS = 2000;

  private readonly gateway: AccessTokenGatewayClient;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: PostmanGatewayAssetsClientOptions) {
    this.gateway = options.gateway;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.gateway.configureTeamContext(teamId, orgMode);
  }

  /**
   * Create an OpenAPI spec in Spec Hub via the gateway specification service.
   * Verified shape: POST /specifications?containerType=workspace&containerId=:ws
   * with a file-level `type: 'ROOT'` (the gateway rejects the create otherwise).
   * Returns the new spec id; preflights a GET so callers can immediately generate.
   */
  async uploadSpec(
    workspaceId: string,
    projectName: string,
    specContent: string,
    openapiVersion: '3.0' | '3.1' | string = '3.0'
  ): Promise<string> {
    if (openapiVersion !== '3.0' && openapiVersion !== '3.1') {
      throw new Error(`uploadSpec: unsupported openapiVersion "${openapiVersion}". Expected '3.0' or '3.1'.`);
    }
    const specType = openapiVersion === '3.1' ? 'OPENAPI:3.1' : 'OPENAPI:3.0';
    const created = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'post',
      path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
      body: {
        name: projectName,
        type: specType,
        files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }]
      }
    });
    const specId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
    if (!specId) {
      throw new Error('Spec upload did not return an ID');
    }
    // Preflight the read so a generate immediately after create does not race.
    await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}`
    });
    return specId;
  }

  /**
   * Generate a collection from a spec and return its uid. Mirrors the PMAK
   * semantics: 423-locked retry on the create, then poll the async task to
   * completion and resolve the generated collection uid from the spec's
   * collection list (`data[].collection`).
   */
  async generateCollection(
    specId: string,
    projectName: string,
    prefix: string,
    folderStrategy: string,
    nestedFolderHierarchy: boolean,
    requestNameSource: string
  ): Promise<string> {
    const name = [prefix.trim(), projectName.trim()].filter(Boolean).join(' ');
    const body = {
      name,
      options: {
        requestNameSource,
        folderStrategy,
        ...(folderStrategy === 'Tags' ? { nestedFolderHierarchy } : {})
      }
    };

    const taskId = await this.postGenerationWithLockRetry(specId, body);

    if (taskId) {
      for (let attempt = 0; attempt < PostmanGatewayAssetsClient.GENERATION_POLL_ATTEMPTS; attempt += 1) {
        await this.sleep(PostmanGatewayAssetsClient.GENERATION_POLL_DELAY_MS);
        const task = await this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'get',
          path: '/tasks',
          query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
        });
        const status = String(asRecord(task?.data)?.[taskId] ?? '').toLowerCase();
        if (status === 'failed' || status === 'error') {
          throw new Error(`Collection generation task failed for ${prefix}`);
        }
        if (status && status !== 'in-progress' && status !== 'pending' && status !== 'queued') {
          break;
        }
        if (attempt === PostmanGatewayAssetsClient.GENERATION_POLL_ATTEMPTS - 1) {
          throw new Error(`Collection generation timed out for ${prefix}`);
        }
      }
    }

    const uid = await this.resolveGeneratedCollectionUid(specId);
    if (!uid) {
      throw new Error(`Collection generation did not yield a collection uid for ${prefix}`);
    }
    return uid;
  }

  /** POST the generation request, retrying a 423-locked spec; returns the task id. */
  private async postGenerationWithLockRetry(specId: string, body: unknown): Promise<string> {
    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      try {
        const created = await this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'post',
          path: `/specifications/${specId}/collections`,
          body
        });
        return String(asRecord(created?.data)?.taskId ?? '').trim();
      } catch (error) {
        const locked = error instanceof HttpError && error.status === 423;
        if (!locked || lockedAttempt >= PostmanGatewayAssetsClient.GENERATION_LOCKED_MAX_RETRIES) {
          throw error;
        }
        await this.sleep(5000 * Math.pow(2, lockedAttempt));
      }
    }
  }

  /** Most-recent generated collection uid for a spec, via the spec's collection list. */
  private async resolveGeneratedCollectionUid(specId: string): Promise<string> {
    const list = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}/collections`
    });
    const entries = Array.isArray(asRecord(list)?.data) ? (asRecord(list)!.data as unknown[]) : [];
    // Newest last: prefer the final entry's collection uid.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = asRecord(entries[i]);
      const uid = String(entry?.collection ?? entry?.collectionId ?? entry?.id ?? entry?.uid ?? '').trim();
      if (uid) return uid;
    }
    return '';
  }

  /**
   * Create a team-visible workspace through the gateway workspaces service.
   *
   * The gateway rejects a direct team/public create ("role not configured"); the
   * verified path (live probe, 2026-06-30) is create at PERSONAL visibility then
   * flip to TEAM via the /visibility subpath, which assigns the default role
   * server-side. `about`/`targetTeamId` are accepted for signature parity with the
   * PMAK client but are not part of the gateway create body.
   *
   * Authoritative + self-cleaning: if the create succeeds but the flip cannot be
   * verified, the just-created workspace is deleted before throwing, so the
   * facade's PMAK fallback never double-creates and no personal-visibility
   * workspace is leaked. A failure of the create step itself throws before any
   * workspace exists, so fallback is safe.
   */
  async createWorkspace(name: string, _about: string, _targetTeamId?: number): Promise<{ id: string }> {
    void _about;
    void _targetTeamId;
    const created = await this.gateway.requestJson<JsonRecord>({
      service: 'workspaces',
      method: 'post',
      path: '/workspaces',
      body: { name, visibilityStatus: 'personal' }
    });
    const workspaceId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
    if (!workspaceId) {
      throw new Error('Workspace create did not return an id');
    }

    try {
      await this.setWorkspaceVisibility(workspaceId, 'team');
      const visibility = await this.getWorkspaceVisibility(workspaceId);
      if (visibility !== 'team') {
        throw new Error(
          `Workspace ${workspaceId} was created but could not be promoted to team visibility (got '${visibility ?? 'unknown'}').`
        );
      }
    } catch (error) {
      await this.deleteWorkspace(workspaceId).catch(() => undefined);
      throw error;
    }

    return { id: workspaceId };
  }

  /**
   * Flip a workspace's visibility through the gateway. Verified shape: PUT
   * /workspaces/:id/visibility with a bare { visibilityStatus } body (the gateway
   * rejects PUT /workspaces/:id outright). The default role is assigned
   * server-side when promoting to team visibility.
   */
  async setWorkspaceVisibility(workspaceId: string, visibility: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'workspaces',
      method: 'put',
      path: `/workspaces/${workspaceId}/visibility`,
      body: { visibilityStatus: visibility }
    });
  }

  /** Delete a workspace through the gateway (used for create-failure cleanup). */
  private async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'workspaces',
      method: 'delete',
      path: `/workspaces/${workspaceId}`
    });
  }

  /** Visibility of a workspace as the access token sees it, or null when unreadable. */
  async getWorkspaceVisibility(workspaceId: string): Promise<string | null> {
    try {
      const response = await this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'get',
        path: `/workspaces/${workspaceId}`
      });
      const data = asRecord(response?.data) ?? asRecord(response?.workspace) ?? asRecord(response);
      const visibility = data?.visibility ?? data?.visibilityStatus;
      return typeof visibility === 'string' ? visibility : null;
    } catch {
      return null;
    }
  }

  async findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>> {
    const all: JsonRecord[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'get',
        path: '/workspaces',
        ...(cursor ? { query: { cursor } } : {})
      });
      const data = asRecord(response);
      const page = Array.isArray(data?.data)
        ? (data!.data as unknown[])
        : Array.isArray(data?.workspaces)
          ? (data!.workspaces as unknown[])
          : [];
      for (const entry of page) {
        const record = asRecord(entry);
        if (record?.id && record?.name) all.push(record);
      }
      const meta = asRecord(data?.meta);
      const next = String(meta?.nextCursor ?? data?.nextCursor ?? '').trim();
      cursor = next && !seenCursors.has(next) ? next : undefined;
      if (cursor) seenCursors.add(cursor);
    } while (cursor);

    return all
      .filter((w) => String(w.name) === name)
      .map((w) => ({ id: String(w.id), name: String(w.name) }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Git repo URL linked to a workspace via the Bifrost filesystem route. The
   * teamId/accessToken parameters are accepted for signature parity with the PMAK
   * client (the gateway client carries auth + team context internally).
   */
  async getWorkspaceGitRepoUrl(
    workspaceId: string,
    _teamId?: string,
    _accessToken?: string
  ): Promise<string | null> {
    void _teamId;
    void _accessToken;
    try {
      const response = await this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'get',
        path: `/workspaces/${workspaceId}/filesystem`
      });
      const data = asRecord(response)?.data ?? response;
      return extractGitRepoUrl(data);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
  }
}
