import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { __resetIdentityMemo, resolveSessionIdentity } from '../src/lib/postman/credential-identity.js';
import { WORKSPACE_PERSONAL_ONLY_ADVICE } from '../src/lib/postman/error-advice.js';

interface Envelope {
  service: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

interface RecordedCall extends Envelope {
  headers: Record<string, string>;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

/**
 * Build a gateway client whose fetch is driven by a handler that receives the
 * parsed proxy envelope and returns a Response. Records every envelope sent.
 */
function makeClient(
  handler: (env: Envelope, callIndex: number) => Response,
  clientOptions?: { generationPollAttempts?: number; generationPollDelayMs?: number }
): { client: PostmanGatewayAssetsClient; gateway: AccessTokenGatewayClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const env = JSON.parse(String((init as RequestInit).body)) as Envelope;
    const headers = Object.fromEntries(
      new Headers((init as RequestInit).headers).entries()
    ) as Record<string, string>;
    calls.push({ ...env, headers });
    return handler(env, i++);
  });
  const provider = new AccessTokenProvider({ accessToken: 'tok-1' });
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: provider,
    fetchImpl,
    sleepImpl: async () => undefined
  });
  const client = new PostmanGatewayAssetsClient({
    gateway,
    sleep: async () => undefined,
    createIdentity: () => 'test-run',
    ...clientOptions
  });
  return { client, gateway, calls };
}

describe('PostmanGatewayAssetsClient', () => {
  describe('uploadSpec', () => {
    it('creates a spec with a file-level type ROOT and returns data.id', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post') return jsonResponse({ meta: {}, data: { id: 'spec-1', type: 'OPENAPI:3.0' } });
        return jsonResponse({ data: { id: 'spec-1' } }); // preflight GET
      });

      const id = await client.uploadSpec('ws-9', 'Telecom API', 'openapi: 3.0.3', '3.0');
      expect(id).toBe('spec-1');

      const create = calls[0];
      expect(create.service).toBe('specification');
      expect(create.method).toBe('post');
      expect(create.path).toBe('/specifications?containerType=workspace&containerId=ws-9');
      const body = create.body as { type: string; files: Array<{ path: string; type: string; content: string }> };
      expect(body.type).toBe('OPENAPI:3.0');
      expect(body.files[0]).toMatchObject({ path: 'index.yaml', type: 'ROOT', content: 'openapi: 3.0.3' });
      // preflight GET happened
      expect(calls[1]).toMatchObject({ service: 'specification', method: 'get', path: '/specifications/spec-1' });
    });

    it('maps 3.1 to OPENAPI:3.1 and rejects unsupported versions', async () => {
      const { client } = makeClient(() => jsonResponse({ data: { id: 's' } }));
      await client.uploadSpec('ws', 'n', 'x', '3.1');
      await expect(client.uploadSpec('ws', 'n', 'x', '2.0')).rejects.toThrow(/unsupported openapiVersion/);
    });

    it('throws when create returns no id', async () => {
      const { client } = makeClient(() => jsonResponse({ data: {} }));
      await expect(client.uploadSpec('ws', 'n', 'x')).rejects.toThrow(/did not return an ID/);
    });
  });

  describe('generateCollection', () => {
    it('posts generate, polls the task to completion, and resolves the collection uid', async () => {
      let polls = 0;
      let posted = false;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          posted = true;
          return jsonResponse({ data: { taskId: 'task-7' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          polls += 1;
          return jsonResponse({ data: { 'task-7': polls < 2 ? 'in-progress' : 'completed' } });
        }
        // spec collections list
        return jsonResponse({ data: posted ? [{ collection: 'uid-A', name: '[Smoke] Telecom [bootstrap:test-run]', state: 'in-sync' }] : [] });
      });

      const uid = await client.generateCollection('spec-1', 'Telecom', '[Smoke]', 'Tags', true, 'Fallback');
      expect(uid).toBe('uid-A');

      const post = calls.find((c) => c.method === 'post' && c.path.endsWith('/collections'));
      expect((post?.body as { options: Record<string, unknown> }).options).toMatchObject({
        requestNameSource: 'Fallback',
        folderStrategy: 'Tags',
        nestedFolderHierarchy: true
      });
      expect(calls.filter((c) => c.path === '/tasks').length).toBe(2);
    });

    it('omits nestedFolderHierarchy when folderStrategy is not Tags', async () => {
      let posted = false;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post') {
          posted = true;
          return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'completed' } });
        return jsonResponse({ data: posted ? [{ collection: 'uid-X', name: 'P [bootstrap:test-run]' }] : [] });
      });
      await client.generateCollection('spec-1', 'P', '', 'None', true, 'Fallback');
      const post = calls.find((c) => c.method === 'post');
      expect((post?.body as { options: Record<string, unknown> }).options).not.toHaveProperty('nestedFolderHierarchy');
    });

    it('retries a transient timeout while renaming a generated collection', async () => {
      let posted = false;
      let renameAttempts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'post') {
          posted = true;
          return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'completed' } });
        if (env.method === 'patch' && env.path === '/v3/collections/collection-1') {
          renameAttempts += 1;
          return renameAttempts === 1
            ? jsonResponse({ error: { details: 'ESOCKETTIMEDOUT', source: 'downstream' } }, { status: 500 })
            : jsonResponse({ data: { id: 'collection-1' } });
        }
        return jsonResponse({ data: posted ? [{ collection: 'owner-collection-1', name: '[Smoke] P [bootstrap:test-run]' }] : [] });
      });

      await expect(client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', true, 'Fallback')).resolves.toBe('owner-collection-1');
      expect(renameAttempts).toBe(2);
    });

    it('retries a 423-locked generate then succeeds', async () => {
      let attempts = 0;
      let posted = false;
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path.endsWith('/collections')) {
          attempts += 1;
          if (attempts === 1) return jsonResponse({ error: 'locked' }, { status: 423 });
          posted = true;
          return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'completed' } });
        return jsonResponse({ data: posted ? [{ collection: 'uid-R', name: '[Contract] P [bootstrap:test-run]' }] : [] });
      });
      const uid = await client.generateCollection('spec-1', 'P', '[Contract]', 'Tags', false, 'Fallback');
      expect(uid).toBe('uid-R');
      expect(attempts).toBe(2);
    });

    it('throws when the generation task reports failure', async () => {
      const { client } = makeClient((env) => {
        if (env.method === 'post') return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'failed' } });
        return jsonResponse({ data: [] });
      });
      await expect(client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', true, 'Fallback')).rejects.toThrow(/task failed/);
    });

    it('caps polling at the explicit generationPollAttempts budget and times out', async () => {
      let polls = 0;
      const { client } = makeClient(
        (env) => {
          if (env.method === 'post') return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
          if (env.path === '/tasks') {
            polls += 1;
            return jsonResponse({ data: { t: 'in-progress' } });
          }
          return jsonResponse({ data: [] });
        },
        { generationPollAttempts: 3, generationPollDelayMs: 0 }
      );
      await expect(client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', true, 'Fallback')).rejects.toThrow(/timed out/);
      expect(polls).toBe(3);
    });

    it('reads the poll budget from POSTMAN_GENERATION_POLL_ATTEMPTS when no option is passed', async () => {
      vi.stubEnv('POSTMAN_GENERATION_POLL_ATTEMPTS', '2');
      vi.stubEnv('POSTMAN_GENERATION_POLL_DELAY_MS', '0');
      try {
        let polls = 0;
        const { client } = makeClient((env) => {
          if (env.method === 'post') {
            return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
          }
          if (env.path === '/tasks') {
            polls += 1;
            return jsonResponse({ data: { t: 'in-progress' } });
          }
          return jsonResponse({ data: [] });
        });
        await expect(client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', true, 'Fallback')).rejects.toThrow(/timed out/);
        expect(polls).toBe(2);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('ignores a below-min or non-numeric env poll budget (falls back to the default)', async () => {
      vi.stubEnv('POSTMAN_GENERATION_POLL_ATTEMPTS', '0'); // below min=1 -> must NOT zero the budget
      vi.stubEnv('POSTMAN_GENERATION_POLL_DELAY_MS', 'nonsense'); // non-numeric -> default delay used
      try {
        let polls = 0;
        let posted = false;
        const { client } = makeClient((env) => {
          if (env.method === 'post') {
            posted = true;
            return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
          }
          if (env.path === '/tasks') {
            polls += 1;
            return jsonResponse({ data: { t: polls < 2 ? 'in-progress' : 'completed' } });
          }
          return jsonResponse({ data: posted ? [{ collection: 'uid-D', name: '[Smoke] P [bootstrap:test-run]', state: 'in-sync' }] : [] });
        });
        // Default budget (90) is far above the 2 polls needed; a zeroed budget would throw instead.
        const uid = await client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', true, 'Fallback');
        expect(uid).toBe('uid-D');
        expect(polls).toBe(2);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('explicit poll-budget option beats the env override', async () => {
      vi.stubEnv('POSTMAN_GENERATION_POLL_ATTEMPTS', '50');
      try {
        let polls = 0;
        const { client } = makeClient(
          (env) => {
            if (env.method === 'post') return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
            if (env.path === '/tasks') {
              polls += 1;
              return jsonResponse({ data: { t: 'in-progress' } });
            }
            return jsonResponse({ data: [] });
          },
          { generationPollAttempts: 1, generationPollDelayMs: 0 }
        );
        await expect(client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', true, 'Fallback')).rejects.toThrow(/timed out/);
        expect(polls).toBe(1);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('createWorkspace', () => {
    it('org-mode: POSTs team visibility with squad and group roles (no flip)', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ meta: {}, data: { id: 'ws-org', visibility: 'team' } });
        }
        if (env.method === 'get' && env.path === '/workspaces/ws-org') {
          return jsonResponse({ meta: {}, data: { id: 'ws-org', visibility: 'team' } });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      const result = await client.createWorkspace('Org WS', 'about', 132319);
      expect(result).toEqual({ id: 'ws-org' });

      const create = calls.find((c) => c.method === 'post' && c.path === '/workspaces');
      const read = calls.find((c) => c.method === 'get' && c.path === '/workspaces/ws-org');
      expect(create?.headers['x-entity-team-id']).toBe('132319');
      expect(read?.headers['x-entity-team-id']).toBe('132319');
      expect(create?.body).toEqual({
        name: 'Org WS',
        visibilityStatus: 'team',
        squad: '132319',
        roles: { group: { '132319': ['WORKSPACE_VIEWER_V9'] } }
      });
      expect(calls.some((c) => c.path.includes('/visibility'))).toBe(false);
    });

    it('non-org: creates personal then flips to team visibility', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ meta: {}, data: { id: 'ws-1' } });
        }
        if (env.method === 'put' && env.path === '/workspaces/ws-1/visibility') {
          return jsonResponse({ meta: {}, data: { id: 'ws-1', visibility: 'team' } });
        }
        if (env.method === 'get' && env.path === '/workspaces/ws-1') {
          return jsonResponse({ meta: {}, data: { id: 'ws-1', visibility: 'team' } });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      const result = await client.createWorkspace('Team WS', 'about');
      expect(result).toEqual({ id: 'ws-1' });

      expect(calls[0]?.body).toEqual({ name: 'Team WS', visibilityStatus: 'personal' });
      expect(calls.some((c) => c.method === 'put' && c.path === '/workspaces/ws-1/visibility')).toBe(true);
    });

    it('org-mode: deletes workspace when team visibility cannot be verified', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ meta: {}, data: { id: 'ws-bad' } });
        }
        if (env.method === 'get' && env.path === '/workspaces/ws-bad') {
          return jsonResponse({ meta: {}, data: { id: 'ws-bad', visibility: 'personal' } });
        }
        if (env.method === 'delete' && env.path === '/workspaces/ws-bad') {
          return jsonResponse({ meta: {}, data: {} });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      await expect(client.createWorkspace('Bad Org WS', 'about', 132319)).rejects.toThrow(
        /team visibility could not be verified/
      );
      const cleanup = calls.find((c) => c.method === 'delete' && c.path === '/workspaces/ws-bad');
      expect(cleanup?.headers['x-entity-team-id']).toBe('132319');
    });
  });

  describe('getWorkspaceVisibility', () => {
    it('reads data.visibility from the gateway workspace envelope', async () => {
      const { client } = makeClient(() => jsonResponse({ meta: {}, data: { id: 'ws', visibility: 'team' } }));
      expect(await client.getWorkspaceVisibility('ws')).toBe('team');
    });

    it('returns null when the workspace is unreadable', async () => {
      const { client } = makeClient(() => jsonResponse({ error: 'nope' }, { status: 404 }));
      expect(await client.getWorkspaceVisibility('ws')).toBeNull();
    });
  });

  describe('findWorkspacesByName', () => {
    it('paginates via meta.nextCursor and filters by exact name', async () => {
      const { client, calls } = makeClient((env, i) => {
        if (i === 0) {
          return jsonResponse({
            meta: { nextCursor: 'c2' },
            data: [{ id: 'b', name: 'Telecom' }, { id: 'z', name: 'Other' }]
          });
        }
        return jsonResponse({ meta: { nextCursor: '' }, data: [{ id: 'a', name: 'Telecom' }] });
      });

      const found = await client.findWorkspacesByName('Telecom');
      expect(found).toEqual([
        { id: 'a', name: 'Telecom' },
        { id: 'b', name: 'Telecom' }
      ]);
      expect(calls[1]).toMatchObject({ query: { cursor: 'c2' } });
    });
  });

  describe('getWorkspaceGitRepoUrl', () => {
    it('extracts the repo url from the filesystem payload', async () => {
      const { client, calls } = makeClient(() =>
        jsonResponse({ meta: {}, data: { repo: 'git@github.com:acme/widgets.git' } })
      );
      expect(await client.getWorkspaceGitRepoUrl('ws-1', 'team', 'tok')).toBe('https://github.com/acme/widgets');
      expect(calls[0]).toMatchObject({ service: 'workspaces', method: 'get', path: '/workspaces/ws-1/filesystem' });
    });

    it('returns null when no repo is linked (data null)', async () => {
      const { client } = makeClient(() => jsonResponse({ meta: {}, data: null }));
      expect(await client.getWorkspaceGitRepoUrl('ws-1')).toBeNull();
    });

    it('returns null on a 404 filesystem', async () => {
      const { client } = makeClient(() => jsonResponse({ error: 'x' }, { status: 404 }));
      expect(await client.getWorkspaceGitRepoUrl('ws-1')).toBeNull();
    });
  });

  describe('tagCollection', () => {
    it('PUTs to the tagging service with the full uid and slug-only tag bodies', async () => {
      const { client, calls } = makeClient(() => jsonResponse({ tags: [{ slug: 'generated-smoke' }] }));
      await client.tagCollection('55363555-abc', ['Generated Smoke', 'generated-smoke']);
      expect(calls[0]).toMatchObject({
        service: 'tagging',
        method: 'put',
        path: '/v1/tags/collections/55363555-abc'
      });
      // slugs are normalized; no `type` field is sent (server assigns it).
      expect(calls[0].body).toEqual({ tags: [{ slug: 'generated-smoke' }, { slug: 'generated-smoke' }] });
    });

    it('throws when no valid slug survives normalization', async () => {
      const { client } = makeClient(() => jsonResponse({}));
      await expect(client.tagCollection('uid', ['!!!'])).rejects.toThrow(/No valid tag slugs/);
    });
  });

  describe('injectTests', () => {
    it('patches /scripts (canonical v3 shape) on each http-request leaf and creates the secrets resolver', async () => {
      const items = [
        { id: '55363555-leaf-1', $kind: 'http-request', name: 'Ping' },
        { id: '55363555-ex-1', $kind: 'http-example', name: 'OK' },
        { id: '55363555-leaf-2', $kind: 'http-request', name: 'Pong' }
      ];
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get') return jsonResponse({ data: items });
        if (env.method === 'post') return jsonResponse({ data: { id: '55363555-secrets' } });
        return jsonResponse({ data: { id: 'patched' } });
      });

      await client.injectTests('55363555-model-9', 'smoke');

      // 1) list on the FULL public uid with trailing slash (bare ids are flaky on org squads)
      expect(calls[0]).toMatchObject({
        service: 'collection',
        method: 'get',
        path: '/v3/collections/55363555-model-9/items/'
      });
      // 2) one /scripts PATCH per http-request leaf (full uid, afterResponse shape)
      const leafPatches = calls.filter((c) => c.method === 'patch' && /\/items\/55363555-leaf-/.test(c.path));
      expect(leafPatches).toHaveLength(2);
      const patch = leafPatches[0].body as Array<{ op: string; path: string; value: Array<{ type: string; code: string; language: string }> }>;
      expect(patch[0]).toMatchObject({ op: 'add', path: '/scripts' });
      expect(patch[0].value[0]).toMatchObject({ type: 'afterResponse', language: 'text/javascript' });
      expect(patch[0].value[0].code).toContain('pm.test');
      // 3) resolve-secrets created with ROOT-level v3 IR headers/body/auth, then scripted
      const create = calls.find((c) => c.method === 'post');
      expect(create?.path).toBe('/v3/collections/55363555-model-9/items/');
      const createBody = create?.body as {
        name: string;
        payload?: unknown;
        headers: Array<{ key: string }>;
        body: { type: string; content: string };
        auth: { type: string; credentials: Array<{ key: string; value: string }> };
      };
      expect(createBody.name).toBe('00 - Resolve Secrets');
      // No payload wrapper — request internals live at the item root (a payload
      // wrapper is silently dropped by the gateway v3 store).
      expect(createBody.payload).toBeUndefined();
      expect(createBody.headers.map((h) => h.key)).toContain('X-Amz-Target');
      expect(createBody.body).toMatchObject({ type: 'json' });
      expect(createBody.auth.type).toBe('awsv4');
      expect(createBody.auth.credentials.map((c) => c.key)).toEqual(['accessKey', 'secretKey', 'region', 'service']);
      const secretsPatch = calls.find((c) => c.method === 'patch' && /\/items\/55363555-secrets$/.test(c.path));
      expect((secretsPatch?.body as Array<{ path: string }>)[0].path).toBe('/scripts');
    });

    it('retries the secrets-resolver scripts patch on a transient 404 (read-after-write lag)', async () => {
      const items = [{ id: '55363555-leaf-1', $kind: 'http-request', name: 'Ping' }];
      let secretsPatchAttempts = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get') return jsonResponse({ data: items });
        if (env.method === 'post') return jsonResponse({ data: { id: '55363555-secrets' } });
        if (env.method === 'patch' && /\/items\/55363555-secrets$/.test(env.path)) {
          secretsPatchAttempts += 1;
          return secretsPatchAttempts === 1
            ? jsonResponse({ error: { code: 'RESOURCE_NOT_FOUND', message: 'Item not found' } }, { status: 404 })
            : jsonResponse({ data: { id: 'patched' } });
        }
        return jsonResponse({ data: { id: 'patched' } });
      });

      await client.injectTests('55363555-model-9', 'smoke');

      // created once, patched twice (404 then 200)
      expect(secretsPatchAttempts).toBe(2);
      const secretsPatches = calls.filter((c) => c.method === 'patch' && /\/items\/55363555-secrets$/.test(c.path));
      expect(secretsPatches).toHaveLength(2);
    });

    it('retries a transient downstream timeout while patching an existing leaf script', async () => {
      const items = [
        { id: '55363555-leaf-1', $kind: 'http-request', name: 'Ping' },
        { id: '55363555-secrets', $kind: 'http-request', name: '00 - Resolve Secrets' }
      ];
      let leafPatchAttempts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get') return jsonResponse({ data: items });
        if (env.method === 'patch') {
          leafPatchAttempts += 1;
          return leafPatchAttempts === 1
            ? jsonResponse(
                { error: { name: 'serverError', details: 'ESOCKETTIMEDOUT', source: 'downstream' } },
                { status: 500 }
              )
            : jsonResponse({ data: { id: 'patched' } });
        }
        return jsonResponse({ error: 'unexpected mutation' }, { status: 500 });
      });

      await client.injectTests('55363555-model-9', 'smoke');

      expect(leafPatchAttempts).toBe(2);
    });

    it('is idempotent: skips the create when a secrets resolver already exists', async () => {
      const items = [
        { id: '55363555-leaf-1', $kind: 'http-request', name: 'Ping' },
        { id: '55363555-secrets', $kind: 'http-request', name: '00 - Resolve Secrets' }
      ];
      const { client, calls } = makeClient((env) =>
        env.method === 'get' ? jsonResponse({ data: items }) : jsonResponse({ data: { id: 'p' } })
      );
      await client.injectTests('55363555-model-9', 'smoke');
      // no create when the resolver is already present
      expect(calls.some((c) => c.method === 'post')).toBe(false);
      // the existing resolver leaf is NOT re-scripted as a normal leaf
      expect(calls.filter((c) => c.method === 'patch')).toHaveLength(1);
      expect(calls.find((c) => c.method === 'patch')?.path).toBe('/v3/collections/55363555-model-9/items/55363555-leaf-1');
    });
  });

  describe('getTeams', () => {
    // Seed getMemoizedSessionIdentity (the org id source) via resolveSessionIdentity,
    // mirroring the credential preflight that runs before getTeams in production.
    async function seedSession(team: number): Promise<void> {
      __resetIdentityMemo();
      await resolveSessionIdentity({
        iapubBaseUrl: 'https://iapub.example',
        accessToken: `tok-${team}`,
        fetchImpl: vi.fn<typeof fetch>(async () =>
          jsonResponse({ session: { consumerType: 'service_account', identity: { user: 1, team, domain: 'd' } } })
        )
      });
    }

    it('enumerates squads via ums GET /api/teams/:orgId/squads (org-mode → organizationId set)', async () => {
      await seedSession(13347347);
      const { client, calls } = makeClient(() =>
        jsonResponse({ data: [{ id: 132319, name: 'CSE v12', handle: 'cse-v12', organizationId: 13347347, extra: 'x' }] })
      );
      const teams = await client.getTeams();
      expect(calls[0]).toMatchObject({
        service: 'ums',
        method: 'get',
        path: '/api/teams/13347347/squads?settings=true&userRoles=true'
      });
      expect(teams).toEqual([{ id: 132319, name: 'CSE v12', handle: 'cse-v12', organizationId: 13347347 }]);
    });

    it('returns [] for a non-org account (ums 400 "Squad feature is not available")', async () => {
      await seedSession(10490519);
      const { client } = makeClient(() =>
        jsonResponse({ error: { name: 'BadRequest', message: 'Squad feature is not available for your team.' } }, { status: 400 })
      );
      expect(await client.getTeams()).toEqual([]);
    });

    it('returns [] when no session identity is memoized (no PMAK /me, no org id)', async () => {
      __resetIdentityMemo();
      const { client, calls } = makeClient(() => jsonResponse({ data: [] }));
      expect(await client.getTeams()).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  describe('createCollection', () => {
    it('rejects native v3 GraphQL before creating the collection', async () => {
      const { client, calls } = makeClient(() => jsonResponse({}));

      await expect(client.createCollection('ws-1', {
        $kind: 'collection',
        name: 'GraphQL',
        items: [{
          $kind: 'graphql-request',
          name: 'Query',
          query: 'query Ping { ping }',
          variables: '{}'
        }]
      })).rejects.toThrow(/graphql-request.*item-create endpoint/i);

      expect(calls).toHaveLength(0);
    });

    it('rejects converted v2 GraphQL before creating the collection', async () => {
      const { client, calls } = makeClient(() => jsonResponse({}));

      await expect(client.createCollection('ws-1', {
        info: {
          name: 'GraphQL',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        item: [{
          name: 'Query',
          request: {
            method: 'POST',
            url: 'https://example.test/graphql',
            body: { mode: 'graphql', graphql: { query: 'query Ping { ping }', variables: '{}' } }
          }
        }]
      })).rejects.toThrow(/graphql-request.*item-create endpoint/i);

      expect(calls).toHaveLength(0);
    });

    it('converts v2.1 -> v3 and creates the root + nested folder/leaf tree, returning the full uid', async () => {
      const v21 = {
        info: { name: 'Curated', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          {
            name: 'Folder',
            item: [
              {
                name: 'Leaf',
                request: { method: 'GET', url: { raw: 'https://example.test/get', host: ['example', 'test'], path: ['get'] } }
              }
            ]
          }
        ]
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-uid' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-root-uid/items/') {
          const body = env.body as { name?: string };
          if (body?.name === 'Folder') return jsonResponse({ data: { id: '55363555-folder-uid' } });
          return jsonResponse({ data: { id: '55363555-leaf-uid' } });
        }
        return jsonResponse({});
      });

      const id = await client.createCollection('ws-1', v21);
      expect(id).toBe('55363555-root-uid');

      const rootCreate = calls.find((c) => c.path.startsWith('/v3/collections/?workspace='));
      expect(rootCreate).toMatchObject({ headers: expect.objectContaining({ 'x-entity-target': 'http' }), body: { name: 'Curated [bootstrap:test-run]' } });

      const folderCreate = calls.find(
        (c) => c.path === '/v3/collections/55363555-root-uid/items/' && (c.body as { name?: string })?.name === 'Folder'
      );
      expect(folderCreate).toMatchObject({
        headers: expect.objectContaining({ 'x-entity-type': 'collection' }),
        body: { $kind: 'collection', name: 'Folder', position: { parent: { id: '55363555-root-uid', $kind: 'collection' } } }
      });

      const leafCreate = calls.find(
        (c) => c.path === '/v3/collections/55363555-root-uid/items/' && (c.body as { name?: string })?.name === 'Leaf'
      );
      expect(leafCreate?.headers['x-entity-type']).toBe('http-request');
      expect(leafCreate?.body).toMatchObject({
        $kind: 'http-request',
        name: 'Leaf',
        method: 'GET',
        url: 'https://example.test/get',
        position: { parent: { id: '55363555-folder-uid', $kind: 'collection' } }
      });
    });

    it('creates canonical v3 collections directly and preserves root and item scripts', async () => {
      const v3 = {
        $kind: 'collection',
        id: 'local-root-id',
        name: 'Curated v3',
        variables: [{ key: 'baseUrl', value: 'https://example.test' }],
        scripts: [{ type: 'beforeRequest', code: 'pm.variables.set("x", "1");', language: 'text/javascript' }],
        items: [
          {
            $kind: 'http-request',
            id: 'local-request-id',
            name: 'Create',
            method: 'POST',
            url: '{{baseUrl}}/things',
            headers: [{ key: 'Content-Type', value: 'application/json' }],
            queryParams: [{ key: 'dryRun', value: 'true' }],
            pathVariables: [{ key: 'tenantId', value: 'demo' }],
            settings: {},
            scripts: [{ type: 'afterResponse', code: 'pm.test("ok", function () {});', language: 'text/javascript' }]
          }
        ]
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-v3' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-root-v3/items/') {
          return jsonResponse({ data: { id: '55363555-create-v3' } });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: { id: 'patched' } });
        }
        return jsonResponse({});
      });

      const id = await client.createCollection('ws-1', v3);

      expect(id).toBe('55363555-root-v3');
      const rootCreate = calls.find((c) => c.path.startsWith('/v3/collections/?workspace='));
      expect(rootCreate?.body).toEqual({ name: 'Curated v3 [bootstrap:test-run]' });

      const itemCreate = calls.find((c) => c.method === 'post' && c.path === '/v3/collections/55363555-root-v3/items/');
      expect(itemCreate).toMatchObject({
        headers: expect.objectContaining({ 'x-entity-type': 'http-request' }),
        body: expect.objectContaining({
          $kind: 'http-request',
          name: 'Create',
          method: 'POST',
          url: '{{baseUrl}}/things',
          headers: [{ key: 'Content-Type', value: 'application/json' }],
          queryParams: [{ key: 'dryRun', value: 'true' }],
          pathVariables: [{ key: 'tenantId', value: 'demo' }],
          settings: {}
        })
      });
      expect((itemCreate?.body as Record<string, unknown>).id).toBeUndefined();

      const itemScriptPatch = calls.find((c) => c.path === '/v3/collections/55363555-root-v3/items/55363555-create-v3');
      expect(itemScriptPatch).toMatchObject({
        method: 'patch',
        headers: expect.objectContaining({ 'x-entity-type': 'http-request' }),
        body: [{ op: 'add', path: '/scripts', value: v3.items[0].scripts }]
      });

      const rootPatch = calls.find((c) => c.path === '/v3/collections/root-v3');
      expect(rootPatch?.body).toEqual([
        { op: 'replace', path: '/name', value: 'Curated v3' },
        { op: 'add', path: '/variables', value: v3.variables },
        {
          op: 'add',
          path: '/scripts',
          value: [{ type: 'http:beforeRequest', code: 'pm.variables.set("x", "1");', language: 'text/javascript' }]
        }
      ]);
    });

    it('applies root description via JSON Patch on create, not the root POST body', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-desc' } });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: { id: 'patched' } });
        }
        return jsonResponse({});
      });

      await client.createCollection('ws-1', {
        $kind: 'collection',
        name: 'Description only',
        description: 'created from Local View',
        items: []
      });

      const rootCreate = calls.find((c) => c.path.startsWith('/v3/collections/?workspace='));
      expect(rootCreate?.body).toEqual({ name: 'Description only [bootstrap:test-run]' });

      const rootPatch = calls.find((c) => c.path === '/v3/collections/root-desc');
      expect(rootPatch?.body).toEqual([
        { op: 'replace', path: '/name', value: 'Description only' },
        { op: 'add', path: '/description', value: 'created from Local View' }
      ]);
    });

    it('throws when the root create returns no id', async () => {
      const { client } = makeClient(() => jsonResponse({ data: {} }));
      await expect(
        client.createCollection('ws-1', {
          info: { name: 'X', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
          item: []
        })
      ).rejects.toThrow('Collection create did not return an id');
    });

    it('throws when an item create returns no id', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-uid' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-root-uid/items/') {
          return jsonResponse({ data: {} });
        }
        return jsonResponse({});
      });

      await expect(
        client.createCollection('ws-1', {
          $kind: 'collection',
          name: 'Missing item id',
          items: [
            {
              $kind: 'http-request',
              name: 'Leaf',
              method: 'GET',
              url: 'https://example.test/leaf',
              scripts: [{ type: 'afterResponse', code: 'pm.test("x", function () {});', language: 'text/javascript' }]
            }
          ]
        })
      ).rejects.toThrow(/item create did not return an id/i);

      expect(calls.some((c) => c.method === 'patch')).toBe(false);
      expect(calls).toContainEqual(expect.objectContaining({
        method: 'delete',
        path: '/v3/collections/root-uid'
      }));
    });

    it('normalizes http: script types for converted v2.1 collection and item scripts', async () => {
      const v21 = {
        info: {
          name: 'Scripted v2',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        event: [
          {
            listen: 'prerequest',
            script: { type: 'text/javascript', exec: ['pm.collectionVariables.set("ready", "1");'] }
          }
        ],
        item: [
          {
            name: 'Leaf',
            event: [
              {
                listen: 'test',
                script: { type: 'text/javascript', exec: ['pm.test("ok", function () {});'] }
              }
            ],
            request: { method: 'GET', url: 'https://example.test/get' }
          }
        ]
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-uid' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-root-uid/items/') {
          return jsonResponse({ data: { id: '55363555-leaf-uid' } });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: { id: 'patched' } });
        }
        return jsonResponse({});
      });

      await client.createCollection('ws-1', v21);

      const itemScriptPatch = calls.find((c) => c.path === '/v3/collections/55363555-root-uid/items/55363555-leaf-uid');
      const itemScripts = (itemScriptPatch?.body as Array<{ value: Array<{ type: string }> }>)[0].value;
      expect(itemScripts.every((script) => !String(script.type).startsWith('http:'))).toBe(true);
      expect(itemScripts.map((script) => script.type)).toContain('afterResponse');

      const rootPatch = calls.find((c) => c.path === '/v3/collections/root-uid');
      const rootScripts = (
        (rootPatch?.body as Array<{ path: string; value?: Array<{ type: string }> }>).find(
          (op) => op.path === '/scripts'
        )?.value ?? []
      );
      expect(rootScripts.length).toBeGreaterThan(0);
      // Root wire form requires http: prefix (live-proven); IR normalize still strips.
      expect(rootScripts.every((script) => String(script.type).startsWith('http:'))).toBe(true);
    });

    it('creates siblings in declared items order', async () => {
      const v3 = {
        $kind: 'collection',
        name: 'Ordered create',
        items: [
          { $kind: 'http-request', name: 'First', method: 'GET', url: 'https://example.test/1' },
          { $kind: 'http-request', name: 'Second', method: 'GET', url: 'https://example.test/2' },
          { $kind: 'http-request', name: 'Third', method: 'GET', url: 'https://example.test/3' }
        ]
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-uid' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-root-uid/items/') {
          const body = env.body as { name?: string };
          return jsonResponse({ data: { id: `55363555-${body.name}-uid` } });
        }
        return jsonResponse({});
      });

      await client.createCollection('ws-1', v3);

      const createdNames = calls
        .filter((c) => c.method === 'post' && c.path === '/v3/collections/55363555-root-uid/items/')
        .map((c) => (c.body as { name?: string }).name);
      expect(createdNames).toEqual(['First', 'Second', 'Third']);
    });

    it('rejects unsupported Local View features before any remote mutation', async () => {
      const { client, calls } = makeClient(() => jsonResponse({ data: { id: 'should-not-create' } }));

      await expect(
        client.createCollection('ws-1', {
          $kind: 'collection',
          name: 'Unsupported',
          items: [
            {
              $kind: 'http-request',
              name: 'With examples',
              method: 'GET',
              url: 'https://example.test/x',
              examples: './.resources/With examples.resources/examples'
            }
          ]
        })
      ).rejects.toThrow(/examples/i);

      expect(calls).toHaveLength(0);
    });

    it('rejects an ambiguous items-only payload before any remote mutation', async () => {
      const { client, calls } = makeClient(() => jsonResponse({ data: { id: 'should-not-create' } }));

      await expect(
        client.createCollection('ws-1', {
          name: 'Missing v3 discriminator',
          items: []
        })
      ).rejects.toThrow(/\$kind.*collection|collection v3/i);

      expect(calls).toHaveLength(0);
    });

    it('rejects unknown v3 fields and script types before any remote mutation', async () => {
      const { client, calls } = makeClient(() => jsonResponse({ data: { id: 'should-not-create' } }));

      await expect(
        client.createCollection('ws-1', {
          $kind: 'collection',
          name: 'Unknown field',
          items: [{
            $kind: 'http-request',
            name: 'Leaf',
            method: 'GET',
            url: 'https://example.test',
            cookieJar: { enabled: true }
          }]
        })
      ).rejects.toThrow(/cookieJar.*cannot be preserved|unsupported.*cookieJar/i);

      await expect(
        client.createCollection('ws-1', {
          $kind: 'collection',
          name: 'Unknown script',
          scripts: [{ type: 'duringRequest', code: '1;', language: 'text/javascript' }],
          items: []
        })
      ).rejects.toThrow(/script type.*duringRequest|duringRequest.*unsupported/i);

      expect(calls).toHaveLength(0);
    });

    it('keeps legacy v2.1 saved examples and folder metadata compatible', async () => {
      const v21 = {
        info: {
          name: 'Legacy compatibility',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        item: [{
          name: 'Folder',
          auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
          event: [{ listen: 'prerequest', script: { exec: ['pm.variables.set("folder", "1");'] } }],
          item: [{
            name: 'Leaf',
            request: { method: 'GET', url: 'https://example.test' },
            response: [{ name: 'Saved', status: 'OK', code: 200 }]
          }]
        }]
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-legacy-root' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-legacy-root/items/') {
          const name = String((env.body as { name?: string }).name ?? 'item').toLowerCase();
          return jsonResponse({ data: { id: `55363555-${name}-id` } });
        }
        return jsonResponse({ data: { id: 'patched' } });
      });

      await expect(client.createCollection('ws-1', v21)).resolves.toBe('55363555-legacy-root');

      const folderScriptPatch = calls.find((call) => (
        call.method === 'patch' &&
        call.headers['x-entity-type'] === 'collection'
      ));
      expect(folderScriptPatch).toBeUndefined();
    });
  });

  describe('updateCollection', () => {
    it('deletes every existing root item, tolerating a 500 on an already-cascaded child, then recreates from the new tree and renames', async () => {
      const v21 = {
        info: { name: 'Curated (updated)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          { name: 'New Leaf', request: { method: 'GET', url: { raw: 'https://example.test/v2', host: ['example', 'test'], path: ['v2'] } } }
        ]
      };
      let itemListReads = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          itemListReads += 1;
          return jsonResponse({
            data: itemListReads === 1
              ? [{ id: 'old-1', $kind: 'http-request' }, { id: 'old-2', $kind: 'http-request' }]
              : []
          });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          // Present root fields that must be cleared on update (live: only remove when present).
          return jsonResponse({
            data: {
              id: '55363555-cid-1',
              name: 'Old',
              description: 'old desc',
              auth: { type: 'bearer', credentials: [{ key: 'token', value: 'x' }] },
              variables: [{ key: 'old', value: '1' }],
              scripts: [{ type: 'http:beforeRequest', code: '1;', language: 'text/javascript' }]
            }
          });
        }
        if (env.method === 'delete' && env.path === '/v3/collections/55363555-cid-1/items/old-1') {
          return new Response(null, { status: 204 });
        }
        if (env.method === 'delete' && env.path === '/v3/collections/55363555-cid-1/items/old-2') {
          return jsonResponse({ error: { code: 'GENERIC_ERROR' } }, { status: 500 });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: { id: '55363555-new-leaf-uid' } });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: 'cid-1' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', v21);

      expect(calls.some((c) => c.method === 'delete' && c.path === '/v3/collections/55363555-cid-1/items/old-1')).toBe(true);
      expect(calls.some((c) => c.method === 'delete' && c.path === '/v3/collections/55363555-cid-1/items/old-2')).toBe(true);
      expect(calls.some((c) => c.method === 'get' && c.path === '/v3/collections/cid-1')).toBe(true);

      const created = calls.find((c) => c.method === 'post' && c.path === '/v3/collections/55363555-cid-1/items/');
      expect(created).toMatchObject({ body: expect.objectContaining({ name: 'New Leaf' }) });

      const patch = calls.find((c) => c.method === 'patch' && c.path === '/v3/collections/cid-1');
      const ops = patch?.body as Array<{ op: string; path: string; value?: unknown }>;
      expect(ops).toEqual(
        expect.arrayContaining([
          { op: 'replace', path: '/name', value: 'Curated (updated)' },
          { op: 'remove', path: '/description' },
          { op: 'remove', path: '/auth' },
          { op: 'remove', path: '/variables' },
          { op: 'remove', path: '/scripts' }
        ])
      );
    });

    it('rejects malformed existing item listings before deleting anything', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: [{ name: 'Missing id', $kind: 'http-request' }] });
        }
        return jsonResponse({ data: {} });
      });

      await expect(client.updateCollection('55363555-cid-1', {
        $kind: 'collection',
        name: 'Replacement',
        items: []
      })).rejects.toThrow(/existing item.*id|item listing.*id/i);

      expect(calls.some((call) => call.method === 'delete')).toBe(false);
      expect(calls.some((call) => call.method === 'post')).toBe(false);
    });

    it('does not recreate when a tolerated delete error leaves an old item behind', async () => {
      let itemListReads = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          itemListReads += 1;
          return jsonResponse({ data: [{ id: 'old-1', name: 'Old', $kind: 'http-request' }] });
        }
        if (env.method === 'delete') {
          return jsonResponse({ error: { code: 'GENERIC_ERROR' } }, { status: 500 });
        }
        return jsonResponse({ data: {} });
      });

      await expect(client.updateCollection('55363555-cid-1', {
        $kind: 'collection',
        name: 'Replacement',
        items: [{ $kind: 'http-request', name: 'New', method: 'GET', url: 'https://example.test' }]
      })).rejects.toThrow(/old items remain|delete.*verification/i);

      // initial list + ambiguous-delete re-read + post-loop verification
      expect(itemListReads).toBe(3);
      expect(calls.some((call) => call.method === 'post')).toBe(false);
    });

    it('reconciles root description/auth/variables/scripts on update, including removals', async () => {
      const desired = {
        $kind: 'collection',
        name: 'Reconciled',
        description: 'updated description',
        auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{t}}' }] },
        variables: [{ key: 'baseUrl', value: 'https://example.test' }],
        scripts: [
          { type: 'beforeRequest', code: 'pm.variables.set("ready", "1");', language: 'text/javascript' }
        ],
        items: []
      };
      let rootState: Record<string, unknown> = {
        id: '55363555-cid-1',
        name: 'Old',
        description: ''
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: rootState });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: { id: 'cid-1' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', desired);

      const patches = calls.filter((c) => c.method === 'patch' && c.path === '/v3/collections/cid-1');
      const ops = patches.flatMap((c) => c.body as Array<{ op: string; path: string; value?: unknown }>);
      expect(ops).toEqual(
        expect.arrayContaining([
          { op: 'replace', path: '/name', value: 'Reconciled' },
          { op: 'add', path: '/description', value: 'updated description' },
          { op: 'add', path: '/auth', value: desired.auth },
          { op: 'add', path: '/variables', value: desired.variables },
          {
            op: 'add',
            path: '/scripts',
            value: [
              {
                type: 'http:beforeRequest',
                code: 'pm.variables.set("ready", "1");',
                language: 'text/javascript'
              }
            ]
          }
        ])
      );

      // Simulate the post-update remote state so clear only removes present fields.
      rootState = {
        id: '55363555-cid-1',
        name: 'Reconciled',
        description: 'updated description',
        auth: desired.auth,
        variables: desired.variables,
        scripts: [{ type: 'http:beforeRequest', code: 'pm.variables.set("ready", "1");', language: 'text/javascript' }]
      };

      const cleared = {
        $kind: 'collection',
        name: 'Cleared root',
        items: []
      };
      calls.length = 0;
      await client.updateCollection('55363555-cid-1', cleared);
      const clearPatches = calls.filter((c) => c.method === 'patch' && c.path === '/v3/collections/cid-1');
      const clearOps = clearPatches.flatMap(
        (c) => c.body as Array<{ op: string; path: string; value?: unknown }>
      );
      expect(clearOps).toEqual(
        expect.arrayContaining([
          { op: 'replace', path: '/name', value: 'Cleared root' },
          { op: 'remove', path: '/description' },
          { op: 'remove', path: '/auth' },
          { op: 'remove', path: '/variables' },
          { op: 'remove', path: '/scripts' }
        ])
      );

      // Absent optional fields must not emit blind removes (live 400).
      rootState = { id: '55363555-cid-1', name: 'Cleared root', description: '' };
      calls.length = 0;
      await client.updateCollection('55363555-cid-1', {
        $kind: 'collection',
        name: 'Still clear',
        items: []
      });
      const absentOps = calls
        .filter((c) => c.method === 'patch' && c.path === '/v3/collections/cid-1')
        .flatMap((c) => c.body as Array<{ op: string; path: string }>);
      expect(absentOps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ op: 'replace', path: '/name', value: 'Still clear' }),
          expect.objectContaining({ op: 'remove', path: '/description' })
        ])
      );
      expect(absentOps.some((op) => op.path === '/auth')).toBe(false);
      expect(absentOps.some((op) => op.path === '/variables')).toBe(false);
      expect(absentOps.some((op) => op.path === '/scripts')).toBe(false);
    });

    it('normalizes http: script types on v2.1 updateCollection', async () => {
      const v21 = {
        info: {
          name: 'Updated scripts',
          schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
        },
        event: [
          {
            listen: 'prerequest',
            script: { type: 'text/javascript', exec: ['pm.collectionVariables.set("ready", "1");'] }
          }
        ],
        item: [
          {
            name: 'Leaf',
            event: [
              {
                listen: 'test',
                script: { type: 'text/javascript', exec: ['pm.test("ok", function () {});'] }
              }
            ],
            request: { method: 'GET', url: 'https://example.test/get' }
          }
        ]
      };
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: '55363555-cid-1', name: 'Old', description: '' } });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: { id: '55363555-leaf-uid' } });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: { id: 'patched' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', v21);

      const itemScriptPatch = calls.find((c) => c.path === '/v3/collections/55363555-cid-1/items/55363555-leaf-uid');
      const itemScripts = (itemScriptPatch?.body as Array<{ value: Array<{ type: string }> }>)[0].value;
      expect(itemScripts.every((script) => !String(script.type).startsWith('http:'))).toBe(true);

      const rootPatch = calls.find(
        (c) => c.method === 'patch' && c.path === '/v3/collections/cid-1'
      );
      const rootScripts =
        (
          (rootPatch?.body as Array<{ path: string; value?: Array<{ type: string }> }> | undefined) ??
          []
        ).find((op) => op.path === '/scripts')?.value ?? [];
      expect(rootScripts.length).toBeGreaterThan(0);
      expect(rootScripts.every((script) => String(script.type).startsWith('http:'))).toBe(true);
    });
  });

  describe('createWorkspace non-org flip 403 safety net', () => {
    it('maps a flip-path 403 (addWorkspaceLevelTeamRoles) to the org-account workspace-team-id guidance', async () => {
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ data: { id: 'ws-flip' } });
        }
        if (env.method === 'put' && env.path === '/workspaces/ws-flip/visibility') {
          return jsonResponse({ error: { name: 'addWorkspaceLevelTeamRoles' } }, { status: 403 });
        }
        return jsonResponse({});
      });

      await expect(client.createWorkspace('ws', 'about')).rejects.toThrow(
        WORKSPACE_PERSONAL_ONLY_ADVICE
      );
    });

    it('maps a flip-path 403 ("not authorized") to the org-account guidance', async () => {
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ data: { id: 'ws-flip2' } });
        }
        if (env.method === 'put') {
          return jsonResponse(
            { error: { message: 'You are not authorized to perform this action' } },
            { status: 403 }
          );
        }
        return jsonResponse({});
      });

      await expect(client.createWorkspace('ws', 'about')).rejects.toThrow(
        WORKSPACE_PERSONAL_ONLY_ADVICE
      );
    });

    it('maps a flip-path 403 ("permission to update visibility to team") to the org-account guidance', async () => {
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ data: { id: 'ws-flip3' } });
        }
        if (env.method === 'put') {
          return jsonResponse(
            {
              error: {
                status: 403,
                name: 'forbidden',
                message: 'Access to this resource is forbidden for this user',
                detail: 'You do not have permission to update visibility to team'
              }
            },
            { status: 403 }
          );
        }
        return jsonResponse({});
      });

      await expect(client.createWorkspace('ws', 'about')).rejects.toThrow(
        WORKSPACE_PERSONAL_ONLY_ADVICE
      );
    });

    it('passes an unrelated flip 403 through unchanged (does not over-trigger)', async () => {
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return jsonResponse({ data: { id: 'ws-x' } });
        }
        if (env.method === 'put') {
          return jsonResponse({ error: { message: 'workspace quota exceeded' } }, { status: 403 });
        }
        return jsonResponse({});
      });

      const error = await client.createWorkspace('ws', 'about').catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(WORKSPACE_PERSONAL_ONLY_ADVICE);
    });
  });
});
