import * as V2 from '@postman/runtime.models/v2';
import { transform, FormatVersion } from '@postman/runtime.models/transforms';

import { HttpError } from '../http-error.js';
import { getMemoizedSessionIdentity } from './credential-identity.js';
import { WORKSPACE_PERSONAL_ONLY_ADVICE } from './error-advice.js';
import { AccessTokenGatewayClient } from './gateway-client.js';
import { normalizeGitRepoUrl } from './git-url.js';
import {
  assertSupportedLocalViewContract,
  normalizeLocalViewScriptType
} from './local-view-contract.js';
import { planContractItemScripts } from '../spec/collection-contracts.js';
import type { ContractIndex } from '../spec/contract-index.js';

function asItemArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

/**
 * Resolve a poll-budget number from an explicit option, then an env override,
 * then the default. Non-numeric or below-`min` values fall through so a stray
 * env value can never zero out or invert a production budget.
 */
function resolvePollBudget(
  explicit: number | undefined,
  envValue: string | undefined,
  fallback: number,
  min: number
): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= min) return explicit;
  if (envValue !== undefined) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed >= min) return parsed;
  }
  return fallback;
}

/**
 * The non-org create path POSTs a personal workspace then flips it to team
 * visibility. That flip 403s when the account cannot promote workspaces to
 * team visibility: org service accounts (`addWorkspaceLevelTeamRoles` /
 * "You are not authorized"), and members whose team policy restricts
 * team-visible workspace creation ("You do not have permission to update
 * visibility to team", live-seen on an enterprise team). Rewrite those 403s
 * into the definitive guidance (set workspace-team-id / fix the member's role)
 * so the fix is obvious instead of a raw gateway 403. Any other error passes
 * through unchanged (the non-org flip succeeds on real non-org accounts, so
 * this never fires there).
 */
function adviseWorkspaceFlipForbidden(error: unknown): unknown {
  if (error instanceof HttpError && error.status === 403) {
    const body = error.responseBody || '';
    if (
      /addWorkspaceLevelTeamRoles/i.test(body) ||
      /You are not authorized to perform this action/i.test(body) ||
      /permission to update visibility to team/i.test(body)
    ) {
      return new Error(WORKSPACE_PERSONAL_ONLY_ADVICE, { cause: error });
    }
  }
  return error;
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
  // Generation task poll budget. Defaults hold the live-proven production values
  // (90 attempts x 2000ms ~= 180s). Overridable so the e2e smoke path can shrink
  // the wait without weakening resilience for real onboarding runs; also read
  // from POSTMAN_GENERATION_POLL_ATTEMPTS / POSTMAN_GENERATION_POLL_DELAY_MS when
  // the options are not passed explicitly.
  generationPollAttempts?: number;
  generationPollDelayMs?: number;
}

/**
 * Access-token-primary asset client over {@link AccessTokenGatewayClient}.
 *
 * Implements only the routes proven against the live gateway (scripts/live-gateway-probe.ts):
 * the OpenAPI spec lifecycle (create, get, generate-collection + task poll),
 * workspace reads (visibility, list/find, git repo url), and sub-team (squad)
 * enumeration over the `ums` service. All of these use the app's `{meta, data}`
 * envelope through the proxy.
 *
 * Method signatures mirror the retired PMAK assets client surface so the facade can prefer this
 * client per method and fall back to PMAK transparently.
 */
export class PostmanGatewayAssetsClient {
  private static readonly GENERATION_LOCKED_MAX_RETRIES = 5;
  private static readonly DEFAULT_GENERATION_POLL_ATTEMPTS = 90;
  private static readonly DEFAULT_GENERATION_POLL_DELAY_MS = 2000;

  private readonly gateway: AccessTokenGatewayClient;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly generationPollAttempts: number;
  private readonly generationPollDelayMs: number;

  constructor(options: PostmanGatewayAssetsClientOptions) {
    this.gateway = options.gateway;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.generationPollAttempts = resolvePollBudget(
      options.generationPollAttempts,
      process.env.POSTMAN_GENERATION_POLL_ATTEMPTS,
      PostmanGatewayAssetsClient.DEFAULT_GENERATION_POLL_ATTEMPTS,
      1
    );
    this.generationPollDelayMs = resolvePollBudget(
      options.generationPollDelayMs,
      process.env.POSTMAN_GENERATION_POLL_DELAY_MS,
      PostmanGatewayAssetsClient.DEFAULT_GENERATION_POLL_DELAY_MS,
      0
    );
  }

  configureTeamContext(teamId: string, orgMode: boolean): void {
    this.gateway.configureTeamContext(teamId, orgMode);
  }

  /**
   * Enumerate the account's sub-teams (squads) over the access-token gateway,
   * replacing the PMAK `GET /teams`. The org id is the session's team
   * (`/api/sessions/current`, memoized by the credential preflight); the squad
   * list comes from `ums GET /api/teams/:orgTeamId/squads?settings=true&userRoles=true`
   * → `{ data:[{ id, name, handle, organizationId, … }] }`. Each squad carries
   * `organizationId`, so the caller's `teams.some(t => t.organizationId != null)`
   * org-mode test works unchanged. Non-org accounts get `400 "Squad feature is not
   * available"` (live-proven, team 10490519) → resolved as `[]` (not org-mode).
   * PMAK is never consulted (reserved for token mint + CLI login).
   */
  async getTeams(): Promise<Array<{ id: number; name: string; handle: string; organizationId?: number }>> {
    const orgTeamId = getMemoizedSessionIdentity()?.teamId;
    if (!orgTeamId) return [];
    try {
      const res = await this.gateway.requestJson<JsonRecord>({
        service: 'ums',
        method: 'get',
        path: `/api/teams/${orgTeamId}/squads?settings=true&userRoles=true`
      });
      const list = Array.isArray(res?.data) ? (res.data as JsonRecord[]) : [];
      return list
        .filter((s) => s?.id != null && s?.name != null)
        .map((s) => ({
          id: Number(s.id),
          name: String(s.name),
          handle: String(s.handle ?? ''),
          ...(s.organizationId != null ? { organizationId: Number(s.organizationId) } : {})
        }));
    } catch {
      // 400 "Squad feature is not available" (non-org) or any read failure: no
      // squads to report, so the account is treated as non-org.
      return [];
    }
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
   * Update a spec's root file content through the gateway (no PMAK):
   *   1. `GET /specifications/:id/files` → find the `type:'ROOT'` file's uuid id.
   *   2. `PATCH /specifications/:id/files/:fileId` with the RFC6902 JSON-Patch
   *      `[{op:'replace', path:'/content', value:specContent}]` → `200`.
   * The v2 `{content}` body and a path-as-fileId both 400 (live-proven); the
   * fileId must be the uuid from the files list, and the body must be the
   * JSON-Patch. `workspaceId` is accepted for signature parity (unused — the spec
   * id already scopes the file). Persistence is confirmed via the public files
   * read (the gateway GET-by-id returns metadata only, no content).
   */
  async updateSpec(specId: string, specContent: string, _workspaceId?: string): Promise<void> {
    void _workspaceId;
    const fileId = await this.resolveRootFileId(specId);
    if (!fileId) {
      throw new Error(`updateSpec: could not resolve a root file id for specification ${specId}`);
    }
    await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'patch',
      path: `/specifications/${specId}/files/${fileId}`,
      body: [{ op: 'replace', path: '/content', value: specContent }]
    });
  }

  /**
   * Read a spec's root file content through the gateway (no PMAK). Mirrors the
   * reference `SpecificationService.fetchFile` content read: the content is
   * served only when requested via the `fields` query param
   * (`GET /specifications/:id/files/:fileId?fields=content` → `{ content, id }`);
   * a bare GET-by-id returns metadata only. Returns undefined when the file or
   * content cannot be resolved (mirrors the PMAK client's tolerant contract).
   */
  async getSpecContent(specId: string): Promise<string | undefined> {
    try {
      const fileId = await this.resolveRootFileId(specId);
      if (!fileId) return undefined;
      const file = await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'get',
        path: `/specifications/${specId}/files/${fileId}`,
        query: { fields: 'content' }
      });
      const content = asRecord(file?.data)?.content ?? file?.content;
      return typeof content === 'string' ? content : undefined;
    } catch {
      return undefined;
    }
  }

  /** Resolve a specification's ROOT file uuid via the files list. */
  private async resolveRootFileId(specId: string): Promise<string> {
    const files = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}/files`
    });
    const list = Array.isArray(files?.data)
      ? (files!.data as JsonRecord[])
      : Array.isArray(asRecord(files?.data)?.files)
        ? (asRecord(files!.data)!.files as JsonRecord[])
        : [];
    const root = list.find((f) => String(f.type ?? '') === 'ROOT') ?? list[0];
    return String(root?.id ?? '').trim();
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
      for (let attempt = 0; attempt < this.generationPollAttempts; attempt += 1) {
        await this.sleep(this.generationPollDelayMs);
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
        if (attempt === this.generationPollAttempts - 1) {
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
   * Org-mode accounts (when `targetTeamId` is the resolved sub-team/squad id):
   * POST a single team-visible workspace with `squad` + group roles — the reference
   * app shape from WorkspaceService.createDraftWorkspace. The personal→team flip
   * 403s for org service accounts (`addWorkspaceLevelTeamRoles`).
   *
   * Non-org accounts: create at PERSONAL visibility then flip to TEAM via the
   * /visibility subpath (live-proven on team 10490519). `about` is accepted for
   * signature parity with the PMAK client but is not part of the gateway body.
   *
   * Self-cleaning: if create succeeds but team visibility cannot be verified, the
   * just-created workspace is deleted before throwing.
   */
  async createWorkspace(name: string, _about: string, targetTeamId?: number): Promise<{ id: string }> {
    void _about;

    if (targetTeamId != null) {
      const squadId = String(targetTeamId);
      this.configureTeamContext(squadId, true);
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'post',
        path: '/workspaces',
        body: {
          name,
          visibilityStatus: 'team',
          squad: squadId,
          roles: {
            group: { [squadId]: ['WORKSPACE_VIEWER_V9'] }
          }
        }
      });
      const workspaceId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
      if (!workspaceId) {
        throw new Error('Workspace create did not return an id');
      }

      const visibility = await this.getWorkspaceVisibility(workspaceId);
      if (visibility !== 'team') {
        await this.deleteWorkspace(workspaceId).catch(() => undefined);
        throw new Error(
          `Workspace ${workspaceId} was created but team visibility could not be verified (got '${visibility ?? 'unknown'}').`
        );
      }

      return { id: workspaceId };
    }

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
      throw adviseWorkspaceFlipForbidden(error);
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

  // --- collection v3 mutation + tagging (live-proven 2026-06-30; see docs/REST-to-gateway.md) ---
  //
  // These retire bootstrap's last asset-op PMAK dependencies. The gateway keys
  // the v3 collection-items surface on the BARE model id (strip the `<owner>-`
  // prefix) with a trailing slash; the tagging service is distinct from the
  // collection service and takes the FULL uid.

  /** `<owner>-<uuid>` public uid -> bare `<uuid>` model id (the v3 items surface keys on it). */
  private bareModelId(uid: string): string {
    const u = String(uid ?? '').trim();
    return u.includes('-') ? u.slice(u.indexOf('-') + 1) : u;
  }

  /**
   * PATCH a freshly-created item's `/scripts`, tolerating the two transient
   * failures this immediate-after-create write is prone to on the shared gateway:
   *   - `404 RESOURCE_NOT_FOUND` — the create write returns the assigned id, but
   *     an immediate PATCH can hit a replica that has not yet observed the create
   *     (read-after-write lag, live-observed on org-mode teams).
   *   - a downstream `5xx` (e.g. `500 ESOCKETTIMEDOUT`) — a Bifrost/gateway read
   *     timeout, not a durable rejection.
   * `op:add /scripts` is idempotent (overwrites), so retrying either is safe.
   * This is a deeper, longer-backoff budget than the gateway client's inner
   * transient retry, to wait out a longer platform hiccup on this fragile write.
   * Non-transient errors (e.g. 4xx schema rejections) surface immediately.
   */
  private async patchNewItemScripts(
    cid: string,
    itemId: string,
    scripts: JsonRecord[],
    entityType = 'http-request'
  ): Promise<void> {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${cid}/items/${itemId}`,
          headers: { 'X-Entity-Type': entityType },
          body: [{ op: 'add', path: '/scripts', value: scripts }]
        });
        return;
      } catch (error) {
        const retriable = error instanceof HttpError && (error.status === 404 || error.status >= 500);
        if (!retriable || attempt === maxAttempts - 1) {
          throw error;
        }
        await this.sleep(Math.min(2000, 300 * 2 ** attempt));
      }
    }
  }

  /**
   * Apply tag slugs via the dedicated `tagging` service:
   * `PUT /v1/tags/collections/:uid` (full uid), body `{ tags:[{ slug }] }` — the
   * server assigns `type:'default'` (sending `type` is rejected by its schema).
   * Slug normalization mirrors the PMAK client.
   */
  async tagCollection(collectionUid: string, tags: string[]): Promise<void> {
    const normalized = tags
      .map((entry) =>
        String(entry || '')
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '')
      )
      .filter((entry) => /^[a-z][a-z0-9-]*[a-z0-9]$/.test(entry));
    if (normalized.length === 0) {
      throw new Error(`No valid tag slugs to apply for collection ${collectionUid}`);
    }
    await this.gateway.requestJson<JsonRecord>({
      service: 'tagging',
      method: 'put',
      path: `/v1/tags/collections/${collectionUid}`,
      body: { tags: normalized.map((slug) => ({ slug })) }
    });
  }

  /**
   * Inject smoke-test assertions into every leaf request of a spec-generated
   * collection, over the v3 collection-items surface (no PMAK):
   *   1. `GET /v3/collections/:cid/items/` (bare model id, trailing slash) — flat list.
   *   2. for each `http-request` leaf, `PATCH /v3/collections/:cid/items/:itemId`
   *      (full uid for `:itemId`, `X-Entity-Type: http-request` header) with a
   *      JSON-Patch that sets `/scripts` to the canonical v3 shape
   *      (`[{type:'afterResponse', code, language}]`). The v3 surface persists test
   *      scripts under `scripts`, NOT `events`: a `/events` patch returns 200 but is
   *      silently dropped, and a `/scripts/test` or `{test:{exec}}` shape is rejected
   *      (REJECTED_PATCH / SCHEMA_ENFORCED). `listen:'test'` → `type:'afterResponse'`
   *      and the `exec` array is `\n`-joined into `code`
   *      (mirrors `schema-normalize.ts:convertECEventsToV3Scripts`).
   *   3. prepend a `00 - Resolve Secrets` item (idempotent) via
   *      `POST /v3/collections/:cid/items/` with `position.parent` = the collection.
   */
  async injectTests(collectionUid: string, type: 'smoke'): Promise<void> {
    void type;
    const cid = this.bareModelId(collectionUid);
    const listed = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}/items/`
    });
    const items = Array.isArray(listed?.data) ? (listed!.data as JsonRecord[]) : [];

    const smokeTests = [
      '// [Smoke] Auto-generated test assertions',
      '',
      "pm.test('Status code is not an error (2xx or 3xx)', function () {",
      '    // Smoke is a generic liveness check, not a contract: a 3xx redirect is a',
      '    // legitimate non-error response, so assert < 400 rather than strict 2xx.',
      '    pm.expect(pm.response.code, "expected a non-error HTTP status (< 400)").to.be.below(400);',
      '});',
      '',
      "pm.test('Response time is acceptable', function () {",
      "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
      '    pm.expect(pm.response.responseTime).to.be.below(threshold);',
      '});',
      '',
      "pm.test('Response body is not empty', function () {",
      "    var bodyless = pm.response.code === 204 || pm.response.code === 205 || pm.response.code === 304 || pm.request.method === 'HEAD';",
      "    var contentLength = pm.response.headers.get('Content-Length');",
      "    // A legitimate empty-body response (e.g. a 200/201 with Content-Length: 0)",
      '    // must not false-fail this generic smoke check.',
      "    if (contentLength !== null && contentLength !== undefined && String(contentLength).trim() === '0') { return; }",
      '    if (!bodyless) {',
      '        var body = pm.response.text();',
      '        pm.expect(body.length).to.be.above(0);',
      '    }',
      '});'
    ];

    // Canonical v3 item scripts: a single `afterResponse` (test) script with the
    // exec lines joined into `code`.
    const toV3Scripts = (exec: string[]): JsonRecord[] => [
      { type: 'afterResponse', code: exec.join('\n'), language: 'text/javascript' }
    ];

    for (const item of items) {
      if (String(item.$kind ?? '') !== 'http-request') continue;
      if (String(item.name ?? '') === '00 - Resolve Secrets') continue;
      const itemId = String(item.id ?? '').trim();
      if (!itemId) continue;
      // `add` on `/scripts` sets the test script; reruns overwrite it (no dupes).
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'patch',
        path: `/v3/collections/${cid}/items/${itemId}`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: [{ op: 'add', path: '/scripts', value: toV3Scripts(smokeTests) }]
      });
    }

    // Idempotent: skip if a prior run already created the secrets resolver.
    if (items.some((i) => String(i.name ?? '') === '00 - Resolve Secrets')) return;
    // Create shape (live-proven): the v3 IR item carries `method`/`url`/`headers`/
    // `body`/`auth` at the ROOT (sibling fields), NOT under a `payload` wrapper — a
    // payload wrapper is silently dropped (body/auth never persist; live-proven via
    // probe-item-auth-roundtrip.ts). `body` is the v3 IR `{type,content}` shape and
    // `auth` is `{type,credentials:[{key,value}]}`. The server assigns the id and
    // echoes `{ id, createdAt }` only.
    const created = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'post',
      path: `/v3/collections/${cid}/items/`,
      headers: { 'X-Entity-Type': 'http-request' },
      body: {
        $kind: 'http-request',
        name: '00 - Resolve Secrets',
        method: 'POST',
        url: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
        headers: [
          { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
          { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
        ],
        body: { type: 'json', content: '{"SecretId": "{{AWS_SECRET_NAME}}"}' },
        auth: {
          type: 'awsv4',
          credentials: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
            { key: 'region', value: '{{AWS_REGION}}' },
            { key: 'service', value: 'secretsmanager' }
          ]
        },
        position: { parent: { id: cid, $kind: 'collection' } }
      }
    });
    // List + create echo item ids as full uids, and `:itemId` PATCH wants the full
    // uid (bare model id only for `:cid`) — use the created id verbatim, do NOT bare it.
    const newItemId = String(asRecord(created?.data)?.id ?? '').trim();
    if (!newItemId) return;
    // Attach the secrets-resolution test script (CI-skipped) as a canonical v3
    // afterResponse script — same `/scripts` shape as the leaf assertions.
    await this.patchNewItemScripts(cid, newItemId, toV3Scripts([
      'if (pm.environment.get("CI") === "true") { return; }',
      'const body = pm.response.json();',
      'if (body.SecretString) {',
      '  const secrets = JSON.parse(body.SecretString);',
      '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
      '}'
    ]));
  }

  // --- workspace roles + member resolution (live-proven 2026-06-30) ---
  //
  // Retires bootstrap's last PMAK `PATCH /workspaces/:id/roles` + `GET /users`.
  // The gateway `workspaces` service takes a BARE JSON array body (no `{roles}`
  // wrapper, no `path` field) keyed by entity type with STRING role-enum names,
  // NOT numeric ids: numeric `[3]` -> 400 "some roles are not configured",
  // `{roles:[...]}` -> 400 "body must be array" (probe-workspace-roles-gateway.ts).
  // Role map (reference WorkspaceRoles.js:307-309): admin == 'WORKSPACE_EDITOR',
  // editor == 'WORKSPACE_EDITOR_V9'.

  /** PATCH a bare role-op array onto a workspace via the gateway. */
  private async patchWorkspaceRoles(workspaceId: string, ops: JsonRecord[]): Promise<void> {
    await this.gateway.requestJson<JsonRecord>({
      service: 'workspaces',
      method: 'patch',
      path: `/workspaces/${workspaceId}/roles`,
      body: ops
    });
  }

  /**
   * Team member roster over the gateway `god` service:
   * `GET /api/organizations/:teamId/members?populate=membership` ->
   * `{ data:[{ id, email, name, username, roles, membership }] }`. This is the
   * access-token equivalent of the PMAK `GET /users` (the reference app resolves
   * email->id client-side against this roster; there is no `?email=` lookup).
   * `teamId` defaults to the memoized session team. A service account is not in
   * its own roster (SAs have no Postman User) — expected; the caller resolves the
   * human requester's email, not the SA's.
   */
  private async getTeamMembers(teamId?: string): Promise<JsonRecord[]> {
    const orgTeamId = teamId || getMemoizedSessionIdentity()?.teamId;
    if (!orgTeamId) return [];
    const res = await this.gateway.requestJson<JsonRecord>({
      service: 'god',
      method: 'get',
      path: `/api/organizations/${orgTeamId}/members`,
      query: { populate: 'membership' }
    });
    const list = Array.isArray(res?.data) ? (res.data as JsonRecord[]) : [];
    return list;
  }

  /**
   * Add workspace admins through the gateway (mirrors the PMAK method). One `add`
   * op carrying every admin id under `value.user` (the validator caps op entries
   * at 2 but allows many user-id keys per op). Role is the admin enum name.
   */
  async addAdminsToWorkspace(workspaceId: string, adminIds: string): Promise<void> {
    const ids = String(adminIds || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    const user: JsonRecord = {};
    for (const id of ids) {
      user[id] = ['WORKSPACE_EDITOR'];
    }
    await this.patchWorkspaceRoles(workspaceId, [{ op: 'add', value: { user } }]);
  }

  /**
   * Grant the requester editor access to the workspace through the gateway
   * (mirrors the PMAK method). Resolves the email against the team roster (the
   * access-token equivalent of the PMAK `GET /users` match), then PATCHes the
   * editor role. No-op when the email is not a team member — the same outcome as
   * the PMAK path's `if (!user?.id) return` early exit.
   */
  async inviteRequesterToWorkspace(workspaceId: string, email: string): Promise<void> {
    const target = String(email || '').trim().toLowerCase();
    if (!target) return;
    const members = await this.getTeamMembers();
    const match = members.find((m) => String(m.email ?? '').trim().toLowerCase() === target);
    const userId = match?.id;
    if (userId == null) return;
    await this.patchWorkspaceRoles(workspaceId, [
      { op: 'add', value: { user: { [String(userId)]: ['WORKSPACE_EDITOR_V9'] } } }
    ]);
  }

  /**
   * Delete a collection through the gateway v3 surface (mirrors the PMAK method).
   * `:id` is the BARE model id. Tolerates both 404 and 500: a delete of an
   * already-gone collection returns 500 GENERIC_ERROR (not 404) on this surface
   * (probe-collection-v3-crud.ts), so both are treated as success.
   */
  /**
   * Inject the deterministic OpenAPI contract assertions into every generated
   * request of a spec-generated collection, entirely over the v3 collection
   * surface (no PMAK, no v2.1.0 read/PUT):
   *   1. `GET /v3/collections/:cid/items/` — flat item list (ids as full uids).
   *   2. `GET /v3/collections/:cid/items/:itemId` (`X-Entity-Type: http-request`)
   *      — the full v3 IR record (method/url/headers/body) the matcher needs.
   *   3. `planContractItemScripts` matches each request to its OpenAPI operation
   *      and builds the `afterResponse` test exec (the same assertions the retired
   *      v2 `item.event` path produced), enforcing coverage + duplicate checks.
   *   4. `PATCH /v3/collections/:cid/items/:itemId` `/scripts` with the afterResponse
   *      script, then prepend the idempotent `00 - Resolve Secrets` item.
   * Returns the non-fatal instrumentation warnings for the caller to surface.
   */
  async injectContractTests(collectionUid: string, index: ContractIndex): Promise<string[]> {
    const cid = this.bareModelId(collectionUid);
    const listed = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}/items/`
    });
    const items = Array.isArray(listed?.data) ? (listed!.data as JsonRecord[]) : [];

    const httpItems: Array<{ itemId: string; item: JsonRecord }> = [];
    for (const listItem of items) {
      if (String(listItem.$kind ?? '') !== 'http-request') continue;
      if (String(listItem.name ?? '') === '00 - Resolve Secrets') continue;
      const itemId = String(listItem.id ?? '').trim();
      if (!itemId) continue;
      // Per-item GET returns the full v3 IR item (method/url/headers/body); the
      // list projection is not guaranteed to carry the request shape the matcher
      // needs, so read each leaf directly. The id is the full uid the PATCH wants.
      const full = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'get',
        path: `/v3/collections/${cid}/items/${itemId}`,
        headers: { 'X-Entity-Type': 'http-request' }
      });
      httpItems.push({ itemId, item: asRecord(full?.data) ?? listItem });
    }

    const plan = planContractItemScripts(httpItems, index);

    // Canonical v3 item scripts: a single `afterResponse` (test) script with the
    // exec lines joined into `code`. `add` on `/scripts` overwrites on rerun.
    const toV3Scripts = (exec: string[]): JsonRecord[] => [
      { type: 'afterResponse', code: exec.join('\n'), language: 'text/javascript' }
    ];
    for (const script of plan.scripts) {
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'patch',
        path: `/v3/collections/${cid}/items/${script.itemId}`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: [{ op: 'add', path: '/scripts', value: toV3Scripts(script.exec) }]
      });
    }

    // Idempotent: skip if a prior run already created the secrets resolver.
    if (!items.some((i) => String(i.name ?? '') === '00 - Resolve Secrets')) {
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: {
          $kind: 'http-request',
          name: '00 - Resolve Secrets',
          method: 'POST',
          url: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
          headers: [
            { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
            { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
          ],
          body: { type: 'json', content: '{"SecretId": "{{AWS_SECRET_NAME}}"}' },
          auth: {
            type: 'awsv4',
            credentials: [
              { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
              { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
              { key: 'region', value: '{{AWS_REGION}}' },
              { key: 'service', value: 'secretsmanager' }
            ]
          },
          position: { parent: { id: cid, $kind: 'collection' } }
        }
      });
      const newItemId = String(asRecord(created?.data)?.id ?? '').trim();
      if (newItemId) {
        await this.patchNewItemScripts(cid, newItemId, toV3Scripts([
          'if (pm.environment.get("CI") === "true") { return; }',
          'const body = pm.response.json();',
          'if (body.SecretString) {',
          '  const secrets = JSON.parse(body.SecretString);',
          '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
          '}'
        ]));
      }
    }

    return plan.warnings;
  }

  async deleteCollection(collectionUid: string): Promise<void> {
    const cid = this.bareModelId(collectionUid);
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'delete',
        path: `/v3/collections/${cid}`
      });
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 500)) {
        return;
      }
      throw error;
    }
  }

  // --- collection v3 create/update (additional local collections; live-proven
  // 2026-07-01; see scripts/probe-collection-v3-crud.ts,
  // scripts/probe-additional-collections-nested.ts,
  // scripts/probe-additional-collections-desc-rename.ts) ---
  //
  // Retires the last PMAK collection-write route (createCollection/updateCollection
  // for user-curated v2.1.0 collections synced from local JSON/YAML). The v2.1
  // input is converted to the canonical v3 IR with the same official
  // `@postman/runtime.models` pipeline repo-sync's converter uses, then written
  // via the v3 items surface: root create (`X-Entity-Target: http`), one
  // `POST .../items/` per node (folder = `$kind:'collection'`, leaf =
  // `$kind:'http-request'`), recursing into folder children
  // with the new item id as `position.parent`. Multi-level nesting, per-item
  // `description`, and collection-level rename/auth/variables are all
  // live-proven against the sandbox. Canonical `graphql-request` input is
  // rejected before root creation because this item-create endpoint rejects it.

  /**
   * Bridge the same v2->v3 graphql gap repo-sync's converter documents: the v2
   * model has no GraphQLRequest, so a v2 graphql body (`{mode:'graphql'}`)
   * transforms into an `http-request` carrying `body.type:'graphql'`, which the
   * v3 item-create surface has no use for. Mirror `postman collection migrate`'s
   * `graphql-request` node (top-level `query`/`variables`, no `body`).
   */
  private normalizeGraphqlRequests(node: JsonRecord): void {
    if (!node || typeof node !== 'object') return;
    const body = node.body as JsonRecord | undefined;
    if (node.$kind === 'http-request' && body && body.type === 'graphql') {
      const content = (body.content ?? {}) as JsonRecord;
      node.$kind = 'graphql-request';
      node.query = typeof content.query === 'string' ? content.query : '';
      node.variables = typeof content.variables === 'string' ? content.variables : '';
      delete node.body;
    }
    for (const child of asItemArray(node.items)) {
      this.normalizeGraphqlRequests(child);
    }
  }

  /**
   * Collection-root scripts require `http:beforeRequest` / `http:afterResponse`
   * (live-proven). Item scripts keep the stripped form used by injectTests.
   */
  private toRootScriptType(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (value === 'beforeRequest' || value === 'afterResponse') {
      return `http:${value}`;
    }
    return value;
  }

  private toRootScripts(scripts: unknown): JsonRecord[] {
    if (!Array.isArray(scripts)) return [];
    return scripts.map((entry) => {
      const script = asRecord(entry);
      if (!script) return entry as JsonRecord;
      return { ...script, type: this.toRootScriptType(script.type) };
    });
  }

  private normalizeScriptsInTree(node: JsonRecord): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.scripts)) {
      node.scripts = node.scripts.map((entry) => {
        const script = asRecord(entry);
        if (!script) return entry;
        return { ...script, type: normalizeLocalViewScriptType(script.type) };
      });
    }
    for (const child of asItemArray(node.items)) {
      this.normalizeScriptsInTree(child);
    }
  }

  private assertGatewayWritableItemKinds(node: JsonRecord): void {
    for (const item of asItemArray(node.items)) {
      if (item.$kind === 'graphql-request') {
        throw new Error(
          'ADDITIONAL_COLLECTION_UNSUPPORTED: graphql-request is not supported by the collection item-create endpoint'
        );
      }
      this.assertGatewayWritableItemKinds(item);
    }
  }

  /** v2.1 collection JSON -> canonical v3 IR, via the official runtime.models transform. */
  private convertV2CollectionToV3(v2Collection: unknown): JsonRecord {
    const model = (V2 as unknown as { Collection: { parse: (v: unknown) => unknown } }).Collection;
    const parsed = model.parse(v2Collection ?? {});
    const v3 = transform(model as never, FormatVersion.V3, parsed as never) as unknown as JsonRecord;
    for (const item of asItemArray(v3.items)) {
      this.normalizeGraphqlRequests(item);
    }
    this.normalizeScriptsInTree(v3);
    return v3;
  }

  /** Accept either legacy v2.1 input or canonical collection v3 input. */
  private normalizeCollectionForWrite(collection: unknown): JsonRecord {
    const record = asRecord(collection);
    if (record?.$kind === 'collection') {
      const v3 = typeof structuredClone === 'function'
        ? structuredClone(record) as JsonRecord
        : JSON.parse(JSON.stringify(record)) as JsonRecord;
      for (const item of asItemArray(v3.items)) {
        this.normalizeGraphqlRequests(item);
      }
      this.normalizeScriptsInTree(v3);
      assertSupportedLocalViewContract(v3, {
        isRoot: true,
        displayPath: String(v3.name ?? 'collection')
      });
      this.assertGatewayWritableItemKinds(v3);
      return v3;
    }
    if (record && Array.isArray(record.items)) {
      throw new Error('Collection v3 payloads with items must declare $kind: collection');
    }
    const v3 = this.convertV2CollectionToV3(collection);
    this.assertGatewayWritableItemKinds(v3);
    return v3;
  }

  /** v3 IR item node -> the POST .../items/ create body, scoped to the fields live-proven above. */
  private buildItemCreateBody(item: JsonRecord, parentId: string): JsonRecord {
    const kind = String(item.$kind ?? 'http-request');
    const body: JsonRecord = {
      $kind: kind,
      name: String(item.name ?? 'Untitled'),
      position: { parent: { id: parentId, $kind: 'collection' } }
    };
    if (typeof item.description === 'string' && item.description) {
      body.description = item.description;
    }
    if (kind === 'collection') {
      return body;
    }
    if (kind === 'graphql-request') {
      if (typeof item.query === 'string') body.query = item.query;
      if (typeof item.variables === 'string') body.variables = item.variables;
      return body;
    }
    if (typeof item.method === 'string') body.method = item.method;
    if (typeof item.url === 'string') body.url = item.url;
    if (Array.isArray(item.headers)) body.headers = item.headers;
    if (Array.isArray(item.queryParams)) body.queryParams = item.queryParams;
    if (Array.isArray(item.pathVariables)) body.pathVariables = item.pathVariables;
    if (item.body && typeof item.body === 'object') body.body = item.body;
    if (item.auth && typeof item.auth === 'object') body.auth = item.auth;
    if (item.settings && typeof item.settings === 'object') body.settings = item.settings;
    return body;
  }

  /** Recursively create a v3 IR item tree under `parentId` (folders recurse into their children). */
  private async createItemTree(cid: string, items: JsonRecord[], parentId: string): Promise<void> {
    for (const item of items) {
      const kind = String(item.$kind ?? 'http-request');
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': kind },
        body: this.buildItemCreateBody(item, parentId)
      });
      const newId = String(asRecord(created?.data)?.id ?? '').trim();
      if (!newId) {
        throw new Error(
          `Item create did not return an id for ${String(item.name ?? 'item')}`
        );
      }
      // Native v3 folder scripts are rejected by the bounded contract. Legacy
      // v2 folder events remain intentionally ignored, matching prior behavior.
      if (kind !== 'collection' && Array.isArray(item.scripts) && item.scripts.length > 0) {
        await this.patchNewItemScripts(cid, newId, item.scripts as JsonRecord[], kind);
      }
      const children = asItemArray(item.items);
      if (kind === 'collection' && children.length > 0) {
        await this.createItemTree(cid, children, newId);
      }
    }
  }

  private async listCollectionItems(cid: string): Promise<JsonRecord[]> {
    const listed = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}/items/`
    });
    if (!Array.isArray(listed?.data)) {
      throw new Error('Collection item listing did not return an array');
    }
    return listed.data.map((entry, index) => {
      const item = asRecord(entry);
      const itemId = String(item?.id ?? '').trim();
      if (!item || !itemId) {
        throw new Error(`Existing collection item listing entry ${index} did not return an id`);
      }
      return item;
    });
  }

  /**
   * Collection-level name/description/auth/variables/scripts via JSON-Patch.
   *
   * Live-proven gateway semantics (scripts/probe-collection-root-patch-reconcile.ts):
   * - `add` works for /description, /auth, /variables, /scripts
   * - root /scripts types must be `http:beforeRequest` / `http:afterResponse`
   * - `remove` of absent /auth|/variables|/scripts => 400 REJECTED_PATCH
   * - `remove` of /description always works (field exists as "")
   * - on update, GET the root first and only remove fields that currently exist
   */
  private async applyCollectionLevelSettings(
    cid: string,
    v3: JsonRecord,
    options: { rename?: boolean; reconcileRemovals?: boolean } = {}
  ): Promise<void> {
    const ops: JsonRecord[] = [];
    if (options.rename && typeof v3.name === 'string' && v3.name) {
      ops.push({ op: 'replace', path: '/name', value: v3.name });
    }

    let current: JsonRecord | null = null;
    if (options.reconcileRemovals) {
      const got = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'get',
        path: `/v3/collections/${cid}`
      });
      current = asRecord(got?.data);
    }

    const hasDescription = typeof v3.description === 'string' && v3.description.length > 0;
    if (hasDescription) {
      ops.push({ op: 'add', path: '/description', value: v3.description });
    } else if (options.reconcileRemovals) {
      // description always exists (possibly ""); remove clears it to ""
      ops.push({ op: 'remove', path: '/description' });
    }

    if (v3.auth && typeof v3.auth === 'object') {
      ops.push({ op: 'add', path: '/auth', value: v3.auth });
    } else if (options.reconcileRemovals && current && current.auth !== undefined) {
      ops.push({ op: 'remove', path: '/auth' });
    }

    if (Array.isArray(v3.variables) && v3.variables.length > 0) {
      ops.push({ op: 'add', path: '/variables', value: v3.variables });
    } else if (options.reconcileRemovals && current && current.variables !== undefined) {
      ops.push({ op: 'remove', path: '/variables' });
    }

    if (Array.isArray(v3.scripts) && v3.scripts.length > 0) {
      ops.push({ op: 'add', path: '/scripts', value: this.toRootScripts(v3.scripts) });
    } else if (options.reconcileRemovals && current && current.scripts !== undefined) {
      ops.push({ op: 'remove', path: '/scripts' });
    }

    if (ops.length === 0) return;
    await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'patch',
      path: `/v3/collections/${cid}`,
      body: ops
    });
  }

  /**
   * Create a curated local v2.1.0 or collection v3 payload through the gateway v3 write
   * surface. Returns the full uid (same format `generateCollection` returns),
   * so callers can persist it and pass it straight to `updateCollection`/
   * `deleteCollection`/`tagCollection`/`injectTests` unchanged.
   */
  async createCollection(workspaceId: string, collection: unknown): Promise<string> {
    const v3 = this.normalizeCollectionForWrite(collection);
    // Root create accepts name only; description/auth/variables/scripts are applied
    // via JSON Patch in applyCollectionLevelSettings (live-proven). Putting
    // description on the POST body makes a later add /description a no-op that
    // can 400 when the patch set is otherwise empty or redundant.
    const rootBody: JsonRecord = { name: String(v3.name ?? 'Untitled Collection') };
    const created = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'post',
      path: `/v3/collections/?workspace=${workspaceId}`,
      headers: { 'X-Entity-Target': 'http' },
      body: rootBody
    });
    const rawId = String(asRecord(created?.data)?.id ?? '').trim();
    if (!rawId) {
      throw new Error('Collection create did not return an id');
    }
    const cid = this.bareModelId(rawId);
    try {
      await this.createItemTree(cid, asItemArray(v3.items), cid);
      await this.applyCollectionLevelSettings(cid, v3);
    } catch (error) {
      let cleanupError: unknown;
      try {
        await this.deleteCollection(rawId);
      } catch (err) {
        cleanupError = err;
      }
      if (cleanupError !== undefined) {
        throw new Error(
          `Collection ${rawId} failed to populate and cleanup also failed: ${
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          }`,
          { cause: error }
        );
      }
      throw error;
    }
    return rawId;
  }

  /**
   * Full-replace reconcile of a curated local v2.1.0 or collection v3 payload: delete every
   * root-level item (deleting a folder cascades its children server-side —
   * live-proven), tolerating the gateway's spurious 500 on an already-cascaded
   * child by not trusting individual delete statuses, then recreate the tree
   * from the converted v3 IR and reapply name/auth/variables.
   */
  async updateCollection(collectionUid: string, collection: unknown): Promise<void> {
    const cid = this.bareModelId(collectionUid);
    const v3 = this.normalizeCollectionForWrite(collection);

    const existingItems = await this.listCollectionItems(cid);
    for (const item of existingItems) {
      const itemId = String(item.id).trim();
      try {
        await this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'delete',
          path: `/v3/collections/${cid}/items/${itemId}`,
          headers: { 'X-Entity-Type': String(item.$kind ?? 'http-request') }
        });
      } catch (error) {
        if (!(error instanceof HttpError && (error.status === 404 || error.status === 500))) {
          throw error;
        }
      }
    }

    const remainingItems = await this.listCollectionItems(cid);
    if (remainingItems.length > 0) {
      throw new Error(
        `Collection delete verification failed: ${remainingItems.length} old items remain`
      );
    }

    await this.createItemTree(cid, asItemArray(v3.items), cid);
    await this.applyCollectionLevelSettings(cid, v3, { rename: true, reconcileRemovals: true });
  }
}
