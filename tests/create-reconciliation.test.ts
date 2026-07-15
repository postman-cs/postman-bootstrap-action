import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { createExtensibleContractCollection, runBootstrap } from '../src/index.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { PostmanExtensibleCollectionClient } from '../src/lib/postman/postman-ec-client.js';
import {
  loadAdditionalCollectionFiles,
  readResourcesState,
  syncAdditionalCollections,
  writeResourcesState,
  type PostmanResourcesState
} from '../src/lib/postman/additional-collections.js';
import type { CoreLike, ExecLike, IOLike } from '../src/index.js';

const VALID_SPEC_31 = `{
  "openapi": "3.1.0",
  "info": { "title": "Payments", "version": "1.0.0" },
  "paths": {
    "/payments": {
      "get": {
        "operationId": "listPayments",
        "responses": { "200": { "description": "ok" } }
      }
    }
  }
}`;

const COLLECTION_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

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

function makeGatewayAssetsClient(
  handler: (env: Envelope, callIndex: number) => Response,
  clientOptions?: { generationPollAttempts?: number; generationPollDelayMs?: number }
): { client: PostmanGatewayAssetsClient; calls: RecordedCall[] } {
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
    retryBaseDelayMs: 1,
    sleepImpl: async () => undefined
  });
  const client = new PostmanGatewayAssetsClient({
    gateway,
    sleep: async () => undefined,
    ...clientOptions
  });
  return { client, calls };
}

function createCoreStub(): CoreLike {
  return {
    getInput: vi.fn().mockReturnValue(''),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    group: vi.fn(async (_name, fn) => fn())
  };
}

function createExecStub(): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  };
}

function createIoStub(): IOLike {
  return { which: vi.fn().mockResolvedValue('/usr/local/bin/postman') };
}

function createCuratedCollection(name: string) {
  return {
    info: { name, schema: COLLECTION_SCHEMA },
    item: [
      {
        name: 'GET /curated',
        request: { method: 'GET', url: 'https://example.test/curated' }
      }
    ]
  };
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.chdir(dir);
  process.env.GITHUB_WORKSPACE = dir;
  try {
    return await fn();
  } finally {
    process.chdir(previous);
    if (previousWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
  }
}

describe('Wave 2 create reconciliation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('gateway operation-aware retries', () => {
    it('does not blind-retry an unsafe workspace create POST after an ambiguous 503', async () => {
      let createPosts = 0;
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        const env = JSON.parse(String((init as RequestInit).body)) as Envelope;
        if (env.method === 'post' && env.path === '/workspaces') {
          createPosts += 1;
          return new Response('{"error":"ESOCKETTIMEDOUT"}', { status: 503 });
        }
        return jsonResponse({ data: [] });
      });
      const provider = new AccessTokenProvider({ accessToken: 'tok' });
      const gateway = new AccessTokenGatewayClient({
        tokenProvider: provider,
        fetchImpl,
        maxRetries: 3,
        retryBaseDelayMs: 1,
        sleepImpl: async () => undefined
      });
      const client = new PostmanGatewayAssetsClient({
        gateway,
        sleep: async () => undefined
      });

      await expect(client.createWorkspace('Wave2 WS', 'about')).rejects.toThrow(/503/);
      expect(createPosts).toBe(1);
    });

    it('still retries safe GET reads on transient 503', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{"error":"ESOCKETTIMEDOUT"}', { status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ data: { id: 'ws-1', visibilityStatus: 'team' } }));
      const provider = new AccessTokenProvider({ accessToken: 'tok' });
      const gateway = new AccessTokenGatewayClient({
        tokenProvider: provider,
        fetchImpl,
        retryBaseDelayMs: 1,
        sleepImpl: async () => undefined
      });
      const client = new PostmanGatewayAssetsClient({ gateway, sleep: async () => undefined });

      await expect(client.getWorkspaceVisibility('ws-1')).resolves.toBe('team');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('workspace create seam', () => {
    it('reconciles an accepted-create-then-503 by exact workspace name without a second POST', async () => {
      let createPosts = 0;
      const { client, calls } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          createPosts += 1;
          return new Response('{"error":"downstream timeout"}', { status: 503 });
        }
        if (env.method === 'get' && env.path === '/workspaces') {
          return jsonResponse({
            data: [{ id: 'ws-adopted', name: 'Wave2 WS', visibilityStatus: 'team' }]
          });
        }
        if (env.path === '/workspaces/ws-adopted') {
          return jsonResponse({ data: { id: 'ws-adopted', visibilityStatus: 'team' } });
        }
        return jsonResponse({ data: {} });
      });

      const result = await client.createWorkspace('Wave2 WS', 'about');
      expect(result).toEqual({ id: 'ws-adopted', reconciled: true });
      expect(createPosts).toBe(1);
      expect(calls.filter((c) => c.method === 'post' && c.path === '/workspaces')).toHaveLength(1);
    });

    it('fails when multiple exact workspace name matches exist after an ambiguous create', async () => {
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return new Response('{"error":"timeout"}', { status: 503 });
        }
        if (env.method === 'get' && env.path === '/workspaces') {
          return jsonResponse({
            data: [
              { id: 'ws-a', name: 'Wave2 WS' },
              { id: 'ws-b', name: 'Wave2 WS' }
            ]
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(client.createWorkspace('Wave2 WS', 'about')).rejects.toThrow(/Ambiguous|exactly one/i);
    });

    it('never deletes a workspace adopted only by exact-name reconciliation', async () => {
      let deleteCalls = 0;
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path === '/workspaces') {
          return new Response('{"error":"timeout"}', { status: 503 });
        }
        if (env.method === 'get' && env.path === '/workspaces') {
          return jsonResponse({ data: [{ id: 'ws-adopted', name: 'Wave2 WS' }] });
        }
        if (env.method === 'get' && env.path === '/workspaces/ws-adopted') {
          return jsonResponse({ data: { id: 'ws-adopted', visibilityStatus: 'personal' } });
        }
        if (env.method === 'delete') deleteCalls += 1;
        return jsonResponse({ data: {} });
      });

      await expect(client.createWorkspace('Wave2 WS', 'about')).rejects.toThrow();
      expect(deleteCalls).toBe(0);
    });
  });

  describe('spec upload seam', () => {
    it('adopts an exact-name spec and updates it with incoming content without a create POST', async () => {
      let createPosts = 0;
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/specifications?')) {
          createPosts += 1;
          return new Response('{"error":"ESOCKETTIMEDOUT"}', { status: 503 });
        }
        if (env.method === 'get' && env.path.startsWith('/specifications?')) {
          return jsonResponse({
            data: [{ id: 'spec-adopted', name: 'Payments API' }]
          });
        }
        if (env.path === '/specifications/spec-adopted/files') {
          return jsonResponse({ data: [{ id: 'root-file', type: 'ROOT' }] });
        }
        if (env.method === 'patch' && env.path === '/specifications/spec-adopted/files/root-file') {
          expect(env.body).toEqual([{ op: 'replace', path: '/content', value: 'openapi: 3.0.3' }]);
          return jsonResponse({ data: {} });
        }
        if (env.path === '/specifications/spec-adopted') {
          return jsonResponse({ data: { id: 'spec-adopted' } });
        }
        return jsonResponse({ data: {} });
      });

      const id = await client.uploadSpec('ws-1', 'Payments API', 'openapi: 3.0.3', '3.0');
      expect(id).toBe('spec-adopted');
      expect(createPosts).toBe(0);
    });
  });

  describe('generated collection seam', () => {
    it('submits a run-unique name and reconciles only that exact identity', async () => {
      let submittedName = '';
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          return submittedName
            ? jsonResponse({ data: [{ collection: 'uid-owned', name: submittedName }] })
            : jsonResponse({ data: [] });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          return new Response('{"error":"disconnect"}', { status: 503 });
        }
        if (env.method === 'patch' && env.path === '/v3/collections/owned') {
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        client.generateCollection('spec-1', 'Payments', '[Smoke]', 'Tags', true, 'Fallback')
      ).resolves.toBe('uid-owned');
      expect(submittedName).toMatch(/^\[Smoke\] Payments \[bootstrap:[A-Za-z0-9-]+\]$/);
    });

    it('does not adopt an arbitrary sole snapshot delta after ambiguous generation', async () => {
      let posted = false;
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          return jsonResponse({
            data: posted ? [{ collection: 'uid-other', name: 'Concurrent collection' }] : []
          });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          posted = true;
          return new Response('{"error":"disconnect"}', { status: 503 });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        client.generateCollection('spec-1', 'Payments', '[Smoke]', 'Tags', true, 'Fallback')
      ).rejects.toThrow(/503|disconnect/i);
    });
    it('never adopts a collection solely because it is newest', async () => {
      let submittedName = '';
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          return jsonResponse({ data: { taskId: 'task-mine' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          return jsonResponse({ data: { 'task-mine': 'completed' } });
        }
        if (env.path === '/specifications/spec-1/collections' && env.method === 'get') {
          if (!submittedName) return jsonResponse({ data: [] });
          // Oldest is ours; a concurrent run's collection appears last (newest).
          return jsonResponse({
            data: [
              { collection: 'uid-ours', name: submittedName },
              { collection: 'uid-newest-other', name: '[Smoke] Other Project' }
            ]
          });
        }
        if (env.path === '/v3/collections/ours' || env.path === '/v3/collections/uid-ours') {
          return jsonResponse({ data: { id: 'uid-ours', name: '[Smoke] Payments' } });
        }
        if (env.path.includes('newest-other') || env.path.includes('uid-newest-other')) {
          return jsonResponse({ data: { id: 'uid-newest-other', name: '[Smoke] Other Project' } });
        }
        // bare-model GET for name resolution
        if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/')) {
          const id = env.path.replace('/v3/collections/', '').replace(/\/$/, '');
          if (id.includes('ours')) {
            return jsonResponse({ data: { id, name: '[Smoke] Payments' } });
          }
          return jsonResponse({ data: { id, name: '[Smoke] Other Project' } });
        }
        return jsonResponse({ data: {} });
      });

      const uid = await client.generateCollection(
        'spec-1',
        'Payments',
        '[Smoke]',
        'Tags',
        true,
        'Fallback'
      );
      expect(uid).toBe('uid-ours');
      expect(uid).not.toBe('uid-newest-other');
    });

    it('correlates generation to the submitted name after an ambiguous create POST', async () => {
      let createPosts = 0;
      let listedBeforeCreate = false;
      let submittedName = '';
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          if (!listedBeforeCreate) {
            listedBeforeCreate = true;
            return jsonResponse({
              data: [{ collection: 'uid-preexisting', name: '[Baseline] Payments' }]
            });
          }
          return jsonResponse({
            data: [
              { collection: 'uid-preexisting', name: '[Baseline] Payments' },
              { collection: 'uid-new', name: submittedName }
            ]
          });
        }
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          createPosts += 1;
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          return new Response('{"error":"timeout"}', { status: 503 });
        }
        if (env.service === 'collection' && env.method === 'get' && env.path.startsWith('/v3/collections/')) {
          const id = env.path.replace('/v3/collections/', '').replace(/\/$/, '');
          if (id.includes('preexisting') || id === 'preexisting') {
            return jsonResponse({ data: { id, name: '[Baseline] Payments' } });
          }
          return jsonResponse({ data: { id, name: '[Smoke] Payments' } });
        }
        return jsonResponse({ data: {} });
      });

      const uid = await client.generateCollection(
        'spec-1',
        'Payments',
        '[Smoke]',
        'Tags',
        true,
        'Fallback'
      );
      expect(uid).toBe('uid-new');
      expect(createPosts).toBe(1);
    });

    it('fails when multiple exact generated collection name matches exist', async () => {
      let submittedName = '';
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path === '/specifications/spec-1/collections') {
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          return jsonResponse({ data: { taskId: 'task-1' } }, { status: 202 });
        }
        if (env.path === '/tasks') {
          return jsonResponse({ data: { 'task-1': 'completed' } });
        }
        if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
          if (!submittedName) return jsonResponse({ data: [] });
          return jsonResponse({
            data: [
              { collection: 'uid-a', name: submittedName },
              { collection: 'uid-b', name: submittedName }
            ]
          });
        }
        if (env.service === 'collection' && env.method === 'get') {
          return jsonResponse({ data: { name: '[Smoke] Payments' } });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        client.generateCollection('spec-1', 'Payments', '[Smoke]', 'Tags', true, 'Fallback')
      ).rejects.toThrow(/Ambiguous|exactly one/i);
    });
  });

  describe('additional collection root and item seams', () => {
    it('persists the additional collection root before child materialization and resumes a partial tree', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-partial-tree-'));
      mkdirSync(join(workspace, 'postman/curated'), { recursive: true });
      writeFileSync(
        join(workspace, 'postman/curated/payments.json'),
        JSON.stringify(
          {
            info: { name: 'Payments curated', schema: COLLECTION_SCHEMA },
            item: [
              {
                name: 'Folder A',
                item: [
                  {
                    name: 'GET /one',
                    request: { method: 'GET', url: 'https://example.test/one' }
                  }
                ]
              },
              {
                name: 'GET /two',
                request: { method: 'GET', url: 'https://example.test/two' }
              }
            ]
          },
          null,
          2
        )
      );

      try {
        await withCwd(workspace, async () => {
          const resourcesState: PostmanResourcesState = {
            workspace: { id: 'ws-1' }
          };
          const itemCreates: string[] = [];

          // First run uses createCollection that invokes onRootCreated then fails mid-tree.
          const gatewayLike = {
            async createCollection(
              workspaceId: string,
              collection: unknown,
              options?: { onRootCreated?: (id: string) => void | Promise<void> }
            ): Promise<string> {
              void workspaceId;
              void collection;
              await options?.onRootCreated?.('col-partial-root');
              itemCreates.push('root-persisted');
              throw new Error('simulated child materialization failure');
            },
            updateCollection: vi.fn().mockResolvedValue(undefined)
          };

          const files = loadAdditionalCollectionFiles('postman/curated', resourcesState);
          await expect(
            syncAdditionalCollections({
              collectionFiles: files,
              core: { info: vi.fn(), warning: vi.fn() },
              postman: gatewayLike,
              resourcesState,
              workspaceId: 'ws-1'
            })
          ).rejects.toThrow(/child materialization failure/);

          expect(readFileSync('.postman/resources.yaml', 'utf8')).toContain('col-partial-root');
          expect(itemCreates).toEqual(['root-persisted']);

          // Fresh process resume: state has the root; second sync updates instead of creating.
          const resumedState = parseYaml(
            readFileSync('.postman/resources.yaml', 'utf8')
          ) as PostmanResourcesState;
          const resumedFiles = loadAdditionalCollectionFiles('postman/curated', resumedState);
          expect(resumedFiles[0]?.existingCollectionId).toBe('col-partial-root');

          await syncAdditionalCollections({
            collectionFiles: resumedFiles,
            core: { info: vi.fn(), warning: vi.fn() },
            postman: {
              createCollection: vi.fn().mockRejectedValue(new Error('must not create again')),
              updateCollection: vi.fn().mockResolvedValue(undefined)
            },
            resourcesState: resumedState,
            workspaceId: 'ws-1'
          });
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('reconciles an ambiguous additional root create by exact collection name', async () => {
      let createPosts = 0;
      let submittedName = '';
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          createPosts += 1;
          submittedName = String((env.body as { name?: unknown })?.name ?? '');
          return new Response('{"error":"timeout"}', { status: 503 });
        }
        if (env.method === 'get' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({
            data: [{ id: 'col-adopted', name: submittedName }]
          });
        }
        if (env.method === 'get' && env.path === '/v3/collections/col-adopted') {
          return jsonResponse({ data: { id: 'col-adopted', name: 'Payments curated' } });
        }
        if (env.method === 'get' && env.path === '/v3/collections/col-adopted/items/') {
          return jsonResponse({ data: [] });
        }
        if (env.method === 'post' && env.path.includes('/items/')) {
          return jsonResponse({ data: { id: 'item-1' } }, { status: 201 });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      const id = await client.createCollection('ws-1', createCuratedCollection('Payments curated'));
      expect(id).toBe('col-adopted');
      expect(createPosts).toBe(1);
    });

    it('reconciles an ambiguous item create by exact sibling name without a second POST', async () => {
      let itemPosts = 0;
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root' } }, { status: 201 });
        }
        if (env.method === 'post' && env.path.includes('/items/')) {
          itemPosts += 1;
          if (itemPosts === 1) {
            return new Response('{"error":"timeout"}', { status: 503 });
          }
          return jsonResponse({ data: { id: 'item-extra' } }, { status: 201 });
        }
        if (env.method === 'get' && env.path.endsWith('/items/')) {
          return jsonResponse({
            data: [{
              id: 'item-adopted',
              $kind: 'http-request',
              name: 'GET /curated',
              position: { parent: { id: 'root' } }
            }]
          });
        }
        if (env.method === 'patch') {
          return jsonResponse({ data: {} });
        }
        return jsonResponse({ data: {} });
      });

      const id = await client.createCollection('ws-1', createCuratedCollection('Payments curated'));
      expect(id).toBe('55363555-root');
      expect(itemPosts).toBe(1);
    });

    it('does not adopt an item whose parent identity is missing', async () => {
      let itemPosts = 0;
      const { client } = makeGatewayAssetsClient((env) => {
        if (env.method === 'post' && env.path.startsWith('/v3/collections/?workspace=')) {
          return jsonResponse({ data: { id: '55363555-root' } }, { status: 201 });
        }
        if (env.method === 'post' && env.path.includes('/items/')) {
          itemPosts += 1;
          return new Response('{"error":"timeout"}', { status: 503 });
        }
        if (env.method === 'get' && env.path.endsWith('/items/')) {
          return jsonResponse({
            data: [{ id: 'item-other', $kind: 'http-request', name: 'GET /curated' }]
          });
        }
        return jsonResponse({ data: {} });
      });

      await expect(
        client.createCollection('ws-1', createCuratedCollection('Payments curated'))
      ).rejects.toThrow();
      expect(itemPosts).toBe(1);
    });
  });

  describe('EC create seam', () => {
    it('does not blind-retry an unsafe EC collection create POST after 503', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('upstream down', { status: 503 }));
      const client = new PostmanExtensibleCollectionClient({
        accessToken: 'tok',
        fetchImpl
      });

      await expect(client.createExtensibleCollection('ws-1', { name: 'EC Contract' })).rejects.toThrow(
        /503/
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('fails an accepted-disconnect EC root create without discovery, population, or cleanup', async () => {
      const ecClient = {
        createExtensibleCollection: vi.fn().mockRejectedValue(new TypeError('disconnected')),
        deleteExtensibleCollection: vi.fn(),
        getExtensibleCollection: vi.fn(),
        populateFromTree: vi.fn()
      };
      const writes: PostmanResourcesState[] = [];

      await expect(
        createExtensibleContractCollection(
          'ws-1',
          { type: 'grpc', collection: { title: 'EC Contract' } } as never,
          { projectName: 'Payments' } as never,
          {
            core: createCoreStub(),
            exec: createExecStub(),
            io: createIoStub(),
            postman: {} as never,
            ecClient: ecClient as never,
            resourcesState: {
              read: () => null,
              write: (state) => writes.push(structuredClone(state))
            },
            specFetcher: vi.fn()
          },
          {}
        )
      ).rejects.toThrow(/disconnected/);

      expect(ecClient.createExtensibleCollection).toHaveBeenCalledTimes(1);
      expect(ecClient.populateFromTree).not.toHaveBeenCalled();
      expect(ecClient.deleteExtensibleCollection).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });

    it('blocks EC replacement after a definite old-root delete failure', async () => {
      const ecClient = {
        createExtensibleCollection: vi.fn(),
        deleteExtensibleCollection: vi.fn().mockRejectedValue(new Error('403 forbidden')),
        getExtensibleCollection: vi.fn(),
        populateFromTree: vi.fn()
      };

      await expect(
        createExtensibleContractCollection(
          'ws-1',
          { type: 'grpc', collection: { title: 'EC Contract' } } as never,
          { projectName: 'Payments', contractCollectionId: 'ec-old' } as never,
          {
            core: createCoreStub(),
            exec: createExecStub(),
            io: createIoStub(),
            postman: {} as never,
            ecClient: ecClient as never,
            resourcesState: { read: () => null, write: vi.fn() },
            specFetcher: vi.fn()
          },
          {}
        )
      ).rejects.toThrow(/403 forbidden/);

      expect(ecClient.createExtensibleCollection).not.toHaveBeenCalled();
    });

    it('persists a run-created EC root before population and cleans up only that id', async () => {
      const writes: PostmanResourcesState[] = [];
      const ecClient = {
        createExtensibleCollection: vi.fn().mockResolvedValue('ec-run-created'),
        deleteExtensibleCollection: vi.fn().mockResolvedValue(undefined),
        getExtensibleCollection: vi.fn(),
        populateFromTree: vi.fn().mockImplementation(async () => {
          expect(writes.at(-1)).toMatchObject({
            cloudResources: {
              collections: { '../postman/collections/[Contract] Payments': 'ec-run-created' }
            }
          });
          throw new Error('population failed');
        })
      };

      await expect(
        createExtensibleContractCollection(
          'ws-1',
          { type: 'grpc', collection: { title: 'EC Contract' } } as never,
          { projectName: 'Payments' } as never,
          {
            core: createCoreStub(),
            exec: createExecStub(),
            io: createIoStub(),
            postman: {} as never,
            ecClient: ecClient as never,
            resourcesState: {
              read: () => null,
              write: (state) => writes.push(structuredClone(state))
            },
            specFetcher: vi.fn()
          },
          {}
        )
      ).rejects.toThrow(/population failed/);

      expect(ecClient.deleteExtensibleCollection).toHaveBeenCalledTimes(1);
      expect(ecClient.deleteExtensibleCollection).toHaveBeenCalledWith('ec-run-created');
    });
  });

  describe('standard state persistence and fresh-process reuse', () => {
    it('contains no production test-environment detection', () => {
      const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
      expect(source).not.toMatch(/VITEST|NODE_ENV/);
    });
    it('persists workspace/spec/generated collection ids on a standard successful run', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-standard-state-'));
      vi.stubEnv('GITHUB_WORKSPACE', workspace);
      writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);

      try {
        await withCwd(workspace, async () => {
          const core = createCoreStub();
          const postman = {
            addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
            createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-created' }),
            findWorkspacesByName: vi.fn().mockResolvedValue([]),
            generateCollection: vi
              .fn()
              .mockImplementation(async (_s: string, _p: string, prefix: string) => {
                if (prefix === '') return 'col-baseline';
                if (prefix === '[Smoke]') return 'col-smoke';
                return 'col-contract';
              }),
            getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
            getCollection: vi.fn().mockResolvedValue({
              info: { name: '[Contract] Payments' },
              item: [
                {
                  name: 'GET /payments',
                  request: { method: 'GET', url: { path: ['payments'] } }
                }
              ]
            }),
            getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
            getTeams: vi.fn().mockResolvedValue([]),
            getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
            getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
            injectContractTests: vi.fn().mockResolvedValue([]),
            injectTests: vi.fn().mockResolvedValue(undefined),
            inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
            tagCollection: vi.fn().mockResolvedValue(undefined),
            updateSpec: vi.fn().mockResolvedValue(undefined),
            uploadSpec: vi.fn().mockResolvedValue('spec-created')
          };
          const internalIntegration = {
            assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
            linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
            syncCollection: vi.fn().mockResolvedValue(undefined)
          };

          await runBootstrap(
            {
              projectName: 'Payments',
              postmanAccessToken: 'access-token',
              postmanApiKey: '',
              specPath: 'openapi.yaml',
              collectionSyncMode: 'version',
              specSyncMode: 'update',
              releaseLabel: 'v1',
              folderStrategy: 'Tags',
              nestedFolderHierarchy: true,
              requestNameSource: 'Fallback',
              syncExamples: true,
              credentialPreflight: 'warn',
              workspaceId: '',
              specId: '',
              baselineCollectionId: '',
              smokeCollectionId: '',
              contractCollectionId: ''
            } as never,
            {
              core,
              exec: createExecStub(),
              io: createIoStub(),
              postman: postman as never,
              resourcesState: { read: readResourcesState, write: writeResourcesState },
              internalIntegration: internalIntegration as never,
              specFetcher: vi.fn()
            }
          );

          const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8'));
          expect(resources).toMatchObject({
            workspace: { id: 'ws-created' },
            canonical: {
              specs: {
                '../openapi.yaml': 'spec-created'
              },
              collections: {
                '../postman/collections/Payments v1': 'col-baseline',
                '../postman/collections/[Smoke] Payments v1': 'col-smoke',
                '../postman/collections/[Contract] Payments v1': 'col-contract'
              }
            }
          });
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it('reuses persisted ids across a fresh process without creating replacements', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-two-run-'));
      vi.stubEnv('GITHUB_WORKSPACE', workspace);
      writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
      mkdirSync(join(workspace, '.postman'), { recursive: true });
      writeFileSync(
        join(workspace, '.postman/resources.yaml'),
        stringifyYaml({
          workspace: { id: 'ws-persisted' },
          cloudResources: {
            specs: { '../openapi.yaml': 'spec-persisted' },
            collections: {
              '../postman/collections/Payments v1': 'col-baseline-persisted',
              '../postman/collections/[Smoke] Payments v1': 'col-smoke-persisted',
              '../postman/collections/[Contract] Payments v1': 'col-contract-persisted'
            }
          }
        })
      );

      try {
        await withCwd(workspace, async () => {
          const postman = {
            addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
            createWorkspace: vi.fn().mockRejectedValue(new Error('must not create workspace')),
            findWorkspacesByName: vi.fn().mockResolvedValue([]),
            generateCollection: vi.fn().mockRejectedValue(new Error('must not generate')),
            getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
            getCollection: vi.fn().mockResolvedValue({
              info: { name: '[Contract] Payments' },
              item: [
                {
                  name: 'GET /payments',
                  request: { method: 'GET', url: { path: ['payments'] } }
                }
              ]
            }),
            getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
            getTeams: vi.fn().mockResolvedValue([]),
            getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
            getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
            injectContractTests: vi.fn().mockResolvedValue([]),
            injectTests: vi.fn().mockResolvedValue(undefined),
            inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
            tagCollection: vi.fn().mockResolvedValue(undefined),
            updateSpec: vi.fn().mockResolvedValue(undefined),
            uploadSpec: vi.fn().mockRejectedValue(new Error('must not upload'))
          };
          const internalIntegration = {
            assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
            linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
            syncCollection: vi.fn().mockResolvedValue(undefined)
          };

          const outputs = await runBootstrap(
            {
              projectName: 'Payments',
              postmanAccessToken: 'access-token',
              postmanApiKey: '',
              specPath: 'openapi.yaml',
              collectionSyncMode: 'version',
              specSyncMode: 'update',
              releaseLabel: 'v1',
              folderStrategy: 'Tags',
              nestedFolderHierarchy: true,
              requestNameSource: 'Fallback',
              syncExamples: true,
              credentialPreflight: 'warn',
              workspaceId: '',
              specId: '',
              baselineCollectionId: '',
              smokeCollectionId: '',
              contractCollectionId: ''
            } as never,
            {
              core: createCoreStub(),
              exec: createExecStub(),
              io: createIoStub(),
              postman: postman as never,
              resourcesState: { read: readResourcesState, write: writeResourcesState },
              internalIntegration: internalIntegration as never,
              specFetcher: vi.fn()
            }
          );

          expect(outputs['workspace-id']).toBe('ws-persisted');
          expect(outputs['spec-id']).toBe('spec-persisted');
          expect(outputs['baseline-collection-id']).toBe('col-baseline-persisted');
          expect(outputs['smoke-collection-id']).toBe('col-smoke-persisted');
          expect(outputs['contract-collection-id']).toBe('col-contract-persisted');
          expect(postman.createWorkspace).not.toHaveBeenCalled();
          expect(postman.uploadSpec).not.toHaveBeenCalled();
          expect(postman.generateCollection).not.toHaveBeenCalled();
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });

  describe('ambiguous sync/delete before replacement', () => {
    it('re-reads state after an ambiguous sync failure and never adopts or replaces by name', async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-ambiguous-sync-'));
      writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
      mkdirSync(join(workspace, '.postman'), { recursive: true });
      writeFileSync(
        join(workspace, '.postman/resources.yaml'),
        stringifyYaml({
          workspace: { id: 'ws-1' },
          cloudResources: {
            specs: { '../openapi.yaml': 'spec-1' },
            collections: {
              '../postman/collections/[Smoke] Payments': 'col-smoke-old'
            }
          }
        })
      );

      try {
        await withCwd(workspace, async () => {
          const postman = {
            addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
            createWorkspace: vi.fn(),
            findWorkspacesByName: vi.fn().mockResolvedValue([]),
            findCollectionsByExactName: vi.fn().mockResolvedValue([
              { id: 'col-a', name: '[Smoke] Payments' },
              { id: 'col-b', name: '[Smoke] Payments' }
            ]),
            generateCollection: vi.fn().mockResolvedValue('col-should-not-create'),
            getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
            getCollection: vi.fn().mockResolvedValue({
              info: { name: '[Contract] Payments' },
              item: [
                {
                  name: 'GET /payments',
                  request: { method: 'GET', url: { path: ['payments'] } }
                }
              ]
            }),
            getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
            getTeams: vi.fn().mockResolvedValue([]),
            getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
            getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
            injectContractTests: vi.fn().mockResolvedValue([]),
            injectTests: vi.fn().mockResolvedValue(undefined),
            inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
            tagCollection: vi.fn().mockResolvedValue(undefined),
            updateSpec: vi.fn().mockResolvedValue(undefined),
            uploadSpec: vi.fn()
          };
          const internalIntegration = {
            assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
            linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
            syncCollection: vi
              .fn()
              .mockRejectedValueOnce(new Error('503 upstream timeout'))
              .mockResolvedValue(undefined)
          };

          await expect(
            runBootstrap(
              {
                projectName: 'Payments',
                postmanAccessToken: 'access-token',
                postmanApiKey: '',
                specPath: 'openapi.yaml',
                collectionSyncMode: 'refresh',
                specSyncMode: 'update',
                folderStrategy: 'Tags',
                nestedFolderHierarchy: true,
                requestNameSource: 'Fallback',
                syncExamples: true,
                credentialPreflight: 'warn',
                workspaceId: 'ws-1',
                specId: 'spec-1',
                baselineCollectionId: 'col-baseline',
                smokeCollectionId: 'col-smoke-old',
                contractCollectionId: 'col-contract'
              } as never,
              {
                core: createCoreStub(),
                exec: createExecStub(),
                io: createIoStub(),
                postman: postman as never,
                resourcesState: { read: readResourcesState, write: writeResourcesState },
                internalIntegration: internalIntegration as never,
                specFetcher: vi.fn()
              }
            )
          ).rejects.toThrow(/503 upstream timeout/i);

          expect(postman.generateCollection).not.toHaveBeenCalled();
          expect(postman.findCollectionsByExactName).not.toHaveBeenCalled();
        });
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  });
});
