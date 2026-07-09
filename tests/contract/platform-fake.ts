/**
 * In-memory Postman/Bifrost platform transport for contract tests.
 *
 * Serves the exact wire shapes the production clients parse (mint, /me, iapub
 * session, and the Bifrost /ws/proxy envelope for ums/workspaces/specification/
 * collection/tagging), parametrized over the axes real callers vary on:
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
  /** Generation task statuses served by successive GET /tasks (last sticks). When absent, generation returns no taskId (no poll). */
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
    taskPollCount: 0
  };

  // Mutable per-run platform state.
  let workspaceVisibility: string | undefined;
  const generatedCollectionUids: string[] = [];
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
        body: payload.body
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

      if (svc === 'specification') {
        if (pmethod === 'post' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
          state.generationPostCount += 1;
          const name = String(asRecord(proxy.body)?.name ?? '');
          const slot = name.includes('[Smoke]')
            ? 'smoke'
            : name.includes('[Contract]')
              ? 'contract'
              : 'baseline';
          generatedCollectionUids.push(`12345678-col-${slot}`);
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
        if (pmethod === 'get' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
          return json({
            data: generatedCollectionUids.map((collection) => ({ collection, state: 'in-sync' }))
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
        if (pmethod === 'get' && /\/export$/.test(ppath)) {
          return json({ data: { collection: {} } });
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
