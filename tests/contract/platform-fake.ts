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

export interface PlatformFakeOptions {
  /** Org-mode account (squads exist; visibility flip 403s). Default false. */
  org?: boolean;
  /** Endpoint profile to serve. Default 'prod'. */
  stack?: 'prod' | 'beta';
  /** Squads returned by the ums probe when org. Default one squad. */
  squads?: PlatformSquad[];
  /** Session identity team id. Defaults: org 13347347, non-org 10490519. */
  teamId?: number;
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
  mintCount: number;
  flipAttempts: number;
  workspaceCreateBodies: JsonRecord[];
  generationPostCount: number;
  taskPollCount: number;
  importPostCount: number;
  deepUpdatePutCount: number;
}

export interface PlatformFake {
  fetch: typeof fetch;
  state: PlatformFakeState;
  hosts: { api: string; bifrost: string; iapub: string };
}

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

export function createPlatformFake(options: PlatformFakeOptions = {}): PlatformFake {
  const org = options.org ?? false;
  const stack = options.stack ?? 'prod';
  const hosts = HOSTS[stack];
  const squads = options.squads ?? (org ? [DEFAULT_SQUAD] : []);
  const teamId = options.teamId ?? (org ? 13347347 : 10490519);
  const consumerType = options.consumerType ?? 'service_account';

  const state: PlatformFakeState = {
    events: [],
    mintCount: 0,
    flipAttempts: 0,
    workspaceCreateBodies: [],
    generationPostCount: 0,
    taskPollCount: 0,
    importPostCount: 0,
    deepUpdatePutCount: 0
  };

  // Mutable per-run platform state.
  let workspaceVisibility: string | undefined;
  let importSeq = 0;
  const collectionsById = new Map<string, { id: string; name: string }>();
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
  const taskStatuses = options.generationTaskStatuses
    ? [...options.generationTaskStatuses]
    : undefined;

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
    }

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
          id: 12345678,
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
        data: { user: { id: 555, roles: ['admin'] } },
        consumerType
      });
    }
    if (url.startsWith('https://dl.pstmn.io/')) {
      return json({ version: '12.0.0' });
    }

    // --- Bifrost /ws/proxy envelope ---
    if (proxy) {
      const { service: svc, method: pmethod, path: ppath } = proxy;

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
          return json({ data: { id: 'ws-contract' } });
        }
        if (pmethod === 'put' && /\/workspaces\/[^/]+\/visibility$/.test(ppath)) {
          state.flipAttempts += 1;
          if (org) {
            // Live gateway behavior: org service accounts cannot flip personal->team.
            return json(
              { message: 'You are not authorized to perform this action', name: 'addWorkspaceLevelTeamRoles' },
              403
            );
          }
          workspaceVisibility = String(asRecord(proxy.body)?.visibilityStatus ?? 'team');
          return json({ data: { id: 'ws-contract', visibilityStatus: workspaceVisibility } });
        }
        if (pmethod === 'delete' && /\/workspaces\/[^/]+$/.test(ppath)) {
          return json({ data: {} });
        }
        if (pmethod === 'get' && /\/workspaces\/[^/]+\/filesystem$/.test(ppath)) {
          return json({ data: null });
        }
        if (pmethod === 'get' && /\/workspaces\/[^/]+$/.test(ppath)) {
          return json({ data: { id: 'ws-contract', visibilityStatus: workspaceVisibility ?? 'team' } });
        }
        if (pmethod === 'get' && ppath.startsWith('/workspaces')) {
          return json({ data: [] });
        }
      }

      if (svc === 'sync') {
        if (pmethod === 'post' && ppath === '/collection/import') {
          state.importPostCount += 1;
          importSeq += 1;
          const body = asRecord(proxy.body) ?? {};
          const info = asRecord(body.info) ?? {};
          const name = String(info.name ?? `Imported ${importSeq}`);
          const slot = roleFromName(name);
          const id = `12345678-col-${slot}-${importSeq}`;
          collectionsById.set(id, { id, name });
          deletedIds.delete(id);
          // Documented live Sync import envelope (model_id + data.info._postman_id).
          return json({
            model_id: id,
            data: {
              info: {
                _postman_id: id,
                name
              }
            }
          });
        }
        if (pmethod === 'put' && /^\/collection\/deepupdate\//.test(ppath)) {
          state.deepUpdatePutCount += 1;
          return json({ data: { ok: true } });
        }
      }

      if (svc === 'specification') {
        if (pmethod === 'post' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
          // Legacy Spec Hub generation path — count only; OpenAPI must not hit this.
          state.generationPostCount += 1;
          if (taskStatuses) {
            return json({ data: { taskId: 'task-1' } });
          }
          return json({ data: {} });
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
          return json({
            data: [...linkedRelations.values()].map((row) => ({
              collection: row.collectionId,
              state: row.state,
              ...(row.options ? { options: row.options } : {}),
              ...(row.syncOptions ? { syncOptions: row.syncOptions } : {})
            }))
          });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+\/files\/[^/]+/.test(ppath)) {
          return json({ data: { id: 'file-root', content: 'openapi: 3.0.0' } });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+\/files$/.test(ppath)) {
          return json({ data: [{ id: 'file-root', type: 'ROOT' }] });
        }
        if (pmethod === 'patch') {
          return json({ data: { id: 'file-root' } });
        }
        if (pmethod === 'post' && ppath.startsWith('/specifications')) {
          return json({ data: { id: 'spec-contract' } });
        }
        if (pmethod === 'get' && /\/specifications\/[^/]+$/.test(ppath)) {
          return json({ data: { id: 'spec-contract' } });
        }
      }

      if (svc === 'collection') {
        if (pmethod === 'get' && ppath.startsWith('/v3/collections/?workspace=')) {
          return json({
            data: [...collectionsById.values()].filter((entry) => !deletedIds.has(entry.id))
          });
        }
        if (pmethod === 'get' && /\/export$/.test(ppath)) {
          return json({ data: { collection: {} } });
        }
        if (pmethod === 'get' && /\/v3\/collections\/[^/?]+$/.test(ppath)) {
          const id = ppath.split('/').pop() || '';
          if (deletedIds.has(id) || ![...collectionsById.keys()].some((key) => key.endsWith(id) || key === id)) {
            return json({ error: 'missing' }, 404);
          }
          return json({ data: { id } });
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
        if (pmethod === 'get' && /\/items\/$/.test(ppath)) {
          return json({ data: [{ $kind: 'http-request', id: 'item-1', name: 'GET /payments' }] });
        }
        if (pmethod === 'patch' && /\/v3\/collections\//.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          const ops = Array.isArray(proxy.body) ? proxy.body : [];
          const nameOp = ops.find((op) => asRecord(op)?.path === '/name');
          const nextName = nameOp ? String(asRecord(nameOp)?.value ?? '') : '';
          for (const [id, entry] of collectionsById) {
            if (id === bare || id.endsWith(bare)) {
              if (nextName) entry.name = nextName;
              collectionsById.set(id, entry);
              return json({ data: { id } });
            }
          }
          return json({ data: { id: bare } });
        }
        if (pmethod === 'delete' && /\/v3\/collections\//.test(ppath)) {
          const bare = ppath.split('/').pop() || '';
          for (const id of collectionsById.keys()) {
            if (id === bare || id.endsWith(bare)) {
              deletedIds.add(id);
            }
          }
          deletedIds.add(bare);
          return json({ data: { ok: true } });
        }
        if (pmethod === 'post') {
          return json({ data: { id: '55363555-created' } });
        }
        if (pmethod === 'patch') {
          return json({ data: { id: 'patched' } });
        }
      }

      if (svc === 'tagging') {
        return json({ tags: [{ slug: 'generated-smoke' }] });
      }

      // Internal-integration (governance/link/sync) and anything else proxied.
      return json({ data: { ok: true } });
    }

    throw new Error(`Unrouted fetch in platform fake: ${method} ${url}`);
  }) as typeof fetch;

  return { fetch: fetchImpl, state, hosts };
}
