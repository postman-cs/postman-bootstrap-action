import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import { runAction, type CoreLike } from '../src/index.js';
import {
  createExecStub,
  createIoStub,
  runWithFakeTimers,
  VALID_SPEC_31
} from './contract/harness.js';

function createGeneratedContractCollection() {
  return {
    info: { name: '[Contract] core-payments' },
    item: [
      {
        name: 'GET /payments',
        request: {
          method: 'GET',
          url: { path: ['payments'] }
        }
      }
    ]
  };
}

describe('runAction credential preflight', () => {
  let specDir: string;

  const NEUTRALIZED_ENV_VARS = [
    'GITHUB_REPOSITORY',
    'GITHUB_SERVER_URL',
    'CI_PROJECT_URL',
    'CI_PROJECT_PATH',
    'CI_PROJECT_NAME',
    'BITBUCKET_GIT_HTTP_ORIGIN',
    'BITBUCKET_WORKSPACE',
    'BITBUCKET_REPO_SLUG',
    'BUILD_REPOSITORY_URI',
    'BUILD_REPOSITORY_NAME',
    'POSTMAN_TEAM_ID',
    'POSTMAN_WORKSPACE_TEAM_ID',
    'WORKSPACE_ADMIN_USER_IDS',
    'GITHUB_TOKEN',
    'GH_FALLBACK_TOKEN'
  ];

  beforeEach(() => {
    __resetIdentityMemo();
    specDir = mkdtempSync(join(tmpdir(), 'bootstrap-preflight-'));
    writeFileSync(join(specDir, 'openapi.json'), VALID_SPEC_31);
    vi.stubEnv('GITHUB_WORKSPACE', specDir);
    for (const name of NEUTRALIZED_ENV_VARS) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(specDir, { recursive: true, force: true });
  });

  function baseInputValues(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      'project-name': 'core-payments',
      'spec-path': 'openapi.json',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'access-token-test',
      ...overrides
    };
  }

  function createRunActionCore(values: Record<string, string>, events: string[]) {
    const infos: string[] = [];
    const warnings: string[] = [];
    const outputs: Record<string, string> = {};
    const core: CoreLike = {
      error: () => {},
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
      group: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      info: (message: string) => {
        infos.push(message);
        events.push(`info:${message}`);
      },
      setFailed: () => {},
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setSecret: () => {},
      warning: (message: string) => {
        warnings.push(message);
        events.push(`warning:${message}`);
      }
    };
    return { core, infos, outputs, warnings };
  }

  interface RunActionRouterOptions {
    events: string[];
    meStatus?: number;
    meUser?: Record<string, unknown>;
    sessionStatus?: number;
    sessionBody?: Record<string, unknown>;
    proxyResponse?: (payload: { service?: string; path?: string }) => Response | undefined;
  }

  function createRunActionFetchRouter(options: RunActionRouterOptions): typeof fetch {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    // Local OpenAPI import resolves uid from sync /collection/import, then
    // rename/elect via collection list. Track imported roots for election + link readback.
    const importedCollections: Array<{ id: string; name: string }> = [];
    const linkedRelations: Array<{
      collection: string;
      state: string;
      options?: Record<string, unknown>;
      syncOptions?: Record<string, unknown>;
    }> = [];
    const router = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      options.events.push(`fetch:${method} ${url}`);

      if (url === 'https://api.getpostman.com/me') {
        if (options.meStatus && options.meStatus !== 200) {
          return json({ error: { name: 'AuthenticationError' } }, options.meStatus);
        }
        return json({
          user: options.meUser ?? {
            id: 12345678,
            fullName: 'Ada Lovelace',
            teamId: 10490519,
            teamName: 'jared-demo',
            teamDomain: 'jared-demo'
          }
        });
      }
      if (url === 'https://iapub.postman.co/api/sessions/current') {
        if (options.sessionStatus && options.sessionStatus !== 200) {
          return json({ error: 'denied' }, options.sessionStatus);
        }
        return json(
          options.sessionBody ?? {
            identity: { team: 10490519, domain: 'jared-demo' },
            data: { user: { id: 555, roles: ['admin'] } },
            consumerType: 'service_account'
          }
        );
      }
      if (url === 'https://api.getpostman.com/teams') {
        return json({ data: [] });
      }
      if (url === 'https://api.getpostman.com/service-account-tokens' && method === 'POST') {
        // Re-mint on a gateway auth failure (gateway-only asset flow); PMAK is
        // reserved for exactly this mint + the CLI spec-lint login.
        return json({ access_token: 'reminted-access-token' });
      }
      if (url === 'https://api.getpostman.com/workspaces' && method === 'POST') {
        return json({ workspace: { id: 'ws-runaction' } });
      }
      if (url.startsWith('https://api.getpostman.com/workspaces/ws-runaction')) {
        return json({ workspace: { id: 'ws-runaction', visibility: 'team' } });
      }
      if (url === 'https://api.getpostman.com/specs/spec-runaction/generations/collection') {
        const name = String(
          (JSON.parse(String(init?.body ?? '{}')) as { name?: string }).name ?? ''
        );
        const slot = name.includes('[Smoke]')
          ? 'smoke'
          : name.includes('[Contract]')
            ? 'contract'
            : 'baseline';
        return json({ collection: { id: `col-${slot}` } });
      }
      if (url.startsWith('https://api.getpostman.com/specs?workspaceId=') && method === 'POST') {
        return json({ id: 'spec-runaction' });
      }
      if (url.startsWith('https://api.getpostman.com/specs/spec-runaction')) {
        return json({ id: 'spec-runaction' });
      }
      if (/^https:\/\/api\.getpostman\.com\/collections\/[^/]+\/tags$/.test(url)) {
        return json({});
      }
      if (/^https:\/\/api\.getpostman\.com\/collections\/[^/]+$/.test(url)) {
        if (method === 'GET') {
          return json({ collection: createGeneratedContractCollection() });
        }
        return json({});
      }
      if (url === 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy') {
        const payload = JSON.parse(String(init?.body ?? '{}')) as {
          service?: string;
          method?: string;
          path?: string;
        };
        const svc = String(payload.service ?? '');
        const pmethod = String(payload.method ?? 'get').toLowerCase();
        const ppath = String(payload.path ?? '');
        // Visibility into the gateway-only asset flow for ordering assertions.
        options.events.push(`proxy:${svc} ${pmethod.toUpperCase()} ${ppath}`);
        const custom = options.proxyResponse?.(payload);
        if (custom) return custom;
        // Default gateway router: the access-token asset flow now runs entirely
        // through /ws/proxy (no PMAK fallback), so serve the real envelopes.
        if (svc === 'workspaces') {
          if (pmethod === 'post' && ppath === '/workspaces') return json({ data: { id: 'ws-runaction' } });
          if (pmethod === 'put' && /\/workspaces\/[^/]+\/visibility$/.test(ppath)) return json({ data: { id: 'ws-runaction', visibilityStatus: 'team' } });
          if (pmethod === 'get' && /\/workspaces\/[^/]+\/filesystem$/.test(ppath)) return json({ data: null });
          if (pmethod === 'get' && /\/workspaces\/[^/]+$/.test(ppath)) return json({ data: { id: 'ws-runaction', visibilityStatus: 'team' } });
          if (pmethod === 'get' && ppath.startsWith('/workspaces')) return json({ data: [] });
        }
        if (svc === 'ums' && /\/squads/.test(ppath)) return json({ data: [] });
        if (svc === 'sync') {
          if (pmethod === 'post' && ppath === '/collection/import') {
            const body = (payload as { body?: { info?: { name?: string } } }).body;
            const name = String(body?.info?.name ?? '');
            const slot = name.includes('[Contract]')
              ? 'contract'
              : name.includes('[Smoke]')
                ? 'smoke'
                : 'baseline';
            const id = `col-${slot}`;
            importedCollections.push({ id, name });
            return json({ data: { id, uid: id } });
          }
          if (pmethod === 'put' && /\/collection\/deepupdate\//.test(ppath)) {
            return json({ data: { ok: true } });
          }
        }
        if (svc === 'specification') {
          if (pmethod === 'put' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
            const body = (payload as { body?: unknown }).body;
            const rows = Array.isArray(body) ? body : [];
            linkedRelations.length = 0;
            for (const row of rows) {
              if (!row || typeof row !== 'object') continue;
              const record = row as {
                collectionId?: string;
                options?: Record<string, unknown>;
                syncOptions?: Record<string, unknown>;
              };
              if (!record.collectionId) continue;
              linkedRelations.push({
                collection: record.collectionId,
                state: 'in-sync',
                options: record.options ?? {
                  requestNameSource: 'Fallback',
                  folderStrategy: 'Paths',
                  parametersResolution: 'Example'
                },
                syncOptions: record.syncOptions ?? { syncExamples: true }
              });
            }
            return json({ data: { updated: linkedRelations.length } });
          }
          if (pmethod === 'post' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
            return json({ data: { taskId: 'task-1' } });
          }
          if (pmethod === 'get' && /\/tasks/.test(ppath)) return json({ data: { 'task-1': 'completed' } });
          if (pmethod === 'get' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
            return json({
              data: linkedRelations.length > 0
                ? linkedRelations
                : importedCollections.map((entry) => ({
                    collection: entry.id,
                    state: 'in-sync',
                    options: {
                      requestNameSource: 'Fallback',
                      folderStrategy: 'Paths',
                      parametersResolution: 'Example'
                    },
                    syncOptions: { syncExamples: true }
                  }))
            });
          }
          if (pmethod === 'get' && /\/specifications\/[^/]+\/files\/[^/]+/.test(ppath)) return json({ data: { id: 'file-root', content: 'openapi: 3.0.0' } });
          if (pmethod === 'get' && /\/specifications\/[^/]+\/files$/.test(ppath)) return json({ data: [{ id: 'file-root', type: 'ROOT' }] });
          if (pmethod === 'patch') return json({ data: { id: 'file-root' } });
          if (pmethod === 'post' && ppath.startsWith('/specifications')) return json({ data: { id: 'spec-runaction' } });
          if (pmethod === 'get' && /\/specifications\/[^/]+$/.test(ppath)) return json({ data: { id: 'spec-runaction' } });
        }
        if (svc === 'collection') {
          if (pmethod === 'get' && ppath.startsWith('/v3/collections/?workspace=')) {
            return json({
              data: importedCollections.map((entry) => ({
                id: entry.id,
                uid: entry.id,
                name: entry.name
              }))
            });
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
          if (pmethod === 'post') return json({ data: { id: '55363555-created' } });
          if (pmethod === 'patch') {
            // Rename after import: keep inventory name in sync for election.
            const bare = ppath.split('/').pop() || '';
            const ops = (payload as { body?: Array<{ path?: string; value?: string }> }).body;
            const nameOp = Array.isArray(ops) ? ops.find((op) => op.path === '/name') : undefined;
            if (nameOp?.value) {
              const hit = importedCollections.find((entry) => entry.id === bare || entry.id.endsWith(bare));
              if (hit) hit.name = String(nameOp.value);
            }
            return json({ data: { id: bare || 'patched' } });
          }
          if (pmethod === 'get' && /\/export$/.test(ppath)) return json({ data: { collection: {} } });
          if (pmethod === 'get' && /\/v3\/collections\/[^/]+$/.test(ppath)) {
            return json({ data: { id: 'col-baseline', name: 'core-payments' } });
          }
          if (pmethod === 'delete') return json({ data: { ok: true } }, 404);
        }
        if (svc === 'tagging') return json({ tags: [{ slug: 'generated-smoke' }] });
        return json({ data: { ok: true } });
      }
      if (url.startsWith('https://dl.pstmn.io/')) {
        return json({ version: '12.0.0' });
      }
      throw new Error(`Unrouted fetch in runAction test: ${method} ${url}`);
    };
    return router as typeof fetch;
  }

  it('runAction logs access-token session identity before the first workspace call', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs } = createRunActionCore(baseInputValues(), events);

    await runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()));

    expect(outputs['workspace-id']).toBe('ws-runaction');
    const sessionLineIndex = events.findIndex((entry) =>
      entry.startsWith('info:postman: access-token session identity')
    );
    const createWorkspaceIndex = events.findIndex(
      (entry) => entry === 'proxy:workspaces POST /workspaces'
    );
    expect(sessionLineIndex).toBeGreaterThanOrEqual(0);
    expect(createWorkspaceIndex).toBeGreaterThan(sessionLineIndex);
    expect(infos.some((line) => line.includes('PMAK identity'))).toBe(false);
  }, 30000);

  it('runAction warns with context and defaults orgMode=false when the early org-mode probe fails', async () => {
    const events: string[] = [];
    vi.stubEnv('GITHUB_REPOSITORY', 'postman-cs/bootstrap\u2028action-test');
    const { PostmanGatewayAssetsClient } = await import(
      '../src/lib/postman/postman-gateway-assets-client.js'
    );
    const getTeamsSpy = vi
      .spyOn(PostmanGatewayAssetsClient.prototype, 'getTeams')
      .mockRejectedValueOnce(
        new Error('ums probe denied for access-token-test\nacross teams')
      );
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    try {
      await runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()));
    } finally {
      getTeamsSpy.mockRestore();
    }

    expect(outputs['workspace-id']).toBe('ws-runaction');
    const probeWarning = warnings.find((line) => line.includes('Could not probe org-mode teams'));
    expect(probeWarning).toBeDefined();
    expect(probeWarning).toContain('repository postman-cs/bootstrap action-test');
    expect(probeWarning).toContain('Impact: defaulting orgMode=false');
    expect(probeWarning).toContain('Remediation: set workspace-team-id');
    expect(probeWarning).toContain('[REDACTED]');
    expect(probeWarning).not.toContain('access-token-test');
    expect(probeWarning).not.toMatch(/[\r\n\u2028\u2029]/);
  }, 30000);

  it('runAction with PMAK only eagerly mints an access token, runs the org-mode probe, and creates the workspace over the gateway', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs, warnings } = createRunActionCore(
      baseInputValues({ 'postman-access-token': '' }),
      events
    );

    await runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()));

    // Eager mint happened before the preflight
    const mintFetchIndex = events.findIndex(
      (entry) => entry === 'fetch:POST https://api.getpostman.com/service-account-tokens'
    );
    expect(mintFetchIndex).toBeGreaterThanOrEqual(0);
    expect(
      infos.some((line) => line.includes('minted a short-lived service-account access token'))
    ).toBe(true);
    // Org-mode squad probe ran (needs the minted token)
    expect(events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    // Governance is no longer silently skipped
    expect(
      warnings.some((line) =>
        line.includes('Skipping governance assignment because postman-access-token is not configured')
      )
    ).toBe(false);
    // Workspace creation went through the gateway as usual
    expect(events.some((entry) => entry === 'proxy:workspaces POST /workspaces')).toBe(true);
    expect(outputs['workspace-id']).toBe('ws-runaction');
  }, 30000);

  it('runAction with PMAK only warns up front when the mint fails (service accounts not enabled)', async () => {
    const events: string[] = [];
    const baseRouter = createRunActionFetchRouter({ events });
    const router = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url === 'https://api.getpostman.com/service-account-tokens' && method === 'POST') {
        events.push(`fetch:${method} ${url}`);
        return new Response('service accounts not enabled', { status: 400 });
      }
      return baseRouter(input, init);
    }) as typeof fetch;
    vi.stubGlobal('fetch', router);
    const { core, warnings } = createRunActionCore(
      baseInputValues({ 'postman-access-token': '' }),
      events
    );

    // Asset ops are gateway-only, so with no mintable token the run cannot
    // proceed; the eager mint surfaces the actionable warning before it fails.
    await expect(
      runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()))
    ).rejects.toThrow(/Could not obtain postman-access-token/);
    expect(
      warnings.some((line) => line.includes('could not mint an access token from the postman-api-key'))
    ).toBe(true);
  }, 30000);


  it('runAction completes when iapub returns 404 under warn mode', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({ events, sessionStatus: 404 })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()));

    expect(outputs['workspace-id']).toBe('ws-runaction');
    expect(warnings.some((line) => line.includes('PMAK identity'))).toBe(false);
    expect(
      warnings.some((line) => line.includes('could not resolve the access-token session identity'))
    ).toBe(true);
  }, 30000);

  it('runAction warns when postman-access-token resolves to a non-service-account session token', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        sessionBody: {
          identity: { team: 10490519, domain: 'jared-demo' },
          data: { user: { id: 2, roles: ['admin'] } },
          consumerType: 'user'
        }
      })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()));

    expect(outputs['workspace-id']).toBe('ws-runaction');
    const warning = warnings.find((line) =>
      line.includes('postman-cs/postman-resolve-service-token-action is the primary CI path')
    );
    expect(warning).toContain('postman-access-token resolved to consumerType user');
    expect(warning).toContain('postman-cs/postman-resolve-service-token-action is the primary CI path');
    expect(warning).toContain('Postman CLI credential store populated by `postman login` is a legacy fallback');
    expect(warning).not.toContain('browser');
    expect(
      warnings.filter((line) =>
        line.includes('Postman CLI credential store populated by `postman login` is a legacy fallback')
      )
    ).toHaveLength(1);
  }, 30000);

  it('runAction rejects credential-preflight=off instead of skipping identity checks', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core } = createRunActionCore(
      baseInputValues({ 'credential-preflight': 'off' }),
      events
    );

    await expect(
      runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()))
    ).rejects.toThrow(/Unsupported credential-preflight/);
    expect(events).toHaveLength(0);
  });

  it('reactive advice still rewrites a Bifrost UNAUTHENTICATED with default preflight enabled', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        proxyResponse: (payload) =>
          String(payload.path ?? '').includes('/specifications/')
            ? new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
                status: 401
              })
            : undefined
      })
    );
    const { core } = createRunActionCore(baseInputValues(), events);

    let thrown: unknown;
    try {
      await runWithFakeTimers(() => runAction(core, createExecStub(), createIoStub()));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('Bifrost rejected the access token (UNAUTHENTICATED)');
    expect(message).toContain('postman-resolve-service-token-action');
    expect(events.some((entry) => entry.includes('iapub.postman.co'))).toBe(true);
  });
});
