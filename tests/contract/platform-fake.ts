/**
 * In-memory Postman/Bifrost platform transport for contract tests.
 *
 * Serves the exact wire shapes the production clients parse (mint, /me, iapub
 * session, and the Bifrost /ws/proxy envelope for ums/workspaces/specification/
 * collection/tagging/sync), parametrized over the axes real callers vary on:
 * org vs non-org account, prod vs beta stack, and failure injection.
 *
 * Realism that makes the org cells meaningful: on an org account the
 * personal->team visibility flip 403s (addWorkspaceLevelTeamRoles), exactly as
 * the live gateway behaves. A regression that skips org-mode detection
 * therefore FAILS these tests instead of silently passing.
 */

type JsonRecord = Record<string, unknown>;

export interface PlatformSquad {
  id: number;
  name: string;
  handle: string;
  organizationId: number;
}

export interface ProxyEnvelope {
  service: string;
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
}

type FakeBodyShape = 'none' | 'record' | 'array' | 'record-or-array';

export interface PlatformFakeRoute {
  service: string;
  method: string;
  path: string;
  query?: readonly string[];
  requiredQuery?: readonly string[];
  body: FakeBodyShape;
}

/**
 * Every request shape the stateful fake intentionally models. The registry is
 * also the fail-closed boundary: handlers are unreachable until the incoming
 * service/method/path/query/body shape matches one row.
 */
export const PLATFORM_FAKE_ROUTES: readonly PlatformFakeRoute[] = [
  { service: 'postman-api', method: 'POST', path: '/service-account-tokens', body: 'record' },
  { service: 'postman-api', method: 'GET', path: '/me', body: 'none' },
  { service: 'iapub', method: 'GET', path: '/api/sessions/current', body: 'none' },
  { service: 'bifrost-direct', method: 'GET', path: '/collection/{param}/sync', query: ['exclude', 'favorite', 'since_id'], requiredQuery: ['exclude', 'favorite', 'since_id'], body: 'none' },
  { service: 'dl.pstmn.io', method: 'GET', path: '/update/status', query: ['currentVersion', 'platform'], body: 'none' },
  { service: 'ums', method: 'GET', path: '/api/teams/{param}/squads', query: ['settings', 'userRoles'], requiredQuery: ['settings', 'userRoles'], body: 'none' },
  { service: 'workspaces', method: 'POST', path: '/workspaces', body: 'record' },
  { service: 'workspaces', method: 'GET', path: '/workspaces', query: ['cursor'], body: 'none' },
  { service: 'workspaces', method: 'GET', path: '/workspaces/filesystem', query: ['path', 'repo'], requiredQuery: ['path', 'repo'], body: 'none' },
  { service: 'workspaces', method: 'GET', path: '/workspaces/{param}', body: 'none' },
  { service: 'workspaces', method: 'DELETE', path: '/workspaces/{param}', body: 'none' },
  { service: 'workspaces', method: 'GET', path: '/workspaces/{param}/filesystem', body: 'none' },
  { service: 'workspaces', method: 'POST', path: '/workspaces/{param}/filesystem', body: 'record' },
  { service: 'workspaces', method: 'PATCH', path: '/workspaces/{param}/roles', body: 'record-or-array' },
  { service: 'workspaces', method: 'PUT', path: '/workspaces/{param}/visibility', body: 'record' },
  { service: 'sync', method: 'POST', path: '/collection/import', query: ['format', 'workspace'], requiredQuery: ['format', 'workspace'], body: 'record' },
  { service: 'sync', method: 'PUT', path: '/collection/deepupdate/{param}', query: ['format'], requiredQuery: ['format'], body: 'record' },
  { service: 'specification', method: 'GET', path: '/specifications', query: ['containerId', 'containerType', 'cursor'], requiredQuery: ['containerId', 'containerType'], body: 'none' },
  { service: 'specification', method: 'POST', path: '/specifications', query: ['containerId', 'containerType'], requiredQuery: ['containerId', 'containerType'], body: 'record' },
  { service: 'specification', method: 'GET', path: '/specifications/{param}', body: 'none' },
  { service: 'specification', method: 'PATCH', path: '/specifications/{param}', body: 'record-or-array' },
  { service: 'specification', method: 'DELETE', path: '/specifications/{param}', body: 'none' },
  { service: 'specification', method: 'GET', path: '/specifications/{param}/collections', query: ['cursor', 'fields'], body: 'none' },
  { service: 'specification', method: 'POST', path: '/specifications/{param}/collections', body: 'record-or-array' },
  { service: 'specification', method: 'PUT', path: '/specifications/{param}/collections', body: 'array' },
  { service: 'specification', method: 'POST', path: '/specifications/{param}/collections/{param}/sync', body: 'record' },
  { service: 'specification', method: 'GET', path: '/specifications/{param}/tree', query: ['cursor', 'fields', 'limit'], body: 'none' },
  { service: 'specification', method: 'GET', path: '/specifications/{param}/files', query: ['cursor'], body: 'none' },
  { service: 'specification', method: 'POST', path: '/specifications/{param}/files', body: 'record-or-array' },
  { service: 'specification', method: 'POST', path: '/specifications/{param}/bulk-files', body: 'record-or-array' },
  { service: 'specification', method: 'GET', path: '/specifications/{param}/files/{param}', query: ['fields'], body: 'none' },
  { service: 'specification', method: 'PATCH', path: '/specifications/{param}/files/{param}', body: 'array' },
  { service: 'specification', method: 'DELETE', path: '/specifications/{param}/files/{param}', body: 'none' },
  { service: 'specification', method: 'GET', path: '/specifications/{param}/tags', query: ['cursor', 'limit'], body: 'none' },
  { service: 'specification', method: 'POST', path: '/specifications/{param}/tags', body: 'record' },
  { service: 'specification', method: 'GET', path: '/tasks', query: ['taskId'], body: 'none' },
  { service: 'collection', method: 'GET', path: '/v3/collections', query: ['cursor', 'workspace'], requiredQuery: ['workspace'], body: 'none' },
  { service: 'collection', method: 'POST', path: '/v3/collections', query: ['workspace'], requiredQuery: ['workspace'], body: 'record' },
  { service: 'collection', method: 'GET', path: '/v3/collections/{param}', body: 'none' },
  { service: 'collection', method: 'PATCH', path: '/v3/collections/{param}', body: 'array' },
  { service: 'collection', method: 'DELETE', path: '/v3/collections/{param}', body: 'none' },
  { service: 'collection', method: 'GET', path: '/v3/collections/{param}/export', body: 'none' },
  { service: 'collection', method: 'GET', path: '/v3/collections/{param}/items', body: 'none' },
  { service: 'collection', method: 'POST', path: '/v3/collections/{param}/items', body: 'record' },
  { service: 'collection', method: 'GET', path: '/v3/collections/{param}/items/{param}', body: 'none' },
  { service: 'collection', method: 'PATCH', path: '/v3/collections/{param}/items/{param}', body: 'record-or-array' },
  { service: 'collection', method: 'DELETE', path: '/v3/collections/{param}/items/{param}', body: 'none' },
  { service: 'collection', method: 'GET', path: '/collections/{param}', body: 'none' },
  { service: 'collection', method: 'DELETE', path: '/collections/{param}', body: 'none' },
  { service: 'collection', method: 'GET', path: '/collections/{param}/items', body: 'none' },
  { service: 'collection', method: 'POST', path: '/collections/{param}/items', body: 'record' },
  { service: 'collection', method: 'GET', path: '/collections/{param}/items/{param}', body: 'none' },
  { service: 'collection', method: 'POST', path: '/collections', body: 'record' },
  { service: 'tagging', method: 'PUT', path: '/v1/tags/collections/{param}', body: 'record' },
  { service: 'god', method: 'GET', path: '/api/organizations/{param}/members', query: ['cursor', 'limit'], body: 'none' },
  { service: 'ruleset', method: 'GET', path: '/configure/workspace-groups', query: ['workspace'], body: 'none' },
  { service: 'ruleset', method: 'PATCH', path: '/configure/workspace-groups/{param}', body: 'record-or-array' }
] as const;

interface ModeledRequest {
  service: string;
  method: string;
  pathname: string;
  rawPath: string;
  query: Record<string, string>;
  body: unknown;
}

function normalizePathname(pathname: string): string {
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

function routePattern(path: string): RegExp {
  const escaped = normalizePathname(path)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{param\\\}/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

export function isModeledPlatformFakeRoute(
  service: string,
  method: string,
  path: string
): boolean {
  const pathname = parsePathAndQuery(path).pathname;
  return PLATFORM_FAKE_ROUTES.some(
    (route) =>
      route.service === service &&
      route.method === method.toUpperCase() &&
      routePattern(route.path).test(pathname)
  );
}

function parsePathAndQuery(
  rawPath: string,
  explicitQuery?: Record<string, unknown>
): { pathname: string; query: Record<string, string> } {
  const parsed = new URL(rawPath, 'https://platform-fake.invalid');
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) query[key] = value;
  for (const [key, value] of Object.entries(explicitQuery ?? {})) {
    query[key] = String(value);
  }
  return { pathname: normalizePathname(parsed.pathname), query };
}

function bodyMatches(shape: FakeBodyShape, body: unknown): boolean {
  if (shape === 'none') return body === undefined || body === null;
  const record = body !== null && typeof body === 'object' && !Array.isArray(body);
  if (shape === 'record') return record;
  if (shape === 'array') return Array.isArray(body);
  return record || Array.isArray(body);
}

function queryMatches(route: PlatformFakeRoute, query: Record<string, string>): boolean {
  const allowed = new Set(route.query ?? []);
  if (Object.keys(query).some((key) => !allowed.has(key))) return false;
  return (route.requiredQuery ?? []).every((key) => query[key] !== undefined && query[key] !== '');
}

function routeDistance(route: PlatformFakeRoute, request: ModeledRequest): number {
  let score = route.service === request.service ? 0 : 100;
  score += route.method === request.method ? 0 : 25;
  const routeSegments = normalizePathname(route.path).split('/');
  const requestSegments = request.pathname.split('/');
  score += Math.abs(routeSegments.length - requestSegments.length) * 5;
  const length = Math.min(routeSegments.length, requestSegments.length);
  for (let index = 0; index < length; index += 1) {
    if (routeSegments[index] !== '{param}' && routeSegments[index] !== requestSegments[index]) score += 1;
  }
  return score;
}

function assertModeledRequest(request: ModeledRequest): PlatformFakeRoute {
  const pathMatches = PLATFORM_FAKE_ROUTES.filter(
    (route) =>
      route.service === request.service &&
      route.method === request.method &&
      routePattern(route.path).test(request.pathname)
  );
  const matched = pathMatches.find(
    (route) => queryMatches(route, request.query) && bodyMatches(route.body, request.body)
  );
  if (matched) return matched;

  const nearest = [...PLATFORM_FAKE_ROUTES].sort(
    (left, right) => routeDistance(left, request) - routeDistance(right, request)
  )[0];
  const query = new URLSearchParams(request.query).toString();
  const reason =
    pathMatches.length > 0
      ? 'query or body shape did not match'
      : 'service, method, or path did not match';
  throw new Error(
    `Unmatched platform fake request: ${request.service} ${request.method} ${request.rawPath}` +
      `${query && !request.rawPath.includes('?') ? `?${query}` : ''}. ` +
      `Nearest modeled route: ${nearest?.service ?? '(none)'} ${nearest?.method ?? ''} ${nearest?.path ?? ''} (${reason})`
  );
}

export interface PlatformFakeCollectionSeed {
  id: string;
  name: string;
  description?: string;
  collection?: JsonRecord;
  /** Numeric owner used by destructive-route authorization. Defaults to fake user. */
  ownerId?: number;
  /** Invisible for this many inventory observations, then visible on the next. */
  visibleAfterObservations?: number;
  /** Vanishes after this many observations since creation. */
  vanishesAfterObservations?: number;
}

export interface PlatformFakeImportElectionOptions {
  /** Canonical inventory UID when Sync returns a bare model id. */
  importedCanonicalId?: string;
  importedVisibleAfterObservations?: number;
  importedVanishesAfterObservations?: number;
  /** Concurrent or pre-existing resources participating in the election. */
  peers?: PlatformFakeCollectionSeed[];
  /** Mirrors org inventory, where collection descriptions are omitted. */
  omitInventoryDescriptions?: boolean;
}

export interface PlatformFakeCollectionState {
  id: string;
  name: string;
  description?: string;
  ownerId: number;
  origin: 'existing' | 'peer' | 'imported';
  status: 'active' | 'deleted' | 'vanished';
  visibleAfterObservations: number;
  vanishesAfterObservations?: number;
}

export type PlatformFakeRequest = ProxyEnvelope;

export interface PlatformFakeOptions {
  /** Org-mode account (squads exist; visibility flip 403s). Default false. */
  org?: boolean;
  /** Endpoint profile to serve. Default 'prod'. */
  stack?: 'prod' | 'beta';
  /** Squads returned by the ums probe when org. Default one squad. */
  squads?: PlatformSquad[];
  /** Session identity team id. Defaults: org 13347347, non-org 10490519. */
  teamId?: number;
  /** Public API /me user id. Default 12345678. */
  userId?: number;
  /** iapub session user id. Default 555. */
  sessionUserId?: number;
  /** Workspace id returned by create/read routes. Default ws-contract. */
  workspaceId?: string;
  /** Specification id returned by create/read routes. Default spec-contract. */
  specificationId?: string;
  /** Specification file id returned by file routes. Default file-root. */
  specificationFileId?: string;
  /** Collection id factory. Defaults to the existing owner/role/sequence shape. */
  collectionId?: (role: 'baseline' | 'smoke' | 'contract', sequence: number) => string;
  /** Generic collection-create id used by non-OpenAPI protocols. */
  createdCollectionId?: string;
  /**
   * Collections that already exist in the workspace before the run (refresh /
   * adopt paths). Export serves a valid v2.1 body for each seeded id.
   */
  existingCollections?: PlatformFakeCollectionSeed[];
  /** Deterministic local-import election/propagation configuration. */
  importElection?: PlatformFakeImportElectionOptions;
  /** Configure the non-org personal-to-team visibility mutation. */
  visibilityFlip?: 'success' | 'forbidden';
  /** Maximum rows per list response. Omit for a single page. */
  pageSize?: number;
  /** Session consumerType. Default 'service_account'. */
  consumerType?: string;
  /** Kept for harness compatibility; OpenAPI no longer polls Spec Hub generation. */
  generationTaskStatuses?: string[];
  /**
   * Failure/override hook, consulted first. Return a Response to short-circuit;
   * return undefined to fall through to the default router.
   */
  override?: (ctx: {
    url: string;
    method: string;
    init?: RequestInit;
    proxy?: ProxyEnvelope;
  }) => Response | undefined;
}

export interface PlatformFakeState {
  events: string[];
  requests: PlatformFakeRequest[];
  mintCount: number;
  flipAttempts: number;
  workspaceCreateBodies: JsonRecord[];
  workspaces: Array<{
    id: string;
    visibility: string;
    status: 'active' | 'deleted';
  }>;
  generationPostCount: number;
  taskPollCount: number;
  importPostCount: number;
  deepUpdatePutCount: number;
  deepUpdatedCollectionIds: string[];
  collectionObservationCount: number;
  paginationCursorsIssued: number;
  collections: PlatformFakeCollectionState[];
  collectionTransitions: string[];
  collectionDeleteLedger: Array<{
    id: string;
    ownedByRun: boolean;
    verifiedAbsent: boolean;
  }>;
}

export interface PlatformFake {
  fetch: typeof fetch;
  state: PlatformFakeState;
  hosts: { api: string; bifrost: string; iapub: string };
}

/** One Spec Hub definition member as the fake stores it. */
interface SpecFakeFile {
  id: string;
  path: string;
  fileType: 'ROOT' | 'DEFAULT';
  content: string;
}

const V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const BARE_COLLECTION_MODEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOSTS = {
  prod: {
    api: 'https://api.getpostman.com',
    bifrost: 'https://bifrost-premium-https-v4.gw.postman.com',
    iapub: 'https://iapub.postman.co'
  },
  beta: {
    api: 'https://api.getpostman-beta.com',
    bifrost: 'https://bifrost-https-v4.gw.postman-beta.com',
    iapub: 'https://iapub.postman.co'
  }
} as const;

export const DEFAULT_SQUAD: PlatformSquad = {
  id: 132319,
  name: 'CSE v12',
  handle: 'cse-v12',
  organizationId: 13347347
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function roleFromName(name: string): 'baseline' | 'smoke' | 'contract' {
  if (name.includes('[Smoke]')) return 'smoke';
  if (name.includes('[Contract]')) return 'contract';
  return 'baseline';
}

function defaultV21Export(id: string, name: string, description = ''): JsonRecord {
  return {
    info: {
      _postman_id: id,
      name,
      ...(description ? { description } : {}),
      schema: V21_SCHEMA
    },
    item: []
  };
}

export function createPlatformFake(options: PlatformFakeOptions = {}): PlatformFake {
  const org = options.org ?? false;
  const stack = options.stack ?? 'prod';
  const hosts = HOSTS[stack];
  const squads = options.squads ?? (org ? [DEFAULT_SQUAD] : []);
  const teamId = options.teamId ?? (org ? 13347347 : 10490519);
  const userId = options.userId ?? 12345678;
  const sessionUserId = options.sessionUserId ?? 555;
  const workspaceId = options.workspaceId ?? 'ws-contract';
  const specificationId = options.specificationId ?? 'spec-contract';
  const specificationFileId = options.specificationFileId ?? 'file-root';
  const collectionId =
    options.collectionId ??
    ((role: 'baseline' | 'smoke' | 'contract', sequence: number) =>
      `12345678-col-${role}-${sequence}`);
  const createdCollectionId = options.createdCollectionId ?? '55363555-created';
  const consumerType = options.consumerType ?? 'service_account';
  const visibilityFlip = options.visibilityFlip ?? (org ? 'forbidden' : 'success');

  const state: PlatformFakeState = {
    events: [],
    requests: [],
    mintCount: 0,
    flipAttempts: 0,
    workspaceCreateBodies: [],
    workspaces: [],
    generationPostCount: 0,
    taskPollCount: 0,
    importPostCount: 0,
    deepUpdatePutCount: 0,
    deepUpdatedCollectionIds: [],
    collectionObservationCount: 0,
    paginationCursorsIssued: 0,
    collections: [],
    collectionTransitions: [],
    collectionDeleteLedger: []
  };

  // Mutable per-run platform state.
  let workspaceVisibility: string | undefined;
  let workspaceDeleted = false;
  let importSeq = 0;
  interface StoredCollection {
    id: string;
    name: string;
    description?: string;
    ownerId: number;
    origin: 'existing' | 'peer' | 'imported';
    createdAtObservation: number;
    visibleAfterObservations: number;
    vanishesAfterObservations?: number;
  }
  const collectionsById = new Map<string, StoredCollection>();
  const collectionExports = new Map<string, JsonRecord>();
  for (const existing of options.existingCollections ?? []) {
    collectionsById.set(existing.id, {
      id: existing.id,
      name: existing.name,
      ...(existing.description ? { description: existing.description } : {}),
      ownerId: existing.ownerId ?? userId,
      origin: 'existing',
      createdAtObservation: 0,
      visibleAfterObservations: 0
    });
    collectionExports.set(
      existing.id,
      existing.collection ?? defaultV21Export(existing.id, existing.name)
    );
  }
  for (const peer of options.importElection?.peers ?? []) {
    collectionsById.set(peer.id, {
      id: peer.id,
      name: peer.name,
      ...(peer.description ? { description: peer.description } : {}),
      ownerId: peer.ownerId ?? userId,
      origin: 'peer',
      createdAtObservation: 0,
      visibleAfterObservations: peer.visibleAfterObservations ?? 0,
      ...(peer.vanishesAfterObservations !== undefined
        ? { vanishesAfterObservations: peer.vanishesAfterObservations }
        : {})
    });
    collectionExports.set(
      peer.id,
      peer.collection ?? defaultV21Export(peer.id, peer.name, peer.description)
    );
  }
  const linkedRelations = new Map<
    string,
    {
      collectionId: string;
      state: string;
      options?: Record<string, unknown>;
      syncOptions?: Record<string, unknown>;
    }
  >();
  const deletedIds = new Set<string>();
  const vanishedIds = new Set<string>();
  const visibleIds = new Set<string>();
  // Spec Hub definition members, keyed by file id. Populated from the inline
  // `files` array of a multi-file create so the readback the client performs
  // after a create/reconcile sees the tree it just uploaded.
  const specFiles = new Map<string, SpecFakeFile>();
  const taskStatuses = options.generationTaskStatuses
    ? [...options.generationTaskStatuses]
    : undefined;
  const pageSize =
    typeof options.pageSize === 'number' && Number.isInteger(options.pageSize) && options.pageSize > 0
      ? options.pageSize
      : Number.POSITIVE_INFINITY;
  const pageSnapshots = new Map<string, unknown[]>();
  let pageSequence = 0;
  const specificationsById = new Map<string, { id: string; name: string; ownerId: number }>();

  function encodeCursor(kind: string, sequence: number, offset: number): string {
    return Buffer.from(JSON.stringify({ kind, sequence, offset }), 'utf8').toString('base64url');
  }

  function decodeCursor(
    kind: string,
    cursor: string
  ): { snapshotKey: string; offset: number } {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        kind?: unknown;
        sequence?: unknown;
        offset?: unknown;
      };
      if (
        decoded.kind !== kind ||
        !Number.isInteger(decoded.sequence) ||
        !Number.isInteger(decoded.offset) ||
        Number(decoded.offset) < 0
      ) {
        throw new Error('cursor payload mismatch');
      }
      return {
        snapshotKey: `${kind}:${Number(decoded.sequence)}`,
        offset: Number(decoded.offset)
      };
    } catch (error) {
      throw new Error(`Invalid ${kind} cursor supplied to platform fake`, { cause: error });
    }
  }

  function paginate<T>(
    kind: string,
    cursor: string,
    createRows: () => T[]
  ): { data: T[]; nextCursor: string } {
    let snapshotKey: string;
    let offset: number;
    if (cursor) {
      ({ snapshotKey, offset } = decodeCursor(kind, cursor));
      if (!pageSnapshots.has(snapshotKey)) {
        throw new Error(`Expired ${kind} cursor supplied to platform fake`);
      }
    } else {
      pageSequence += 1;
      snapshotKey = `${kind}:${pageSequence}`;
      offset = 0;
      pageSnapshots.set(snapshotKey, createRows());
    }
    const rows = pageSnapshots.get(snapshotKey) as T[];
    const data = rows.slice(offset, offset + pageSize);
    const nextOffset = offset + data.length;
    const nextCursor = nextOffset < rows.length
      ? encodeCursor(kind, Number(snapshotKey.split(':').pop()), nextOffset)
      : '';
    if (nextCursor) state.paginationCursorsIssued += 1;
    else pageSnapshots.delete(snapshotKey);
    return { data, nextCursor };
  }

  function refreshWorkspaceState(): void {
    state.workspaces = workspaceVisibility
      ? [
          {
            id: workspaceId,
            visibility: workspaceVisibility,
            status: workspaceDeleted ? 'deleted' : 'active'
          }
        ]
      : [];
  }

  function refreshCollectionState(): void {
    state.collections = [...collectionsById.values()].map((entry) => ({
      id: entry.id,
      name: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ownerId: entry.ownerId,
      origin: entry.origin,
      status: deletedIds.has(entry.id)
        ? 'deleted'
        : vanishedIds.has(entry.id)
          ? 'vanished'
          : 'active',
      visibleAfterObservations: entry.visibleAfterObservations,
      ...(entry.vanishesAfterObservations !== undefined
        ? { vanishesAfterObservations: entry.vanishesAfterObservations }
        : {})
    }));
  }

  function resolveCollectionId(candidate: string): string | undefined {
    return [...collectionsById.keys()].find(
      (id) => id === candidate || id.endsWith(candidate)
    );
  }

  function observeCollections(): StoredCollection[] {
    state.collectionObservationCount += 1;
    const visible: StoredCollection[] = [];
    for (const entry of collectionsById.values()) {
      const elapsed = state.collectionObservationCount - entry.createdAtObservation;
      if (
        entry.vanishesAfterObservations !== undefined &&
        elapsed > entry.vanishesAfterObservations &&
        !vanishedIds.has(entry.id)
      ) {
        vanishedIds.add(entry.id);
        state.collectionTransitions.push(`vanished:${entry.id}:observation=${elapsed}`);
      }
      if (
        deletedIds.has(entry.id) ||
        vanishedIds.has(entry.id) ||
        elapsed <= entry.visibleAfterObservations
      ) {
        continue;
      }
      if (!visibleIds.has(entry.id)) {
        visibleIds.add(entry.id);
        state.collectionTransitions.push(`visible:${entry.id}:observation=${elapsed}`);
      }
      visible.push(entry);
    }
    refreshCollectionState();
    return visible;
  }

  refreshCollectionState();

  function captureSpecFiles(body: unknown): void {
    const rows = asRecord(body)?.files;
    if (!Array.isArray(rows)) return;
    specFiles.clear();
    rows.forEach((row, index) => {
      const record = asRecord(row);
      const path = String(record?.path ?? '').trim();
      if (!path) return;
      const id = `spec-file-${index}`;
      specFiles.set(id, {
        id,
        path,
        fileType: String(record?.type ?? 'DEFAULT') === 'ROOT' ? 'ROOT' : 'DEFAULT',
        content: String(record?.content ?? '')
      });
    });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    state.events.push(`fetch:${method} ${url}`);

    let proxy: ProxyEnvelope | undefined;
    if (url === `${hosts.bifrost}/ws/proxy`) {
      const payload = JSON.parse(String(init?.body ?? '{}')) as Partial<ProxyEnvelope>;
      proxy = {
        service: String(payload.service ?? ''),
        method: String(payload.method ?? 'get').toLowerCase(),
        path: String(payload.path ?? ''),
        body: payload.body,
        ...(payload.query ? { query: payload.query as Record<string, unknown> } : {})
      };
      state.events.push(`proxy:${proxy.service} ${proxy.method.toUpperCase()} ${proxy.path}`);
      state.requests.push({ ...proxy });
    }

    let request: ModeledRequest;
    if (proxy) {
      const parsed = parsePathAndQuery(proxy.path, proxy.query);
      request = {
        service: proxy.service,
        method: proxy.method.toUpperCase(),
        pathname: parsed.pathname,
        rawPath: proxy.path,
        query: parsed.query,
        body: proxy.body
      };
    } else {
      const parsedUrl = new URL(url);
      let body: unknown;
      if (init?.body !== undefined && init.body !== null) {
        try {
          body = JSON.parse(String(init.body));
        } catch {
          body = Symbol('invalid-json-body');
        }
      }
      const service =
        parsedUrl.origin === hosts.api
          ? 'postman-api'
          : parsedUrl.origin === hosts.iapub
            ? 'iapub'
            : parsedUrl.origin === hosts.bifrost
              ? 'bifrost-direct'
            : parsedUrl.hostname === 'dl.pstmn.io'
              ? 'dl.pstmn.io'
              : parsedUrl.hostname;
      request = {
        service,
        method,
        pathname: normalizePathname(parsedUrl.pathname),
        rawPath: `${parsedUrl.pathname}${parsedUrl.search}`,
        query: Object.fromEntries(parsedUrl.searchParams),
        body
      };
    }
    const matchedRoute = assertModeledRequest(request);

    const custom = options.override?.({ url, method, init, proxy });
    if (custom) return custom;

    // --- direct (non-proxy) endpoints ---
    if (url === `${hosts.api}/service-account-tokens` && method === 'POST') {
      state.mintCount += 1;
      return json({ access_token: 'minted-access-token' });
    }
    if (url === `${hosts.api}/me`) {
      return json({
        user: {
          id: userId,
          fullName: 'Ada Lovelace',
          teamId,
          teamName: org ? 'field-services-v12-demo' : 'jared-demo',
          teamDomain: org ? 'field-services-v12-demo' : 'jared-demo'
        }
      });
    }
    if (url === `${hosts.iapub}/api/sessions/current`) {
      return json({
        identity: { team: teamId, domain: org ? 'field-services-v12-demo' : 'jared-demo' },
        data: { user: { id: sessionUserId, roles: ['admin'] } },
        consumerType
      });
    }
    if (url.startsWith('https://dl.pstmn.io/')) {
      return json({ version: '12.0.0' });
    }
    if (request.service === 'bifrost-direct' && method === 'GET') {
      const requested = decodeURIComponent(request.pathname.split('/')[2] ?? '');
      const id = resolveCollectionId(requested);
      if (!id || deletedIds.has(id) || vanishedIds.has(id)) {
        return json({ error: 'missing' }, 404);
      }
      const entry = collectionsById.get(id)!;
      const exported = collectionExports.get(id) ?? defaultV21Export(id, entry.name, entry.description);
      const info = asRecord(exported.info) ?? {};
      return json({
        entities: [{
          revision: 1,
          data: {
            uid: id,
            name: String(info.name ?? entry.name),
            description: String(info.description ?? entry.description ?? '')
          }
        }]
      });
    }

    // --- Bifrost /ws/proxy envelope ---
    if (proxy) {
      const svc = proxy.service;
      const pmethod = proxy.method;
      const ppath = request.pathname;
      const query = request.query;

      if (svc === 'ums' && /\/squads/.test(ppath)) {
        if (!org) {
          return json({ message: 'Squad feature is not available' }, 400);
        }
        return json({ data: squads });
      }

      if (svc === 'workspaces') {
        if (pmethod === 'post' && ppath === '/workspaces') {
          const body = asRecord(proxy.body) ?? {};
          state.workspaceCreateBodies.push(body);
          workspaceVisibility = body.squad ? 'team' : 'personal';
          workspaceDeleted = false;
          refreshWorkspaceState();
          return json({ data: { id: workspaceId } });
        }
        if (pmethod === 'put' && /\/workspaces\/[^/]+\/visibility$/.test(ppath)) {
          state.flipAttempts += 1;
          if (visibilityFlip === 'forbidden') {
            // Live gateway behavior: org service accounts cannot flip personal->team.
            return json(
              { message: 'You are not authorized to perform this action', name: 'addWorkspaceLevelTeamRoles' },
              403
            );
          }
          workspaceVisibility = String(asRecord(proxy.body)?.visibilityStatus ?? 'team');
          refreshWorkspaceState();
          return json({ data: { id: workspaceId, visibilityStatus: workspaceVisibility } });
        }
        if (pmethod === 'delete' && /\/workspaces\/[^/]+$/.test(ppath)) {
          workspaceDeleted = true;
          refreshWorkspaceState();
          return json({ data: { deleted: workspaceId } });
        }
        if (pmethod === 'get' && /\/workspaces\/[^/]+\/filesystem$/.test(ppath)) {
          return json({ data: null });
        }
        if (pmethod === 'get' && ppath === '/workspaces/filesystem') {
          return json({ data: null });
        }
        if (pmethod === 'get' && /\/workspaces\/[^/]+$/.test(ppath)) {
          if (workspaceDeleted) return json({ error: 'missing' }, 404);
          return json({ data: { id: workspaceId, visibilityStatus: workspaceVisibility ?? 'team' } });
        }
        if (pmethod === 'get' && ppath === '/workspaces') {
          const page = paginate('workspace-list', query.cursor ?? '', () =>
            workspaceVisibility && !workspaceDeleted
              ? [{ id: workspaceId, visibilityStatus: workspaceVisibility }]
              : []
          );
          return json({ data: page.data, meta: { nextCursor: page.nextCursor } });
        }
        if (pmethod === 'post' && /\/workspaces\/[^/]+\/filesystem$/.test(ppath)) {
          return json({ data: { workspaceId } });
        }
        if (pmethod === 'patch' && /\/workspaces\/[^/]+\/roles$/.test(ppath)) {
          return json({ data: { workspaceId } });
        }
      }

      if (svc === 'sync') {
        if (pmethod === 'post' && ppath === '/collection/import') {
          state.importPostCount += 1;
          importSeq += 1;
          const body = asRecord(proxy.body) ?? {};
          const info = asRecord(body.info) ?? {};
          const name = String(info.name ?? `Imported ${importSeq}`);
          const description =
            typeof info.description === 'string' ? info.description : '';
          const slot = roleFromName(name);
          // Sync preserves the client-supplied collection root identity. The
          // fallback keeps legacy fake callers working, but production import
          // tests must observe the exact id that was sent on the unsafe POST.
          const suppliedModelId = String(info._postman_id ?? '').trim();
          const modelId = suppliedModelId || collectionId(slot, importSeq);
          const id =
            options.importElection?.importedCanonicalId ??
            (BARE_COLLECTION_MODEL_ID.test(modelId) ? `${Math.abs(userId)}-${modelId}` : modelId);
          collectionsById.set(id, {
            id,
            name,
            ...(description ? { description } : {}),
            ownerId: userId,
            origin: 'imported',
            createdAtObservation: state.collectionObservationCount,
            visibleAfterObservations:
              options.importElection?.importedVisibleAfterObservations ?? 0,
            ...(options.importElection?.importedVanishesAfterObservations !== undefined
              ? {
                  vanishesAfterObservations:
                    options.importElection.importedVanishesAfterObservations
                }
              : {})
          });
          collectionExports.set(id, structuredClone(body));
          deletedIds.delete(id);
          vanishedIds.delete(id);
          visibleIds.delete(id);
          state.collectionTransitions.push(`imported:${id}:${name}`);
          refreshCollectionState();
          // Documented live Sync import envelope (model_id + data.info._postman_id).
          return json({
            model_id: modelId,
            data: {
              info: {
                _postman_id: modelId,
                name
              }
            }
          });
        }
        if (pmethod === 'put' && /^\/collection\/deepupdate\//.test(ppath)) {
          state.deepUpdatePutCount += 1;
          const bare = ppath.split('/').pop() || '';
          const id = resolveCollectionId(bare) ?? bare;
          if (!state.deepUpdatedCollectionIds.includes(id)) {
            state.deepUpdatedCollectionIds.push(id);
          }
          const body = asRecord(proxy.body);
          if (body && collectionsById.has(id)) {
            collectionExports.set(id, structuredClone(body));
            const entry = collectionsById.get(id)!;
            const info = asRecord(body.info);
            if (typeof info?.name === 'string' && info.name) entry.name = info.name;
            if (typeof info?.description === 'string' && info.description) {
              entry.description = info.description;
            } else {
              delete entry.description;
            }
            refreshCollectionState();
          }
          return json({ data: { id } });
        }
      }

      if (svc === 'specification') {
        if (pmethod === 'post' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
          // Legacy Spec Hub generation path — count only; OpenAPI must not hit this.
          state.generationPostCount += 1;
          if (taskStatuses) {
            return json({ data: { taskId: 'task-1' } });
          }
          return json({ data: { generation: 'accepted' } });
        }
        if (pmethod === 'get' && /\/tasks/.test(ppath)) {
          state.taskPollCount += 1;
          const status =
            taskStatuses && taskStatuses.length > 1
              ? taskStatuses.shift()!
              : (taskStatuses?.[0] ?? 'completed');
          return json({ data: { 'task-1': status } });
        }
        if (pmethod === 'put' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
          const rows = Array.isArray(proxy.body) ? proxy.body : [];
          for (const row of rows) {
            const record = asRecord(row);
            if (!record) continue;
            const collectionId = String(record.collectionId ?? '').trim();
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
            linkedRelations.set(collectionId, {
              collectionId,
              state: 'in-sync',
              ...(options ? { options } : {}),
              ...(syncOptions ? { syncOptions } : {})
            });
          }
          return json({ data: { updated: rows.length } });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
          const page = paginate('specification-relations', query.cursor ?? '', () =>
            [...linkedRelations.values()].map((row) => ({
              collection: row.collectionId,
              state: row.state,
              ...(row.options ? { options: row.options } : {}),
              ...(row.syncOptions ? { syncOptions: row.syncOptions } : {})
            }))
          );
          return json({
            data: page.data,
            meta: { cursor: { next: page.nextCursor } }
          });
        }
        // Definition tree fast path. Members carry id/path/fileType/content, so a
        // multi-file create verifies against the tree it actually uploaded
        // instead of passing through the permissive default.
        if (pmethod === 'get' && /\/specifications\/[^/]+\/tree$/.test(ppath)) {
          const page = paginate('specification-tree', query.cursor ?? '', () =>
            [...specFiles.values()].map((file) => ({
              type: 'FILE',
              id: file.id,
              name: file.path.split('/').pop(),
              path: file.path,
              fileType: file.fileType,
              content: file.content
            }))
          );
          return json({
            data: page.data,
            meta: { cursor: { next: page.nextCursor } }
          });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+\/files\/[^/]+/.test(ppath)) {
          const file = specFiles.get(ppath.split('/').pop() || '');
          if (file) {
            return json({ data: { id: file.id, path: file.path, content: file.content } });
          }
          return json({ data: { id: specificationFileId, content: 'openapi: 3.0.0' } });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+\/files$/.test(ppath)) {
          if (specFiles.size > 0) {
            return json({
              data: [...specFiles.values()].map((file) => ({
                id: file.id,
                path: file.path,
                type: file.fileType
              }))
            });
          }
          return json({ data: [{ id: specificationFileId, type: 'ROOT' }] });
        }
        if (pmethod === 'post' && /\/specifications\/[^/]+\/(bulk-)?files$/.test(ppath)) {
          captureSpecFiles(proxy.body);
          return json({ data: [...specFiles.values()].map((file) => ({ id: file.id })) });
        }
        if (pmethod === 'delete' && /\/specifications\/[^/]+\/files\/[^/]+$/.test(ppath)) {
          const id = ppath.split('/').pop() || '';
          specFiles.delete(id);
          return json({ data: { deleted: id } });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+\/tags$/.test(ppath)) {
          return json({ data: [], meta: { cursor: { next: '' } } });
        }
        if (pmethod === 'post' && /\/specifications\/[^/]+\/tags$/.test(ppath)) {
          return json({ data: { name: String(asRecord(proxy.body)?.name ?? '') } });
        }
        if (pmethod === 'post' && /\/specifications\/[^/]+\/collections\/[^/]+\/sync$/.test(ppath)) {
          return json({ data: { state: 'in-sync' } });
        }
        if (pmethod === 'patch' && /\/specifications\/[^/]+\/files\/[^/]+$/.test(ppath)) {
          const file = specFiles.get(ppath.split('/').pop() || '');
          if (file) {
            // RFC6902 patch against /content, exactly as the client sends it.
            for (const op of Array.isArray(proxy.body) ? proxy.body : []) {
              const record = asRecord(op);
              if (record?.path === '/content') file.content = String(record.value ?? '');
            }
            specFiles.set(file.id, file);
            return json({ data: { id: file.id } });
          }
          return json({ data: { id: specificationFileId } });
        }
        if (pmethod === 'patch') {
          return json({ data: { id: specificationFileId } });
        }
        if (pmethod === 'post' && ppath.startsWith('/specifications')) {
          captureSpecFiles(proxy.body);
          const name = String(asRecord(proxy.body)?.name ?? 'Specification');
          specificationsById.set(specificationId, {
            id: specificationId,
            name,
            ownerId: userId
          });
          return json({ data: { id: specificationId } });
        }
        if (pmethod === 'get' && ppath === '/specifications') {
          const page = paginate('specification-list', query.cursor ?? '', () => [
            ...specificationsById.values()
          ].map((entry) => ({
            id: entry.id,
            name: entry.name
          }))
          );
          return json({ data: page.data, meta: { cursor: { next: page.nextCursor } } });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+$/.test(ppath)) {
          const id = ppath.split('/').pop() || '';
          const specification = specificationsById.get(id);
          if (!specification && id !== specificationId) return json({ error: 'missing' }, 404);
          return json({
            data: specification
              ? { id: specification.id, name: specification.name }
              : { id: specificationId }
          });
        }
        if (pmethod === 'delete' && /\/specifications\/[^/]+$/.test(ppath)) {
          const id = ppath.split('/').pop() || '';
          const specification = specificationsById.get(id);
          if (!specification) return json({ error: 'missing' }, 404);
          if (specification.ownerId !== userId) return json({ error: 'forbidden owner' }, 403);
          specificationsById.delete(id);
          return json({ data: { deleted: id } });
        }
      }

      if (svc === 'collection') {
        if (pmethod === 'get' && ppath === '/v3/collections') {
          const page = paginate('collection-list', query.cursor ?? '', () =>
            observeCollections().map((entry) => ({
              id: entry.id,
              name: entry.name,
              ...(!options.importElection?.omitInventoryDescriptions && entry.description
                ? { description: entry.description }
                : {})
            }))
          );
          for (const deletion of state.collectionDeleteLedger) {
            if (!page.data.some((entry) => asRecord(entry)?.id === deletion.id)) {
              deletion.verifiedAbsent = true;
            }
          }
          return json({
            data: page.data,
            meta: { pagination: { nextPage: page.nextCursor } }
          });
        }
        if (pmethod === 'get' && /\/export$/.test(ppath)) {
          const bare = ppath.replace(/\/export$/, '').split('/').pop() || '';
          const id = resolveCollectionId(bare) ?? bare;
          const entry = collectionsById.get(id);
          const collection = entry
            ? (collectionExports.get(id) ?? defaultV21Export(id, entry.name, entry.description))
            : {};
          return json({ data: { collection } });
        }
        if (pmethod === 'get' && /\/v3\/collections\/[^/?]+$/.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          if (BARE_COLLECTION_MODEL_ID.test(bare)) {
            return json({ error: 'forbidden collection root' }, 403);
          }
          const id = resolveCollectionId(bare);
          if (!id || deletedIds.has(id) || vanishedIds.has(id)) {
            const deletion = state.collectionDeleteLedger.findLast(
              (entry) => entry.id === id || entry.id.endsWith(bare)
            );
            if (deletion) deletion.verifiedAbsent = true;
            return json({ error: 'missing' }, 404);
          }
          return json({ data: { id, name: collectionsById.get(id)?.name } });
        }
        if (pmethod === 'get' && /\/items\/[^/]+$/.test(ppath)) {
          return json({
            data: {
              $kind: 'http-request',
              id: 'item-1',
              name: 'GET /payments',
              method: 'GET',
              url: 'https://example.test/payments'
            }
          });
        }
        if (pmethod === 'get' && /\/items$/.test(ppath)) {
          return json({ data: [{ $kind: 'http-request', id: 'item-1', name: 'GET /payments' }] });
        }
        if (pmethod === 'get' && /^\/collections\/[^/]+$/.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          const id = resolveCollectionId(bare);
          const entry = id ? collectionsById.get(id) : undefined;
          return entry
            ? json({ data: { collection: collectionExports.get(id!) ?? defaultV21Export(id!, entry.name) } })
            : json({ error: 'missing' }, 404);
        }
        if (pmethod === 'delete' && /^\/collections\/[^/]+$/.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          const id = resolveCollectionId(bare);
          if (!id) return json({ error: 'missing' }, 404);
          const resource = collectionsById.get(id);
          if (resource?.ownerId !== userId) return json({ error: 'forbidden owner' }, 403);
          deletedIds.add(id);
          return json({ data: { deleted: id } });
        }
        if (pmethod === 'delete' && /\/items\/[^/]+$/.test(ppath)) {
          return json({ data: { deleted: ppath.split('/').pop() } });
        }
        if (pmethod === 'patch' && /^\/v3\/collections\/[^/]+$/.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          if (BARE_COLLECTION_MODEL_ID.test(bare)) {
            return json({ error: 'forbidden collection root' }, 403);
          }
          const ops = Array.isArray(proxy.body) ? proxy.body : [];
          const id = resolveCollectionId(bare);
          const entry = id ? collectionsById.get(id) : undefined;
          if (id && entry) {
            const exported = collectionExports.get(id);
            const exportedInfo = asRecord(exported?.info);
            for (const rawOp of ops) {
              const op = asRecord(rawOp);
              const patchPath = String(op?.path ?? '');
              const remove = String(op?.op ?? '').toLowerCase() === 'remove';
              if (patchPath === '/name' && !remove) {
                const nextName = String(op?.value ?? '');
                if (nextName) {
                  const previousName = entry.name;
                  entry.name = nextName;
                  if (exportedInfo) exportedInfo.name = nextName;
                  state.collectionTransitions.push(`renamed:${id}:${previousName}->${nextName}`);
                }
              }
              if (patchPath === '/description') {
                const nextDescription = remove ? '' : String(op?.value ?? '');
                if (nextDescription) entry.description = nextDescription;
                else delete entry.description;
                if (exportedInfo) {
                  if (nextDescription) exportedInfo.description = nextDescription;
                  else delete exportedInfo.description;
                }
              }
            }
            collectionsById.set(id, entry);
            refreshCollectionState();
            return json({ data: { id } });
          }
          return json({ data: { id: bare } });
        }
        if (pmethod === 'delete' && /\/v3\/collections\//.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          const id = resolveCollectionId(bare);
          if (!id) return json({ error: 'missing' }, 404);
          const resource = collectionsById.get(id);
          if (resource?.ownerId !== userId) {
            return json({ error: 'forbidden owner' }, 403);
          }
          deletedIds.add(id);
          if (!state.collectionDeleteLedger.some((entry) => entry.id === id)) {
            state.collectionDeleteLedger.push({
              id,
              ownedByRun: resource?.origin === 'imported',
              verifiedAbsent: false
            });
          }
          state.collectionTransitions.push(`deleted:${id}`);
          refreshCollectionState();
          return json({ data: { deleted: id } });
        }
        if (pmethod === 'post') {
          if (ppath === '/collections' || ppath === '/v3/collections') {
            const body = asRecord(proxy.body) ?? {};
            const name = String(body.name ?? asRecord(body.collection)?.name ?? 'Created Collection');
            collectionsById.set(createdCollectionId, {
              id: createdCollectionId,
              name,
              ownerId: userId,
              origin: 'imported',
              createdAtObservation: state.collectionObservationCount,
              visibleAfterObservations: 0
            });
            refreshCollectionState();
          }
          return json({ data: { id: createdCollectionId } });
        }
        if (pmethod === 'patch') {
          return json({ data: { id: 'patched' } });
        }
      }

      if (svc === 'tagging') {
        return json({ tags: [{ slug: 'generated-smoke' }] });
      }

      if (svc === 'god') {
        return json({ data: [] });
      }

      if (svc === 'ruleset' && matchedRoute.method === 'GET') {
        return json({ data: [] });
      }
      if (svc === 'ruleset' && matchedRoute.method === 'PATCH') {
        return json({ data: { updated: ppath.split('/').pop() } });
      }

      throw new Error(
        `Modeled platform fake route has no handler: ${svc} ${pmethod.toUpperCase()} ${proxy.path}`
      );
    }

    throw new Error(`Unrouted fetch in platform fake: ${method} ${url}`);
  }) as typeof fetch;

  return { fetch: fetchImpl, state, hosts };
}
