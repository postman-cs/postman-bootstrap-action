import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { __resetIdentityMemo, resolveSessionIdentity } from '../src/lib/postman/credential-identity.js';
import { WORKSPACE_PERSONAL_ONLY_ADVICE } from '../src/lib/postman/error-advice.js';
import {
  createDefinitionBundle,
  createDefinitionFile
} from '../src/lib/spec/definition-bundle.js';
import {
  definitionBundleToSnapshot,
  type SpecReconcileCapabilityPolicy
} from '../src/lib/postman/spec-file-reconcile.js';

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
  clientOptions?: {
    generationPollAttempts?: number;
    generationPollDelayMs?: number;
    createIdentity?: () => string;
    reconcileCapabilityPolicy?: SpecReconcileCapabilityPolicy;
    sleep?: (delayMs: number) => Promise<void>;
  }
): { client: PostmanGatewayAssetsClient; gateway: AccessTokenGatewayClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const requestUrl = new URL(String(url));
    const env = requestUrl.pathname === '/ws/proxy'
      ? JSON.parse(String((init as RequestInit).body)) as Envelope
      : {
          service: 'direct',
          method: String((init as RequestInit).method ?? 'GET').toLowerCase(),
          path: `${requestUrl.pathname}${requestUrl.search}`
        };
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

      const create = calls.find((call) => call.method === 'post');
      expect(create).toBeDefined();
      if (!create) throw new Error('spec create request was not made');
      expect(create.service).toBe('specification');
      expect(create.method).toBe('post');
      expect(create.path).toBe('/specifications?containerType=workspace&containerId=ws-9');
      const body = create.body as { type: string; files: Array<{ path: string; type: string; content: string }> };
      expect(body.type).toBe('OPENAPI:3.0');
      expect(body.files[0]).toMatchObject({ path: 'index.yaml', type: 'ROOT', content: 'openapi: 3.0.3' });
      // preflight GET happened
      expect(calls.at(-1)).toMatchObject({ service: 'specification', method: 'get', path: '/specifications/spec-1' });
    });

    it('reports an uncontested spec create as rollback-owned', async () => {
      let created = false;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: created ? [{ id: 'spec-owned', name: 'Telecom' }] : [] });
        }
        if (env.method === 'post' && env.path.includes('/specifications?')) {
          created = true;
          return jsonResponse({ data: { id: 'spec-owned' } });
        }
        return jsonResponse({ data: { id: 'spec-owned' } });
      });

      await expect(
        client.uploadSpecWithOutcome('ws-9', 'Telecom', 'openapi: 3.0.3', '3.0')
      ).resolves.toEqual({ specId: 'spec-owned', created: true });
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

    it('elects one winner and removes concurrently created duplicate specs', async () => {
      let listCalls = 0;
      let deletedB = false;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          listCalls += 1;
          if (listCalls === 1) return jsonResponse({ data: [] });
          // Keep both IDs list-visible until election deletes the loser so the
          // stable-set quiet streak can observe the concurrent pair.
          if (!deletedB) {
            return jsonResponse({
              data: [
                { id: 'spec-a', name: 'Payments' },
                { id: 'spec-b', name: 'Payments' }
              ]
            });
          }
          return jsonResponse({ data: [{ id: 'spec-a', name: 'Payments' }] });
        }
        if (env.method === 'post') return jsonResponse({ data: { id: 'spec-b' } });
        if (env.method === 'delete' && env.path === '/specifications/spec-b') {
          deletedB = true;
          return jsonResponse({ data: { id: 'spec-b' } });
        }
        if (env.path === '/specifications/spec-a/files') {
          return jsonResponse({ data: [{ id: 'root-a', type: 'ROOT' }] });
        }
        if (env.method === 'patch') return jsonResponse({ data: { id: 'root-a' } });
        return jsonResponse({ data: { id: 'spec-a' } });
      });

      await expect(
        client.uploadSpecWithOutcome('ws-1', 'Payments', 'openapi: 3.0.3', '3.0')
      ).resolves.toEqual({ specId: 'spec-a', created: false });
      expect(calls).toContainEqual(
        expect.objectContaining({
          service: 'specification',
          method: 'delete',
          path: '/specifications/spec-b'
        })
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          service: 'specification',
          method: 'patch',
          path: '/specifications/spec-a/files/root-a'
        })
      );
    });

    it('waits for a delayed concurrent spec to become list-visible before generation', async () => {
      let listCalls = 0;
      let deletedB = false;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          listCalls += 1;
          if (listCalls === 1) return jsonResponse({ data: [] });
          // First post-create observations are still a singleton; peer appears
          // after the historic single-settle window (listCalls >= 4).
          if (listCalls <= 3) {
            return jsonResponse({ data: [{ id: 'spec-b', name: 'Payments' }] });
          }
          if (!deletedB) {
            return jsonResponse({
              data: [
                { id: 'spec-a', name: 'Payments' },
                { id: 'spec-b', name: 'Payments' }
              ]
            });
          }
          return jsonResponse({ data: [{ id: 'spec-a', name: 'Payments' }] });
        }
        if (env.method === 'post') return jsonResponse({ data: { id: 'spec-b' } });
        if (env.method === 'delete' && env.path === '/specifications/spec-b') {
          deletedB = true;
          return jsonResponse({ data: { id: 'spec-b' } });
        }
        if (env.path === '/specifications/spec-a/files') {
          return jsonResponse({ data: [{ id: 'root-a', type: 'ROOT' }] });
        }
        if (env.method === 'patch') return jsonResponse({ data: { id: 'root-a' } });
        return jsonResponse({ data: { id: 'spec-a' } });
      });

      await expect(
        client.uploadSpec('ws-1', 'Payments', 'openapi: 3.0.3', '3.0')
      ).resolves.toBe('spec-a');
      expect(listCalls).toBeGreaterThanOrEqual(4);
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'delete', path: '/specifications/spec-b' })
      );
    });

    it('does not claim exclusive rollback ownership after its winner is shared with a peer', async () => {
      let listCalls = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          listCalls += 1;
          if (listCalls === 1) return jsonResponse({ data: [] });
          if (listCalls <= 3) {
            return jsonResponse({
              data: [
                { id: 'spec-a', name: 'Payments' },
                { id: 'spec-b', name: 'Payments' }
              ]
            });
          }
          return jsonResponse({ data: [{ id: 'spec-a', name: 'Payments' }] });
        }
        if (env.method === 'post') return jsonResponse({ data: { id: 'spec-a' } });
        if (env.method === 'delete') {
          return jsonResponse({ error: 'winner must not delete a peer-owned spec' }, { status: 500 });
        }
        return jsonResponse({ data: { id: 'spec-a' } });
      });

      await expect(
        client.uploadSpecWithOutcome('ws-1', 'Payments', 'openapi: 3.0.3', '3.0')
      ).resolves.toEqual({ specId: 'spec-a', created: false });
      expect(calls.some((call) => call.method === 'delete')).toBe(false);
    });
  });

  describe('generateCollection', () => {
    it('hydrates generated names through the app sync route instead of the forbidden v3 root', async () => {
      const modelId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const collectionUid = `132319-${modelId}`;
      let submittedName = '';
      let currentName = '';
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          if (!submittedName) return jsonResponse({ data: [] });
          return jsonResponse({
            data: [{ collection: collectionUid, state: 'in-sync', options: {}, syncOptions: {} }]
          });
        }
        if (env.service === 'direct') {
          return jsonResponse({
            entities: [{ data: { uid: collectionUid, name: currentName }, revision: '1' }]
          });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          currentName = submittedName;
          return jsonResponse({ data: { taskId: 'task-org' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          return jsonResponse({ data: { 'task-org': 'completed' } });
        }
        if (env.method === 'patch' && env.path === `/v3/collections/${modelId}`) {
          currentName = '[Smoke] Telecom';
          return jsonResponse({ data: { id: modelId } });
        }
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse(
            { error: { code: 'FORBIDDEN', message: `Access to ${modelId} denied` } },
            { status: 403 }
          );
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });
      client.configureTeamContext('132319', true);

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Smoke]', 'Tags', true, 'Fallback')
      ).resolves.toBe(collectionUid);

      const specListCalls = calls.filter(
        (call) => call.method === 'get' && call.path === '/specifications/spec-1/collections'
      );
      expect(specListCalls.length).toBeGreaterThanOrEqual(3);
      expect(specListCalls.every((call) => call.query?.fields === 'syncOptions,options')).toBe(true);
      expect(specListCalls.every((call) => call.headers['x-entity-team-id'] === '132319')).toBe(true);
      expect(calls).toContainEqual(expect.objectContaining({
        service: 'direct',
        method: 'get',
        path: `/collection/${collectionUid}/sync?since_id=0&favorite=true&exclude=response%2Crequest`
      }));
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('hydrates names through the app sync route before adopting an existing collection', async () => {
      const collectionUid = '132319-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          return jsonResponse({
            data: [{ collection: collectionUid, state: 'in-sync', options: {}, syncOptions: {} }]
          });
        }
        if (env.service === 'direct') {
          return jsonResponse({ entities: [{ data: { name: '[Smoke] Telecom' }, revision: '1' }] });
        }
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse({ error: { code: 'FORBIDDEN' } }, { status: 403 });
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });
      client.configureTeamContext('132319', true);

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Smoke]', 'Tags', true, 'Fallback')
      ).resolves.toBe(collectionUid);

      expect(calls.every((call) => call.method !== 'post')).toBe(true);
      expect(calls.some((call) => call.service === 'collection')).toBe(false);
      expect(calls[0]).toMatchObject({
        service: 'specification',
        method: 'get',
        path: '/specifications/spec-1/collections',
        query: { fields: 'syncOptions,options' },
        headers: expect.objectContaining({ 'x-entity-team-id': '132319' })
      });
    });

    it('hydrates nameless Spec Hub relations without reading v3 collection roots', async () => {
      const staleModelId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const staleUid = `132319-${staleModelId}`;
      const generatedModelId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      const generatedUid = `132319-${generatedModelId}`;
      let submittedName = '';
      let currentName = '';
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          return jsonResponse({
            data: [
              { collection: staleUid },
              ...(submittedName ? [{ collection: generatedUid, name: currentName }] : [])
            ]
          });
        }
        if (env.service === 'direct') {
          const name = env.path.includes(generatedUid) ? currentName : '[Baseline] Other';
          return jsonResponse({ entities: [{ data: { name }, revision: '1' }] });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          currentName = submittedName;
          return jsonResponse({ data: { taskId: 'task-nameless' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          return jsonResponse({ data: { 'task-nameless': 'completed' } });
        }
        if (env.method === 'patch' && env.path === `/v3/collections/${generatedModelId}`) {
          currentName = '[Smoke] Telecom';
          return jsonResponse({ data: { id: generatedModelId } });
        }
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse({ error: { code: 'FORBIDDEN' } }, { status: 403 });
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Smoke]', 'Tags', true, 'Fallback')
      ).resolves.toBe(generatedUid);

      expect(
        calls
          .filter(
            (call) => call.method === 'get' && call.path === '/specifications/spec-1/collections'
          )
          .every((call) => call.query?.fields === 'syncOptions,options')
      ).toBe(true);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('waits for direct sync name hydration on a newly appeared relation', async () => {
      const peerModelId = '11111111-1111-1111-1111-111111111111';
      const peerUid = `132319-${peerModelId}`;
      const generatedModelId = '22222222-2222-2222-2222-222222222222';
      const generatedUid = `132319-${generatedModelId}`;
      let submittedName = '';
      let postTaskListReads = 0;
      let enrichedName = '';
      const { client, calls } = makeClient(
        (env) => {
          if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
            if (!submittedName) {
              return jsonResponse({ data: [{ collection: peerUid }] });
            }
            postTaskListReads += 1;
            // Live race: relation appears immediately after task completion, but
            // direct sync hydration lags for at least two authorized list reads.
            if (postTaskListReads <= 2) {
              return jsonResponse({
                data: [{ collection: peerUid }, { collection: generatedUid }]
              });
            }
            return jsonResponse({
              data: [
                { collection: peerUid },
                { collection: generatedUid }
              ]
            });
          }
          if (env.service === 'direct') {
            const name = env.path.includes(generatedUid) && postTaskListReads > 2
              ? enrichedName || submittedName
              : env.path.includes(peerUid) ? '[Baseline] Other' : '';
            return jsonResponse({ entities: [{ data: { name }, revision: '1' }] });
          }
          if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
            submittedName = String((env.body as { name?: unknown })?.name ?? '');
            enrichedName = submittedName;
            return jsonResponse({ data: { taskId: 'task-enrich' } }, { status: 202 });
          }
          if (env.path === '/tasks') {
            return jsonResponse({ data: { 'task-enrich': 'completed' } });
          }
          if (env.method === 'patch' && env.path === `/v3/collections/${generatedModelId}`) {
            enrichedName = '[Contract] Telecom';
            return jsonResponse({ data: { id: generatedModelId } });
          }
          if (env.service === 'collection' && env.method === 'get') {
            return jsonResponse(
              { error: { code: 'FORBIDDEN', message: `Access to ${env.path} denied` } },
              { status: 403 }
            );
          }
          return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
        },
        { generationPollDelayMs: 0 }
      );
      client.configureTeamContext('132319', true);

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Contract]', 'Tags', false, 'Fallback')
      ).resolves.toBe(generatedUid);

      expect(postTaskListReads).toBeGreaterThanOrEqual(3);
      expect(submittedName).toBe('[Contract] Telecom [bootstrap:test-run]');
      const specListCalls = calls.filter(
        (call) => call.method === 'get' && call.path === '/specifications/spec-1/collections'
      );
      expect(specListCalls.every((call) => call.query?.fields === 'syncOptions,options')).toBe(true);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('adopts the sole peer final after its own temporary relation disappears', async () => {
      const peerUid = '132319-34343434-3434-3434-3434-343434343434';
      let submitted = false;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          if (!submitted) return jsonResponse({ data: [] });
          return jsonResponse({ data: [{ collection: peerUid, name: '[Contract] Telecom' }] });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submitted = true;
          return jsonResponse({ data: { taskId: 'task-peer-final' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          return jsonResponse({ data: { 'task-peer-final': 'completed' } });
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Contract]', 'Tags', false, 'Fallback')
      ).resolves.toBe(peerUid);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('adopts the sole hydrated peer final after its own temporary relation disappears', async () => {
      const peerModelId = '34343434-3434-3434-3434-343434343434';
      const peerUid = `132319-${peerModelId}`;
      let submitted = false;
      let postTaskReads = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          if (!submitted) return jsonResponse({ data: [] });
          postTaskReads += 1;
          return jsonResponse({ data: [{ collection: peerUid }] });
        }
        if (env.service === 'direct') {
          return jsonResponse({ entities: [{ data: { name: '[Contract] Telecom' } }] });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submitted = true;
          return jsonResponse({ data: { taskId: 'task-peer-final' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { 'task-peer-final': 'completed' } });
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });
      const delays: number[] = [];
      (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
        delays.push(ms);
      };

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Contract]', 'Tags', false, 'Fallback')
      ).resolves.toBe(peerUid);

      expect(postTaskReads).toBeGreaterThanOrEqual(21);
      expect(delays.slice(1, 20)).toEqual(Array(19).fill(1000));
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('caps post-completion name enrichment before one final peer lookup', async () => {
      let submitted = false;
      let settleReads = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          if (submitted) settleReads += 1;
          return jsonResponse({ data: submitted ? [{ collection: '132319-nameless' }] : [] });
        }
        if (env.service === 'direct') return jsonResponse({ entities: [{ data: { name: '' } }] });
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submitted = true;
          return jsonResponse({ data: { taskId: 'task-settle-cap' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { 'task-settle-cap': 'completed' } });
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Contract]', 'Tags', false, 'Fallback')
      ).rejects.toThrow(/did not yield a collection uid/);
      expect(settleReads).toBe(21);
    });

    it('re-POSTs once when an ambiguous generation 500 did not commit an exact-name relation', async () => {
      const generatedModelId = '33333333-3333-3333-3333-333333333333';
      let createPosts = 0;
      const submittedNames: string[] = [];
      let identities = 0;
      const { client, calls } = makeClient(
        (env) => {
          if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
            if (createPosts < 2) {
              // First ambiguous POST never committed: settle window stays empty.
              return jsonResponse({ data: [] });
            }
            const submittedName = submittedNames[1] ?? '';
            return jsonResponse({
              data: submittedName
                ? [{ collection: generatedModelId, name: submittedName }]
                : []
            });
          }
          if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
            createPosts += 1;
            submittedNames.push(String((env.body as { name?: unknown })?.name ?? ''));
            if (createPosts === 1) {
              return jsonResponse(
                { error: { name: 'serverError', message: 'Something went wrong with the server' } },
                { status: 500 }
              );
            }
            return jsonResponse({ data: { taskId: 'task-repost' } }, { status: 202 });
          }
          if (env.path === '/tasks') {
            return jsonResponse({ data: { 'task-repost': 'completed' } });
          }
          if (env.method === 'patch' && env.path === `/v3/collections/${generatedModelId}`) {
            return jsonResponse({ data: { id: generatedModelId } });
          }
          if (env.service === 'collection' && env.method === 'get') {
            return jsonResponse({ error: { code: 'FORBIDDEN' } }, { status: 403 });
          }
          return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
        },
        {
          generationPollDelayMs: 0,
          createIdentity: () => `attempt-${++identities}`
        }
      );

      await expect(
        client.generateCollection('spec-1', 'Telecom', '[Contract]', 'Tags', false, 'Fallback')
      ).resolves.toBe(generatedModelId);

      expect(createPosts).toBe(2);
      expect(
        calls.filter((call) => call.method === 'post' && call.path === '/specifications/spec-1/collections')
      ).toHaveLength(2);
      expect(submittedNames).toEqual([
        '[Contract] Telecom [bootstrap:attempt-1]',
        '[Contract] Telecom [bootstrap:attempt-2]'
      ]);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('uses the preferred collection identity when Spec Hub name enrichment lags', async () => {
      const preferredUid = '132319-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      const unrelatedUid = '132319-ffffffff-ffff-ffff-ffff-ffffffffffff';
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          return jsonResponse({
            data: [
              { collection: preferredUid },
              { collection: unrelatedUid }
            ]
          });
        }
        if (env.service === 'direct') {
          return jsonResponse({ entities: [{ data: { name: '' }, revision: '1' }] });
        }
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse({ error: { code: 'FORBIDDEN' } }, { status: 403 });
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });
      client.configureTeamContext('132319', true);

      await expect(
        client.adoptGeneratedCollection('spec-1', 'Telecom', '[Smoke]', preferredUid)
      ).resolves.toBe(preferredUid);

      const specListCalls = calls.filter(
        (call) => call.method === 'get' && call.path === '/specifications/spec-1/collections'
      );
      expect(specListCalls).toHaveLength(2);
      expect(specListCalls.every((call) => call.query?.fields === 'syncOptions,options')).toBe(true);
      expect(specListCalls.every((call) => call.headers['x-entity-team-id'] === '132319')).toBe(true);
      expect(calls.some((call) => call.service === 'collection')).toBe(false);
    });

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

    it('waits through eventual task authorization after an accepted generation', async () => {
      let taskReads = 0;
      let posted = false;
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path.endsWith('/collections')) {
          posted = true;
          return jsonResponse({ data: { taskId: 'task-eventual' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          taskReads += 1;
          if (taskReads === 1) return jsonResponse({ error: { name: 'permissionError' } }, { status: 403 });
          if (taskReads === 2) return jsonResponse({ error: { name: 'notFoundError' } }, { status: 404 });
          return jsonResponse({ data: { 'task-eventual': 'completed' } });
        }
        return jsonResponse({ data: posted ? [{ collection: 'uid-eventual', name: 'P [bootstrap:test-run]' }] : [] });
      });

      await expect(
        client.generateCollection('spec-1', 'P', '', 'None', true, 'Fallback')
      ).resolves.toBe('uid-eventual');
      expect(taskReads).toBe(3);
    });

    it('waits for a newly uploaded specification collection relation route to become readable', async () => {
      let listReads = 0;
      let posted = false;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          listReads += 1;
          if (listReads <= 2) return jsonResponse({ error: { name: 'notFoundError' } }, { status: 404 });
          return jsonResponse({ data: posted ? [{ collection: 'uid-readable', name: 'P [bootstrap:test-run]' }] : [] });
        }
        if (env.method === 'post' && env.path.endsWith('/collections')) {
          posted = true;
          return jsonResponse({ data: { taskId: 'task-readable' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { 'task-readable': 'completed' } });
        return jsonResponse({ data: {} });
      });

      await expect(
        client.generateCollection('spec-1', 'P', '', 'None', true, 'Fallback')
      ).resolves.toBe('uid-readable');
      expect(listReads).toBeGreaterThanOrEqual(4);
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
      // 2 for the initial rename (1 fail + 1 retry), plus converge may rename again.
      expect(renameAttempts).toBeGreaterThanOrEqual(2);
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

    it('adopts a peer-generated final collection after a 423 lock', async () => {
      let listCalls = 0;
      let posts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path.endsWith('/collections')) {
          posts += 1;
          return jsonResponse({ error: 'locked' }, { status: 423 });
        }
        if (env.method === 'get' && env.path.endsWith('/collections')) {
          listCalls += 1;
          return jsonResponse({
            data:
              listCalls === 1
                ? []
                : [{ collection: 'uid-peer', name: '[Smoke] P' }]
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', false, 'Fallback')
      ).resolves.toBe('uid-peer');
      expect(posts).toBe(1);
    });

    it('does not delete peer-owned generated collections after winning convergence', async () => {
      let posted = false;
      const deleted = new Set<string>();
      const ours = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const peerFinal = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const peerTemp = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      let oursName = '[Smoke] P [bootstrap:test-run]';
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path.endsWith('/collections')) {
          posted = true;
          return jsonResponse({ data: { taskId: 't' } }, { status: 202 });
        }
        if (env.path === '/tasks') return jsonResponse({ data: { t: 'completed' } });
        if (env.method === 'delete' && env.path.startsWith('/v3/collections/')) {
          deleted.add(env.path.split('/').pop() || '');
          return jsonResponse({ data: { id: 'gone' } });
        }
        if (env.method === 'patch' && env.path.includes(ours)) {
          oursName = '[Smoke] P';
          return jsonResponse({ data: { id: ours } });
        }
        if (env.method === 'get' && env.path.endsWith('/collections')) {
          if (!posted) return jsonResponse({ data: [] });
          return jsonResponse({
            data: [
              { collection: peerFinal, name: '[Smoke] P' },
              { collection: ours, name: oursName },
              { collection: peerTemp, name: '[Smoke] P [bootstrap:peer]' }
            ].filter((entry) => !deleted.has(entry.collection))
          });
        }
        if (env.method === 'patch') return jsonResponse({ data: { id: ours } });
        return jsonResponse({ data: {} });
      });

      await expect(
        client.generateCollection('spec-1', 'P', '[Smoke]', 'Tags', false, 'Fallback')
      ).resolves.toBe(ours);
      expect([...deleted]).toEqual([]);
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
        squad: 132319,
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

      const rootCreate = calls.find((c) => c.method === 'post' && c.path.startsWith('/v3/collections/?workspace='));
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
      const rootCreate = calls.find((c) => c.method === 'post' && c.path.startsWith('/v3/collections/?workspace='));
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

      const rootCreate = calls.find((c) => c.method === 'post' && c.path.startsWith('/v3/collections/?workspace='));
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

    it('retries an item create that 500s without committing (ESOCKETTIMEDOUT), then succeeds', async () => {
      const v21 = {
        info: { name: 'Curated (updated)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          { name: 'New Leaf', request: { method: 'GET', url: { raw: 'https://example.test/v2', host: ['example', 'test'], path: ['v2'] } } }
        ]
      };
      let itemListReads = 0;
      let createAttempts = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          itemListReads += 1;
          return jsonResponse({
            data: itemListReads === 1 ? [{ id: 'old-1', $kind: 'http-request' }] : []
          });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: '55363555-cid-1', name: 'Old' } });
        }
        if (env.method === 'delete') {
          return new Response(null, { status: 204 });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-cid-1/items/') {
          createAttempts += 1;
          if (createAttempts === 1) {
            return jsonResponse(
              { error: { name: 'serverError', details: 'ESOCKETTIMEDOUT', source: 'downstream' } },
              { status: 500 }
            );
          }
          return jsonResponse({ data: { id: '55363555-new-leaf-uid' } });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: 'cid-1' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', v21);

      expect(createAttempts).toBeGreaterThanOrEqual(2);
      const posts = calls.filter((c) => c.method === 'post' && c.path === '/v3/collections/55363555-cid-1/items/');
      expect(posts.length).toBeGreaterThanOrEqual(2);
    });

    it('adopts an item create that 500s but committed server-side (no duplicate)', async () => {
      const v21 = {
        info: { name: 'Curated (updated)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          { name: 'New Leaf', request: { method: 'GET', url: { raw: 'https://example.test/v2', host: ['example', 'test'], path: ['v2'] } } }
        ]
      };
      let itemListReads = 0;
      let createAttempts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          itemListReads += 1;
          if (itemListReads === 1) {
            return jsonResponse({ data: [{ id: 'old-1', $kind: 'http-request' }] });
          }
          if (itemListReads === 2) {
            // Delete verification: old tree gone.
            return jsonResponse({ data: [] });
          }
          // Adopt reconcile read: the 500'd create DID commit server-side.
          return jsonResponse({
            data: [
              {
                id: '55363555-committed-uid',
                name: 'New Leaf',
                $kind: 'http-request',
                position: { parent: '55363555-cid-1' }
              }
            ]
          });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: '55363555-cid-1', name: 'Old' } });
        }
        if (env.method === 'delete') {
          return new Response(null, { status: 204 });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-cid-1/items/') {
          createAttempts += 1;
          return jsonResponse(
            { error: { name: 'serverError', details: 'ESOCKETTIMEDOUT', source: 'downstream' } },
            { status: 500 }
          );
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: 'cid-1' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', v21);

      expect(createAttempts).toBe(1);
    });

    it('adopts a late-visible committed item on the settle read instead of re-POSTing a duplicate', async () => {
      const v21 = {
        info: { name: 'Curated (updated)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: [
          { name: 'New Leaf', request: { method: 'GET', url: { raw: 'https://example.test/v2', host: ['example', 'test'], path: ['v2'] } } }
        ]
      };
      let itemListReads = 0;
      let createAttempts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          itemListReads += 1;
          if (itemListReads === 1) {
            return jsonResponse({ data: [{ id: 'old-1', $kind: 'http-request' }] });
          }
          if (itemListReads === 2) {
            // Delete verification: old tree gone.
            return jsonResponse({ data: [] });
          }
          if (itemListReads === 3) {
            // Immediate reconcile read: replica lag, the committed item is not
            // visible yet.
            return jsonResponse({ data: [] });
          }
          // Settle read after the jittered backoff: the 500'd create surfaces.
          return jsonResponse({
            data: [
              {
                id: '55363555-late-visible-uid',
                name: 'New Leaf',
                $kind: 'http-request',
                position: { parent: '55363555-cid-1' }
              }
            ]
          });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: '55363555-cid-1', name: 'Old' } });
        }
        if (env.method === 'delete') {
          return new Response(null, { status: 204 });
        }
        if (env.method === 'post' && env.path === '/v3/collections/55363555-cid-1/items/') {
          createAttempts += 1;
          return jsonResponse(
            { error: { name: 'serverError', details: 'ESOCKETTIMEDOUT', source: 'downstream' } },
            { status: 500 }
          );
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          return jsonResponse({ data: { id: 'cid-1' } });
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', v21);

      expect(createAttempts).toBe(1);
      expect(itemListReads).toBeGreaterThanOrEqual(4);
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

  describe('updateCollectionDescription', () => {
    const modelId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const collectionUid = `132319-${modelId}`;
    const description = 'branch:feature/preview';

    it('succeeds with only the description PATCH when any collection-root GET would 403', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse(
            { error: { code: 'FORBIDDEN', message: `Access to ${modelId} denied` } },
            { status: 403 }
          );
        }
        if (env.method === 'patch' && env.path === `/v3/collections/${modelId}`) {
          return jsonResponse({ data: { id: modelId } });
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });

      await expect(client.updateCollectionDescription(collectionUid, description)).resolves.toBeUndefined();

      expect(calls).toEqual([
        expect.objectContaining({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${modelId}`,
          body: [{ op: 'add', path: '/description', value: description }]
        })
      ]);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('retries a bounded description PATCH through 404 read-after-write lag, then succeeds', async () => {
      let patchAttempts = 0;
      const sleep = vi.fn(async () => undefined);
      const { client, calls } = makeClient(
        (env) => {
          if (env.service === 'collection' && env.method === 'get') {
            return jsonResponse(
              { error: { code: 'FORBIDDEN', message: `Access to ${modelId} denied` } },
              { status: 403 }
            );
          }
          if (env.method === 'patch' && env.path === `/v3/collections/${modelId}`) {
            patchAttempts += 1;
            return patchAttempts === 1
              ? jsonResponse(
                  { error: { code: 'RESOURCE_NOT_FOUND', message: 'Collection not found' } },
                  { status: 404 }
                )
              : jsonResponse({ data: { id: modelId } });
          }
          return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
        },
        { sleep }
      );

      await expect(client.updateCollectionDescription(collectionUid, description)).resolves.toBeUndefined();

      expect(patchAttempts).toBe(2);
      expect(sleep).toHaveBeenCalled();
      const patches = calls.filter(
        (call) => call.method === 'patch' && call.path === `/v3/collections/${modelId}`
      );
      expect(patches).toHaveLength(2);
      expect(patches[0]?.body).toEqual([{ op: 'add', path: '/description', value: description }]);
      expect(patches[1]?.body).toEqual([{ op: 'add', path: '/description', value: description }]);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
    });

    it('treats a no-op description REJECTED_PATCH as already applied without any root GET', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse(
            { error: { code: 'FORBIDDEN', message: `Access to ${modelId} denied` } },
            { status: 403 }
          );
        }
        if (env.method === 'patch' && env.path === `/v3/collections/${modelId}`) {
          return jsonResponse(
            {
              error: {
                name: 'REJECTED_PATCH',
                message: 'Patch must update at least one value'
              }
            },
            { status: 400 }
          );
        }
        return jsonResponse({ error: `unexpected ${env.method} ${env.path}` }, { status: 500 });
      });

      await expect(client.updateCollectionDescription(collectionUid, description)).resolves.toBeUndefined();

      expect(calls).toEqual([
        expect.objectContaining({
          service: 'collection',
          method: 'patch',
          path: `/v3/collections/${modelId}`,
          body: [{ op: 'add', path: '/description', value: description }]
        })
      ]);
      expect(calls.some((call) => call.service === 'collection' && call.method === 'get')).toBe(false);
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
  describe('transient root-PATCH retry (ESOCKETTIMEDOUT)', () => {
    const timeout500 = () => jsonResponse(
      { error: { name: 'serverError', message: 'Something went wrong with the server', details: 'ESOCKETTIMEDOUT', source: 'downstream' } },
      { status: 500 }
    );

    it('createCollection retries the collection-level settings PATCH after a downstream socket timeout', async () => {
      let patchAttempts = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root-uid' } });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/root-uid') {
          patchAttempts += 1;
          if (patchAttempts === 1) return timeout500();
          return jsonResponse({ data: { id: 'root-uid' } });
        }
        return jsonResponse({});
      });

      await client.createCollection('ws-1', {
        info: { name: 'Curated', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: []
      });

      expect(patchAttempts).toBe(2);
      expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0);
    });

    it('updateCollection retries the reconcile PATCH, and on a remove-already-applied 400 verifies the intended end state before reporting success', async () => {
      let patchAttempts = 0;
      let rootReads = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          rootReads += 1;
          // First read: reconcileRemovals pre-read (old state). Second read:
          // post-400 verification -- the timed-out PATCH actually committed.
          return jsonResponse({
            data: rootReads === 1
              ? { id: '55363555-cid-1', name: 'Old', description: 'old', auth: { type: 'bearer' } }
              : { id: '55363555-cid-1', name: 'New', description: '' }
          });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          patchAttempts += 1;
          if (patchAttempts === 1) return timeout500();
          return jsonResponse(
            { error: { name: 'invalidParamsError', message: 'Remove operation must point to an existing value' } },
            { status: 400 }
          );
        }
        return jsonResponse({});
      });

      await client.updateCollection('55363555-cid-1', {
        info: { name: 'New', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
        item: []
      });

      expect(patchAttempts).toBe(2);
      // Success required a verification read of the root, not just the 400.
      expect(rootReads).toBe(2);
      expect(calls.filter((c) => c.method === 'get' && c.path === '/v3/collections/cid-1')).toHaveLength(2);
    });

    it('updateCollection surfaces the failure when the remove-already-applied 400 masks a batch that never committed', async () => {
      let patchAttempts = 0;
      let rootReads = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          rootReads += 1;
          // Another actor removed /auth, but the rename in this batch never
          // landed: verification must fail and the error must surface.
          return jsonResponse({
            data: rootReads === 1
              ? { id: '55363555-cid-1', name: 'Old', description: 'old', auth: { type: 'bearer' } }
              : { id: '55363555-cid-1', name: 'Old', description: 'old' }
          });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          patchAttempts += 1;
          if (patchAttempts === 1) return timeout500();
          return jsonResponse(
            { error: { name: 'invalidParamsError', message: 'Remove operation must point to an existing value' } },
            { status: 400 }
          );
        }
        return jsonResponse({});
      });

      await expect(
        client.updateCollection('55363555-cid-1', {
          info: { name: 'New', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
          item: []
        })
      ).rejects.toThrow(/400/);

      expect(patchAttempts).toBe(2);
      expect(rootReads).toBe(2);
    });

    it('updateCollection surfaces failure when a stale non-null value is present but not equal to the requested add/replace (no false-verify)', async () => {
      let patchAttempts = 0;
      let rootReads = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/v3/collections/55363555-cid-1/items/') {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'get' && env.path === '/v3/collections/cid-1') {
          rootReads += 1;
          // Pre-read has old variables. Post-400 verify read returns the SAME
          // stale variables plus a removed auth — /variables was requested as an
          // add of the NEW value but the committed value is stale, so a
          // presence-only check would falsely pass. Structural equality must
          // reject and surface the error.
          return jsonResponse({
            data: rootReads === 1
              ? { id: '55363555-cid-1', name: 'Old', description: 'old', auth: { type: 'bearer' }, variables: [{ key: 'stale', value: '1' }] }
              : { id: '55363555-cid-1', name: 'New', description: '', variables: [{ key: 'stale', value: '1' }] }
          });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/cid-1') {
          patchAttempts += 1;
          if (patchAttempts === 1) return timeout500();
          return jsonResponse(
            { error: { name: 'invalidParamsError', message: 'Remove operation must point to an existing value' } },
            { status: 400 }
          );
        }
        return jsonResponse({});
      });

      await expect(
        client.updateCollection('55363555-cid-1', {
          info: { name: 'New', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
          variable: [{ key: 'fresh', value: '2' }],
          item: []
        })
      ).rejects.toThrow(/400/);
      expect(patchAttempts).toBe(2);
      expect(rootReads).toBe(2);
    });

    it('updateSpec retries the spec-file content PATCH after a downstream socket timeout', async () => {
      let patchAttempts = 0;
      const { client } = makeClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
          return jsonResponse({ data: [{ id: 'file-1', type: 'ROOT' }] });
        }
        if (env.method === 'patch' && env.path === '/specifications/spec-1/files/file-1') {
          patchAttempts += 1;
          if (patchAttempts === 1) return timeout500();
          return jsonResponse({ data: { id: 'file-1' } });
        }
        return jsonResponse({});
      });

      await client.updateSpec('spec-1', 'openapi: 3.0.3');

      expect(patchAttempts).toBe(2);
    });
  });

  describe('collection ROOT bare-model-id parsing (strict UID)', () => {
    it('strips the owner prefix from a full <owner>-<uuid> public uid', async () => {
      const { client, calls } = makeClient(() => jsonResponse({ data: {} }));
      await client.deleteCollection('55363555-11111111-2222-3333-4444-555555555555');
      const del = calls.find((c) => c.method === 'delete');
      expect(del?.path).toBe('/v3/collections/11111111-2222-3333-4444-555555555555');
    });

    it('passes a bare UUID through unchanged (does not lop off its first segment)', async () => {
      const { client, calls } = makeClient(() => jsonResponse({ data: {} }));
      await client.deleteCollection('11111111-2222-3333-4444-555555555555');
      const del = calls.find((c) => c.method === 'delete');
      // A naive split on the first hyphen would corrupt this to
      // '2222-3333-4444-555555555555'; the strict guard preserves it.
      expect(del?.path).toBe('/v3/collections/11111111-2222-3333-4444-555555555555');
    });
  });

  describe('multi-file Spec Hub bundle sync (R6)', () => {
    const rootContent = 'openapi: 3.0.3\ninfo:\n  title: t\n  version: 1.0.0\n';
    const petV1 = 'type: object\nexample: bundle-v1\n';
    const petV2 = 'type: object\nexample: bundle-v2\n';
    const errorYaml = 'type: object\nproperties:\n  code:\n    type: string\n';

    function defFile(path: string, role: 'root' | 'dependency', content: string) {
      return createDefinitionFile({
        path,
        role,
        bytes: new TextEncoder().encode(content)
      });
    }

    function openApiBundle(files: ReturnType<typeof defFile>[]) {
      const root = files.find((entry) => entry.role === 'root');
      if (!root) throw new Error('missing root');
      return createDefinitionBundle({
        rootPath: root.path,
        format: 'openapi-yaml',
        completeness: 'full',
        provenance: { source: 'spec-path', evidence: ['test'] },
        files
      });
    }

    function timeout500(): Response {
      return jsonResponse(
        { error: { name: 'ESOCKETTIMEDOUT', message: 'socket hang up' } },
        { status: 500, statusText: 'Internal Server Error' }
      );
    }

    function cloudState(
      files: Array<{
        id: string;
        path: string;
        type: 'ROOT' | 'DEFAULT';
        content: string;
        parentId?: string;
      }>
    ) {
      const byId = new Map(files.map((file) => [file.id, file]));
      return (env: Envelope): Response => {
        if (env.method === 'get' && env.path.endsWith('/files') && !env.path.includes('/files/')) {
          return jsonResponse({
            data: files.map(({ id, path, type, parentId }) => ({
              id,
              path,
              type,
              ...(parentId ? { parentId } : {})
            }))
          });
        }
        const fileMatch = env.path.match(/\/files\/([^/?]+)/);
        if (env.method === 'get' && fileMatch) {
          const file = byId.get(fileMatch[1]!);
          if (!file) return jsonResponse({ error: 'not found' }, { status: 404 });
          return jsonResponse({ data: { id: file.id, content: file.content } });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'get' && /^\/specifications\/[^/]+$/.test(env.path)) {
          return jsonResponse({ data: { id: 'spec-1' } });
        }
        return jsonResponse({});
      };
    }

    function filesListCalls(calls: RecordedCall[]): RecordedCall[] {
      return calls.filter(
        (call) =>
          call.method === 'get' &&
          call.path.endsWith('/files') &&
          !/\/files\/[^/?]+/.test(call.path)
      );
    }

    it('uploadSpecBundle posts the exact multi-file create shape and verifies digest', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      let created = false;
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const base = cloudState(files);
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          created = true;
          return jsonResponse({ data: { id: 'spec-1' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: created ? [{ id: 'spec-1', name: 'Payments' }] : [] });
        }
        return base(env);
      });

      const result = await client.uploadSpecBundle('ws-1', 'Payments', target, '3.0');
      expect(result.specId).toBe('spec-1');
      expect(result.created).toBe(true);
      expect(result.outcome.status).toBe('ok');

      const create = calls.find(
        (call) => call.method === 'post' && call.path.startsWith('/specifications?')
      );
      expect(create?.body).toEqual({
        name: 'Payments',
        type: 'OPENAPI:3.0',
        files: [
          { path: 'components/pet.yaml', content: petV1, type: 'DEFAULT' },
          { path: 'openapi.yaml', content: rootContent, type: 'ROOT' }
        ]
      });
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
    });

    it('uploadSpecBundle waits for a delayed peer before electing; loser is not returned and created reflects election', async () => {
      // Models the live nonorg dual-preview race: after create, the first settle
      // read still shows only our singleton; a peer same-name spec becomes
      // list-visible later. Stable lowest ID must win; created is true only when
      // the elected winner is the spec this runner POSTed.
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const peerFiles = [
        { id: 'root-a', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-a', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const ourFiles = [
        { id: 'root-b', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-b', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      let listCalls = 0;
      let deletedB = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          return jsonResponse({ data: { id: 'spec-b' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          listCalls += 1;
          // 1: pre-create empty
          if (listCalls === 1) return jsonResponse({ data: [] });
          // 2-3: post-create + first settle still singleton (current bug acceptance window)
          if (listCalls <= 3) {
            return jsonResponse({ data: [{ id: 'spec-b', name: 'Payments' }] });
          }
          // 4+: peer becomes visible; after election deletes, only winner remains
          if (deletedB > 0) {
            return jsonResponse({ data: [{ id: 'spec-a', name: 'Payments' }] });
          }
          return jsonResponse({
            data: [
              { id: 'spec-a', name: 'Payments' },
              { id: 'spec-b', name: 'Payments' }
            ]
          });
        }
        if (env.method === 'delete' && env.path === '/specifications/spec-b') {
          deletedB += 1;
          // Peer may already have deleted the loser — second delete is 404.
          if (deletedB > 1) {
            return jsonResponse({ error: { name: 'notFound', message: 'gone' } }, { status: 404 });
          }
          return jsonResponse({ data: { id: 'spec-b' } });
        }
        if (env.method === 'delete' && env.path === '/specifications/spec-a') {
          throw new Error('elected peer must not be whole-deleted');
        }
        if (env.path.includes('/specifications/spec-a/')) {
          return cloudState(peerFiles)(env);
        }
        if (env.path.includes('/specifications/spec-b/')) {
          return cloudState(ourFiles)(env);
        }
        if (env.method === 'get' && env.path === '/specifications/spec-a') {
          return jsonResponse({ data: { id: 'spec-a' } });
        }
        return jsonResponse({ data: {} });
      });

      const result = await client.uploadSpecBundle('ws-1', 'Payments', target, '3.0');
      expect(result.specId).toBe('spec-a');
      expect(result.created).toBe(false);
      expect(result.outcome.status).toBe('ok');
      expect(listCalls).toBeGreaterThan(3);
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'delete', path: '/specifications/spec-b' })
      );
      expect(calls.some((call) => call.method === 'delete' && call.path === '/specifications/spec-a')).toBe(
        false
      );
    });

    it('uploadSpecBundle relinquishes rollback ownership when its elected winner is shared', async () => {
      // Winner-owner race: this runner created the lowest-ID winner. A peer loser
      // becomes list-visible, but this runner must never DELETE the peer ID —
      // peer self-cleanup is observed on bounded subsequent list polls.
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const winnerFiles = [
        { id: 'root-a', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-a', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      let listCalls = 0;
      let dualListCount = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          return jsonResponse({ data: { id: 'spec-a' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          listCalls += 1;
          if (listCalls === 1) return jsonResponse({ data: [] });
          if (listCalls <= 3) {
            return jsonResponse({ data: [{ id: 'spec-a', name: 'Payments' }] });
          }
          dualListCount += 1;
          // Quiet dual set (two polls), then peer self-cleans on later converge polls.
          if (dualListCount > 3) {
            return jsonResponse({ data: [{ id: 'spec-a', name: 'Payments' }] });
          }
          return jsonResponse({
            data: [
              { id: 'spec-a', name: 'Payments' },
              { id: 'spec-b', name: 'Payments' }
            ]
          });
        }
        if (env.method === 'delete' && env.path === '/specifications/spec-b') {
          throw new Error('peer-created loser must not be deleted by winner owner');
        }
        if (env.path.includes('/specifications/spec-a/')) {
          return cloudState(winnerFiles)(env);
        }
        if (env.method === 'get' && env.path === '/specifications/spec-a') {
          return jsonResponse({ data: { id: 'spec-a' } });
        }
        return jsonResponse({ data: {} });
      });

      const result = await client.uploadSpecBundle('ws-1', 'Payments', target, '3.0');
      expect(result.specId).toBe('spec-a');
      expect(result.created).toBe(false);
      expect(result.outcome.status).toBe('ok');
      expect(listCalls).toBeGreaterThan(3);
      expect(calls.some((call) => call.method === 'delete' && call.path === '/specifications/spec-b')).toBe(
        false
      );
      expect(calls.some((call) => call.method === 'delete' && call.path === '/specifications/spec-a')).toBe(
        false
      );
    });

    it('deleteSpec treats 404 as successful idempotent deletion', async () => {
      const { client } = makeClient((env) => {
        if (env.method === 'delete' && env.path === '/specifications/spec-gone') {
          return jsonResponse({ error: { name: 'notFound' } }, { status: 404 });
        }
        return jsonResponse({ data: {} });
      });
      await expect(client.deleteSpec('spec-gone')).resolves.toBeUndefined();
    });

    it('reconcileSpecBundle is a no-op when the full-set digest matches', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const { client, calls } = makeClient(
        cloudState([
          { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', content: rootContent },
          { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT', content: petV1 }
        ])
      );

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome).toMatchObject({ status: 'ok', changed: false, verifiedDigest: target.digest });
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
      expect(calls.some((call) => call.method === 'patch')).toBe(false);
      expect(calls.some((call) => call.method === 'delete')).toBe(false);
    });

    it('reconciles companion-only update via atomic bulk-files', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV2)
      ]);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const base = cloudState(files);
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          files[1]!.content = petV2;
          return jsonResponse({ data: { update: [{ id: 'pet-id' }] } }, { status: 201 });
        }
        return base(env);
      });

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome.status).toBe('ok');
      expect(outcome.changed).toBe(true);
      if (outcome.status === 'ok') expect(outcome.verifiedDigest).toBe(target.digest);
      expect(outcome.priorSnapshot.digest).not.toBe(target.digest);

      const bulk = calls.find((call) => call.path === '/specifications/spec-1/bulk-files');
      expect(bulk?.body).toEqual({
        update: [{ id: 'pet-id', content: petV2 }]
      });
    });

    it('reconciles add and delete via atomic bulk-files', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/error.yaml', 'dependency', errorYaml)
      ]);
      let files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          files = [
            { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', content: rootContent },
            { id: 'error-id', path: 'components/error.yaml', type: 'DEFAULT', content: errorYaml }
          ];
          return jsonResponse({ data: { create: [{ id: 'error-id' }] } }, { status: 201 });
        }
        return cloudState(files)(env);
      });

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome.status).toBe('ok');
      expect(outcome.changed).toBe(true);

      const bulk = calls.find((call) => call.path === '/specifications/spec-1/bulk-files');
      expect(bulk?.body).toEqual({
        create: [{ path: 'components/error.yaml', content: errorYaml, type: 'DEFAULT' }],
        delete: [{ id: 'pet-id' }]
      });
    });

    it('atomic bulk failure readback does not claim success when digest unchanged', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV2)
      ]);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          return jsonResponse(
            { error: { name: 'badRequest', status: 400, title: 'invalid delete' } },
            { status: 400 }
          );
        }
        return cloudState(files)(env);
      });

      await expect(client.reconcileSpecBundle('spec-1', target)).rejects.toThrow(/400/);
      expect(calls.filter((call) => call.path.endsWith('/files')).length).toBeGreaterThan(1);
      expect(calls.filter((call) => call.path.includes('/bulk-files')).length).toBe(1);
    });

    it('ambiguous bulk timeout returns verification-needed after readback (no blind retry)', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV2)
      ]);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          return timeout500();
        }
        return cloudState(files)(env);
      });

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome.status).toBe('verification-needed');
      if (outcome.status === 'verification-needed') {
        expect(outcome.targetDigest).toBe(target.digest);
        expect(outcome.reason).toBe('ambiguous-bulk-modify');
      }
      expect(calls.filter((call) => call.path.includes('/bulk-files')).length).toBe(1);
    });

    it('root path change throws CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED without mutation', async () => {
      const target = openApiBundle([
        defFile('index.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const { client, calls } = makeClient(
        cloudState([
          { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', content: rootContent },
          { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT', content: petV1 }
        ])
      );

      await expect(client.reconcileSpecBundle('spec-1', target)).rejects.toThrow(
        /CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED/
      );
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
      expect(calls.some((call) => call.method === 'patch' || call.method === 'delete')).toBe(false);
    });

    it('restoreSpecBundle reconciles the prior snapshot and verifies digest', async () => {
      const prior = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const snapshot = definitionBundleToSnapshot(prior);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV2 }
      ];
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          files[1]!.content = petV1;
          return jsonResponse({ data: {} }, { status: 201 });
        }
        return cloudState(files)(env);
      });

      const outcome = await client.restoreSpecBundle('spec-1', snapshot);
      expect(outcome.status).toBe('ok');
      expect(outcome.changed).toBe(true);
      if (outcome.status === 'ok') expect(outcome.verifiedDigest).toBe(prior.digest);
    });

    it('rejects duplicate cloud paths on readback', async () => {
      const { client } = makeClient(() =>
        jsonResponse({
          data: [
            { id: 'a', path: 'openapi.yaml', type: 'ROOT' },
            { id: 'b', path: 'OpenAPI.yaml', type: 'DEFAULT' }
          ]
        })
      );
      await expect(client.getSpecBundle('spec-1', 'openapi-yaml')).rejects.toThrow(
        /CONTRACT_DEFINITION_DUPLICATE_PATH/
      );
    });

    it('keeps uploadSpec/updateSpec/getSpecContent as one-file wrappers', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          return jsonResponse({ data: { id: 'spec-1' } });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
          return jsonResponse({ data: [{ id: 'file-1', type: 'ROOT', path: 'index.yaml' }] });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-1/files/file-1') {
          return jsonResponse({ data: { id: 'file-1', content: 'openapi: 3.0.3' } });
        }
        if (env.method === 'patch') return jsonResponse({ data: { id: 'file-1' } });
        return jsonResponse({ data: { id: 'spec-1' } });
      });

      await client.uploadSpec('ws-9', 'Legacy', 'openapi: 3.0.3', '3.0');
      await client.updateSpec('spec-1', 'openapi: 3.0.3\n');
      await client.getSpecContent('spec-1');

      const create = calls.find(
        (call) => call.method === 'post' && call.path.startsWith('/specifications?')
      );
      expect(create?.body).toMatchObject({
        files: [{ path: 'index.yaml', type: 'ROOT', content: 'openapi: 3.0.3' }]
      });
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
      const patch = calls.find((call) => call.method === 'patch');
      expect(patch?.path).toBe('/specifications/spec-1/files/file-1');
      expect(patch?.body).toEqual([{ op: 'replace', path: '/content', value: 'openapi: 3.0.3\n' }]);
    });

    it('bulkModify=false applies sorted non-root upserts, root last, then sorted deletes', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', `${rootContent}#v2\n`),
        defFile('components/error.yaml', 'dependency', errorYaml),
        defFile('components/zoo.yaml', 'dependency', 'type: string\n')
      ]);
      let files: Array<{
        id: string;
        path: string;
        type: 'ROOT' | 'DEFAULT';
        content: string;
        parentId?: string;
      }> = [
        {
          id: 'root-id',
          path: 'openapi.yaml',
          type: 'ROOT',
          content: rootContent,
          parentId: 'folder-root'
        },
        {
          id: 'pet-id',
          path: 'components/pet.yaml',
          type: 'DEFAULT',
          content: petV1,
          parentId: 'folder-components'
        },
        {
          id: 'zoo-id',
          path: 'components/zoo.yaml',
          type: 'DEFAULT',
          content: 'type: number\n',
          parentId: 'folder-components'
        }
      ];
      const mutationOrder: string[] = [];
      const { client, calls } = makeClient(
        (env) => {
          if (env.method === 'post' && env.path === '/specifications/spec-1/files') {
            const body = env.body as { name: string; content: string; parentId?: string };
            mutationOrder.push(`create:${body.name}`);
            files = [
              ...files.filter((file) => file.path !== `components/${body.name}`),
              {
                id: 'error-id',
                path: 'components/error.yaml',
                type: 'DEFAULT',
                content: body.content,
                ...(body.parentId ? { parentId: body.parentId } : {})
              }
            ];
            return jsonResponse({ data: { id: 'error-id' } }, { status: 201 });
          }
          if (env.method === 'patch' && env.path.includes('/files/')) {
            const id = env.path.split('/').pop()!;
            mutationOrder.push(`update:${id}`);
            const patch = env.body as Array<{ value: string }>;
            files = files.map((file) =>
              file.id === id ? { ...file, content: patch[0]!.value } : file
            );
            return jsonResponse({ data: { id } });
          }
          if (env.method === 'delete' && env.path.includes('/files/')) {
            const id = env.path.split('/').pop()!;
            mutationOrder.push(`delete:${id}`);
            files = files.filter((file) => file.id !== id);
            return jsonResponse({ data: {} });
          }
          return cloudState(files)(env);
        },
        {
          reconcileCapabilityPolicy: {
            bulkModify: false,
            atomicBulk: false,
            rootPathChange: false
          }
        }
      );

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome.status).toBe('ok');
      expect(outcome.changed).toBe(true);
      expect(mutationOrder).toEqual([
        'create:error.yaml',
        'update:zoo-id',
        'update:root-id',
        'delete:pet-id'
      ]);
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
      const createBody = calls.find(
        (call) => call.method === 'post' && call.path === '/specifications/spec-1/files'
      )?.body;
      expect(createBody).toEqual({
        name: 'error.yaml',
        content: errorYaml,
        type: 'DEFAULT',
        parentId: 'folder-components'
      });
      expect(filesListCalls(calls)).toHaveLength(2);
    });

    it('atomicBulk=false returns verification-needed with prior snapshot after bulk failure', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV2)
      ]);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client, calls } = makeClient(
        (env) => {
          if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
            return jsonResponse(
              { error: { name: 'badRequest', status: 400, title: 'invalid delete' } },
              { status: 400 }
            );
          }
          return cloudState(files)(env);
        },
        {
          reconcileCapabilityPolicy: {
            bulkModify: true,
            atomicBulk: false,
            rootPathChange: false
          }
        }
      );

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome.status).toBe('verification-needed');
      if (outcome.status === 'verification-needed') {
        expect(outcome.reason).toBe('non-atomic-bulk-modify');
        expect(outcome.targetDigest).toBe(target.digest);
        expect(outcome.priorSnapshot.files.map((file) => file.path).sort()).toEqual([
          'components/pet.yaml',
          'openapi.yaml'
        ]);
        expect(outcome.priorSnapshot.digest).not.toBe(target.digest);
      }
      expect(calls.filter((call) => call.path.includes('/bulk-files'))).toHaveLength(1);
    });

    it('rootPathChange=false rejects root path change with zero mutations', async () => {
      const target = openApiBundle([
        defFile('index.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const { client, calls } = makeClient(
        cloudState([
          { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', content: rootContent },
          { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT', content: petV1 }
        ]),
        {
          reconcileCapabilityPolicy: {
            bulkModify: true,
            atomicBulk: true,
            rootPathChange: false
          }
        }
      );

      await expect(client.reconcileSpecBundle('spec-1', target)).rejects.toThrow(
        /CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED/
      );
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
      expect(calls.some((call) => call.method === 'patch' || call.method === 'delete')).toBe(false);
      expect(filesListCalls(calls)).toHaveLength(1);
    });

    it('post-create list throw whole-deletes the new spec and preserves the original failure', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      let listCalls = 0;
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          return jsonResponse({ data: { id: 'spec-new' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          listCalls += 1;
          if (listCalls === 1) return jsonResponse({ data: [] });
          return jsonResponse(
            { error: { name: 'serverError', message: 'list exploded' } },
            { status: 500 }
          );
        }
        if (env.method === 'delete' && env.path === '/specifications/spec-new') {
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      await expect(client.uploadSpecBundle('ws-1', 'Payments', target, '3.0')).rejects.toThrow(
        /500|list exploded|Internal Server Error/
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          method: 'delete',
          path: '/specifications/spec-new'
        })
      );
    });

    it('post-create detail GET throw whole-deletes the new spec', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      let created = false;
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          created = true;
          return jsonResponse({ data: { id: 'spec-new' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: created ? [{ id: 'spec-new', name: 'Payments' }] : [] });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-new') {
          return jsonResponse(
            { error: { name: 'serverError', message: 'detail failed' } },
            { status: 500 }
          );
        }
        if (env.method === 'delete' && env.path === '/specifications/spec-new') {
          return jsonResponse({ data: {} });
        }
        return cloudState(files)(env);
      });

      await expect(client.uploadSpecBundle('ws-1', 'Payments', target, '3.0')).rejects.toThrow(/500/);
      expect(calls).toContainEqual(
        expect.objectContaining({ method: 'delete', path: '/specifications/spec-new' })
      );
    });

    it('post-create readback throw whole-deletes; cleanup failure does not claim success', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      let created = false;
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          created = true;
          return jsonResponse({ data: { id: 'spec-new' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: created ? [{ id: 'spec-new', name: 'Payments' }] : [] });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-new/files') {
          return jsonResponse(
            { error: { name: 'serverError', message: 'files list failed' } },
            { status: 500 }
          );
        }
        if (env.method === 'delete' && env.path === '/specifications/spec-new') {
          return jsonResponse(
            { error: { name: 'serverError', message: 'delete failed' } },
            { status: 500 }
          );
        }
        return jsonResponse({ data: {} });
      });

      await expect(client.uploadSpecBundle('ws-1', 'Payments', target, '3.0')).rejects.toThrow(
        /whole-delete cleanup also failed/
      );
    });

    it('adopted existing specs are never whole-deleted on reconcile failure', async () => {
      const target = openApiBundle([
        defFile('index.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const { client, calls } = makeClient((env) => {
        if (env.method === 'get' && env.path.includes('/specifications?')) {
          return jsonResponse({ data: [{ id: 'spec-adopted', name: 'Payments' }] });
        }
        if (env.path.includes('/specifications/spec-adopted/files')) {
          return cloudState([
            { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', content: rootContent },
            { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT', content: petV1 }
          ])(env);
        }
        return jsonResponse({ data: {} });
      });

      await expect(client.uploadSpecBundle('ws-1', 'Payments', target, '3.0')).rejects.toThrow(
        /CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED/
      );
      expect(calls.some((call) => call.method === 'delete')).toBe(false);
    });

    it('changed reconcile issues exactly one initial files list plus one verification list', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV2)
      ]);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client, calls } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          files[1]!.content = petV2;
          return jsonResponse({ data: {} }, { status: 201 });
        }
        return cloudState(files)(env);
      });

      await client.reconcileSpecBundle('spec-1', target);
      expect(filesListCalls(calls)).toHaveLength(2);
    });

    it('no-op digest match issues exactly one files list and zero mutations', async () => {
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const { client, calls } = makeClient(
        cloudState([
          { id: 'root-id', path: 'openapi.yaml', type: 'ROOT', content: rootContent },
          { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT', content: petV1 }
        ])
      );

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome).toMatchObject({ status: 'ok', changed: false, verifiedDigest: target.digest });
      expect(filesListCalls(calls)).toHaveLength(1);
      expect(calls.some((call) => call.path.includes('/bulk-files'))).toBe(false);
      expect(calls.some((call) => call.method === 'post')).toBe(false);
      expect(calls.some((call) => call.method === 'patch')).toBe(false);
      expect(calls.some((call) => call.method === 'delete')).toBe(false);
    });

    it('priorSnapshot is an exact rollback snapshot of the pre-mutation full set', async () => {
      const prior = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV1)
      ]);
      const target = openApiBundle([
        defFile('openapi.yaml', 'root', rootContent),
        defFile('components/pet.yaml', 'dependency', petV2)
      ]);
      const files = [
        { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' as const, content: rootContent },
        { id: 'pet-id', path: 'components/pet.yaml', type: 'DEFAULT' as const, content: petV1 }
      ];
      const { client } = makeClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/bulk-files') {
          files[1]!.content = petV2;
          return jsonResponse({ data: {} }, { status: 201 });
        }
        return cloudState(files)(env);
      });

      const outcome = await client.reconcileSpecBundle('spec-1', target);
      expect(outcome.priorSnapshot).toEqual(definitionBundleToSnapshot(prior));
      expect(outcome.priorSnapshot.digest).toBe(prior.digest);
      expect(outcome.priorSnapshot.files).toEqual([
        expect.objectContaining({ path: 'components/pet.yaml', content: petV1 }),
        expect.objectContaining({ path: 'openapi.yaml', content: rootContent })
      ]);
    });
  });

  describe('spec-tree fast path (loadSpecBundleState)', () => {
    const rootContent = 'openapi: 3.0.3\ninfo:\n  title: t\n  version: 1.0.0\n';
    const petContent = 'type: object\nexample: tree-fast-path\n';

    function treePageResponse(page: { data: unknown[]; meta?: { cursor?: { next?: string } } }): Response {
      return jsonResponse(page);
    }

    function legacyFilesResponse(files: Array<{ id: string; path: string; type: string }>): Response {
      return jsonResponse({ data: files });
    }

    function legacyFileContentResponse(id: string, content: string): Response {
      return jsonResponse({ data: { id, content } });
    }

    it('uses the paginated tree endpoint and preserves root/default members with parentId', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          return treePageResponse({
            data: [
              { type: 'FOLDER', id: 'folder-1', path: 'components' },
              { type: 'FILE', id: 'root-id', path: 'openapi.yaml', fileType: 'ROOT', content: rootContent },
              { type: 'FILE', id: 'pet-id', path: 'components/pet.yaml', parentId: 'folder-1', fileType: 'YAML', content: petContent }
            ],
            meta: { cursor: {} }
          });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      const bundle = await client.getSpecBundle('spec-1', 'openapi-yaml');
      expect(bundle.files.size).toBe(2);
      const root = Array.from(bundle.files.values()).find((f) => f.path === 'openapi.yaml');
      const dep = Array.from(bundle.files.values()).find((f) => f.path === 'components/pet.yaml');
      expect(root?.role).toBe('root');
      expect(root?.content).toBe(rootContent);
      expect(dep?.role).toBe('dependency');
      expect(dep?.content).toBe(petContent);

      // Tree endpoint was hit with the expected fields/cursor query shape.
      const treeCall = calls.find((c) => c.path === '/specifications/spec-1/tree');
      expect(treeCall).toBeDefined();
      expect(treeCall?.query).toMatchObject({
        fields: 'id,name,type,path,parentId,fileType,content',
        limit: 100
      });
      // Legacy per-file content reads did NOT happen.
      expect(calls.some((c) => /\/files\/[^/?]+/.test(c.path))).toBe(false);
    });

    it('follows cursor pagination across multiple tree pages', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          const cursor = String(env.query?.cursor ?? '');
          if (!cursor) {
            return treePageResponse({
              data: [{ type: 'FILE', id: 'root-id', path: 'openapi.yaml', fileType: 'ROOT', content: rootContent }],
              meta: { cursor: { next: 'page-2' } }
            });
          }
          if (cursor === 'page-2') {
            return treePageResponse({
              data: [{ type: 'FILE', id: 'pet-id', path: 'components/pet.yaml', fileType: 'YAML', content: petContent }],
              meta: { cursor: {} }
            });
          }
          return jsonResponse({ error: 'unexpected cursor' }, { status: 500 });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      const bundle = await client.getSpecBundle('spec-1', 'openapi-yaml');
      expect(bundle.files.size).toBe(2);
      expect(Array.from(bundle.files.values()).map((f) => f.path).sort()).toEqual(['components/pet.yaml', 'openapi.yaml']);

      const treeCalls = calls.filter((c) => c.path === '/specifications/spec-1/tree');
      expect(treeCalls).toHaveLength(2);
      // First call has no cursor (spread omits it when empty); second carries the page-2 cursor.
      expect(treeCalls[0].query).not.toHaveProperty('cursor');
      expect(treeCalls[1].query).toMatchObject({ cursor: 'page-2' });
    });

    it('falls back to the legacy files-list-plus-content path when the tree 404s', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          return jsonResponse({ error: 'tree not found' }, { status: 404 });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
          return legacyFilesResponse([
            { id: 'root-id', path: 'openapi.yaml', type: 'ROOT' }
          ]);
        }
        if (env.path === '/specifications/spec-1/files/root-id') {
          return legacyFileContentResponse('root-id', rootContent);
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      const bundle = await client.getSpecBundle('spec-1', 'openapi-yaml');
      expect(bundle.files.size).toBe(1);
      expect(bundle.files.get(bundle.rootPath)!.path).toBe('openapi.yaml');
      expect(bundle.files.get(bundle.rootPath)!.content).toBe(rootContent);

      // Legacy path was exercised.
      expect(calls.some((c) => c.path === '/specifications/spec-1/files')).toBe(true);
      expect(calls.some((c) => c.path === '/specifications/spec-1/files/root-id')).toBe(true);
    });

    it('falls back to the legacy path when the tree response is structurally incomplete', async () => {
      const { client, calls } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          // Missing `data` array -> SPEC_TREE_INCOMPLETE -> fallback.
          return jsonResponse({ meta: {} });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
          return legacyFilesResponse([{ id: 'root-id', path: 'openapi.yaml', type: 'ROOT' }]);
        }
        if (env.path === '/specifications/spec-1/files/root-id') {
          return legacyFileContentResponse('root-id', rootContent);
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      const bundle = await client.getSpecBundle('spec-1', 'openapi-yaml');
      expect(bundle.files.get(bundle.rootPath)!.content).toBe(rootContent);
      expect(calls.some((c) => c.path === '/specifications/spec-1/files')).toBe(true);
    });

    it('throws instead of falling back when a tree cursor repeats (loop protection)', async () => {
      const { client } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          return treePageResponse({
            data: [{ type: 'FILE', id: 'root-id', path: 'openapi.yaml', fileType: 'ROOT', content: rootContent }],
            meta: { cursor: { next: 'stuck' } }
          });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      await expect(client.getSpecBundle('spec-1', 'openapi-yaml')).rejects.toThrow(/SPEC_TREE_CURSOR_REPEATED/);
    });

    it('throws instead of falling back when the tree exceeds the page limit', async () => {
      let pages = 0;
      const { client } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          pages += 1;
          return treePageResponse({
            data: [{ type: 'FILE', id: `f-${pages}`, path: `a/${pages}.yaml`, fileType: 'YAML', content: 'x' }],
            meta: { cursor: { next: `c-${pages}` } }
          });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      await expect(client.getSpecBundle('spec-1', 'openapi-yaml')).rejects.toThrow(/SPEC_TREE_PAGE_LIMIT_EXCEEDED/);
      // The loop checks page >= 100 before issuing the 101st request, so exactly
      // 100 tree pages are served before the limit fires.
      expect(pages).toBe(100);
    });

    it('throws on an unsafe tree path instead of falling back', async () => {
      const { client } = makeClient((env) => {
        if (env.path === '/specifications/spec-1/tree') {
          return treePageResponse({
            data: [{ type: 'FILE', id: 'root-id', path: '../../escape.yaml', fileType: 'ROOT', content: rootContent }],
            meta: { cursor: {} }
          });
        }
        return jsonResponse({ error: 'unexpected' }, { status: 500 });
      });

      await expect(client.getSpecBundle('spec-1', 'openapi-yaml')).rejects.toThrow(/ESCAPE/);
    });

    it('skips the tree fast path entirely when POSTMAN_SPEC_TREE_FAST_PATH=off', async () => {
      vi.stubEnv('POSTMAN_SPEC_TREE_FAST_PATH', 'off');
      try {
        const { client, calls } = makeClient((env) => {
          if (env.path === '/specifications/spec-1/tree') {
            return jsonResponse({ error: 'tree should not be called' }, { status: 500 });
          }
          if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
            return legacyFilesResponse([{ id: 'root-id', path: 'openapi.yaml', type: 'ROOT' }]);
          }
          if (env.path === '/specifications/spec-1/files/root-id') {
            return legacyFileContentResponse('root-id', rootContent);
          }
          return jsonResponse({ error: 'unexpected' }, { status: 500 });
        });

        const bundle = await client.getSpecBundle('spec-1', 'openapi-yaml');
        expect(bundle.files.get(bundle.rootPath)!.content).toBe(rootContent);
        expect(calls.some((c) => c.path === '/specifications/spec-1/tree')).toBe(false);
        expect(calls.some((c) => c.path === '/specifications/spec-1/files')).toBe(true);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe('generation poll deadline, backoff, and fixed rollback', () => {
    function makeGenerationClient(opts: {
      taskId: string;
      statusByPoll: Record<number, string>;
      clientOptions?: { generationPollAttempts?: number; generationPollDelayMs?: number };
    }) {
      const { taskId, statusByPoll, clientOptions } = opts;
      let taskPollIndex = 0;
      let submittedName = '';
      let taskCompleted = false;
      const { client, calls } = makeClient(
        (env) => {
          if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
            submittedName = String((env.body as { name?: unknown })?.name ?? '');
            return jsonResponse({ data: { taskId } }, { status: 202 });
          }
          if (env.path === '/tasks') {
            const status = statusByPoll[taskPollIndex] ?? 'in-progress';
            taskPollIndex += 1;
            if (status === 'completed') taskCompleted = true;
            return jsonResponse({ data: { [taskId]: status } });
          }
          if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
            // After the task completes, the generated collection relation appears.
            if (taskCompleted) {
              return jsonResponse({ data: [{ collection: 'uid-gen', name: submittedName }] });
            }
            return jsonResponse({ data: [] });
          }
          if (env.method === 'patch' && env.path.startsWith('/v3/collections/')) {
            return jsonResponse({ data: { id: 'uid-gen' } });
          }
          return jsonResponse({ data: [] });
        },
        { createIdentity: () => 'test-run', ...clientOptions }
      );
      return { client, calls, getSubmittedName: () => submittedName };
    }

    it('uses exponential delays by default (no real waits with injected sleep)', async () => {
      const delays: number[] = [];
      const { client } = makeGenerationClient({
        taskId: 't-exp',
        statusByPoll: { 0: 'in-progress', 1: 'in-progress', 2: 'completed' },
        clientOptions: { generationPollAttempts: 5, generationPollDelayMs: 1000 }
      });
      (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
        delays.push(ms);
      };
      const now = 0;
      (client as unknown as { now: () => number }).now = () => now;

      await client.generateCollection('spec-1', 'P', '', 'Tags', false, 'Fallback');

      // The task-poll loop sleeps BEFORE each task request, including the one
      // that returns 'completed'. The separate post-completion relation settle
      // remains a fixed 1s cadence and must not be counted as task polling.
      expect(delays.slice(0, 3)).toEqual([2000, 4000, 8000]);
      expect(delays.slice(3)).toEqual([1000]);
    });

    it('rolls back to fixed delays when POSTMAN_GENERATION_POLL_MODE=fixed', async () => {
      vi.stubEnv('POSTMAN_GENERATION_POLL_MODE', 'fixed');
      try {
        const delays: number[] = [];
        const { client } = makeGenerationClient({
          taskId: 't-fixed',
          statusByPoll: { 0: 'in-progress', 1: 'completed' },
          clientOptions: { generationPollAttempts: 5, generationPollDelayMs: 500 }
        });
        (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => { delays.push(ms); };
        const now = 0;
        (client as unknown as { now: () => number }).now = () => now;

        await client.generateCollection('spec-1', 'P', '', 'Tags', false, 'Fallback');

        // Fixed mode uses the configured generationPollDelayMs (500) for each
        // task poll; relation settling remains independently fixed at 1s.
        expect(delays.slice(0, 2)).toEqual([500, 500]);
        expect(delays.slice(2)).toEqual([1000]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('throws COLLECTION_GENERATION_TIMEOUT when the 180s deadline elapses', async () => {
      const { client } = makeGenerationClient({
        taskId: 't-deadline',
        statusByPoll: { 0: 'in-progress', 1: 'in-progress', 2: 'in-progress', 3: 'in-progress', 4: 'in-progress' },
        clientOptions: { generationPollAttempts: 90, generationPollDelayMs: 0 }
      });
      let now = 0;
      (client as unknown as { now: () => number }).now = () => now;
      (client as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
        // Advance time by the requested delay so the 180s deadline eventually elapses.
        now += ms;
      };

      await expect(
        client.generateCollection('spec-1', 'P', '', 'Tags', false, 'Fallback')
      ).rejects.toThrow(/COLLECTION_GENERATION_TIMEOUT/);
    });
  });
});
