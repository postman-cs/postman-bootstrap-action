import { randomUUID } from 'node:crypto';

import {
  AccessTokenGatewayClient,
  HttpError,
  fullJitterDelayMs,
  retry,
  type GatewayRetryEvent as RetryEvent
} from '@postman-cs/automation-core';
import {
  adoptExactMatch,
  isAmbiguousTransportError
} from './create-reconciliation.js';
import { getMemoizedSessionIdentity } from './credential-identity.js';
import { WORKSPACE_PERSONAL_ONLY_ADVICE } from './error-advice.js';
import { normalizeGitRepoUrl } from './git-url.js';
import {
  isBareCollectionUuid,
  isFullPublicCollectionUid,
  normalizeCollectionModelIdentity
} from './collection-model-identity.js';
import {
  assertV2CollectionModel,
  convertV2CollectionToV3Model,
  convertV3CollectionToV2Model
} from './collection-model-conversion.js';
import {
  createSecretsResolverExec,
  createSecretsResolverV3Body,
  isSecretsResolverEnabled,
  isSecretsResolverItemName,
  type SecretsResolverProvider
} from '@postman-cs/automation-core';
import {
  assertSupportedLocalViewContract,
  normalizeLocalViewScriptType
} from './local-view-contract.js';
import { planContractItemScripts } from '../spec/collection-contracts.js';
import type { ContractIndex } from '../spec/contract-index.js';
import type { DefinitionBundle, DefinitionFormat } from '../spec/definition-bundle.js';
import {
  computePayloadDigest,
  describePayloadDigestDifference
} from '../spec/local-openapi-collection-generation.js';
import type {
  CollectionDeltaOperation,
  CollectionDeltaPlan
} from '../spec/collection-delta.js';
import { parseAssetMarker } from '../repo/branch-decision.js';
import {
  assertNoCloudPathCollisions,
  assertSameRootPath,
  buildBulkFilesBody,
  buildMultiFileCreateBody,
  cloudMembersToDefinitionBundle,
  contentFromGatewayFileRead,
  DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY,
  definitionBundleToSnapshot,
  listFilesFromGatewayResponse,
  orderPerFileReconcileOps,
  perFileCreateName,
  planHasMutations,
  planSpecFileReconcile,
  resolvePerFileCreateParentId,
  snapshotToDefinitionBundle,
  validateSpecReconcileCapabilityPolicy,
  type CloudSpecFileMeta,
  type SpecBundleMutationOutcome,
  type SpecBundleSnapshot,
  type SpecReconcileCapabilityPolicy
} from './spec-file-reconcile.js';
import { parseSpecTreePage, specTreeNextCursor } from './spec-tree.js';

function asItemArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? (value as JsonRecord[]) : [];
}

/**
 * Sanitized convergence evidence for collection writes. Counts, durations, and
 * normalized route templates only: content, names, and ids never enter it.
 */
export interface CollectionWriteMetrics {
  ambiguousWrites: number;
  convergedWithoutResend: number;
  resendCount: number;
  verifyPolls: number;
  recoveryMs: number;
  inventoryReads: number;
  inventorySleepMs: number;
  rootResolveMs: number;
  renameMs: number;
  electionMs: number;
  deltaOpsByKind: { create: number; patch: number; move: number; delete: number };
  deltaRoutes: string[];
  changedBytes: number;
  deltaMs: number;
  fallbackReasons: string[];
}

type JsonRecord = Record<string, unknown>;

type InventoryRetryPolicy = 'safe' | 'rate-limit' | 'none';

export interface WorkspaceInventoryRow {
  id: string;
  name: string;
  description?: string;
}

export interface WorkspaceInventoryObservation {
  readonly rows: readonly WorkspaceInventoryRow[] | undefined;
}

/** One imported identity's bounded inventory-settle timeline. */
export interface ImportSettleCursor {
  readonly workspaceId: string;
  readonly identity: string;
  readonly delays: readonly number[];
  readonly peerDelayCount: number;
  readonly observations: WorkspaceInventoryObservation[];
  nextDelayIndex: number;
}

export interface ImportRootResolution {
  readonly rootUid: string | undefined;
  readonly resolvedRow: WorkspaceInventoryRow | undefined;
  readonly observations: readonly WorkspaceInventoryObservation[];
  readonly cursor: ImportSettleCursor;
}

/** Workspace-local physical inventory reads shared by concurrent settle cursors. */
export interface WorkspaceInventoryObserver {
  observe(
    cursor: ImportSettleCursor,
    retryPolicy: InventoryRetryPolicy
  ): Promise<WorkspaceInventoryObservation>;
  consumeDelay(cursor: ImportSettleCursor): Promise<boolean>;
}

class MemoizedWorkspaceInventoryObserver implements WorkspaceInventoryObserver {
  private inFlight: Promise<WorkspaceInventoryRow[]> | undefined;

  constructor(
    private readonly readInventory: (retryPolicy: InventoryRetryPolicy) => Promise<WorkspaceInventoryRow[]>,
    private readonly sleep: (delayMs: number) => Promise<void>,
    private readonly onPhysicalRead: () => void,
    private readonly onSleep: (delayMs: number) => void
  ) {}

  async observe(
    cursor: ImportSettleCursor,
    retryPolicy: InventoryRetryPolicy
  ): Promise<WorkspaceInventoryObservation> {
    let rows: WorkspaceInventoryRow[] | undefined;
    try {
      rows = await this.read(retryPolicy);
    } catch {
      // An unreadable observation consumes this cursor's bounded budget. The
      // caller retains the failure as an absent row and therefore fails closed.
      rows = undefined;
    }
    const observation: WorkspaceInventoryObservation = { rows };
    cursor.observations.push(observation);
    return observation;
  }

  async consumeDelay(cursor: ImportSettleCursor): Promise<boolean> {
    const delay = cursor.delays[cursor.nextDelayIndex];
    if (delay === undefined) return false;
    cursor.nextDelayIndex += 1;
    this.onSleep(delay);
    await this.sleep(delay);
    return true;
  }

  private read(retryPolicy: InventoryRetryPolicy): Promise<WorkspaceInventoryRow[]> {
    if (this.inFlight) return this.inFlight;
    this.onPhysicalRead();
    const shared = this.readInventory(retryPolicy).then(
      (rows) => {
        if (this.inFlight === shared) this.inFlight = undefined;
        return rows;
      },
      (error: unknown) => {
        if (this.inFlight === shared) this.inFlight = undefined;
        throw error;
      }
    );
    this.inFlight = shared;
    return shared;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

/**
 * The single UMS response that proves an account is NOT org-mode: squads are
 * not a feature of its plan. Matched on a `400` body only; wording drift makes
 * discovery indeterminate rather than silently non-org, which fails closed.
 */
const NON_ORG_SQUAD_SENTINEL = /squad feature is not available/i;

/** Longest safe body excerpt kept on a discovery failure for operator triage. */
const SQUAD_DISCOVERY_BODY_DIGEST_LIMIT = 200;

/**
 * Positive safe integer from the ums squads transport contract: a finite number
 * or a decimal-digit string that normalizes exactly (no fractions, negatives,
 * booleans, or values outside Number.isSafeInteger).
 */
function parsePositiveSafeInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    if (String(parsed) !== trimmed) return null;
    return parsed;
  }
  return null;
}

/**
 * Sub-team (squad) discovery reached a terminal outcome that neither produced a
 * usable squad list nor matched the non-org sentinel, so whether the account is
 * org-mode is unknown. Carries the observed HTTP status (0 when the failure was
 * not an HTTP response) and a truncated, secret-masked body digest. Callers that
 * must create a workspace have to fail on this rather than assume
 * "not org-mode": that assumption is what produced the late visibility-flip 403.
 */
export class SquadDiscoveryUnavailableError extends Error {
  readonly observedStatus: number;
  readonly bodyDigest: string;

  constructor(cause: unknown) {
    const status = cause instanceof HttpError ? cause.status : 0;
    const rawBody =
      cause instanceof HttpError
        ? cause.responseBody || cause.message || ''
        : cause instanceof Error
          ? cause.message
          : String(cause ?? '');
    // HttpError already redacts known secret values; truncate so a large body
    // cannot dominate the operator-facing message.
    const digest = String(rawBody)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SQUAD_DISCOVERY_BODY_DIGEST_LIMIT);
    super(
      `Org sub-team (squad) discovery is unavailable (observed UMS status ${status || 'none'})` +
        (digest ? `: ${digest}` : '')
    );
    this.name = 'SquadDiscoveryUnavailableError';
    this.observedStatus = status;
    this.bodyDigest = digest;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * A 400 from a JSON-Patch remove whose target no longer exists — the signature
 * of a retried PATCH whose first attempt actually committed downstream.
 */
function isMissingPatchValueError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    error.responseBody.includes('Remove operation must point to an existing value')
  );
}

/**
 * Generic no-op JSON-Patch rejection: the server refuses a patch whose net
 * effect is zero (e.g. add /description with the same value, replace /name
 * with the current name). Distinct from isMissingPatchValueError, which is
 * remove-specific. Both are safe to treat as already-applied when the
 * readback confirms the intended end state.
 */
function isRejectedPatchError(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    error.status === 400 &&
    /REJECTED_PATCH|must update at least one/i.test(
      `${error.message}\n${error.responseBody ?? ''}`
    )
  );
}

/**
 * Order-insensitive deep equality by canonical JSON. Object keys are sorted so
 * the readback of an add/replace can be compared against the exact requested
 * value regardless of key order — a stale pre-PATCH value fails this even when
 * it is merely non-null.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = canonicalize(record[key]);
    }
    return out;
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * Next-page cursor of a Postman list response, or '' on the last page.
 *
 * Two cursor envelopes are in play and both are read here because one client
 * method can hit either service:
 *   - specification service: `meta.cursor.next` (also seen flattened as
 *     `meta.nextCursor` / `nextCursor` on the workspaces route).
 *   - collection service v3: `meta.pagination.nextPage`.
 * A list read that stops at page 1 concludes "absent" on a large customer team
 * and forks a duplicate asset, so every list read must drain its cursor.
 */
function nextPageCursor(response: unknown): string {
  const root = asRecord(response);
  const meta = asRecord(root?.meta);
  const cursor = asRecord(meta?.cursor);
  const pagination = asRecord(meta?.pagination);
  const candidates = [cursor?.next, meta?.nextCursor, pagination?.nextPage, root?.nextCursor];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * Drain every page of a cursor-paginated list. A repeated cursor and a hard page
 * ceiling turn a server-side cursor bug into a loud failure instead of an
 * unbounded onboarding hang.
 */
async function collectPagedList<T>(
  fetchPage: (cursor: string) => Promise<unknown>,
  extract: (page: unknown) => T[],
  label: string
): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  let cursor = '';
  for (let page = 0; ; page += 1) {
    if (page >= 200) throw new Error(`${label}_PAGE_LIMIT_EXCEEDED`);
    const response = await fetchPage(cursor);
    out.push(...extract(response));
    const next = nextPageCursor(response);
    if (!next) return out;
    if (seen.has(next)) throw new Error(`${label}_CURSOR_REPEATED`);
    seen.add(next);
    cursor = next;
  }
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
  /** Injectable RNG for deterministic jitter in tests (default Math.random). */
  random?: () => number;
  // Generation task poll budget. Defaults hold the live-proven production values
  // (90 attempts x 2000ms ~= 180s). Overridable so the e2e smoke path can shrink
  // the wait without weakening resilience for real onboarding runs; also read
  // from POSTMAN_GENERATION_POLL_ATTEMPTS / POSTMAN_GENERATION_POLL_DELAY_MS when
  // the options are not passed explicitly.
  generationPollAttempts?: number;
  generationPollDelayMs?: number;
  now?: () => number;
  createIdentity?: () => string;
  /**
   * Validated Spec Hub reconcile capability policy. Defaults are the live-proven
   * R5 values (bulkModify=true, atomicBulk=true, rootPathChange=false). Injectable
   * for tests; never loaded from external mutable state at runtime.
   */
  reconcileCapabilityPolicy?: SpecReconcileCapabilityPolicy;
  onRetry?: (event: RetryEvent) => void;
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
  private static readonly GENERATION_OBSERVATION_MAX_RETRIES = 4;
  private static readonly DEFAULT_GENERATION_POLL_ATTEMPTS = 90;
  private static readonly DEFAULT_GENERATION_POLL_DELAY_MS = 2000;
  /**
   * Bounded Spec Hub relation/name-enrichment polls after generation task
   * completion or an ambiguous create POST. Kept far below the full task
   * budget so a nameless newly-appeared relation can settle without waiting
   * the full ~180s generation poll window.
   */
  private static readonly GENERATION_RELATION_SETTLE_MAX_POLLS = 20;
  /** Post-create exact-name polls before a singleton may be accepted as final. */
  private static readonly SPEC_CREATE_STABLE_MAX_POLLS = 10;
  /** Consecutive identical normalized ID sets required before acting on the set. */
  private static readonly SPEC_CREATE_STABLE_QUIET_STREAK = 2;
  /**
   * Minimum poll index (0-based) before a quiet singleton is accepted. Forces at
   * least three observations so a peer that becomes list-visible after the first
   * settle read is still observed (live nonorg dual-preview race).
   */
  private static readonly SPEC_CREATE_SINGLETON_MIN_POLL_INDEX = 2;
  /**
   * Bounded org eventual-consistency settle schedule for resolving a final-name
   * Sync import and concurrent final-name election on canonical/channel/legacy
   * names. Each delay is one observation gap while org list visibility catches
   * up to a late peer; never a size/depth rejection cap.
   */
  private static readonly IMPORT_IDENTITY_SETTLE_DELAYS_MS = [
    250, 500, 750, 1000, 1250
  ] as const;
  /**
   * Extended settle schedule for branch-preview final names only
   * (`previewAssetName` contract: `<base> @<branch-slug>`). 18s total budget
   * covers the live nonorg dual-preview race where a peer final may appear after
   * the standard window.
   */
  private static readonly IMPORT_IDENTITY_PREVIEW_SETTLE_DELAYS_MS = [
    250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000
  ] as const;
  /** Matches {@link previewAssetName}: final name ends with ` @<non-whitespace slug>`. */
  private static readonly PREVIEW_ASSET_NAME_SUFFIX = / @\S+$/;

  private static importIdentitySettleDelaysForFinalName(
    finalName: string
  ): readonly number[] {
    return PostmanGatewayAssetsClient.PREVIEW_ASSET_NAME_SUFFIX.test(finalName)
      ? PostmanGatewayAssetsClient.IMPORT_IDENTITY_PREVIEW_SETTLE_DELAYS_MS
      : PostmanGatewayAssetsClient.IMPORT_IDENTITY_SETTLE_DELAYS_MS;
  }

  /**
   * Inventory-visibility schedule for resolving a bare Sync model id to its
   * ROOT-addressable uid. Import already carries the final name, so this read
   * observes only the exact preallocated model identity and shares its remaining
   * delayed-peer window with election.
   */
  private static rootUidResolveDelaysForFinalName(finalName: string): readonly number[] {
    if (PostmanGatewayAssetsClient.PREVIEW_ASSET_NAME_SUFFIX.test(finalName)) {
      return PostmanGatewayAssetsClient.IMPORT_IDENTITY_PREVIEW_SETTLE_DELAYS_MS;
    }
    return [
      ...PostmanGatewayAssetsClient.IMPORT_IDENTITY_SETTLE_DELAYS_MS,
      ...PostmanGatewayAssetsClient.IMPORT_IDENTITY_PREVIEW_SETTLE_DELAYS_MS.slice(
        PostmanGatewayAssetsClient.IMPORT_IDENTITY_SETTLE_DELAYS_MS.length
      )
    ];
  }
  /**
   * Bounded eventual-consistency verification after a successful owned-root delete.
   * HTTP 404 on collection-root GET proves absence; service-account sessions that
   * 403 on root GET fall back to workspace inventory with normalized identity
   * comparison. Stale post-delete visibility is polled across the full schedule
   * (9s total) before failing closed.
   */
  private static readonly DELETE_ABSENCE_SETTLE_DELAYS_MS = [
    250, 500, 750, 1000, 1500, 2000, 3000
  ] as const;
  /** Successful export envelopes can briefly precede a complete collection model. */
  private static readonly EXPORT_MODEL_SETTLE_DELAYS_MS = [100, 250, 500] as const;

  private readonly gateway: AccessTokenGatewayClient;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly random: () => number;
  private readonly generationPollAttempts: number;
  private readonly generationPollDelayMs: number;
  private readonly now: () => number;
  private readonly createIdentity: () => string;
  private readonly reconcileCapabilityPolicy: SpecReconcileCapabilityPolicy;
  private readonly onRetry?: (event: RetryEvent) => void;
  private readonly workspaceInventoryObservers = new Map<string, WorkspaceInventoryObserver>();
  private activeImportMutations = 0;
  private readonly importMutationWaiters: Array<() => void> = [];

  constructor(options: PostmanGatewayAssetsClientOptions) {
    this.gateway = options.gateway;
    this.createIdentity = options.createIdentity ?? randomUUID;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.random = options.random ?? Math.random;
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
    this.now = options.now ?? Date.now;
    this.reconcileCapabilityPolicy = validateSpecReconcileCapabilityPolicy(
      options.reconcileCapabilityPolicy ?? DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY
    );
    this.onRetry = options.onRetry;
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
   * org-mode test works unchanged. PMAK is never consulted (reserved for token
   * mint + CLI login).
   *
   * Outcomes are classified, never collapsed. Exactly one endpoint response
   * means "not org-mode": `400` whose body matches
   * `/squad feature is not available/i` (live-proven, team 10490519) → `[]`.
   * Everything else - other `4xx`, terminal `5xx`/transport after the gateway's
   * safe-read retries, a non-array or empty `data`, or any row without a usable
   * numeric id, non-empty name, and positive safe organizationId - is
   * indeterminate and raises `SquadDiscoveryUnavailableError`. Successful
   * payloads are validated whole rather than filtered: dropping bad rows can
   * turn a two-squad account into an unsafe single-squad auto-pick. A missing
   * memoized session identity still returns `[]`, because there is no org id to
   * query with.
   */
  async getTeams(): Promise<Array<{ id: number; name: string; handle: string; organizationId: number }>> {
    const orgTeamId = getMemoizedSessionIdentity()?.teamId;
    if (!orgTeamId) return [];
    let res: JsonRecord | null;
    try {
      res = await this.gateway.requestJson<JsonRecord>({
        service: 'ums',
        method: 'get',
        path: `/api/teams/${orgTeamId}/squads?settings=true&userRoles=true`
      });
    } catch (err) {
      if (
        err instanceof HttpError &&
        err.status === 400 &&
        NON_ORG_SQUAD_SENTINEL.test(err.responseBody || err.message || '')
      ) {
        // The one unambiguous non-org signal: squads are not a feature here.
        return [];
      }
      throw new SquadDiscoveryUnavailableError(err);
    }
    if (!Array.isArray(res?.data)) {
      throw new SquadDiscoveryUnavailableError(
        new Error('ums squads response did not contain a data array')
      );
    }
    const list = res.data as JsonRecord[];
    if (list.length === 0) {
      throw new SquadDiscoveryUnavailableError(
        new Error('ums squads response contained an empty data array')
      );
    }
    return list.map((row) => {
      const squad = asRecord(row);
      if (!squad) {
        throw new SquadDiscoveryUnavailableError(
          new Error('ums squads response contained a row that is not an object')
        );
      }
      const id = parsePositiveSafeInteger(squad.id);
      const organizationId = parsePositiveSafeInteger(squad.organizationId);
      const name = typeof squad.name === 'string' ? squad.name.trim() : '';
      if (id === null || organizationId === null || !name) {
        throw new SquadDiscoveryUnavailableError(
          new Error(
            'ums squads response contained a row without usable id, name, and organizationId'
          )
        );
      }
      const handle =
        typeof squad.handle === 'string' ? squad.handle : String(squad.handle ?? '');
      return { id, name, handle, organizationId };
    });
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
    const outcome = await this.uploadSpecWithOutcome(
      workspaceId,
      projectName,
      specContent,
      openapiVersion
    );
    return outcome.specId;
  }

  /** Upload or adopt a single-file spec and report rollback ownership. */
  async uploadSpecWithOutcome(
    workspaceId: string,
    projectName: string,
    specContent: string,
    openapiVersion: '3.0' | '3.1' | string = '3.0'
  ): Promise<{ specId: string; created: boolean }> {
    if (openapiVersion !== '3.0' && openapiVersion !== '3.1') {
      throw new Error(`uploadSpec: unsupported openapiVersion "${openapiVersion}". Expected '3.0' or '3.1'.`);
    }
    // Resolution-layer idempotency: an absent tracked state must not mean a
    // blind create. Exact final-name lookup adopts one match, fails loudly on
    // ambiguity, and only then enters the randomized-create race guard.
    const before = await this.findSpecificationsByExactName(workspaceId, projectName);
    const existing = adoptExactMatch(
      `specification:${workspaceId}:${projectName}`,
      before,
      (entry) => entry.id
    );
    if (existing) {
      // Adoption is resolution, not success: a same-identity spec from a prior
      // run still needs the incoming content before collection generation.
      await this.updateSpec(existing.id, specContent, workspaceId);
      return { specId: existing.id, created: false };
    }
    const specType = openapiVersion === '3.1' ? 'OPENAPI:3.1' : 'OPENAPI:3.0';
    let created: JsonRecord | null;
    let createdByThisRun = true;
    try {
      created = await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'post',
        path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
        retry: 'none',
        body: {
          name: projectName,
          type: specType,
          files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }]
        }
      });
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      createdByThisRun = false;
      const match = adoptExactMatch(
        `specification:${workspaceId}:${projectName}`,
        await this.findSpecificationsByExactName(workspaceId, projectName),
        (entry) => entry.id
      );
      if (!match) throw error;
      created = { data: { id: match.id } };
    }
    const createdSpecId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
    if (!createdSpecId) {
      throw new Error('Spec upload did not return an ID');
    }
    // A concurrent same-identity create may have won between lookup and POST.
    // Stable-set election before proceeding so a duplicate is never retained and
    // generation never targets a loser a peer is about to delete.
    const election = await this.electStableNewSpecificationIdentity(
      workspaceId,
      projectName,
      before,
      createdSpecId
    );
    const specId = election.specId;
    // The winner may have been created by the peer. Last writer wins for the
    // same branch identity, which is safe and ensures this run's content lands.
    if (specId !== createdSpecId) {
      await this.updateSpec(specId, specContent, workspaceId);
    }
    // Preflight the read so a generate immediately after create does not race.
    await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}`
    });
    return {
      specId,
      created: createdByThisRun && specId === createdSpecId && !election.shared
    };
  }

  /**
   * Delete an entire Spec Hub specification. Used for concurrent-create
   * election cleanup and for orchestrator whole-spec cleanup when a brand-new
   * create fails after mutation (lint/generation/linking). 404 means a peer
   * already removed it — treat as successful idempotent deletion.
   */
  async deleteSpec(specId: string): Promise<void> {
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'delete',
        path: `/specifications/${specId}`,
        retry: 'none'
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return;
      throw error;
    }
  }

  /**
   * After a create when the pre-create exact-name list was empty, poll until the
   * normalized ID set is quiet and elect the stable lowest ID. Each runner may
   * delete only its own created loser; never deletes a peer-created ID or any
   * ID observed in `before`. Winner-owners wait boundedly for peers to
   * self-clean. Bounded and fake-timer compatible (attempt/streak based).
   */
  private async electStableNewSpecificationIdentity(
    workspaceId: string,
    projectName: string,
    before: Array<{ id: string; name: string }>,
    createdSpecId: string
  ): Promise<{ specId: string; shared: boolean }> {
    const identityKey = `specification:${workspaceId}:${projectName}`;

    // Pre-existing exact-name rows were observed before create: never run the
    // concurrent-loser delete path against them (ambiguity is handled by adopt).
    if (before.length > 0) {
      const matches = await this.findSpecificationsByExactName(workspaceId, projectName);
      const verified = adoptExactMatch(identityKey, matches, (entry) => entry.id);
      return { specId: verified?.id ?? createdSpecId, shared: false };
    }

    let matches: Array<{ id: string; name: string }> = [];
    let lastSetKey: string | null = null;
    let quietStreak = 0;
    let shared = false;
    for (
      let poll = 0;
      poll < PostmanGatewayAssetsClient.SPEC_CREATE_STABLE_MAX_POLLS;
      poll += 1
    ) {
      matches = await this.findSpecificationsByExactName(workspaceId, projectName);
      if (matches.length > 1) shared = true;
      const setKey = matches.map((entry) => entry.id).join('\0');
      if (setKey === lastSetKey) {
        quietStreak += 1;
      } else {
        lastSetKey = setKey;
        quietStreak = 1;
      }

      const quietEnough =
        quietStreak >= PostmanGatewayAssetsClient.SPEC_CREATE_STABLE_QUIET_STREAK;
      if (quietEnough && matches.length > 1) {
        break;
      }
      if (
        quietEnough &&
        matches.length === 1 &&
        poll >= PostmanGatewayAssetsClient.SPEC_CREATE_SINGLETON_MIN_POLL_INDEX
      ) {
        break;
      }
      await this.sleep(poll === 0 ? 1000 : 250);
    }

    if (matches.length > 1) {
      // Exact-name set is sorted ascending; lowest ID is the stable winner.
      // Never loop-delete all matches — only the runner that created a loser
      // may delete that loser. Winner-owners wait for peer self-cleanup.
      const winnerId = matches[0]!.id;
      if (createdSpecId !== winnerId) {
        if (matches.some((entry) => entry.id === createdSpecId)) {
          await this.deleteSpecification(createdSpecId);
        }
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        matches = await this.findSpecificationsByExactName(workspaceId, projectName);
        if (matches.length <= 1) break;
        await this.sleep(250 * (attempt + 1));
      }
      if (matches.length > 1) {
        throw new Error(
          `Concurrent specification create for ${projectName} did not converge`
        );
      }
      const converged = adoptExactMatch(identityKey, matches, (entry) => entry.id);
      if (!converged) {
        throw new Error(`Concurrent specification create for ${projectName} did not converge`);
      }
      return { specId: converged.id, shared: true };
    }

    const verified = adoptExactMatch(identityKey, matches, (entry) => entry.id);
    return { specId: verified?.id ?? createdSpecId, shared };
  }

  private async deleteSpecification(specId: string): Promise<void> {
    await this.deleteSpec(specId);
  }

  async findSpecificationsByExactName(
    workspaceId: string,
    name: string
  ): Promise<Array<{ id: string; name: string }>> {
    const entries = await collectPagedList(
      (cursor) =>
        this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'get',
          path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
          ...(cursor ? { query: { cursor } } : {})
        }),
      (page) => (Array.isArray(asRecord(page)?.data) ? (asRecord(page)!.data as unknown[]) : []),
      'SPEC_LIST'
    );
    return entries
      .map((value) => asRecord(value))
      .filter((value): value is JsonRecord => value !== null)
      .map((value) => ({
        id: String(value.id ?? value.uid ?? '').trim(),
        name: String(value.name ?? '').trim()
      }))
      .filter((value) => value.id && value.name === name)
      .sort((a, b) => a.id.localeCompare(b.id));
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
      // Replacing the ROOT file content with the same value is idempotent, so a
      // transient downstream timeout (ESOCKETTIMEDOUT) is safe to retry.
      retry: 'safe',
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

  /**
   * Create (or adopt+reconcile) a multi-file OpenAPI Spec Hub definition from a
   * DefinitionBundle. Uses the R5-proven create shape
   * `{name,type:'OPENAPI:3.x',files:[{path,content,type:'ROOT'|'DEFAULT'}]}`.
   * Returns the prior/empty snapshot surface for orchestrator rollback; a brand
   * new create that fails verification is whole-deleted (not per-file rolled back).
   */
  async uploadSpecBundle(
    workspaceId: string,
    projectName: string,
    bundle: DefinitionBundle,
    openapiVersion: '3.0' | '3.1' | string = '3.0'
  ): Promise<{
    specId: string;
    created: boolean;
    priorSnapshot: SpecBundleSnapshot | null;
    outcome: SpecBundleMutationOutcome;
  }> {
    const before = await this.findSpecificationsByExactName(workspaceId, projectName);
    const existing = adoptExactMatch(
      `specification:${workspaceId}:${projectName}`,
      before,
      (entry) => entry.id
    );
    if (existing) {
      const outcome = await this.reconcileSpecBundle(existing.id, bundle);
      return {
        specId: existing.id,
        created: false,
        priorSnapshot: outcome.priorSnapshot,
        outcome
      };
    }

    const body = buildMultiFileCreateBody({ name: projectName, openapiVersion, bundle });
    let created: JsonRecord | null;
    try {
      created = await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'post',
        path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
        retry: 'none',
        body
      });
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const match = adoptExactMatch(
        `specification:${workspaceId}:${projectName}`,
        await this.findSpecificationsByExactName(workspaceId, projectName),
        (entry) => entry.id
      );
      if (!match) {
        return {
          specId: '',
          created: false,
          priorSnapshot: null,
          outcome: {
            status: 'verification-needed',
            changed: true,
            priorSnapshot: {
              schemaVersion: 1,
              rootPath: bundle.rootPath,
              format: bundle.format,
              files: [],
              digest: ''
            },
            targetDigest: bundle.digest,
            reason: 'ambiguous-create-without-list-match',
            cause: error
          }
        };
      }
      const outcome = await this.reconcileSpecBundle(match.id, bundle);
      return {
        specId: match.id,
        created: false,
        priorSnapshot: outcome.priorSnapshot,
        outcome
      };
    }

    const createdSpecId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
    if (!createdSpecId) {
      throw new Error('Spec bundle upload did not return an ID');
    }

    // After a new spec ID is known, any election/readback/detail failure must
    // whole-delete only the newly created spec (never an elected/adopted peer).
    let cleanupSafe = true;
    try {
      const election = await this.electStableNewSpecificationIdentity(
        workspaceId,
        projectName,
        before,
        createdSpecId
      );
      const specId = election.specId;
      cleanupSafe = !election.shared;
      const weCreatedWinner = specId === createdSpecId;

      // Lost the election: land our content on the peer winner and surface
      // created:false so orchestrator rollback never deletes the elected peer.
      if (!weCreatedWinner) {
        const outcome = await this.reconcileSpecBundle(specId, bundle);
        return {
          specId,
          created: false,
          priorSnapshot: outcome.priorSnapshot,
          outcome
        };
      }

      const readback = await this.getSpecBundle(specId, bundle.format);
      if (readback.digest !== bundle.digest) {
        throw new Error(
          `Spec Hub bundle verify failed after create for ${specId}: expected digest ${bundle.digest}, got ${readback.digest}`
        );
      }

      await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'get',
        path: `/specifications/${specId}`
      });

      const priorSnapshot: SpecBundleSnapshot = {
        schemaVersion: 1,
        rootPath: bundle.rootPath,
        format: bundle.format,
        files: [],
        digest: ''
      };
      return {
        specId,
        created: cleanupSafe,
        priorSnapshot,
        outcome: {
          status: 'ok',
          changed: true,
          priorSnapshot,
          verifiedDigest: readback.digest
        }
      };
    } catch (error) {
      let cleanupFailed: unknown;
      try {
        // Idempotent: 404 (peer already deleted the loser) is success.
        if (cleanupSafe) await this.deleteSpecification(createdSpecId);
      } catch (cleanupError) {
        cleanupFailed = cleanupError;
      }
      if (cleanupFailed) {
        const original =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `${original}; newly created spec ${createdSpecId} whole-delete cleanup also failed`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  /**
   * List every Spec Hub definition member and read content by UUID
   * (`GET .../files/:uuid?fields=content`). Normalizes paths/roles and computes
   * a DefinitionBundle-compatible full-set digest. Rejects cloud
   * duplicate/case-colliding paths.
   */
  async getSpecBundle(specId: string, format: DefinitionFormat): Promise<DefinitionBundle> {
    const loaded = await this.loadSpecBundleState(specId, format);
    return loaded.bundle;
  }

  /**
   * One files-list plus per-file content reads. Retains file IDs/metadata so
   * reconcile planning does not issue a duplicate pre-mutation list.
   */
  private async loadSpecBundleState(
    specId: string,
    format: DefinitionFormat
  ): Promise<{
    bundle: DefinitionBundle;
    metas: CloudSpecFileMeta[];
    contentById: Map<string, string>;
  }> {
    if (process.env.POSTMAN_SPEC_TREE_FAST_PATH !== 'off') {
      try {
        const members: Array<{ path: string; type: string; content: string }> = [];
        const metas: CloudSpecFileMeta[] = [];
        const contentById = new Map<string, string>();
        const cursors = new Set<string>();
        let cursor = '';
        for (let page = 0; ; page += 1) {
          if (page >= 100) throw new Error('SPEC_TREE_PAGE_LIMIT_EXCEEDED');
          const tree = await this.gateway.requestJson<JsonRecord>({
            service: 'specification', method: 'get', path: `/specifications/${specId}/tree`,
            query: { fields: 'id,name,type,path,parentId,fileType,content', limit: 100, ...(cursor ? { cursor } : {}) }
          });
          const files = parseSpecTreePage(tree);
          for (const file of files) {
            metas.push({ id: file.id, path: file.path, type: file.type, ...(file.parentId ? { parentId: file.parentId } : {}) });
            contentById.set(file.id, file.content);
            members.push({ path: file.path, type: file.type, content: file.content });
          }
          const next = specTreeNextCursor(tree);
          if (!next) {
            assertNoCloudPathCollisions(metas);
            return { bundle: cloudMembersToDefinitionBundle({ format, members }), metas, contentById };
          }
          if (cursors.has(next)) throw new Error('SPEC_TREE_CURSOR_REPEATED');
          cursors.add(next);
          cursor = next;
        }
      } catch (error) {
        if (
          !(error instanceof HttpError && [403, 404, 405, 501].includes(error.status)) &&
          !(error instanceof Error && error.message === 'SPEC_TREE_INCOMPLETE')
        ) throw error;
      }
    }
    const metas = await collectPagedList<CloudSpecFileMeta>(
      (cursor) =>
        this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'get',
          path: `/specifications/${specId}/files`,
          ...(cursor ? { query: { cursor } } : {})
        }),
      (page) => listFilesFromGatewayResponse(page),
      'SPEC_FILES_LIST'
    );
    assertNoCloudPathCollisions(metas);

    const members: Array<{ path: string; type: string; content: string }> = [];
    const contentById = new Map<string, string>();
    for (const meta of metas) {
      const file = await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'get',
        path: `/specifications/${specId}/files/${meta.id}`,
        query: { fields: 'content' }
      });
      const content = contentFromGatewayFileRead(file);
      if (content === undefined) {
        throw new Error(
          `CONTRACT_DEFINITION_CLOSURE_INCOMPLETE: Spec Hub file ${meta.path} returned no content`
        );
      }
      contentById.set(meta.id, content);
      members.push({ path: meta.path, type: meta.type, content });
    }

    return {
      bundle: cloudMembersToDefinitionBundle({ format, members }),
      metas,
      contentById
    };
  }

  /**
   * Reconcile Spec Hub to the exact target path set. Digest-equal → zero
   * mutations (one initial list only). Changed sets use the capability policy:
   * bulk when bulkModify=true, otherwise ordered per-file fallback. Always
   * full-set readback-verifies after mutation. Non-atomic/ambiguous failures
   * read back and surface rollback-capable verification-needed without blind
   * retries. Root path change throws when rootPathChange=false.
   */
  async reconcileSpecBundle(
    specId: string,
    target: DefinitionBundle
  ): Promise<SpecBundleMutationOutcome> {
    const policy = this.reconcileCapabilityPolicy;
    const priorState = await this.loadSpecBundleState(specId, target.format);
    const prior = priorState.bundle;
    const priorSnapshot = definitionBundleToSnapshot(prior);

    if (prior.digest === target.digest) {
      return {
        status: 'ok',
        changed: false,
        priorSnapshot,
        verifiedDigest: prior.digest
      };
    }

    if (!policy.rootPathChange) {
      assertSameRootPath(prior.rootPath, target.rootPath);
    } else if (prior.rootPath !== target.rootPath) {
      // rootPathChange=true is not live-proven; refuse rather than invent a path.
      throw new Error(
        'CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED: rootPathChange=true is not implemented; clear spec-id to recreate'
      );
    }

    // Reuse IDs/metadata from the initial snapshot/list — no second pre-mutation list.
    const metas = priorState.metas;
    const plan = planSpecFileReconcile({
      cloud: metas,
      cloudContentById: priorState.contentById,
      target
    });

    if (!planHasMutations(plan)) {
      // Path sets matched but digest differed only if content maps were incomplete.
      const verified = await this.getSpecBundle(specId, target.format);
      if (verified.digest === target.digest) {
        return {
          status: 'ok',
          changed: false,
          priorSnapshot,
          verifiedDigest: verified.digest
        };
      }
      throw new Error(
        `Spec Hub bundle verify failed: empty plan but digest still mismatches (expected ${target.digest}, got ${verified.digest})`
      );
    }

    const mutationResult = policy.bulkModify
      ? await this.applyBulkSpecFileReconcile(specId, target, plan, priorSnapshot)
      : await this.applyPerFileSpecFileReconcile(specId, target, plan, metas, priorSnapshot);

    if (mutationResult) return mutationResult;

    const verified = await this.getSpecBundle(specId, target.format);
    if (verified.digest !== target.digest) {
      throw new Error(
        `Spec Hub bundle verify failed after reconcile: expected digest ${target.digest}, got ${verified.digest}`
      );
    }
    return {
      status: 'ok',
      changed: true,
      priorSnapshot,
      verifiedDigest: verified.digest
    };
  }

  /**
   * Atomic/non-atomic bulk path. Always read back before any retry; never blind
   * resend. When atomicBulk=false, definitive HTTP failures still surface
   * verification-needed with the prior snapshot for orchestrator rollback.
   */
  private async applyBulkSpecFileReconcile(
    specId: string,
    target: DefinitionBundle,
    plan: ReturnType<typeof planSpecFileReconcile>,
    priorSnapshot: SpecBundleSnapshot
  ): Promise<SpecBundleMutationOutcome | null> {
    const bulkBody = buildBulkFilesBody(plan);
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'specification',
        method: 'post',
        path: `/specifications/${specId}/bulk-files`,
        retry: 'none',
        body: bulkBody
      });
      return null;
    } catch (error) {
      const readback = await this.getSpecBundle(specId, target.format).catch(() => null);
      if (readback && readback.digest === target.digest) {
        return {
          status: 'ok',
          changed: true,
          priorSnapshot,
          verifiedDigest: readback.digest
        };
      }
      if (isAmbiguousTransportError(error) || !this.reconcileCapabilityPolicy.atomicBulk) {
        return {
          status: 'verification-needed',
          changed: true,
          priorSnapshot,
          targetDigest: target.digest,
          reason: isAmbiguousTransportError(error)
            ? 'ambiguous-bulk-modify'
            : 'non-atomic-bulk-modify',
          cause: error
        };
      }
      throw error;
    }
  }

  /**
   * Per-file fallback order: sorted non-root creates/updates, root content
   * update last, then sorted stale non-root deletes. Each path uses
   * retry:'none'; ambiguous/partial failures read back and return
   * verification-needed without blind retries.
   */
  private async applyPerFileSpecFileReconcile(
    specId: string,
    target: DefinitionBundle,
    plan: ReturnType<typeof planSpecFileReconcile>,
    metas: CloudSpecFileMeta[],
    priorSnapshot: SpecBundleSnapshot
  ): Promise<SpecBundleMutationOutcome | null> {
    const ops = orderPerFileReconcileOps({ plan, cloud: metas });
    try {
      for (const op of ops) {
        if (op.kind === 'create') {
          const parentId = resolvePerFileCreateParentId(metas, op.path);
          await this.gateway.requestJson<JsonRecord>({
            service: 'specification',
            method: 'post',
            path: `/specifications/${specId}/files`,
            retry: 'none',
            body: {
              name: perFileCreateName(op.path),
              content: op.content,
              type: 'DEFAULT',
              ...(parentId ? { parentId } : {})
            }
          });
        } else if (op.kind === 'update') {
          await this.gateway.requestJson<JsonRecord>({
            service: 'specification',
            method: 'patch',
            path: `/specifications/${specId}/files/${op.id}`,
            retry: 'none',
            body: [{ op: 'replace', path: '/content', value: op.content }]
          });
        } else {
          await this.gateway.requestJson<JsonRecord>({
            service: 'specification',
            method: 'delete',
            path: `/specifications/${specId}/files/${op.id}`,
            retry: 'none'
          });
        }
      }
      return null;
    } catch (error) {
      const readback = await this.getSpecBundle(specId, target.format).catch(() => null);
      if (readback && readback.digest === target.digest) {
        return {
          status: 'ok',
          changed: true,
          priorSnapshot,
          verifiedDigest: readback.digest
        };
      }
      return {
        status: 'verification-needed',
        changed: true,
        priorSnapshot,
        targetDigest: target.digest,
        reason: isAmbiguousTransportError(error)
          ? 'ambiguous-per-file-modify'
          : 'per-file-modify-incomplete',
        cause: error
      };
    }
  }

  /**
   * Restore a prior full-set snapshot (orchestrator rollback). Reconciles the
   * snapshot bytes/roles and verifies the snapshot digest.
   */
  async restoreSpecBundle(
    specId: string,
    snapshot: SpecBundleSnapshot
  ): Promise<SpecBundleMutationOutcome> {
    const target = snapshotToDefinitionBundle(snapshot);
    return this.reconcileSpecBundle(specId, target);
  }

  /**
   * Native Spec Hub version tags (branch-aware sync P3.5). Tags attach to the
   * LATEST changelog group; the backend 409s when that group is already tagged
   * (VersionControlService). Callers handle 409 as idempotent-by-group.
   */
  async tagSpecVersion(specId: string, name: string): Promise<{ id: string; name: string }> {
    const trimmed = name.trim().slice(0, 255);
    const created = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'post',
      path: `/specifications/${specId}/tags`,
      retry: 'none',
      body: { name: trimmed }
    });
    const record = asRecord(created?.data) ?? created ?? {};
    return {
      id: String(record.id ?? '').trim(),
      name: String(record.name ?? trimmed).trim()
    };
  }

  /** List a spec's native version tags (newest first per backend ordering). */
  async listSpecVersionTags(specId: string): Promise<Array<{ id: string; name: string }>> {
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'specification',
      method: 'get',
      path: `/specifications/${specId}/tags`,
      query: { limit: '50' }
    });
    const entries = Array.isArray(response?.data) ? (response.data as JsonRecord[]) : [];
    return entries
      .map((value) => asRecord(value))
      .filter((value): value is JsonRecord => value !== null)
      .map((value) => ({
        id: String(value.id ?? '').trim(),
        // listTags returns `message`; createTag returns `name`. Accept both.
        name: String(value.name ?? value.message ?? '').trim()
      }))
      .filter((value) => value.id || value.name);
  }

  /**
   * Resolve a specification's ROOT file uuid via the (paginated) files list.
   *
   * The ROOT file can land on any page, and callers write the whole root
   * document to whatever id comes back — so a page-1-only read can PATCH the
   * root spec over a component file. When no file is typed ROOT, a lone file is
   * accepted as its own root; two or more untyped candidates are ambiguous and
   * fail loudly rather than silently overwriting an arbitrary dependency.
   */
  private async resolveRootFileId(specId: string): Promise<string> {
    const list = await collectPagedList<JsonRecord>(
      (cursor) =>
        this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'get',
          path: `/specifications/${specId}/files`,
          ...(cursor ? { query: { cursor } } : {})
        }),
      (page) => {
        const files = asRecord(page);
        if (Array.isArray(files?.data)) return files!.data as JsonRecord[];
        const nested = asRecord(files?.data);
        return Array.isArray(nested?.files) ? (nested!.files as JsonRecord[]) : [];
      },
      'SPEC_FILES_LIST'
    );
    const roots = list.filter((f) => String(f.type ?? '') === 'ROOT');
    if (roots.length > 1) {
      throw new Error(
        `SPEC_ROOT_FILE_AMBIGUOUS: specification ${specId} reports ${roots.length} ROOT files`
      );
    }
    if (roots.length === 1) return String(roots[0]?.id ?? '').trim();
    if (list.length > 1) {
      throw new Error(
        `SPEC_ROOT_FILE_AMBIGUOUS: specification ${specId} has ${list.length} files and none is typed ROOT`
      );
    }
    return String(list[0]?.id ?? '').trim();
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
    const before = await this.listGeneratedCollectionRefs(specId);
    // A completed prior run has already renamed its generated collection to the
    // final identity. Adopt exactly one such collection before asking Spec Hub
    // to generate again; ambiguity is a hard safety failure.
    const existing = adoptExactMatch(
      `generated-collection:${specId}:${name}`,
      await this.filterGeneratedCollectionsByExactName(before, name),
      (entry) => entry.id
    );
    if (existing) return this.convergeGeneratedCollections(specId, name, existing.id);

    // Spec Hub collection-generation tasks occasionally fail under load; one
    // full re-POST with a fresh temp name absorbs that flake without masking
    // durable contract errors.
    let lastError: Error | undefined;
    for (let taskAttempt = 0; taskAttempt < 2; taskAttempt += 1) {
      const submittedName = `${name} [bootstrap:${this.createIdentity()}]`;
      const body = {
        name: submittedName,
        options: {
          requestNameSource,
          folderStrategy,
          ...(folderStrategy === 'Tags' ? { nestedFolderHierarchy } : {})
        }
      };
      let taskId: string;
      try {
        const generation = await this.postGenerationWithLockRetry(specId, body, name);
        if (generation.adoptedId) {
          return this.convergeGeneratedCollections(specId, name, generation.adoptedId);
        }
        taskId = generation.taskId ?? '';
      } catch (error) {
        if (!isAmbiguousTransportError(error)) throw error;
        const beforeIds = new Set(before.map((entry) => entry.id));
        const matchId = await this.awaitExactAppearedGeneratedCollection(
          specId,
          beforeIds,
          submittedName
        );
        if (matchId) {
          await this.renameGeneratedCollection(matchId, name);
          return this.convergeGeneratedCollections(specId, name, matchId);
        }
        // Ambiguous POST with no exact accepted relation after the settle
        // window: allow the outer loop's one fresh re-POST. Surface on the
        // final attempt so a durable failure is not masked.
        if (taskAttempt === 0) {
          lastError = error instanceof Error ? error : new Error(String(error));
          continue;
        }
        throw error;
      }

      let taskFailed = false;
      if (taskId) {
        const deadline = this.now() + 180_000;
        let observationRetries = 0;
        for (let attempt = 0; attempt < this.generationPollAttempts; attempt += 1) {
          const fixed = process.env.POSTMAN_GENERATION_POLL_MODE === 'fixed';
          const delay = fixed ? this.generationPollDelayMs : Math.min(16_000, 2_000 * Math.pow(2, attempt));
          const remaining = deadline - this.now();
          if (remaining <= 0) throw new Error('COLLECTION_GENERATION_TIMEOUT');
          await this.sleep(Math.min(delay, remaining));
          let task: JsonRecord | null;
          try {
            task = await this.gateway.requestJson<JsonRecord>({
              service: 'specification',
              method: 'get',
              path: '/tasks',
              query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
            });
            observationRetries = 0;
          } catch (error) {
            const notReady = error instanceof HttpError && (error.status === 403 || error.status === 404);
            if (
              notReady &&
              observationRetries < PostmanGatewayAssetsClient.GENERATION_OBSERVATION_MAX_RETRIES &&
              attempt < this.generationPollAttempts - 1
            ) {
              observationRetries += 1;
              this.onRetry?.({ class: 'poll', status: error.status, attempt: observationRetries, delay: 0 });
              continue;
            }
            throw error;
          }
          const status = String(asRecord(task?.data)?.[taskId] ?? '').toLowerCase();
          if (status === 'failed' || status === 'error') {
            taskFailed = true;
            lastError = new Error(`Collection generation task failed for ${prefix}`);
            break;
          }
          if (status && status !== 'in-progress' && status !== 'pending' && status !== 'queued') {
            break;
          }
          if (attempt === this.generationPollAttempts - 1) {
            throw new Error(`COLLECTION_GENERATION_TIMEOUT: Collection generation timed out for ${prefix}`);
          }
          if (this.now() >= deadline) throw new Error('COLLECTION_GENERATION_TIMEOUT');
        }
      }
      if (taskFailed) {
        this.onRetry?.({ class: 'poll', attempt: taskAttempt + 2, delay: 1000 * (taskAttempt + 1) });
        await this.sleep(1000 * (taskAttempt + 1));
        continue;
      }

      const beforeIds = new Set(before.map((entry) => entry.id));
      const uid = await this.awaitExactAppearedGeneratedCollection(
        specId,
        beforeIds,
        submittedName
      );
      if (!uid) {
        // A concurrent runner may rename and converge before this runner sees
        // its own temporary relation, then remove that temp as the loser. The
        // pre-create read proved there was no final identity beforehand, so a
        // sole exact final relation is the peer's converged result.
        const peerFinal = adoptExactMatch(
          `generated-collection:${specId}:${name}`,
          await this.filterGeneratedCollectionsByExactName(
            await this.listGeneratedCollectionRefs(specId),
            name
          ),
          (entry) => entry.id
        );
        if (peerFinal) return this.convergeGeneratedCollections(specId, name, peerFinal.id);
        throw new Error(`Collection generation did not yield a collection uid for ${prefix}`);
      }
      await this.renameGeneratedCollection(uid, name);
      return this.convergeGeneratedCollections(specId, name, uid);
    }
    throw lastError ?? new Error(`Collection generation task failed for ${prefix}`);
  }

  /**
   * Poll Spec Hub collection relations until the exact unique submitted name
   * appears among IDs that were not present before this generation attempt.
   * Never hydrates a collection root and never adopts a nameless peer ID —
   * concurrent branch-aware previews can also appear nameless while enriching.
   */
  private async awaitExactAppearedGeneratedCollection(
    specId: string,
    beforeIds: ReadonlySet<string>,
    submittedName: string
  ): Promise<string | undefined> {
    for (
      let poll = 0;
      poll < PostmanGatewayAssetsClient.GENERATION_RELATION_SETTLE_MAX_POLLS;
      poll += 1
    ) {
      if (poll > 0) {
        await this.sleep(1000);
      }
      const after = await this.listGeneratedCollectionRefs(specId);
      const appeared = after.filter((entry) => !beforeIds.has(entry.id));
      const candidates = await this.filterGeneratedCollectionsByExactName(
        appeared,
        submittedName
      );
      const match = adoptExactMatch(
        `generated-collection:${specId}:${submittedName}`,
        candidates,
        (entry) => entry.id
      );
      if (match) return match.id;
    }
    return undefined;
  }

  /**
   * Re-elect the durable generated collection for a final name. Call after
   * concurrent dual-trigger generates and before description/inject/tag so a
   * peer orphan-sweep cannot leave this runner holding a deleted id.
   */
  async adoptGeneratedCollection(
    specId: string,
    projectName: string,
    prefix: string,
    preferredId = ''
  ): Promise<string> {
    const name = [prefix.trim(), projectName.trim()].filter(Boolean).join(' ');
    return this.convergeGeneratedCollections(specId, name, preferredId);
  }

  async waitForGeneratedCollectionLinks(
    specId: string,
    collectionIds: string[]
  ): Promise<void> {
    const expected = new Set(collectionIds.map((id) => this.bareModelId(id)).filter(Boolean));
    if (expected.size === 0) return;
    let consecutive = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const linked = new Set(
        (await this.listGeneratedCollectionRefs(specId))
          .map((entry) => this.bareModelId(entry.id))
          .filter(Boolean)
      );
      if ([...expected].every((id) => linked.has(id))) {
        consecutive += 1;
        if (consecutive >= 2) return;
      } else {
        consecutive = 0;
      }
      if (attempt < 11) await this.sleep(1000);
    }
    throw new Error(
      `CONTRACT_COLLECTION_LINK_NOT_STABLE: generated collections ${[...expected].join(', ')} did not stabilize on specification ${specId}`
    );
  }

  /**
   * Concurrent dual-trigger previews can each generate+rename the same final
   * collection identity. Elect the stable lowest-id winner.
   *
   * Losers only delete *their own* preferred collection. Winners wait briefly
   * for peers to self-delete, but never delete a peer-owned id that may still be
   * in use. Abandoned peer artifacts are left to preview GC.
   */
  private async convergeGeneratedCollections(
    specId: string,
    finalName: string,
    preferredId: string
  ): Promise<string> {
    const tempPrefix = `${finalName} [bootstrap:`;
    const preferredModelId = this.bareModelId(preferredId);
    const listKnownIdentities = async () => {
      const linked = await this.listGeneratedCollectionRefs(specId);
      return linked.map((entry) => {
        if (entry.name) return { id: entry.id, name: entry.name };
        // The caller has already renamed its preferred collection. Keep that
        // identity during transient Spec Hub name-enrichment lag, but never
        // infer or delete another nameless relation.
        if (preferredModelId && this.bareModelId(entry.id) === preferredModelId) {
          return { id: entry.id, name: finalName };
        }
        return { id: entry.id, name: '' };
      });
    };

    const selectSameIdentity = (
      entries: Array<{ id: string; name: string }>
    ) =>
      entries
        .filter(
          (entry) =>
            entry.name === finalName || entry.name.startsWith(tempPrefix)
        )
        .sort((a, b) => a.id.localeCompare(b.id));

    let sameIdentity = selectSameIdentity(await listKnownIdentities());
    if (sameIdentity.length === 0) return preferredId;

    // Solo observation is not final under dual-trigger: a peer may still be
    // renaming its temp into this identity. One short settle catches that.
    if (sameIdentity.length === 1) {
      await this.sleep(1000);
      sameIdentity = selectSameIdentity(await listKnownIdentities());
      if (sameIdentity.length === 0) return preferredId;
    }

    const winner = sameIdentity[0];
    if (winner.name !== finalName) {
      await this.renameGeneratedCollection(winner.id, finalName);
    }

    const preferredBare = this.bareModelId(preferredId);
    const winnerBare = this.bareModelId(winner.id);
    if (preferredId && preferredBare && preferredBare !== winnerBare) {
      // We lost the election: drop only our own collection so a peer still
      // injecting/tagging its preferred id is not deleted out from under it.
      // Compare via bare model id — never treat bare vs canonical as a peer loss.
      const own = sameIdentity.find((entry) => this.bareModelId(entry.id) === preferredBare);
      if (own) {
        try {
          await this.deleteCollection(own.id);
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        }
      }
      return winner.id;
    }

    // We won (including bare Sync id matching canonical inventory uid). Observe
    // boundedly for peers to self-delete, but never remove an id we did not create.
    if (sameIdentity.length > 1) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await this.sleep(250 * (attempt + 1));
        sameIdentity = selectSameIdentity(await listKnownIdentities());
        if (sameIdentity.length <= 1) break;
      }
    }
    return winner.id;
  }

  /** POST the generation request, retrying a 423-locked spec; returns the task id. */
  private async postGenerationWithLockRetry(
    specId: string,
    body: unknown,
    finalName: string
  ): Promise<{ taskId?: string; adoptedId?: string }> {
    for (let lockedAttempt = 0; ; lockedAttempt += 1) {
      try {
        const created = await this.gateway.requestJson<JsonRecord>({
          service: 'specification',
          method: 'post',
          path: `/specifications/${specId}/collections`,
          retry: 'none',
          body
        });
        return { taskId: String(asRecord(created?.data)?.taskId ?? '').trim() };
      } catch (error) {
        const locked = error instanceof HttpError && error.status === 423;
        if (!locked || lockedAttempt >= PostmanGatewayAssetsClient.GENERATION_LOCKED_MAX_RETRIES) {
          throw error;
        }
        const delay = 5000 * Math.pow(2, lockedAttempt);
        this.onRetry?.({ class: 'poll', status: error.status, attempt: lockedAttempt + 2, delay });
        await this.sleep(delay);
        const adopted = adoptExactMatch(
          `generated-collection:${specId}:${finalName}`,
          await this.filterGeneratedCollectionsByExactName(
            await this.listGeneratedCollectionRefs(specId),
            finalName
          ),
          (entry) => entry.id
        );
        if (adopted) return { adoptedId: adopted.id };
      }
    }
  }

  private async listGeneratedCollectionRefs(
    specId: string
  ): Promise<Array<{ id: string; name?: string }>> {
    const readRelationPage = async (cursor: string): Promise<JsonRecord | null> => {
      for (
        let attempt = 0;
        attempt <= PostmanGatewayAssetsClient.GENERATION_OBSERVATION_MAX_RETRIES;
        attempt += 1
      ) {
        try {
          return await this.gateway.requestJson<JsonRecord>({
            service: 'specification',
            method: 'get',
            path: `/specifications/${specId}/collections`,
            query: { fields: 'syncOptions,options', ...(cursor ? { cursor } : {}) }
          });
        } catch (error) {
          if (
            !(error instanceof HttpError && error.status === 404) ||
            attempt === PostmanGatewayAssetsClient.GENERATION_OBSERVATION_MAX_RETRIES
          ) {
            throw error;
          }
          this.onRetry?.({ class: 'poll', status: error.status, attempt: attempt + 2, delay: 1000 });
          await this.sleep(1000);
        }
      }
      return null;
    };
    const entries = await collectPagedList(
      (cursor) => readRelationPage(cursor),
      (page) => (Array.isArray(asRecord(page)?.data) ? (asRecord(page)!.data as unknown[]) : []),
      'SPEC_COLLECTION_RELATIONS'
    );
    const results: Array<{ id: string; name?: string }> = [];
    for (const raw of entries) {
      const entry = asRecord(raw);
      const id = String(entry?.collection ?? entry?.collectionId ?? entry?.id ?? entry?.uid ?? '').trim();
      if (!id) continue;
      const entryName = String(entry?.name ?? entry?.title ?? '').trim();
      results.push({ id, ...(entryName ? { name: entryName } : {}) });
    }
    const hydrated = await Promise.all(results.map(async (entry) => {
      if (entry.name) return entry;
      const name = await this.readGeneratedCollectionName(entry.id);
      return { id: entry.id, ...(name ? { name } : {}) };
    }));
    return hydrated.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async readGeneratedCollectionName(collectionId: string): Promise<string | undefined> {
    const path =
      `/collection/${encodeURIComponent(collectionId)}/sync` +
      '?since_id=0&favorite=true&exclude=response%2Crequest';
    try {
      const response = await this.gateway.requestDirectJson<JsonRecord>(path);
      const entities = Array.isArray(response?.entities) ? response.entities : [];
      const first = asRecord(entities[0]);
      const data = asRecord(first?.data);
      return String(data?.name ?? '').trim() || undefined;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async filterGeneratedCollectionsByExactName(
    entries: Array<{ id: string; name?: string }>,
    expectedName: string
  ): Promise<Array<{ id: string; name: string }>> {
    return entries.flatMap((entry) =>
      entry.name === expectedName ? [{ id: entry.id, name: entry.name }] : []
    );
  }

  private async renameGeneratedCollection(collectionId: string, name: string): Promise<void> {
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'patch',
        path: `/v3/collections/${this.collectionRootId(collectionId)}`,
        // Replacing a generated collection's name with the same value is idempotent.
        retry: 'safe',
        body: [{ op: 'replace', path: '/name', value: name }]
      });
    } catch (error) {
      // Eventual list consistency can make converge re-issue the final rename
      // after the name is already correct; treat no-op patch as success.
      if (
        error instanceof HttpError &&
        error.status === 400 &&
        /must update at least one|REJECTED_PATCH/i.test(
          `${error.message}\n${error.responseBody ?? ''}`
        )
      ) {
        return;
      }
      throw error;
    }
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
  async createWorkspace(
    name: string,
    _about: string,
    targetTeamId?: number
  ): Promise<{ id: string; reconciled?: boolean }> {
    void _about;

    if (targetTeamId != null) {
      const squadId = String(targetTeamId);
      this.configureTeamContext(squadId, true);
      let created: JsonRecord | null;
      let createdByThisRun = true;
      try {
        created = await this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'post',
        path: '/workspaces',
        retry: 'none',
        body: {
          name,
          visibilityStatus: 'team',
          squad: targetTeamId,
          roles: {
            group: { [squadId]: ['WORKSPACE_VIEWER_V9'] }
          }
        }
        });
      } catch (error) {
        if (!isAmbiguousTransportError(error)) throw error;
        const match = adoptExactMatch(
          `workspace:${name}`,
          await this.findWorkspacesByName(name),
          (entry) => entry.id
        );
        if (!match) throw error;
        createdByThisRun = false;
        created = { data: { id: match.id } };
      }
      const workspaceId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
      if (!workspaceId) {
        throw new Error('Workspace create did not return an id');
      }

      const visibility = await this.getWorkspaceVisibility(workspaceId);
      if (visibility !== 'team') {
        if (createdByThisRun) {
          await this.deleteWorkspace(workspaceId).catch(() => undefined);
        }
        throw new Error(
          `Workspace ${workspaceId} was created but team visibility could not be verified (got '${visibility ?? 'unknown'}').`
        );
      }

      return { id: workspaceId, ...(!createdByThisRun ? { reconciled: true } : {}) };
    }

    let created: JsonRecord | null;
    let createdByThisRun = true;
    try {
      created = await this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'post',
        path: '/workspaces',
        retry: 'none',
        body: { name, visibilityStatus: 'personal' }
      });
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const match = adoptExactMatch(
        `workspace:${name}`,
        await this.findWorkspacesByName(name),
        (entry) => entry.id
      );
      if (!match) throw error;
      createdByThisRun = false;
      created = { data: { id: match.id } };
    }
    const workspaceId = String(asRecord(created?.data)?.id ?? created?.id ?? '').trim();
    if (!workspaceId) {
      throw new Error('Workspace create did not return an id');
    }

    if (!createdByThisRun) {
      const visibility = await this.getWorkspaceVisibility(workspaceId);
      if (visibility !== 'team') {
        throw new Error(
          `Workspace ${workspaceId} matched an ambiguous create by name but is not team-visible; refusing to mutate or delete an unowned workspace.`
        );
      }
      return { id: workspaceId, reconciled: true };
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
    const all = await collectPagedList(
      (cursor) => this.gateway.requestJson<JsonRecord>({
        service: 'workspaces',
        method: 'get',
        path: '/workspaces',
        ...(cursor ? { query: { cursor } } : {})
      }),
      (response) => {
        const data = asRecord(response);
        const page = Array.isArray(data?.data)
          ? (data.data as unknown[])
          : Array.isArray(data?.workspaces)
            ? (data.workspaces as unknown[])
            : [];
        return page.flatMap((entry) => {
          const record = asRecord(entry);
          return record?.id && record?.name ? [record] : [];
        });
      },
      'WORKSPACE'
    );

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
  // These retire bootstrap's last asset-op PMAK dependencies. Collection ROOT
  // routes (GET/PATCH `/v3/collections/:id`) must use the FULL public uid
  // (`<owner>-<uuid>`): bare model ids are rejected 403 FORBIDDEN (live-proven
  // 2026-08-03 on non-org team 10490519 and org team 172912 — the same ACL
  // tightening that reached the items surface on 2026-07-14). `/export` and
  // DELETE still accept the bare id (same 2026-08-03 live A/B: bare=200) but
  // are addressed by the full uid too whenever the caller holds one, so a
  // single vocabulary covers the whole collection service and those routes
  // stay safe if the tightening spreads again.
  // Collection ITEMS routes (`/v3/collections/:id/items/...`) must use the FULL
  // public uid (live-proven 2026-07-14 on team 172912 / Northwind — immediate
  // post-generation `GET .../items/` returns 403 FORBIDDEN with bare id).
  // The tagging service is distinct and takes the FULL uid.
  // Sync routes (`/collection/import`, `/collection/deepupdate/:id`) keep the
  // BARE model id, which is also the form the import envelope returns.

  /**
   * `<owner>-<uuid>` public uid -> bare `<uuid>` model id. Used for the SYNC
   * routes and for identity comparison only — never to build a collection ROOT
   * or ITEMS URL. Strip ONLY the numeric owner prefix of a full public uid; a
   * bare UUID (which itself contains hyphens) must pass through unchanged, so a
   * naive split on the first hyphen — which would lop off a UUID's first
   * segment — is rejected here in favour of an anchored `<digits>-<uuid>` match.
   */
  private bareModelId(uid: string): string {
    return normalizeCollectionModelIdentity(uid);
  }

  /**
   * Collection id for ROOT routes (`GET`/`PATCH /v3/collections/:id`). Preserve
   * legacy non-UUID aliases, but reject a known bare UUID locally: production
   * rejects that shape 403, so callers must resolve it through inventory first.
   */
  private collectionRootId(uid: string): string {
    const id = String(uid ?? '').trim();
    if (isBareCollectionUuid(id)) {
      throw new Error(
        'COLLECTION_ROOT_UID_REQUIRED: a bare collection model id cannot address Collection ROOT'
      );
    }
    return id;
  }

  /**
   * Resolve a collection's ROOT-addressable id from workspace inventory — the
   * only surface that carries the numeric owner prefix. The prefix is not
   * derivable from a bare uuid, and inferring it from the service-account
   * identity would be a guess (the collection owner is not necessarily the
   * caller), so inventory is the sole authority here.
   *
   * A ROOT-addressable input is returned unchanged without spending a read. A
   * bare model id is polled across `delays` until inventory reports the exact
   * normalized identity, absorbing import read-after-write lag rather than
   * letting a bare id reach a route that would reject it 403.
   *
   * Returns `undefined` only when the identity never became inventory-visible
   * within the budget (or inventory stayed unreadable throughout) — the caller
   * decides how to fail, since there is no safe bare-id fallback.
   */
  private async resolveCollectionRootUid(
    workspaceId: string,
    collectionId: string,
    delays: readonly number[],
    retryPolicy: 'safe' | 'rate-limit' | 'none' = 'safe',
    peerDelayCount = delays.length
  ): Promise<ImportRootResolution> {
    const started = this.now();
    const id = String(collectionId ?? '').trim();
    const targetIdentity = normalizeCollectionModelIdentity(id);
    const cursor = this.createImportSettleCursor(
      workspaceId,
      targetIdentity,
      delays,
      peerDelayCount
    );
    const observer = this.workspaceInventoryObserver(workspaceId);
    let resolvedRow: WorkspaceInventoryRow | undefined;
    try {
      do {
        const observation = await observer.observe(cursor, retryPolicy);
        const match = observation.rows?.find(
          (entry) => normalizeCollectionModelIdentity(entry.id) === targetIdentity
        );
        // Inventory sometimes exposes only the bare model id. That confirms the
        // identity exists but is not ROOT-addressable, so keep polling for the
        // owner-prefixed public uid rather than sending a forbidden ROOT request.
        if (match && (!isBareCollectionUuid(id) || isFullPublicCollectionUid(match.id))) {
          resolvedRow = match;
          break;
        }
      } while (await observer.consumeDelay(cursor));
      return {
        rootUid: !id ? undefined : isBareCollectionUuid(id) ? resolvedRow?.id : id,
        resolvedRow,
        observations: cursor.observations,
        cursor
      };
    } finally {
      this.writeMetrics.rootResolveMs += Math.max(0, this.now() - started);
    }
  }

  private createImportSettleCursor(
    workspaceId: string,
    identity: string,
    delays: readonly number[],
    peerDelayCount: number
  ): ImportSettleCursor {
    return {
      workspaceId,
      identity,
      delays,
      peerDelayCount: Math.min(delays.length, peerDelayCount),
      observations: [],
      nextDelayIndex: 0
    };
  }

  private workspaceInventoryObserver(workspaceId: string): WorkspaceInventoryObserver {
    let observer = this.workspaceInventoryObservers.get(workspaceId);
    if (!observer) {
      observer = new MemoizedWorkspaceInventoryObserver(
        (retryPolicy) => this.listWorkspaceCollections(workspaceId, retryPolicy),
        this.sleep,
        () => { this.writeMetrics.inventoryReads += 1; },
        (delayMs) => { this.writeMetrics.inventorySleepMs += delayMs; }
      );
      this.workspaceInventoryObservers.set(workspaceId, observer);
    }
    return observer;
  }

  private async withImportMutation<T>(mutation: () => Promise<T>): Promise<T> {
    if (this.activeImportMutations >= 2) {
      await new Promise<void>((resolve) => this.importMutationWaiters.push(resolve));
    }
    this.activeImportMutations += 1;
    try {
      return await mutation();
    } finally {
      this.activeImportMutations -= 1;
      this.importMutationWaiters.shift()?.();
    }
  }

  /**
   * Ambiguous whole-tree write visibility budget: one immediate export plus at
   * most four 2.5 second re-exports, for a 10 second budget. A client abort says
   * the response is unknown, not that the server rejected the write, so the
   * desired digest is polled before any decision to resend or fail.
   */
  private static readonly AMBIGUOUS_WRITE_VERIFY_DELAYS_MS: readonly number[] = [2500, 2500, 2500, 2500];

  private readonly writeMetrics: CollectionWriteMetrics = {
    ambiguousWrites: 0,
    convergedWithoutResend: 0,
    resendCount: 0,
    verifyPolls: 0,
    recoveryMs: 0,
    inventoryReads: 0,
    inventorySleepMs: 0,
    rootResolveMs: 0,
    renameMs: 0,
    electionMs: 0,
    deltaOpsByKind: { create: 0, patch: 0, move: 0, delete: 0 },
    deltaRoutes: [],
    changedBytes: 0,
    deltaMs: 0,
    fallbackReasons: []
  };

  /** Snapshot of sanitized convergence counters. Never carries collection content. */
  get collectionWriteMetrics(): CollectionWriteMetrics {
    return {
      ...this.writeMetrics,
      deltaOpsByKind: { ...this.writeMetrics.deltaOpsByKind },
      deltaRoutes: [...this.writeMetrics.deltaRoutes],
      fallbackReasons: [...this.writeMetrics.fallbackReasons]
    };
  }

  /**
   * Bounded export/digest visibility poll used only after an ambiguous write.
   * Returns whether the desired semantic digest became visible and how many
   * export observations were spent. An unreadable export burns one observation
   * rather than aborting the budget.
   */
  private async awaitExportedDigest(
    uid: string,
    digest: string
  ): Promise<{ converged: boolean; polls: number; observed?: unknown }> {
    const delays = PostmanGatewayAssetsClient.AMBIGUOUS_WRITE_VERIFY_DELAYS_MS;
    let polls = 0;
    let observed: unknown;
    for (let observation = 0; observation <= delays.length; observation += 1) {
      polls += 1;
      try {
        observed = await this.exportV2Collection(uid);
        if (computePayloadDigest(asRecord(observed) ?? {}) === digest) {
          return { converged: true, polls, observed };
        }
      } catch {
        // Export unreadable on this observation; spend the remaining budget.
      }
      if (observation < delays.length) {
        await this.sleep(delays[observation]!);
      }
    }
    return { converged: false, polls, observed };
  }

  /**
   * Collection id for ITEMS routes. Prefer the full public uid; fall back to the
   * trimmed input when the caller already has a bare/model id.
   */
  private collectionItemsId(uid: string): string {
    return String(uid ?? '').trim();
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
          retry: 'safe',
          headers: { 'X-Entity-Type': entityType },
          body: [{ op: 'add', path: '/scripts', value: scripts }]
        });
        return;
      } catch (error) {
        const retriable = error instanceof HttpError && (error.status === 404 || error.status >= 500);
        if (!retriable || attempt === maxAttempts - 1) {
          throw error;
        }
        const delay = fullJitterDelayMs(attempt, 300, 2000, this.random);
        this.onRetry?.({ class: 'poll', status: error.status, attempt: attempt + 2, delay });
        await this.sleep(delay);
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
    // PUT is idempotent (replace tag set). Concurrent dual-trigger previews can
    // race the tagging service into transient 500s; safe-retry absorbs those.
    await this.gateway.requestJson<JsonRecord>({
      service: 'tagging',
      method: 'put',
      path: `/v1/tags/collections/${collectionUid}`,
      retry: 'safe',
      body: { tags: normalized.map((slug) => ({ slug })) }
    });
  }

  /**
   * Inject smoke-test assertions into every leaf request of a spec-generated
   * collection, over the v3 collection-items surface (no PMAK):
   *   1. `GET /v3/collections/:cid/items/` (FULL public uid, trailing slash) — flat list.
   *   2. for each `http-request` leaf, `PATCH /v3/collections/:cid/items/:itemId`
   *      (full uid for `:cid` and `:itemId`, `X-Entity-Type: http-request` header) with a
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
  async injectTests(
    collectionUid: string,
    type: 'smoke',
    resolverProvider: SecretsResolverProvider = 'none'
  ): Promise<void> {
    void type;
    const cid = this.collectionItemsId(collectionUid);
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
        retry: 'safe',
        headers: { 'X-Entity-Type': 'http-request' },
        body: [{ op: 'add', path: '/scripts', value: toV3Scripts(smokeTests) }]
      });
    }

    // Opt-in: no provider selected means no resolver helper is created at all.
    if (!isSecretsResolverEnabled(resolverProvider)) return;
    // Idempotent: skip if a prior run already created the secrets resolver.
    if (items.some((i) => isSecretsResolverItemName(i.name))) return;
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
        ...createSecretsResolverV3Body(resolverProvider),
        position: { parent: { id: cid, $kind: 'collection' } }
      }
    });
    // List + create echo item ids as full uids; items routes want full uids for
    // both `:cid` and `:itemId` — use the created id verbatim, do NOT bare it.
    const newItemId = String(asRecord(created?.data)?.id ?? '').trim();
    if (!newItemId) return;
    // Attach the secrets-resolution test script (CI-skipped) as a canonical v3
    // afterResponse script — same `/scripts` shape as the leaf assertions.
    await this.patchNewItemScripts(
      cid,
      newItemId,
      toV3Scripts(createSecretsResolverExec(resolverProvider))
    );
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
   *   1. `GET /v3/collections/:cid/items/` — flat item list (FULL public uid for `:cid`).
   *   2. `GET /v3/collections/:cid/items/:itemId` (`X-Entity-Type: http-request`)
   *      — the full v3 IR record (method/url/headers/body) the matcher needs.
   *   3. `planContractItemScripts` matches each request to its OpenAPI operation
   *      and builds the consolidated collection-root `test` script(s) plus any
   *      request-level mapping-failure scripts, enforcing coverage + duplicates.
   *   4. `PATCH /v3/collections/:cid/items/:itemId` `/scripts` for mapping
   *      failures, `PATCH /v3/collections/:cid` `/scripts` for the shared
   *      validator, then prepend the idempotent `00 - Resolve Secrets` item.
   * Returns the non-fatal instrumentation warnings for the caller to surface.
   */
  async injectContractTests(
    collectionUid: string,
    index: ContractIndex,
    resolverProvider: SecretsResolverProvider = 'none'
  ): Promise<string[]> {
    const cid = this.collectionItemsId(collectionUid);
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
      try {
        await this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${cid}/items/${script.itemId}`,
          retry: 'safe',
          headers: { 'X-Entity-Type': 'http-request' },
          body: [{ op: 'add', path: '/scripts', value: toV3Scripts(script.exec) }]
        });
      } catch (error) {
        // Idempotent rerun: the item already carries the exact script we are
        // adding, so the server rejects the patch as a no-op. Treat as success.
        if (isRejectedPatchError(error)) continue;
        throw error;
      }
    }
    // Consolidated shared validator rides the collection root. `add /scripts`
    // overwrites wholesale, so a rerun converges instead of accumulating.
    if (plan.rootScripts.length > 0) {
      const rootScripts = plan.rootScripts.map((exec) => ({
        type: 'afterResponse',
        code: exec.join('\n'),
        language: 'text/javascript'
      }));
      try {
        await this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${this.collectionRootId(collectionUid)}`,
          retry: 'safe',
          body: [{ op: 'add', path: '/scripts', value: this.toRootScripts(rootScripts) }]
        });
      } catch (error) {
        // Idempotent rerun: the root already carries these exact scripts.
        if (!isRejectedPatchError(error)) throw error;
      }
    }
    // Opt-in: no provider selected means no resolver helper is created at all.
    // Idempotent: skip if a prior run already created the secrets resolver.
    if (
      isSecretsResolverEnabled(resolverProvider) &&
      !items.some((i) => isSecretsResolverItemName(i.name))
    ) {
      const created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: {
          ...createSecretsResolverV3Body(resolverProvider),
          position: { parent: { id: cid, $kind: 'collection' } }
        }
      });
      const newItemId = String(asRecord(created?.data)?.id ?? '').trim();
      if (newItemId) {
        await this.patchNewItemScripts(
          cid,
          newItemId,
          toV3Scripts(createSecretsResolverExec(resolverProvider))
        );
      }
    }

    return plan.warnings;
  }

  async deleteCollection(collectionUid: string): Promise<void> {
    // DELETE is NOT part of the ROOT GET/PATCH ACL tightening: it accepts the
    // bare model id (2026-08-03 live A/B: bare=200). Keep the bare vocabulary
    // that is actually live-proven — journaled cleanup ids can be bare, and
    // rewriting this route on speculation would change a proven-good call.
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
    const v3 = convertV2CollectionToV3Model(v2Collection);
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
  private buildItemCreateBody(
    item: JsonRecord,
    parentId: string,
    parentKind: CollectionDeltaOperation['entityType'] = 'collection'
  ): JsonRecord {
    const kind = String(item.$kind ?? 'http-request');
    const body: JsonRecord = {
      $kind: kind,
      name: String(item.name ?? 'Untitled'),
      position: { parent: { id: parentId, $kind: parentKind } }
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
    if (kind === 'http-example') {
      if (item.request && typeof item.request === 'object') body.request = item.request;
      if (item.response && typeof item.response === 'object') body.response = item.response;
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
      // Retry only a 5xx/timeout that did NOT commit server-side (adopt finds no
      // match). A committed 5xx is adopted below; a 4xx rejection surfaces at once.
      // A downstream `500 ESOCKETTIMEDOUT` (live-observed on shared gateway under
      // concurrent load) is exactly this transient, uncommitted case.
      const maxAttempts = 4;
      let newId = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let created: JsonRecord | null;
        try {
          created = await this.gateway.requestJson<JsonRecord>({
            service: 'collection',
            method: 'post',
            path: `/v3/collections/${cid}/items/`,
            retry: 'none',
            // The transport's cold /_api fallback only fires after the primary
            // budget is exhausted; by then this loop has reconciled the item as
            // absent (match == null), so a fallback resend cannot duplicate a
            // committed create.
            fallback: 'auto',
            headers: { 'X-Entity-Type': kind },
            body: this.buildItemCreateBody(item, parentId)
          });
        } catch (error) {
          if (!isAmbiguousTransportError(error)) throw error;
          const name = String(item.name ?? 'Untitled');
          const findCommittedItem = async () => {
            const matches = (await this.listCollectionItems(cid)).filter((candidate) => {
              if (String(candidate.name ?? candidate.title ?? '') !== name) return false;
              if (String(candidate.$kind ?? candidate.type ?? 'http-request') !== kind) return false;
              const position = asRecord(candidate.position);
              const parent = asRecord(position?.parent);
              const candidateParent = String(parent?.id ?? position?.parent ?? candidate.parent ?? '').trim();
              return Boolean(candidateParent) &&
                this.bareModelId(candidateParent) === this.bareModelId(parentId);
            });
            return adoptExactMatch(
              `collection-item:${cid}:${parentId}:${kind}:${name}`,
              matches,
              (candidate) => String(candidate.id ?? '')
            );
          };
          let match = await findCommittedItem();
          if (!match) {
            // The create may have committed on a replica the first list read has
            // not caught up to yet. Wait the jittered backoff, then reconcile
            // once more before resending (or surfacing) - a blind re-POST here
            // would duplicate a late-visible item.
            await this.sleep(fullJitterDelayMs(attempt - 1, 300, 2000, this.random));
            match = await findCommittedItem();
          }
          if (match) {
            created = { data: { id: match.id } };
          } else {
            // Not committed server-side. Retry through the transient 5xx; only
            // surface after the bounded budget is exhausted. The backoff was
            // already taken between the two reconciliation reads above.
            const retriable = error instanceof HttpError && error.status >= 500;
            if (!retriable || attempt === maxAttempts) throw error;
            this.onRetry?.({
              class: 'poll',
              status: error instanceof HttpError ? error.status : undefined,
              attempt: attempt + 1,
              delay: 0
            });
            continue;
          }
        }
        newId = String(asRecord(created?.data)?.id ?? '').trim();
        if (newId) break;
      }
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
    const flattened: JsonRecord[] = [];
    const visit = (entries: unknown[], path: string): void => {
      entries.forEach((entry, index) => {
        const item = asRecord(entry);
        const itemId = String(item?.id ?? '').trim();
        if (!item || !itemId) {
          throw new Error(`Existing collection item listing entry ${path}${index} did not return an id`);
        }
        flattened.push(item);
        if (item.items !== undefined && !Array.isArray(item.items)) {
          throw new Error(`Existing collection item listing entry ${path}${index}.items was not an array`);
        }
        if (Array.isArray(item.items)) visit(item.items, `${path}${index}.items.`);
      });
    };
    visit(listed.data, '');
    return flattened;
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
  /**
   * GET a collection root, retrying through the v3 surface's read-after-write
   * 404 lag. A freshly generated/renamed collection can transiently report
   * RESOURCE_NOT_FOUND for a few seconds (worse under concurrent runner load);
   * retrying absorbs that instead of hard-failing the run.
   */
  private async getCollectionRoot(cid: string): Promise<JsonRecord | null> {
    const got = await retry(
      () =>
        this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'get',
          path: `/v3/collections/${cid}`,
          retry: 'none'
        }),
      {
        maxAttempts: 6,
        delayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 8000,
        sleep: this.sleep,
        onRetry: ({ attempt, delayMs, error }) => this.onRetry?.({
          class: 'poll',
          status: error instanceof HttpError ? error.status : undefined,
          attempt: attempt + 1,
          delay: delayMs
        }),
        shouldRetry: (error) => error instanceof HttpError && error.status === 404
      }
    );
    return asRecord(got?.data);
  }

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
      current = await this.getCollectionRoot(cid);
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
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'patch',
        path: `/v3/collections/${cid}`,
        // Fixed-path add/replace ops are idempotent, and a remove that already
        // committed is reconciled below, so transient downstream timeouts
        // (ESOCKETTIMEDOUT) are safe to retry.
        retry: 'safe',
        body: ops
      });
    } catch (error) {
      // A retried PATCH whose first attempt actually committed fails its
      // removes as already-applied — but that 400 only proves one remove
      // target is absent, not that the whole batch landed. Read the root back
      // and only report success when every intended op's end state holds.
      if (
        isMissingPatchValueError(error) &&
        ops.some((op) => op.op === 'remove') &&
        (await this.verifyRootSettingsApplied(cid, ops))
      ) {
        return;
      }
      // Generic no-op rejection (add/replace with same value, or a batch the
      // server considers already applied): verify the end state holds and
      // treat as success when it does.
      if (
        isRejectedPatchError(error) &&
        (await this.verifyRootSettingsApplied(cid, ops))
      ) {
        return;
      }
      throw error;
    }
  }

  /**
   * Read the collection root and check that every JSON-Patch op's intended end
   * state holds. add/replace targets must be structurally equal to the exact
   * requested value (a stale pre-PATCH description/auth/variables/scripts is
   * non-null but not equal, so it can never falsely verify); remove targets must
   * be absent (description clears to "" rather than disappearing).
   */
  private async verifyRootSettingsApplied(cid: string, ops: JsonRecord[]): Promise<boolean> {
    let current: JsonRecord | null;
    try {
      const got = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'get',
        path: `/v3/collections/${cid}`
      });
      current = asRecord(got?.data);
    } catch {
      return false;
    }
    if (!current) return false;
    for (const op of ops) {
      const rawPath = String(op.path ?? '');
      const field = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
      if (!field) return false;
      const value = current[field];
      if (op.op === 'remove') {
        if (field === 'description') {
          if (typeof value === 'string' && value.length > 0) return false;
        } else if (!(value === undefined || value === null || (Array.isArray(value) && value.length === 0))) {
          return false;
        }
      } else {
        // add / replace: the committed value must structurally equal what we
        // requested, not merely be present. Presence-only would accept a stale
        // pre-PATCH value after a retried-timeout batch.
        if (value === undefined || value === null) return false;
        if (!deepEqual(value, op.value)) return false;
      }
    }
    return true;
  }

  /**
   * Create a curated local v2.1.0 or collection v3 payload through the gateway v3 write
   * surface. Returns the full uid (same format `generateCollection` returns),
   * so callers can persist it and pass it straight to `updateCollection`/
   * `deleteCollection`/`tagCollection`/`injectTests` unchanged.
   */
  async findCollectionsByExactName(
    workspaceId: string,
    name: string,
    retryPolicy?: 'safe' | 'rate-limit' | 'none'
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    const entries = await this.listWorkspaceCollections(workspaceId, retryPolicy);
    return entries
      .filter((value) => value.name === name)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async listWorkspaceCollections(
    workspaceId: string,
    retryPolicy?: 'safe' | 'rate-limit' | 'none'
  ): Promise<Array<{ id: string; name: string; description?: string }>> {
    const entries = await collectPagedList(
      (cursor) =>
        this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'get',
          path: `/v3/collections/?workspace=${workspaceId}`,
          ...(cursor ? { query: { cursor } } : {}),
          ...(retryPolicy ? { retry: retryPolicy } : {})
        }),
      (page) => (Array.isArray(asRecord(page)?.data) ? (asRecord(page)!.data as unknown[]) : []),
      'COLLECTION_LIST'
    );
    return entries
      .map((value) => asRecord(value))
      .filter((value): value is JsonRecord => value !== null)
      .map((value) => ({
        id: String(value.id ?? value.uid ?? '').trim(),
        name: String(value.name ?? value.title ?? '').trim(),
        ...(String(value.description ?? '').trim()
          ? { description: String(value.description).trim() }
          : {})
      }))
      .filter((value) => value.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async createCollection(
    workspaceId: string,
    collection: unknown,
    options: { onRootCreated?: (id: string) => void | Promise<void> } = {}
  ): Promise<string> {
    const v3 = this.normalizeCollectionForWrite(collection);
    // Root create accepts name only; description/auth/variables/scripts are applied
    // via JSON Patch in applyCollectionLevelSettings (live-proven). Putting
    // description on the POST body makes a later add /description a no-op that
    // can 400 when the patch set is otherwise empty or redundant.
    const desiredName = String(v3.name ?? 'Untitled Collection');
    const existing = adoptExactMatch(
      `collection:${workspaceId}:${desiredName}`,
      await this.findCollectionsByExactName(workspaceId, desiredName),
      (entry) => entry.id
    );
    if (existing) {
      await this.updateCollection(existing.id, collection);
      return existing.id;
    }
    const submittedName = `${desiredName} [bootstrap:${this.createIdentity()}]`;
    const rootBody: JsonRecord = { name: submittedName };
    let created: JsonRecord | null;
    try {
      created = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'post',
        path: `/v3/collections/?workspace=${workspaceId}`,
        retry: 'none',
        headers: { 'X-Entity-Target': 'http' },
        body: rootBody
      });
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const match = adoptExactMatch(
        `collection:${workspaceId}:${String(rootBody.name)}`,
        await this.findCollectionsByExactName(workspaceId, String(rootBody.name)),
        (entry) => entry.id
      );
      if (!match) throw error;
      created = { data: { id: match.id } };
    }
    const rawId = String(asRecord(created?.data)?.id ?? '').trim();
    if (!rawId) {
      throw new Error('Collection create did not return an id');
    }
    // Both the items and root routes need the full public uid.
    const itemsCid = this.collectionItemsId(rawId);
    const rootCid = this.collectionRootId(rawId);
    await options.onRootCreated?.(rawId);
    try {
      await this.createItemTree(itemsCid, asItemArray(v3.items), itemsCid);
      await this.applyCollectionLevelSettings(rootCid, v3, { rename: true });
    } catch (error) {
      if (options.onRootCreated) throw error;
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
   * Patch only the durable collection description without reconciling its item tree.
   *
   * Generated collections authorize the description PATCH for the service-account
   * access token, but collection-root GET often 403s (live on org and non-org).
   * Issue the idempotent description JSON-Patch directly — no root preflight /
   * readback. Retry only 404 read-after-write lag (same bounded budget as the
   * former getCollectionRoot preflight). A no-op REJECTED_PATCH for this single
   * add /description op means the intended value is already present.
   */
  async updateCollectionDescription(collectionUid: string, description: string): Promise<void> {
    const cid = this.collectionRootId(collectionUid);
    const ops = [{ op: 'add', path: '/description', value: description }];
    try {
      await retry(
        () =>
          this.gateway.requestJson<JsonRecord>({
            service: 'collection',
            method: 'patch',
            path: `/v3/collections/${cid}`,
            // Fixed-path add is idempotent; transient downstream timeouts are safe.
            retry: 'safe',
            body: ops
          }),
        {
          maxAttempts: 6,
          delayMs: 1000,
          backoffMultiplier: 2,
          maxDelayMs: 8000,
          sleep: this.sleep,
          onRetry: ({ attempt, delayMs, error }) => this.onRetry?.({
            class: 'poll',
            status: error instanceof HttpError ? error.status : undefined,
            attempt: attempt + 1,
            delay: delayMs
          }),
          shouldRetry: (error) => error instanceof HttpError && error.status === 404
        }
      );
    } catch (error) {
      if (isRejectedPatchError(error)) return;
      throw error;
    }
  }

  /**
   * Full-replace reconcile of a curated local v2.1.0 or collection v3 payload: delete every
   * root-level item (deleting a folder cascades its children server-side —
   * live-proven), tolerating the gateway's spurious 500 on an already-cascaded
   * child by not trusting individual delete statuses, then recreate the tree
   * from the converted v3 IR and reapply name/auth/variables.
   */
  async updateCollection(collectionUid: string, collection: unknown): Promise<void> {
    const itemsCid = this.collectionItemsId(collectionUid);
    const rootCid = this.collectionRootId(collectionUid);
    const v3 = this.normalizeCollectionForWrite(collection);

    const existingItems = await this.listCollectionItems(itemsCid);
    for (const item of existingItems) {
      const itemId = String(item.id).trim();
      try {
        await this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'delete',
          path: `/v3/collections/${itemsCid}/items/${itemId}`,
          retry: 'none',
          headers: { 'X-Entity-Type': String(item.$kind ?? 'http-request') }
        });
      } catch (error) {
        if (isAmbiguousTransportError(error)) {
          // Re-read before deciding. Gone => cascade/spurious 5xx; still present =>
          // fall through to the post-loop verification so we never recreate.
          const stillPresent = (await this.listCollectionItems(itemsCid)).some(
            (candidate) => String(candidate.id ?? '').trim() === itemId
          );
          if (!stillPresent) continue;
          continue;
        }
        if (!(error instanceof HttpError && error.status === 404)) {
          throw error;
        }
      }
    }

    const remainingItems = await this.listCollectionItems(itemsCid);
    if (remainingItems.length > 0) {
      throw new Error(
        `Collection delete verification failed: ${remainingItems.length} old items remain`
      );
    }

    await this.createItemTree(itemsCid, asItemArray(v3.items), itemsCid);
    await this.applyCollectionLevelSettings(rootCid, v3, { rename: true, reconcileRemovals: true });
  }

  /**
   * Whole-collection import of a final v2.1 payload via sync
   * `POST /collection/import`. The payload carries its final name and a
   * client-known root identity before the sole unsafe request. Ambiguous
   * outcomes reconcile only that normalized identity and require exact
   * ownership/payload evidence; display-name peers are never response recovery.
   */
  async importV2Collection(
    workspaceId: string,
    collection: unknown,
    finalName: string
  ): Promise<ImportV2CollectionResult> {
    const desiredName = String(finalName || '').trim();
    if (!desiredName) {
      throw new Error('LOCAL_OPENAPI_IMPORT_FAILED: final collection name is required');
    }
    const prepared = this.prepareV2ImportPayload(collection, desiredName);
    const desiredDescription = String(asRecord(prepared.info)?.description ?? '').trim();
    const importPayload = this.cloneJson(prepared);
    const info = asRecord(importPayload.info) ?? {};
    info.name = desiredName;
    // Role generation assigns pairwise-disjoint root identities before
    // materialization. Preserve that identity across the import; synthesize one
    // only for legacy direct callers that did not supply it.
    if (typeof info._postman_id !== 'string' || !info._postman_id.trim()) {
      info._postman_id = randomUUID();
    }
    importPayload.info = info;
    // Enforce v2.1 schema before the unsafe create.
    this.assertV21Collection(importPayload);

    const preallocatedId = String(info._postman_id).trim();
    const preallocatedIdentity = normalizeCollectionModelIdentity(preallocatedId);
    if (!preallocatedIdentity) {
      throw new Error('LOCAL_OPENAPI_IMPORT_FAILED: preallocated root identity is required');
    }
    // Journal before the request. The bare id is already a unique run-owned
    // deletion identity; promote it to the public uid once inventory resolves.
    const journaledRootIds: string[] = [preallocatedId];

    // The pre-mutation snapshot is part of the safety boundary. If it cannot be
    // read without hidden retry, no unsafe import is attempted.
    const staleFinalIdentities = new Set(
      (await this.findCollectionsByExactName(workspaceId, desiredName, 'none'))
        .filter((entry) => !this.hasSameBranchAssetMarker(entry.description, desiredDescription))
        .map((entry) => normalizeCollectionModelIdentity(entry.id))
    );

    let created: JsonRecord | null;
    let resolution: ImportRootResolution | undefined;
    let preferredEvidenceVerified = false;
    try {
      created = await this.withImportMutation(() => this.gateway.requestJson<JsonRecord>({
          service: 'sync',
          method: 'post',
          path: '/collection/import',
          query: { workspace: workspaceId, format: '2.1.0' },
          retry: 'none',
          body: importPayload
        }));
    } catch (error) {
      if (!isAmbiguousTransportError(error)) {
        throw this.sanitizeImportError('import-transport', error);
      }
      // A final name is not an identity. Resolve only the client-known root and
      // never adopt a same-name peer as proof that this POST committed.
      resolution = await this.resolveCollectionRootUid(
        workspaceId,
        preallocatedId,
        PostmanGatewayAssetsClient.rootUidResolveDelaysForFinalName(desiredName),
        'safe',
        PostmanGatewayAssetsClient.importIdentitySettleDelaysForFinalName(desiredName).length
      );
      if (!resolution.rootUid || !resolution.resolvedRow) {
        // The response is unknown but the mutation key is not: the exact
        // preallocated root was journaled before submit. Best-effort delete and
        // absence verification can target only that run-owned identity; a
        // same-name peer is never touched.
        await this.deleteVerifiedRunOwnedCollections(workspaceId, journaledRootIds)
          .catch(() => undefined);
        throw this.sanitizeImportError('import-ambiguous-unreconciled', error);
      }
      await this.assertRecoveredImportEvidence(
        resolution.resolvedRow,
        preallocatedIdentity,
        desiredName,
        importPayload,
        desiredDescription
      );
      preferredEvidenceVerified = true;
      created = {
        model_id: preallocatedId,
        data: { info: { _postman_id: preallocatedId, name: desiredName } }
      };
    }

    const rawId = this.extractCollectionUid(created);
    if (!rawId) {
      await this.deleteVerifiedRunOwnedCollections(workspaceId, [preallocatedId])
        .catch(() => undefined);
      throw new Error('LOCAL_OPENAPI_IMPORT_FAILED: import did not return a collection id');
    }
    if (normalizeCollectionModelIdentity(rawId) !== preallocatedIdentity) {
      // The response's foreign id is not ours to touch. The only safe cleanup
      // target is the root identity journaled before the request.
      await this.deleteVerifiedRunOwnedCollections(workspaceId, [preallocatedId])
        .catch(() => undefined);
      throw new Error(
        'LOCAL_OPENAPI_IMPORT_FAILED: IMPORT_RESPONSE_ID_MISMATCH: server returned a different collection identity'
      );
    }

    try {
      resolution ??= await this.resolveCollectionRootUid(
        workspaceId,
        preallocatedId,
        PostmanGatewayAssetsClient.rootUidResolveDelaysForFinalName(desiredName),
        'safe',
        PostmanGatewayAssetsClient.importIdentitySettleDelaysForFinalName(desiredName).length
      );
      const electedId = await this.electImportedCollectionIdentity(
        workspaceId,
        desiredName,
        preallocatedId,
        staleFinalIdentities,
        desiredDescription,
        resolution.cursor,
        importPayload,
        preferredEvidenceVerified
      );
      const rawBare = this.bareModelId(preallocatedId);
      const electedBare = this.bareModelId(electedId);
      if (rawBare && electedBare && rawBare === electedBare) {
        // Same root: promote the pre-request bare journal entry to the
        // canonical <owner>-<model_id> inventory uid.
        journaledRootIds[0] = electedId;
      } else {
        // True peer won: our journaled root was deleted during election.
        const idx = journaledRootIds.findIndex((id) => this.bareModelId(id) === rawBare);
        if (idx >= 0) journaledRootIds.splice(idx, 1);
        // The surviving peer was produced by an earlier or concurrent run, so
        // its content is that run's payload, not this one's. Converge the
        // survivor in place (UID preserved) so downstream gates never execute
        // stale bytes. Failing here fails the import: returning an unverified
        // stale survivor would ship wrong bytes into the contract gate.
        await this.deepUpdateV2Collection(
          electedId,
          prepared,
          computePayloadDigest(prepared)
        );
      }
      return {
        collectionId: electedId,
        journaledRootIds: [...journaledRootIds],
        deleteVerifiedCleanup: async (ids) => {
          await this.deleteVerifiedRunOwnedCollections(workspaceId, ids ?? journaledRootIds);
        }
      };
    } catch (error) {
      // A verified exact-ID digest conflict can be a foreign UUID collision;
      // never delete it. Every other finalize failure concerns the preallocated
      // run identity and retains the existing best-effort exact cleanup.
      if (!this.isImportIdentityConflict(error)) {
        await this.deleteVerifiedRunOwnedCollections(workspaceId, journaledRootIds).catch(() => undefined);
      }
      throw this.sanitizeImportError('import-finalize', error);
    }
  }

  /**
   * In-place deep-update of an existing collection with a complete final v2.1
   * payload. Preserves the root UID. Ambiguous transport never retries/creates/
   * replaces: export + semantic digest verification only.
   */
  async deepUpdateV2Collection(
    collectionUid: string,
    collection: unknown,
    expectedPayloadDigest: string
  ): Promise<string> {
    const uid = String(collectionUid || '').trim();
    if (!uid) {
      throw new Error('LOCAL_OPENAPI_DEEP_UPDATE_FAILED: collection uid is required');
    }
    const digest = String(expectedPayloadDigest || '').trim();
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('LOCAL_OPENAPI_DEEP_UPDATE_FAILED: expectedPayloadDigest must be lowercase 64-hex');
    }
    const bareId = this.bareModelId(uid);
    const prepared = this.prepareV2ImportPayload(collection, undefined);
    // Force the tracked bare root ID so converter-generated identities cannot
    // replace the existing collection UID on deep-update.
    const info = asRecord(prepared.info) ?? {};
    info._postman_id = bareId;
    prepared.info = info;
    this.assertV21Collection(prepared);

    const putEnvelope = {
      service: 'sync' as const,
      method: 'put' as const,
      path: `/collection/deepupdate/${bareId}`,
      query: { format: '2.1.0' },
      retry: 'none' as const,
      body: prepared
    };

    try {
      await this.gateway.requestJson<JsonRecord>(putEnvelope);
      return uid;
    } catch (error) {
      if (!isAmbiguousTransportError(error)) {
        throw this.sanitizeDeepUpdateError('deep-update-transport', error);
      }
      // Ambiguous outcome (5xx, socket failure, or a client deadline abort):
      // the server may have committed this exact payload. Verify remote state
      // before deciding to resend or fail. No generic retry policy is attached
      // to the unsafe PUT and terminal 4xx never reaches this path.
      const recoveryStarted = this.now();
      this.writeMetrics.ambiguousWrites += 1;
      const first = await this.awaitExportedDigest(uid, digest);
      this.writeMetrics.verifyPolls += first.polls;
      if (first.converged) {
        this.writeMetrics.convergedWithoutResend += 1;
        this.writeMetrics.recoveryMs += Math.max(0, this.now() - recoveryStarted);
        return uid;
      }
      // The desired bytes never appeared inside the visibility budget, so the
      // write is not merely invisible. Exactly one explicitly verified resend of
      // the identical root-pinned payload is permitted, still with retry:'none'.
      this.writeMetrics.resendCount += 1;
      try {
        await this.gateway.requestJson<JsonRecord>(putEnvelope);
      } catch (resendError) {
        if (!isAmbiguousTransportError(resendError)) {
          this.writeMetrics.recoveryMs += Math.max(0, this.now() - recoveryStarted);
          throw this.sanitizeDeepUpdateError('deep-update-resend', resendError);
        }
      }
      const second = await this.awaitExportedDigest(uid, digest);
      this.writeMetrics.verifyPolls += second.polls;
      this.writeMetrics.recoveryMs += Math.max(0, this.now() - recoveryStarted);
      if (!second.converged) {
        throw new Error(
          `LOCAL_OPENAPI_DEEP_UPDATE_FAILED: ambiguous-deep-update-digest-mismatch stage=deep-update-verify`,
          { cause: error }
        );
      }
      return uid;
    }
  }

  /**
   * Apply a conservative, preplanned v2.1 content delta through the collection
   * item surface. This method intentionally owns only transport convergence:
   * callers retain the preflight snapshot as their transaction rollback
   * authority and may pass it here for immediate final-digest rollback.
   */
  async applyCollectionDelta(
    collectionUid: string,
    plan: CollectionDeltaPlan,
    desiredCollection: unknown,
    expectedPayloadDigest: string,
    rollback?: { collection: unknown; payloadDigest: string }
  ): Promise<{
    strategy: 'unchanged' | 'delta' | 'whole-fallback';
    fallbackReason?: string;
    observedPayloadDigest?: string;
  }> {
    const uid = String(collectionUid ?? '').trim();
    const digest = String(expectedPayloadDigest ?? '').trim();
    if (!isFullPublicCollectionUid(uid)) {
      throw new Error('COLLECTION_DELTA_UID_REQUIRED: a full public collection uid is required');
    }
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('COLLECTION_DELTA_DIGEST_REQUIRED: expectedPayloadDigest must be lowercase 64-hex');
    }
    if (plan.decision === 'unchanged') {
      return { strategy: 'unchanged', observedPayloadDigest: digest };
    }
    if (plan.decision === 'fallback') {
      this.recordDeltaFallback(plan.reason, plan.changedBytes);
      await this.deepUpdateV2Collection(uid, desiredCollection, digest);
      return { strategy: 'whole-fallback', fallbackReason: plan.reason };
    }

    this.writeMetrics.changedBytes += plan.changedBytes;
    for (const operation of plan.operations) {
      this.writeMetrics.deltaOpsByKind[operation.kind] += 1;
    }
    const started = this.now();
    const itemIds = new Map<string, string>();
    try {
      for (const item of await this.listCollectionItems(uid)) {
        const itemId = String(item.id ?? '').trim();
        if (itemId) itemIds.set(`id:${normalizeCollectionModelIdentity(itemId)}`, itemId);
      }
      for (let offset = 0; offset < plan.operations.length;) {
        const first = plan.operations[offset]!;
        const group = [first];
        offset += 1;
        // Only siblings share a transport batch. Parent/child operations and
        // different mutation kinds stay ordered so a failed or ambiguous parent
        // can never be followed by a dependent child write.
        while (
          offset < plan.operations.length &&
          plan.operations[offset]!.kind === first.kind &&
          plan.operations[offset]!.parentKey === first.parentKey
        ) {
          group.push(plan.operations[offset]!);
          offset += 1;
        }
        const outcome = await this.applyPlannedCollectionDeltaGroup(uid, group, itemIds, digest);
        if (outcome === 'converged') break;
        if (outcome === 'fallback') {
          this.recordDeltaFallback('ambiguous-delta-mutation', 0);
          await this.deepUpdateV2Collection(uid, desiredCollection, digest);
          this.writeMetrics.deltaMs += Math.max(0, this.now() - started);
          return { strategy: 'whole-fallback', fallbackReason: 'ambiguous-delta-mutation' };
        }
      }
      const verification = await this.awaitExportedDigest(uid, digest);
      this.writeMetrics.verifyPolls += verification.polls;
      if (!verification.converged) {
        const difference = describePayloadDigestDifference(
          asRecord(desiredCollection) ?? {},
          asRecord(verification.observed) ?? {}
        );
        await this.rollbackCollectionDelta(uid, rollback);
        throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: delta-digest-mismatch (${difference})`);
      }
      this.writeMetrics.deltaMs += Math.max(0, this.now() - started);
      return { strategy: 'delta', observedPayloadDigest: digest };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('LOCAL_OPENAPI_DELTA_FAILED: delta-digest-mismatch')) {
        throw error;
      }
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
        throw error;
      }
      const failureReason = this.deltaMutationFailureReason(error);
      this.recordDeltaFallback(failureReason, 0);
      try {
        await this.deepUpdateV2Collection(uid, desiredCollection, digest);
      } catch (fallbackError) {
        await this.rollbackCollectionDelta(uid, rollback);
        throw fallbackError;
      } finally {
        this.writeMetrics.deltaMs += Math.max(0, this.now() - started);
      }
      return { strategy: 'whole-fallback', fallbackReason: failureReason };
    }
  }

  private deltaMutationFailureReason(error: unknown): string {
    if (error instanceof HttpError) return `delta-mutation-failed:http-${error.status}`;
    if (error instanceof Error) {
      const internal = /^LOCAL_OPENAPI_DELTA_FAILED: ([a-z0-9-]+)/i.exec(error.message)?.[1];
      if (internal) return `delta-mutation-failed:${internal.toLowerCase()}`;
      const name = error.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      if (name) return `delta-mutation-failed:${name}`;
    }
    return 'delta-mutation-failed:unknown';
  }

  private recordDeltaFallback(reason: string, changedBytes: number): void {
    this.writeMetrics.fallbackReasons.push(reason);
    this.writeMetrics.changedBytes += changedBytes;
  }

  private async rollbackCollectionDelta(
    uid: string,
    rollback: { collection: unknown; payloadDigest: string } | undefined
  ): Promise<void> {
    if (!rollback) return;
    await this.deepUpdateV2Collection(uid, rollback.collection, rollback.payloadDigest);
  }

  private deltaV3Item(item: JsonRecord): JsonRecord {
    const converted = this.convertV2CollectionToV3({
      info: {
        name: 'Delta conversion',
        schema: `https://schema.getpostman.com/json/collection/${'v2.1.0'}/collection.json`
      },
      item: [item]
    });
    const convertedItem = asItemArray(converted.items)[0];
    if (!convertedItem) throw new Error('LOCAL_OPENAPI_DELTA_FAILED: item conversion returned no item');
    return convertedItem;
  }

  private resolveDeltaItemId(
    operation: CollectionDeltaOperation,
    itemIds: ReadonlyMap<string, string>
  ): string {
    if (operation.sourceId) {
      const matched = itemIds.get(`id:${normalizeCollectionModelIdentity(operation.sourceId)}`);
      if (matched) return matched;
    }
    throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: exact item identity unavailable for ${operation.key}`);
  }

  private resolveDeltaParentId(
    parentKey: string | undefined,
    itemIds: ReadonlyMap<string, string>,
    rootId: string
  ): string | undefined {
    if (!parentKey) return rootId;
    const direct = itemIds.get(parentKey);
    if (direct) return direct;
    if (parentKey.startsWith('id:')) {
      return itemIds.get(`id:${normalizeCollectionModelIdentity(parentKey.slice(3))}`);
    }
    return undefined;
  }

  private resolveDeltaSiblingId(
    siblingKey: string | undefined,
    itemIds: ReadonlyMap<string, string>
  ): string | undefined {
    if (!siblingKey) return undefined;
    const direct = itemIds.get(siblingKey);
    if (direct) return direct;
    if (siblingKey.startsWith('id:')) {
      return itemIds.get(`id:${normalizeCollectionModelIdentity(siblingKey.slice(3))}`);
    }
    return undefined;
  }

  private async moveDeltaItem(input: {
    collectionId: string;
    itemId: string;
    entityType: CollectionDeltaOperation['entityType'];
    parentId: string;
    previousSiblingId?: string;
    nextSiblingId?: string;
  }): Promise<void> {
    this.writeMetrics.deltaRoutes.push('POST /v3/items/move');
    const response = await this.gateway.requestJson<JsonRecord>({
      service: 'collection',
      method: 'post',
      path: '/v3/items/move',
      retry: 'none',
      body: {
        items: [{ id: input.itemId, $kind: input.entityType }],
        toPosition: {
          collectionId: input.collectionId,
          parent: { id: input.parentId, $kind: 'collection' },
          ...(input.previousSiblingId
            ? { previousSibling: { id: input.previousSiblingId, $kind: input.entityType } }
            : {}),
          ...(input.nextSiblingId
            ? { nextSibling: { id: input.nextSiblingId, $kind: input.entityType } }
            : {})
        }
      }
    });
    const result = asRecord(response?.data);
    const moved = Array.isArray(result?.moved) ? result.moved.map(String) : [];
    const failed = Array.isArray(result?.failed) ? result.failed.map(String) : [];
    if (failed.length > 0 || !moved.includes(input.itemId)) {
      throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: move rejected for ${input.itemId}`);
    }
  }

  private async applyPlannedCollectionDeltaOperation(
    uid: string,
    operation: CollectionDeltaOperation,
    itemIds: Map<string, string>,
    desiredDigest: string
  ): Promise<'applied' | 'converged' | 'fallback'> {
    const cid = this.collectionItemsId(uid);
    const request = async (): Promise<void> => {
      if (operation.kind === 'create') {
        const parentId = this.resolveDeltaParentId(operation.parentKey, itemIds, cid);
        if (!parentId) {
          throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: create parent unavailable for ${operation.key}`);
        }
        const convertedItem = this.deltaV3Item(operation.item);
        const body = this.buildItemCreateBody(convertedItem, parentId);
        this.writeMetrics.deltaRoutes.push('POST /v3/collections/{param}/items');
        const created = await this.gateway.requestJson<JsonRecord>({
          service: 'collection',
          method: 'post',
          path: `/v3/collections/${cid}/items/`,
          retry: 'none',
          headers: { 'X-Entity-Type': operation.entityType },
          body
        });
        const id = String(asRecord(created?.data)?.id ?? '').trim();
        if (!id) {
          throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: create returned no id for ${operation.key}`);
        }
        itemIds.set(operation.key, id);
        const nextSiblingId = this.resolveDeltaSiblingId(operation.nextSiblingKey, itemIds);
        if (operation.nextSiblingKey && !nextSiblingId) {
          throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: create sibling unavailable for ${operation.key}`);
        }
        if (nextSiblingId) {
          await this.moveDeltaItem({
            collectionId: cid,
            itemId: id,
            entityType: operation.entityType,
            parentId,
            nextSiblingId
          });
        }
        if (Array.isArray(convertedItem.scripts) && convertedItem.scripts.length > 0) {
          this.writeMetrics.deltaRoutes.push('PATCH /v3/collections/{param}/items/{param}');
          await this.patchNewItemScripts(
            cid,
            id,
            convertedItem.scripts as JsonRecord[],
            operation.entityType
          );
        }
        for (const example of asItemArray(convertedItem.examples)) {
          this.writeMetrics.deltaRoutes.push('POST /v3/collections/{param}/items');
          const createdExample = await this.gateway.requestJson<JsonRecord>({
            service: 'collection',
            method: 'post',
            path: `/v3/collections/${cid}/items/`,
            retry: 'none',
            headers: { 'X-Entity-Type': 'http-example' },
            body: this.buildItemCreateBody(example, id, 'http-request')
          });
          if (!String(asRecord(createdExample?.data)?.id ?? '').trim()) {
            throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: example create returned no id for ${operation.key}`);
          }
        }
        return;
      }
      const itemId = this.resolveDeltaItemId(operation, itemIds);
      if (operation.kind === 'delete') {
        this.writeMetrics.deltaRoutes.push('DELETE /v3/collections/{param}/items/{param}');
        await this.gateway.requestJson<JsonRecord>({
          service: 'collection', method: 'delete', path: `/v3/collections/${cid}/items/${itemId}`,
          retry: 'none', headers: { 'X-Entity-Type': operation.entityType }
        });
        return;
      }
      if (operation.kind === 'move') {
        const parentId = this.resolveDeltaParentId(operation.parentKey, itemIds, cid);
        if (!parentId) throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: move parent unavailable for ${operation.key}`);
        const previousSiblingId = this.resolveDeltaSiblingId(operation.previousSiblingKey, itemIds);
        const nextSiblingId = this.resolveDeltaSiblingId(operation.nextSiblingKey, itemIds);
        if (operation.previousSiblingKey && !previousSiblingId) {
          throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: move previous sibling unavailable for ${operation.key}`);
        }
        if (!previousSiblingId && operation.nextSiblingKey && !nextSiblingId) {
          throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: move next sibling unavailable for ${operation.key}`);
        }
        await this.moveDeltaItem({
          collectionId: cid,
          itemId,
          entityType: operation.entityType,
          parentId,
          ...(previousSiblingId ? { previousSiblingId } : {}),
          ...(!previousSiblingId && nextSiblingId ? { nextSiblingId } : {})
        });
        return;
      }
      const patchItem: JsonRecord = operation.entityType === 'collection'
        ? {
            name: operation.item.name,
            item: [],
            ...(operation.item.description !== undefined ? { description: operation.item.description } : {})
          }
        : {
            name: operation.item.name,
            request: operation.item.request,
            ...(operation.item.description !== undefined ? { description: operation.item.description } : {})
          };
      const target = this.deltaV3Item(patchItem);
      const fields = operation.patchFields ?? [];
      const body = fields
        .filter((field) => target[field] !== undefined)
        .map((field) => ({ op: 'add', path: `/${field}`, value: target[field] }));
      if (body.length === 0) throw new Error(`LOCAL_OPENAPI_DELTA_FAILED: no supported patch fields for ${operation.key}`);
      this.writeMetrics.deltaRoutes.push('PATCH /v3/collections/{param}/items/{param}');
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection', method: 'patch', path: `/v3/collections/${cid}/items/${itemId}`,
        retry: 'none', headers: { 'X-Entity-Type': operation.entityType }, body
      });
    };
    try {
      await request();
      return 'applied';
    } catch (error) {
      if (!isAmbiguousTransportError(error)) throw error;
      const recoveryStarted = this.now();
      this.writeMetrics.ambiguousWrites += 1;
      const observed = await this.awaitExportedDigest(uid, desiredDigest);
      this.writeMetrics.verifyPolls += observed.polls;
      this.writeMetrics.recoveryMs += Math.max(0, this.now() - recoveryStarted);
      if (observed.converged) {
        this.writeMetrics.convergedWithoutResend += 1;
        return 'converged';
      }
      return 'fallback';
    }
  }

  /** Serialize all mutations: create placement depends on earlier sibling writes. */
  private async applyPlannedCollectionDeltaGroup(
    uid: string,
    operations: readonly CollectionDeltaOperation[],
    itemIds: Map<string, string>,
    desiredDigest: string
  ): Promise<'applied' | 'converged' | 'fallback'> {
    let next = 0;
    let fallback = false;
    let converged = false;
    const worker = async (): Promise<void> => {
      while (!fallback && !converged) {
        const operation = operations[next];
        next += 1;
        if (!operation) return;
        const outcome = await this.applyPlannedCollectionDeltaOperation(uid, operation, itemIds, desiredDigest);
        if (outcome === 'converged') {
          converged = true;
          return;
        }
        if (outcome === 'fallback') {
          fallback = true;
          return;
        }
      }
    };
    const concurrency = 1;
    await Promise.all(Array.from({ length: Math.min(concurrency, operations.length) }, () => worker()));
    return converged ? 'converged' : fallback ? 'fallback' : 'applied';
  }

  /** Delete and verify absence of only the supplied run-owned collection roots. */
  async deleteVerifiedRunOwnedCollections(
    workspaceId: string,
    collectionIds: string[]
  ): Promise<void> {
    const unique = [...new Set(collectionIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const delays = PostmanGatewayAssetsClient.DELETE_ABSENCE_SETTLE_DELAYS_MS;
    for (const id of unique) {
      // Re-issue DELETE between absence observations. Gateway may return 500 for
      // already-cascaded deletes OR for failed deletes; only inventory/404 prove gone.
      let verifiedAbsent = false;
      for (let attempt = 0; attempt <= delays.length; attempt += 1) {
        await this.deleteCollection(id);
        verifiedAbsent = await this.verifyCollectionAbsentOnce(workspaceId, id);
        if (verifiedAbsent) break;
        if (attempt < delays.length) await this.sleep(delays[attempt]!);
      }
      if (!verifiedAbsent) {
        throw new Error(
          `LOCAL_OPENAPI_CLEANUP_FAILED: owned collection ${id} absence unverifiable after delete`
        );
      }
    }
  }

  /**
   * Single absence observation. A full public uid can use ROOT GET: 404 proves
   * gone, while GET 200/403 falls back to workspace inventory (never treating
   * 403 alone as absence). A bare journal id skips ROOT GET entirely because
   * that route rejects it; normalized workspace inventory is its authority.
   * Transient >=500 is not absence.
   *
   * A caller holding the full public uid gets a real ROOT GET; a caller holding
   * only a bare journal id skips ROOT GET and is resolved through normalized
   * inventory, the authority for that case.
   */
  private async verifyCollectionAbsentOnce(
    workspaceId: string,
    collectionId: string
  ): Promise<boolean> {
    const id = String(collectionId ?? '').trim();
    const targetIdentity = normalizeCollectionModelIdentity(id);
    if (isBareCollectionUuid(id)) {
      return (await this.inventoryOmitsNormalizedIdentity(workspaceId, targetIdentity)) === true;
    }
    const path = `/v3/collections/${this.collectionRootId(id)}`;
    try {
      await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'get',
        path,
        retry: 'none'
      });
      // Root GET can lag after a successful delete. Inventory is the
      // workspace-scoped truth for whether the identity still exists.
      return (await this.inventoryOmitsNormalizedIdentity(workspaceId, targetIdentity)) === true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return true;
      }
      if (error instanceof HttpError && error.status === 403) {
        return (await this.inventoryOmitsNormalizedIdentity(workspaceId, targetIdentity)) === true;
      }
      return false;
    }
  }

  /**
   * true = identity absent from inventory; false = still present;
   * null = inventory unreadable (fail closed for absence proof).
   */
  private async inventoryOmitsNormalizedIdentity(
    workspaceId: string,
    targetIdentity: string
  ): Promise<boolean | null> {
    try {
      const inventory = await this.listWorkspaceCollections(workspaceId, 'none');
      return !this.isNormalizedIdentityPresentInInventory(inventory, targetIdentity);
    } catch {
      return null;
    }
  }

  private isNormalizedIdentityPresentInInventory(
    inventory: Array<{ id: string; name: string; description?: string }>,
    targetIdentity: string
  ): boolean {
    return inventory.some(
      (entry) => normalizeCollectionModelIdentity(entry.id) === targetIdentity
    );
  }

  private prepareV2ImportPayload(collection: unknown, forceName?: string): JsonRecord {
    const clone = this.cloneJson(asRecord(collection) ?? {});
    if (forceName !== undefined) {
      const info = asRecord(clone.info) ?? {};
      info.name = forceName;
      clone.info = info;
    }
    return clone;
  }

  /**
   * Prove that an exact-ID row observed after an ambiguous import is this
   * request's committed payload. The client-known root id is the ownership
   * marker for canonical collections; branch-scoped collections additionally
   * require their durable branch marker. A name/list match alone is never proof.
   */
  private async assertRecoveredImportEvidence(
    row: WorkspaceInventoryRow,
    expectedIdentity: string,
    expectedName: string,
    expectedCollection: JsonRecord,
    expectedDescription: string
  ): Promise<void> {
    if (normalizeCollectionModelIdentity(row.id) !== expectedIdentity) {
      throw new Error(
        'IMPORT_IDENTITY_CONFLICT: recovered collection does not match the preallocated identity'
      );
    }
    if (row.name !== expectedName) {
      throw new Error(
        'IMPORT_IDENTITY_CONFLICT: exact preallocated collection has a different final name'
      );
    }

    let exported: JsonRecord;
    try {
      exported = await this.exportV2Collection(row.id);
    } catch (error) {
      throw new Error(
        'IMPORT_IDENTITY_CONFLICT: exact preallocated collection evidence is unavailable',
        { cause: error }
      );
    }
    const exportedInfo = asRecord(exported.info) ?? {};
    const exportedId = String(exportedInfo._postman_id ?? '').trim();
    if (
      exportedId &&
      normalizeCollectionModelIdentity(exportedId) !== expectedIdentity
    ) {
      throw new Error(
        'IMPORT_IDENTITY_CONFLICT: exported collection root differs from the preallocated identity'
      );
    }
    if (
      parseAssetMarker(expectedDescription) &&
      !this.hasSameBranchAssetMarker(
        String(exportedInfo.description ?? '').trim() || undefined,
        expectedDescription
      )
    ) {
      throw new Error(
        'IMPORT_IDENTITY_CONFLICT: exact preallocated collection carries a foreign ownership marker'
      );
    }
    if (computePayloadDigest(exported) !== computePayloadDigest(expectedCollection)) {
      throw new Error(
        'IMPORT_IDENTITY_CONFLICT: exact preallocated collection payload digest does not match'
      );
    }
  }

  private isImportIdentityConflict(error: unknown): boolean {
    return (
      error instanceof Error &&
      /\bIMPORT_(?:IDENTITY_CONFLICT|RESPONSE_ID_MISMATCH)\b/.test(error.message)
    );
  }

  /** A same-name peer is eligible only when its exact exported bytes are ours. */
  private async matchesImportedPeerEvidence(
    row: WorkspaceInventoryRow,
    expectedCollection: JsonRecord,
    expectedDescription: string
  ): Promise<boolean> {
    try {
      await this.assertRecoveredImportEvidence(
        row,
        normalizeCollectionModelIdentity(row.id),
        String(asRecord(expectedCollection.info)?.name ?? '').trim(),
        expectedCollection,
        expectedDescription
      );
      return true;
    } catch {
      return false;
    }
  }

  private assertV21Collection(collection: JsonRecord): void {
    try {
      assertV2CollectionModel(collection);
    } catch (error) {
      throw new Error(
        `LOCAL_OPENAPI_IMPORT_FAILED: collection failed v2.1 schema validation (${
          error instanceof Error ? error.message.slice(0, 160) : 'invalid'
        })`,
        { cause: error }
      );
    }
  }

  private extractCollectionUid(created: JsonRecord | null): string {
    if (!created) return '';
    const asNonEmptyString = (value: unknown): string => {
      if (typeof value !== 'string') return '';
      return value.trim();
    };
    const data = asRecord(created.data);
    const info = asRecord(data?.info);
    const nested = asRecord(data?.collection) ?? asRecord(created.collection);
    // Live Sync import envelope (collection-service SyncService): prefer
    // data.info._postman_id, then top-level model_id, then legacy id/uid shapes.
    const candidates = [
      info?._postman_id,
      created.model_id,
      data?.id,
      data?.uid,
      created.id,
      created.uid,
      nested?.id,
      nested?.uid
    ];
    for (const candidate of candidates) {
      const id = asNonEmptyString(candidate);
      if (id) return id;
    }
    return '';
  }

  private async electImportedCollectionIdentity(
    workspaceId: string,
    finalName: string,
    preferredId: string,
    staleFinalIdentities: ReadonlySet<string>,
    desiredDescription: string,
    existingCursor?: ImportSettleCursor,
    desiredCollection?: JsonRecord,
    preferredEvidenceVerified = false
  ): Promise<string> {
    const started = this.now();
    const preferredIdentity = normalizeCollectionModelIdentity(preferredId);
    const settleDelays = PostmanGatewayAssetsClient.importIdentitySettleDelaysForFinalName(finalName);
    const cursor = existingCursor ?? this.createImportSettleCursor(
      workspaceId,
      preferredIdentity,
      PostmanGatewayAssetsClient.rootUidResolveDelaysForFinalName(finalName),
      settleDelays.length
    );
    const observer = this.workspaceInventoryObserver(workspaceId);
    let eligible: WorkspaceInventoryRow[] = [];
    let ownCanonical: WorkspaceInventoryRow | undefined;
    let sameNameSurvivors: WorkspaceInventoryRow[] = [];
    let preferredObserved: WorkspaceInventoryRow | undefined;
    const observeInventory = (observation: WorkspaceInventoryObservation): void => {
      const inventory = observation.rows ?? [];
      preferredObserved = inventory.find(
        (entry) =>
          !isBareCollectionUuid(entry.id) &&
          normalizeCollectionModelIdentity(entry.id) === preferredIdentity
      );
      sameNameSurvivors = inventory
        .filter((entry) => entry.name === finalName)
        .sort((a, b) => a.id.localeCompare(b.id));
      eligible = sameNameSurvivors.filter(
        (entry) =>
          !isBareCollectionUuid(entry.id) &&
          !staleFinalIdentities.has(normalizeCollectionModelIdentity(entry.id))
      );
      ownCanonical = eligible.find(
        (entry) => normalizeCollectionModelIdentity(entry.id) === preferredIdentity
      );
    };

    try {
      // Root resolution and ambiguous-import readback already observed this
      // identity. Replay those observations before spending another delay so a
      // delayed same-marker peer cannot disappear behind a phase restart.
      for (const observation of cursor.observations) observeInventory(observation);
      if (cursor.observations.length === 0) {
        observeInventory(await observer.observe(cursor, 'safe'));
      }
      // Consume only this identity's remaining delayed-peer budget. A cursor
      // created by a later import starts at zero even when earlier roles have
      // exhausted theirs; there is deliberately no workspace-global deadline.
      while (
        cursor.nextDelayIndex < cursor.peerDelayCount &&
        await observer.consumeDelay(cursor)
      ) {
        observeInventory(await observer.observe(cursor, 'safe'));
      }

      if (desiredCollection) {
        if (preferredObserved && !preferredEvidenceVerified) {
          // A nominal 2xx proves only what the response claimed. Prove that the
          // exact inventory row has the requested final name, ownership marker,
          // and semantic bytes before it can win election or cleanup ownership.
          await this.assertRecoveredImportEvidence(
            preferredObserved,
            preferredIdentity,
            finalName,
            desiredCollection,
            desiredDescription
          );
          preferredEvidenceVerified = true;
        }
        const verified: WorkspaceInventoryRow[] = [];
        for (const entry of eligible) {
          if (
            (normalizeCollectionModelIdentity(entry.id) === preferredIdentity &&
              preferredEvidenceVerified) ||
            await this.matchesImportedPeerEvidence(entry, desiredCollection, desiredDescription)
          ) {
            verified.push(entry);
          }
        }
        eligible = verified;
        ownCanonical = eligible.find(
          (entry) => normalizeCollectionModelIdentity(entry.id) === preferredIdentity
        );
      }

      if (!ownCanonical) {
      // Own root is absent from inventory. It may have been deleted by a peer,
      // or it may still exist but remain inventory-invisible after import.
      // Before adopting a same-marker peer and dropping this run's
      // journal ownership, actively delete and prove absence of the run-owned
      // preferred root.
      // Adopt the sole surviving same-marker final for this exact name when the
      // owned root is verifiably gone: that asset carries this branch's durable
      // marker, so it is the asset this run was asked to produce. The peer is
      // never deleted or claimed; cleanup failure fails closed. Anything unmarked
      // or carrying a different marker is a stranger and still fails.
      //
      // Adoption scans every same-name survivor rather than the eligible set.
      // Org inventory omits root descriptions, so the pre-import snapshot cannot
      // read a peer's marker and classifies that peer as stale; keeping it out
      // here would fail closed on an asset this branch legitimately owns. Marker
      // identity is still proven per candidate over the v2.1 export route, so a
      // stranger is never adopted on the strength of the name alone. Bare rows
      // are excluded because canonical election may never return one.
        let adoptable: string | undefined;
        if (desiredCollection) {
          const verifiedPeers: WorkspaceInventoryRow[] = [];
          for (const peer of sameNameSurvivors.filter(
            (entry) => !isBareCollectionUuid(entry.id)
          )) {
            if (await this.matchesImportedPeerEvidence(peer, desiredCollection, desiredDescription)) {
              verifiedPeers.push(peer);
            }
          }
          adoptable = verifiedPeers.sort((a, b) => a.id.localeCompare(b.id))[0]?.id;
        } else {
          adoptable = await this.adoptableSameMarkerFinal(
            sameNameSurvivors.filter((entry) => !isBareCollectionUuid(entry.id)),
            desiredDescription
          );
        }
        if (adoptable) {
          await this.deleteVerifiedRunOwnedCollections(workspaceId, [preferredId]);
          return adoptable;
        }
        throw new Error(
          'COLLECTION_ROOT_UID_RESOLUTION_FAILED: imported collection did not become inventory-visible with a ROOT-addressable canonical uid'
        );
      }

      const winner = eligible[0]!;
      const winnerIdentity = normalizeCollectionModelIdentity(winner.id);
      if (preferredIdentity !== winnerIdentity) {
      // True peer won: delete only the run-owned loser and verify absence before
      // returning the peer winner so the caller drops journal ownership only
      // after the owned root is confirmed gone. Winners never delete peers here —
      // that races a peer still inside its election window.
        await this.deleteVerifiedRunOwnedCollections(workspaceId, [ownCanonical.id]);
        return winner.id;
      }

      // Same root (bare Sync model_id vs canonical <owner>-<model_id>): return the
      // inventory UID so downstream tagging and relation writes never see bare id.
      return ownCanonical.id;
    } finally {
      this.writeMetrics.electionMs += Math.max(0, this.now() - started);
    }
  }

  /**
   * Collapse duplicate preview/channel finals to the lowest UID. Exact name is
   * not an ownership boundary: only roots carrying the same durable branch
   * marker are eligible. Canonical and stranger collections are never touched.
   */
  async reconcileDuplicateFinalCollections(
    workspaceId: string,
    candidates: Array<{ finalName: string; desiredDescription: string }>
  ): Promise<Record<string, string>> {
    const uniqueCandidates = new Map<string, string>();
    for (const candidate of candidates) {
      const finalName = String(candidate.finalName || '').trim();
      const desiredDescription = String(candidate.desiredDescription || '').trim();
      if (!finalName || !parseAssetMarker(desiredDescription)) continue;
      uniqueCandidates.set(finalName, desiredDescription);
    }
    const winners: Record<string, string> = {};
    if (uniqueCandidates.size === 0) return winners;
    const inventory = await this.listWorkspaceCollections(workspaceId, 'safe');
    for (const [finalName, desiredDescription] of uniqueCandidates) {
      const matches: Array<{ id: string; name: string; description?: string }> = [];
      for (const entry of inventory.filter((candidate) => candidate.name === finalName)) {
        let description = entry.description;
        if (!description) {
          // Org inventory omits root descriptions. The export route remains
          // readable for generated collections and carries info.description.
          // If export cannot prove ownership, leave the candidate untouched.
          try {
            const exported = await this.exportV2Collection(entry.id);
            description = String(asRecord(exported.info)?.description ?? '').trim() || undefined;
          } catch {
            description = undefined;
          }
        }
        if (this.hasSameBranchAssetMarker(description, desiredDescription)) {
          matches.push({ ...entry, ...(description ? { description } : {}) });
        }
      }
      matches.sort((a, b) => a.id.localeCompare(b.id));
      if (matches.length === 0) continue;
      const winnerId = matches[0]!.id;
      winners[finalName] = winnerId;
      if (matches.length === 1) continue;
      const losers = matches.slice(1).map((entry) => entry.id);
      await this.deleteVerifiedRunOwnedCollections(workspaceId, losers);
      for (const id of losers) {
        const identity = normalizeCollectionModelIdentity(id);
        for (let i = inventory.length - 1; i >= 0; i -= 1) {
          if (normalizeCollectionModelIdentity(inventory[i]!.id) === identity) {
            inventory.splice(i, 1);
          }
        }
      }
    }
    return winners;
  }

  /**
   * Sole existing final with this exact name carrying the same durable branch
   * marker as this run's payload, or undefined. Lets a channel/preview rerun
   * deep-update its prior-run asset in place instead of importing a fresh root
   * and re-electing. Zero same-marker survivors return undefined; multiple
   * same-marker survivors fail closed rather than selecting an arbitrary asset.
   */
  async findAdoptableSameMarkerCollection(
    workspaceId: string,
    finalName: string,
    desiredDescription: string
  ): Promise<string | undefined> {
    const name = String(finalName || '').trim();
    const description = String(desiredDescription || '').trim();
    if (!name || !parseAssetMarker(description)) return undefined;
    const survivors = await this.findCollectionsByExactName(workspaceId, name, 'safe');
    if (survivors.length === 0) return undefined;
    return this.adoptableSameMarkerFinal(survivors, description);
  }

  /**
   * Sole exact-name final carrying the same durable branch marker as this run's
   * payload, or undefined. Org inventory omits root descriptions, so fall back
   * to the v2.1 export route; an unprovable candidate is never adoptable. More
   * than one same-marker survivor is ambiguous and fails closed before a caller
   * can mutate or elect an arbitrary winner.
   */
  private async adoptableSameMarkerFinal(
    eligible: ReadonlyArray<{ id: string; name: string; description?: string }>,
    desiredDescription: string
  ): Promise<string | undefined> {
    if (!parseAssetMarker(desiredDescription)) return undefined;
    const matches: string[] = [];
    for (const entry of eligible) {
      let description = entry.description;
      if (!description) {
        try {
          const exported = await this.exportV2Collection(entry.id);
          description = String(asRecord(exported.info)?.description ?? '').trim() || undefined;
        } catch {
          description = undefined;
        }
      }
      if (this.hasSameBranchAssetMarker(description, desiredDescription)) matches.push(entry.id);
    }
    if (matches.length === 0) return undefined;
    if (matches.length === 1) return matches[0];
    throw new Error(
      'SAME_MARKER_COLLECTION_AMBIGUOUS: multiple exact-name collections carry the same branch marker'
    );
  }

  private hasSameBranchAssetMarker(
    candidateDescription: string | undefined,
    desiredDescription: string
  ): boolean {
    const candidate = parseAssetMarker(candidateDescription);
    const desired = parseAssetMarker(desiredDescription);
    return Boolean(
      candidate &&
      desired &&
      candidate.repo === desired.repo &&
      candidate.rawBranch === desired.rawBranch &&
      candidate.sanitizedBranch === desired.sanitizedBranch &&
      candidate.role === desired.role &&
      candidate.headRepoId === desired.headRepoId
    );
  }

  async exportV2Collection(collectionUid: string): Promise<JsonRecord> {
    // `/export` is NOT part of the ROOT GET/PATCH ACL tightening: it accepts
    // the bare model id (2026-08-03 live A/B: bare=200). Keep the live-proven
    // bare vocabulary rather than rewriting a working route on speculation.
    const bareId = this.bareModelId(collectionUid);
    const delays = PostmanGatewayAssetsClient.EXPORT_MODEL_SETTLE_DELAYS_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      const exported = await this.gateway.requestJson<JsonRecord>({
        service: 'collection',
        method: 'get',
        path: `/v3/collections/${bareId}/export`,
        retry: 'safe'
      });
      const data = asRecord(exported?.data) ?? exported;
      const collection =
        asRecord(asRecord(data)?.collection) ??
        asRecord(data) ??
        {};
      try {
        if (asRecord(collection)?.$kind === 'collection' || Array.isArray(asRecord(collection)?.items)) {
          return asRecord(convertV3CollectionToV2Model(collection)) ?? {};
        }
        this.assertV21Collection(collection);
        return collection;
      } catch (error) {
        lastError = error;
        if (attempt < delays.length) await this.sleep(delays[attempt]!);
      }
    }
    throw lastError;
  }

  private cloneJson<T>(value: T): T {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private sanitizeImportError(stage: string, error: unknown): Error {
    const cause = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 240) : 'failure';
    return new Error(`LOCAL_OPENAPI_IMPORT_FAILED: stage=${stage} cause=${cause}`);
  }

  private sanitizeDeepUpdateError(stage: string, error: unknown): Error {
    const cause = error instanceof Error ? error.message.replace(/\s+/g, ' ').trim().slice(0, 240) : 'failure';
    return new Error(`LOCAL_OPENAPI_DEEP_UPDATE_FAILED: stage=${stage} cause=${cause}`);
  }
}

export interface ImportV2CollectionResult {
  collectionId: string;
  /** Roots created by this import attempt (exact run identity only). */
  journaledRootIds: string[];
  /** Delete and verify only journaled (or explicitly supplied) run-owned roots. */
  deleteVerifiedCleanup: (ids?: string[]) => Promise<void>;
}
