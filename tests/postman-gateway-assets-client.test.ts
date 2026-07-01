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
  handler: (env: Envelope, callIndex: number) => Response
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

  describe('isGrpcExecutionAllowed', () => {
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

    it('POSTs the features service for the team entity and returns true when the flag value is true', async () => {
      await seedSession(10490519);
      const { client, calls } = makeClient(() =>
        jsonResponse({
          data: {
            features: { grpc_protocol_execution_allowed: { type: 'boolean', value: true, properties: {} } }
          }
        })
      );
      expect(await client.isGrpcExecutionAllowed()).toBe(true);
      expect(calls[0]).toMatchObject({
        service: 'features',
        method: 'post',
        path: '/features/list?entityType=team&entityValue=10490519',
        body: { features: ['grpc_protocol_execution_allowed'] }
      });
    });

    it('returns false when the flag value is false', async () => {
      await seedSession(10490519);
      const { client } = makeClient(() =>
        jsonResponse({ data: { features: { grpc_protocol_execution_allowed: { value: false } } } })
      );
      expect(await client.isGrpcExecutionAllowed()).toBe(false);
    });

    it('returns false (conservative default) on a non-2xx probe', async () => {
      await seedSession(10490519);
      const { client } = makeClient(() =>
        jsonResponse({ error: { name: 'UnexpectedError' } }, { status: 500 })
      );
      expect(await client.isGrpcExecutionAllowed()).toBe(false);
    });

    it('returns false without probing when no session identity is memoized', async () => {
      __resetIdentityMemo();
      const { client, calls } = makeClient(() => jsonResponse({ data: {} }));
      expect(await client.isGrpcExecutionAllowed()).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  describe('createCollection', () => {
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
        if (env.method === 'post' && env.path === '/v3/collections/root-uid/items/') {
          const body = env.body as { name?: string };
          if (body?.name === 'Folder') return jsonResponse({ data: { id: '55363555-folder-uid' } });
          return jsonResponse({ data: { id: '55363555-leaf-uid' } });
        }
        return jsonResponse({});
      });

      const id = await client.createCollection('ws-1', v21);
      expect(id).toBe('55363555-root-uid');

      const rootCreate = calls.find((c) => c.path.startsWith('/v3/collections/?workspace='));
      expect(rootCreate).toMatchObject({ headers: expect.objectContaining({ 'x-entity-target': 'http' }), body: { name: 'Curated' } });

      const folderCreate = calls.find(
        (c) => c.path === '/v3/collections/root-uid/items/' && (c.body as { name?: string })?.name === 'Folder'
      );
      expect(folderCreate).toMatchObject({
        headers: expect.objectContaining({ 'x-entity-type': 'collection' }),
        body: { $kind: 'collection', name: 'Folder', position: { parent: { id: 'root-uid', $kind: 'collection' } } }
      });

      const leafCreate = calls.find(
        (c) => c.path === '/v3/collections/root-uid/items/' && (c.body as { name?: string })?.name === 'Leaf'
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

    it('throws when the root create returns no id', async () => {
      const { client } = makeClient(() => jsonResponse({ data: {} }));
      await expect(
        client.createCollection('ws-1', {
          info: { name: 'X', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
          item: []
        })
      ).rejects.toThrow('Collection create did not return an id');
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
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/cid-1/items/') {
          return jsonResponse({ data: [{ id: 'old-1', $kind: 'http-request' }, { id: 'old-2', $kind: 'http-request' }] });
        }
        if (env.method === 'delete' && env.path === '/v3/collections/cid-1/items/old-1') {
          return new Response(null, { status: 204 });
        }
        if (env.method === 'delete' && env.path === '/v3/collections/cid-1/items/old-2') {
          return jsonResponse({ error: { code: 'GENERIC_ERROR' } }, { status: 500 });
        }
        if (env.method === 'post' && env.path === '/v3/collections/cid-1/items/') {
          return jsonResponse({ data: { id: '55363555-new-leaf-uid' } });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: 'cid-1' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', v21);

      expect(calls.some((c) => c.method === 'delete' && c.path === '/v3/collections/cid-1/items/old-1')).toBe(true);
      expect(calls.some((c) => c.method === 'delete' && c.path === '/v3/collections/cid-1/items/old-2')).toBe(true);

      const created = calls.find((c) => c.method === 'post' && c.path === '/v3/collections/cid-1/items/');
      expect(created).toMatchObject({ body: expect.objectContaining({ name: 'New Leaf' }) });

      const patch = calls.find((c) => c.method === 'patch' && c.path === '/v3/collections/cid-1');
      expect(patch?.body).toEqual([{ op: 'replace', path: '/name', value: 'Curated (updated)' }]);
    });
  });
});