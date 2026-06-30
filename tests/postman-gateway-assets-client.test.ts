import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { __resetIdentityMemo, resolveSessionIdentity } from '../src/lib/postman/credential-identity.js';

interface Envelope {
  service: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
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
  handler: (env: Envelope, callIndex: number) => Response
): { client: PostmanGatewayAssetsClient; gateway: AccessTokenGatewayClient; calls: Envelope[] } {
  const calls: Envelope[] = [];
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    const env = JSON.parse(String((init as RequestInit).body)) as Envelope;
    calls.push(env);
    return handler(env, i++);
  });
  const provider = new AccessTokenProvider({ accessToken: 'tok-1' });
  const gateway = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl });
  const client = new PostmanGatewayAssetsClient({ gateway, sleep: async () => undefined });
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
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          return jsonResponse({ data: { taskId: 'task-7' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          polls += 1;
          return jsonResponse({ data: { 'task-7': polls < 2 ? 'in-progress' : 'completed' } });
        }
        // spec collections list
        return jsonResponse({ data: [{ collection: 'uid-A', state: 'in-sync' }] });
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
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post') return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'completed' } });
        return jsonResponse({ data: [{ collection: 'uid-X' }] });
      });
      await client.generateCollection('spec-1', 'P', '', 'None', true, 'Fallback');
      const post = calls.find((c) => c.method === 'post');
      expect((post?.body as { options: Record<string, unknown> }).options).not.toHaveProperty('nestedFolderHierarchy');
    });

    it('retries a 423-locked generate then succeeds', async () => {
      let attempts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path.endsWith('/collections')) {
          attempts += 1;
          if (attempts === 1) return jsonResponse({ error: 'locked' }, { status: 423 });
          return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'completed' } });
        return jsonResponse({ data: [{ collection: 'uid-R' }] });
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

      // 1) list on the bare model id with trailing slash
      expect(calls[0]).toMatchObject({
        service: 'collection',
        method: 'get',
        path: '/v3/collections/model-9/items/'
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
      expect(create?.path).toBe('/v3/collections/model-9/items/');
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
      expect(calls.find((c) => c.method === 'patch')?.path).toBe('/v3/collections/model-9/items/55363555-leaf-1');
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
});
