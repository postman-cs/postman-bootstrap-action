import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';

const GATEWAY = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';

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
});
