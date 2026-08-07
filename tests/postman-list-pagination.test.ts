import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '@postman-cse/automation-core';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { createInternalIntegrationAdapter } from '../src/lib/postman/internal-integration-adapter.js';

/**
 * Cursor-pagination contracts for every Postman list endpoint bootstrap reads to
 * decide create-vs-adopt. Postman's own services page these lists (specification
 * service `defaultLimit: 50` / `maxLimit: 100` with `meta.cursor.next`; collection
 * service `COLLECTION_PAGE_SIZE = 100` with `meta.pagination.nextPage`), so a
 * page-1-only read on a large customer team silently concludes "absent" and forks
 * a duplicate asset, or resolves the wrong file id for a spec content write.
 */

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

function makeClient(
  handler: (env: Envelope, callIndex: number) => Response
): { client: PostmanGatewayAssetsClient; calls: Envelope[] } {
  const calls: Envelope[] = [];
  let i = 0;
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    const requestUrl = new URL(String(url));
    // Proxy calls carry the {service,method,path} envelope in the body; direct
    // app calls (requestDirectJson) are plain GETs with no body.
    const env: Envelope =
      requestUrl.pathname === '/ws/proxy'
        ? (JSON.parse(String((init as RequestInit).body)) as Envelope)
        : {
            service: 'direct',
            method: String((init as RequestInit).method ?? 'GET').toLowerCase(),
            path: `${requestUrl.pathname}${requestUrl.search}`
          };
    calls.push(env);
    return handler(env, i++);
  });
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'tok-1' }),
    fetchImpl,
    sleepImpl: async () => undefined
  });
  const client = new PostmanGatewayAssetsClient({
    gateway,
    sleep: async () => undefined,
    createIdentity: () => 'test-run'
  });
  return { client, calls };
}

/** Cursor of a specification-service style page: `meta.cursor.next`. */
function specPage(data: unknown[], next?: string): Response {
  return jsonResponse({ data, meta: { cursor: { next: next ?? null } } });
}

/** Cursor of a collection-service v3 page: `meta.pagination.nextPage`. */
function collectionPage(data: unknown[], nextPage?: string): Response {
  return jsonResponse({
    data,
    meta: { pagination: { nextPage: nextPage ?? null, pageSize: 100 } }
  });
}

const COLLECTION_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('specification list pagination', () => {
  it('findSpecificationsByExactName follows meta.cursor.next before concluding absent', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.path.startsWith('/specifications?containerType=workspace')) {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) return specPage([{ id: 'spec-other', name: 'Unrelated API' }], 'page-2');
        if (cursor === 'page-2') return specPage([{ id: 'spec-target', name: 'Telecom API' }]);
        return jsonResponse({ error: 'unexpected cursor' }, { status: 500 });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    const found = await client.findSpecificationsByExactName('ws-1', 'Telecom API');
    expect(found).toEqual([{ id: 'spec-target', name: 'Telecom API' }]);
    const listCalls = calls.filter((call) =>
      call.path.startsWith('/specifications?containerType=workspace')
    );
    expect(listCalls).toHaveLength(2);
  });

  it('uploadSpecWithOutcome adopts a same-named spec found on a later page instead of creating a duplicate', async () => {
    const posts: Envelope[] = [];
    const { client } = makeClient((env) => {
      if (env.method === 'get' && env.path.startsWith('/specifications?containerType=workspace')) {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) {
          return specPage(
            Array.from({ length: 50 }, (_unused, index) => ({
              id: `spec-noise-${index}`,
              name: `Other API ${index}`
            })),
            'page-2'
          );
        }
        return specPage([{ id: 'spec-existing', name: 'Telecom API' }]);
      }
      if (env.method === 'get' && env.path === '/specifications/spec-existing/files') {
        return specPage([{ id: 'root-file', path: 'index.yaml', type: 'ROOT' }]);
      }
      if (env.method === 'patch') return jsonResponse({ data: { id: 'root-file' } });
      if (env.method === 'get' && env.path.includes('/files/root-file')) {
        return jsonResponse({ data: { id: 'root-file', content: 'openapi: 3.0.3' } });
      }
      if (env.method === 'post') {
        posts.push(env);
        return jsonResponse({ data: { id: 'spec-duplicate' } });
      }
      return jsonResponse({ data: {} });
    });

    const outcome = await client.uploadSpecWithOutcome(
      'ws-1',
      'Telecom API',
      'openapi: 3.0.3',
      '3.0'
    );
    expect(outcome.specId).toBe('spec-existing');
    expect(posts).toHaveLength(0);
  });
});

describe('specification files list pagination', () => {
  it('resolves the ROOT file id from a later page rather than writing to a page-1 file', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) {
          return specPage(
            [{ id: 'dep-file', path: 'components/pet.yaml', type: 'DEFAULT' }],
            'files-2'
          );
        }
        return specPage([{ id: 'root-file', path: 'openapi.yaml', type: 'ROOT' }]);
      }
      if (env.method === 'patch') return jsonResponse({ data: { id: 'root-file' } });
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    await client.updateSpec('spec-1', 'openapi: 3.1.0');
    const patch = calls.find((call) => call.method === 'patch');
    expect(patch?.path).toBe('/specifications/spec-1/files/root-file');
  });

  it('fails loudly instead of writing the root document over an arbitrary non-ROOT file', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
        return specPage([
          { id: 'dep-a', path: 'components/pet.yaml', type: 'DEFAULT' },
          { id: 'dep-b', path: 'components/order.yaml', type: 'DEFAULT' }
        ]);
      }
      if (env.method === 'patch') return jsonResponse({ data: { id: 'dep-a' } });
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    await expect(client.updateSpec('spec-1', 'openapi: 3.1.0')).rejects.toThrow(
      /SPEC_ROOT_FILE_AMBIGUOUS/
    );
    expect(calls.filter((call) => call.method === 'patch')).toHaveLength(0);
  });

  it('still accepts an untyped single-file spec as its own root', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
        return specPage([{ id: 'only-file', path: 'index.yaml' }]);
      }
      if (env.method === 'patch') return jsonResponse({ data: { id: 'only-file' } });
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    await client.updateSpec('spec-1', 'openapi: 3.1.0');
    expect(calls.find((call) => call.method === 'patch')?.path).toBe(
      '/specifications/spec-1/files/only-file'
    );
  });

  it('getSpecBundle reads every file page when the tree fast path is unavailable', async () => {
    const rootContent = 'openapi: 3.0.3\ninfo:\n  title: t\n  version: 1.0.0\npaths: {}\n';
    const depContent = 'type: object\n';
    const { client } = makeClient((env) => {
      if (env.path === '/specifications/spec-1/tree') {
        return jsonResponse({ error: 'not found' }, { status: 404 });
      }
      if (env.method === 'get' && env.path === '/specifications/spec-1/files') {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) {
          return specPage([{ id: 'root-file', path: 'openapi.yaml', type: 'ROOT' }], 'files-2');
        }
        return specPage([{ id: 'dep-file', path: 'components/pet.yaml', type: 'DEFAULT' }]);
      }
      if (env.path === '/specifications/spec-1/files/root-file') {
        return jsonResponse({ data: { id: 'root-file', content: rootContent } });
      }
      if (env.path === '/specifications/spec-1/files/dep-file') {
        return jsonResponse({ data: { id: 'dep-file', content: depContent } });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    const bundle = await client.getSpecBundle('spec-1', 'openapi-yaml');
    expect(Array.from(bundle.files.values()).map((file) => file.path).sort()).toEqual([
      'components/pet.yaml',
      'openapi.yaml'
    ]);
  });
});

describe('workspace collection inventory pagination', () => {
  it('findCollectionsByExactName follows meta.pagination.nextPage before concluding absent', async () => {
    const { client, calls } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get') {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) {
          return collectionPage([{ id: 'col-noise', name: 'Unrelated' }], 'collections-2');
        }
        return collectionPage([{ id: 'col-target', name: 'Telecom API - Baseline' }]);
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    const found = await client.findCollectionsByExactName('ws-1', 'Telecom API - Baseline');
    expect(found).toEqual([{ id: 'col-target', name: 'Telecom API - Baseline' }]);
    expect(calls.filter((call) => call.service === 'collection')).toHaveLength(2);
  });

  it('createCollection adopts a same-named collection from a later inventory page', async () => {
    const posts: Envelope[] = [];
    const { client } = makeClient((env) => {
      if (env.service === 'collection' && env.method === 'get' && env.path.includes('?workspace=')) {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) {
          return collectionPage(
            Array.from({ length: 100 }, (_unused, index) => ({
              id: `col-noise-${index}`,
              name: `Other ${index}`
            })),
            'collections-2'
          );
        }
        return collectionPage([{ id: 'col-existing', name: 'Telecom API - Baseline' }]);
      }
      if (env.method === 'post') {
        posts.push(env);
        return jsonResponse({ data: { id: 'col-duplicate' } });
      }
      // Item-tree reconcile reads on the adopt path: an empty live tree.
      return jsonResponse({ data: [] });
    });

    const id = await client.createCollection('ws-1', {
      info: { name: 'Telecom API - Baseline', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: []
    });
    expect(id).toBe('col-existing');
    expect(posts).toHaveLength(0);
  });
});

describe('specification collection relation pagination', () => {
  it('waitForGeneratedCollectionLinks sees a link that lands on a later relation page', async () => {
    const { client } = makeClient((env) => {
      if (env.method === 'get' && env.path === '/specifications/spec-1/collections') {
        const cursor = String(env.query?.cursor ?? '');
        if (!cursor) {
          return specPage([{ collection: '99999-11111111-2222-3333-4444-555555555555' }], 'rel-2');
        }
        return specPage([{ collection: `12345-${COLLECTION_UUID}` }]);
      }
      // Nameless relation rows are hydrated through the direct app sync read.
      if (env.service === 'direct' && env.path.startsWith('/collection/')) {
        return jsonResponse({ entities: [{ data: { name: 'Telecom API' } }] });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    });

    await expect(
      client.waitForGeneratedCollectionLinks('spec-1', [COLLECTION_UUID])
    ).resolves.toBeUndefined();
  });

  it('adapter listSpecificationCollectionRelations returns relations from every page', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const env = JSON.parse(String((init as RequestInit).body)) as Envelope;
      const cursor = String((env.query as Record<string, unknown> | undefined)?.cursor ?? '');
      if (!cursor) {
        return jsonResponse({
          data: [
            {
              collection: 'col-1',
              state: 'in-sync',
              options: { requestNameSource: 'Fallback' },
              syncOptions: { syncExamples: true }
            }
          ],
          meta: { cursor: { next: 'rel-2' } }
        });
      }
      return jsonResponse({
        data: [
          {
            collection: 'col-2',
            state: 'in-sync',
            options: { requestNameSource: 'Fallback' },
            syncOptions: { syncExamples: true }
          }
        ],
        meta: { cursor: { next: null } }
      });
    });

    const adapter = createInternalIntegrationAdapter({
      backend: 'bifrost',
      accessToken: 'token-123',
      teamId: '11430732',
      orgMode: true,
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.10.0' }
    });

    const relations = await adapter.listSpecificationCollectionRelations!('spec-1');
    expect(relations.map((relation) => relation.collectionId)).toEqual(['col-1', 'col-2']);
  });
});
