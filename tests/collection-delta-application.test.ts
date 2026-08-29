import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '@postman-cs/automation-core';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { planCollectionDelta, type CollectionDeltaPlan } from '../src/lib/spec/collection-delta.js';
import { computePayloadDigest } from '../src/lib/spec/local-openapi-collection-generation.js';

const bare = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const uid = `55363555-${bare}`;
const requestId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const requestUid = `991-${requestId}`;
const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

interface Envelope {
  service: string;
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });
}

function isPopulatedSyncSnapshot(env: Envelope): boolean {
  return env.service === 'sync' &&
    env.method === 'get' &&
    env.path === `/collection/${uid}` &&
    env.query?.populate === 'true' &&
    env.query?.format === '2.1.0' &&
    env.query?.uid === 'false';
}

function syncSnapshotResponse(collection: unknown): Response {
  return jsonResponse({ data: collection });
}

function collection(url: string) {
  return {
    info: { name: 'Payments', schema, _postman_id: bare },
    item: [{ id: requestId, name: 'GET /payments', request: { method: 'GET', url } }]
  };
}

function abortError(): Error {
  return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

function makeClient(handler: (env: Envelope) => Response | Promise<Response>) {
  const calls: Array<Envelope & { headers: Record<string, string> }> = [];
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: new AccessTokenProvider({ accessToken: 'token' }),
    fetchImpl: vi.fn<typeof fetch>(async (_url, init) => {
      const env = JSON.parse(String((init as RequestInit).body)) as Envelope;
      calls.push({
        ...env,
        headers: Object.fromEntries(new Headers((init as RequestInit).headers).entries())
      });
      return handler(env);
    }),
    retryBaseDelayMs: 1,
    sleepImpl: async () => undefined
  });
  return { client: new PostmanGatewayAssetsClient({ gateway, sleep: async () => undefined }), calls };
}

describe('applyCollectionDelta', () => {
  it('uses full public collection and item UIDs with entity headers, then verifies the exact digest', async () => {
    const snapshot = collection('https://example.test/stale');
    const desired = collection('https://example.test/fresh');
    const plan = planCollectionDelta({ snapshot, desired });
    const digest = computePayloadDigest(desired);
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [{ id: requestUid, $kind: 'http-request', name: 'GET /payments' }] });
      }
      if (env.path === `/v3/collections/${uid}/items/${requestUid}`) return jsonResponse({ data: {} });
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toEqual({
      strategy: 'delta', observedPayloadDigest: digest
    });
    const patch = calls.find((call) => call.method === 'patch');
    expect(patch?.path).toBe(`/v3/collections/${uid}/items/${requestUid}`);
    expect(patch?.headers['x-entity-type']).toBe('http-request');
    expect(calls.filter((call) => isPopulatedSyncSnapshot(call))).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith('/export'))).toHaveLength(0);
    expect(client.collectionWriteMetrics.deltaRoutes).toEqual([
      'PATCH /v3/collections/{param}/items/{param}'
    ]);
  });

  it('excludes unchanged scripts and responses from request patch conversion', async () => {
    const snapshot = collection('https://example.test/stale') as Record<string, unknown>;
    const desired = collection('https://example.test/fresh') as Record<string, unknown>;
    for (const value of [snapshot, desired]) {
      const item = (value.item as Array<Record<string, unknown>>)[0]!;
      item.event = [{ listen: 'test', script: { exec: ['large-script-marker'] } }];
      item.response = [{ name: 'ok', code: 200, body: 'large-response-marker' }];
    }
    const plan = planCollectionDelta({ snapshot, desired });
    const digest = computePayloadDigest(desired);
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [{ id: requestUid, $kind: 'http-request', name: 'GET /payments' }] });
      }
      if (env.path === `/v3/collections/${uid}/items/${requestUid}`) return jsonResponse({ data: {} });
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    const patch = calls.find((call) => call.method === 'patch');
    expect(JSON.stringify(patch?.body)).not.toContain('large-script-marker');
    expect(JSON.stringify(patch?.body)).not.toContain('large-response-marker');
  });

  it('reconciles an ambiguous mid-apply transport outcome before any next mutation', async () => {
    const snapshot = collection('https://example.test/stale');
    const desired = collection('https://example.test/fresh');
    const plan = planCollectionDelta({ snapshot, desired });
    const digest = computePayloadDigest(desired);
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [{ id: requestUid, $kind: 'http-request', name: 'GET /payments' }] });
      }
      if (env.path === `/v3/collections/${uid}/items/${requestUid}`) throw abortError();
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    expect(calls.filter((call) => call.method === 'patch')).toHaveLength(1);
    expect(client.collectionWriteMetrics.ambiguousWrites).toBe(1);
  });

  it('stops later ordered operations when ambiguous readback proves whole convergence', async () => {
    const snapshot = collection('https://example.test/stale');
    const desired = collection('https://example.test/fresh');
    const planned = planCollectionDelta({ snapshot, desired });
    if (planned.decision !== 'apply') throw new Error('expected apply plan');
    const plan = {
      ...planned,
      operations: [
        planned.operations[0]!,
        { ...planned.operations[0]!, kind: 'move' as const, index: 0 }
      ]
    };
    const digest = computePayloadDigest(desired);
    let snapshotReads = 0;
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [{ id: requestUid, $kind: 'http-request', name: 'GET /payments' }] });
      }
      if (env.method === 'patch') throw abortError();
      if (isPopulatedSyncSnapshot(env)) {
        snapshotReads += 1;
        return syncSnapshotResponse(desired);
      }
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    expect(calls.filter((call) => call.method === 'patch')).toHaveLength(1);
    expect(snapshotReads).toBe(2);
  });

  it('applies an independently rekeyed nested request patch using the exact public item uid', async () => {
    const folderId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const folderUid = `991-${folderId}`;
    const snapshot = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: [{ id: folderId, name: 'payments', item: [
        { id: requestId, name: 'GET /payments', description: 'stale', request: { method: 'GET', url: 'https://example.test/payments' } }
      ] }]
    };
    const desired = structuredClone(snapshot);
    desired.item[0]!.id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    desired.item[0]!.item[0]!.id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    desired.item[0]!.item[0]!.description = 'fresh';
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan).toMatchObject({ decision: 'apply' });
    const digest = computePayloadDigest(desired);
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) return jsonResponse({ data: [
        { id: folderUid, $kind: 'collection', name: 'payments', items: [
          { id: requestUid, $kind: 'http-request', name: 'GET /payments' }
        ] }
      ] });
      if (env.path === `/v3/collections/${uid}/items/${requestUid}`) return jsonResponse({ data: {} });
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    expect(calls.find((call) => call.method === 'patch')?.path).toBe(`/v3/collections/${uid}/items/${requestUid}`);
  });

  it('normalizes a full public parent key when creating a nested request', async () => {
    const folderId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const folderUid = `991-${folderId}`;
    const snapshot = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: [{ id: folderUid, name: 'payments', item: [] }]
    };
    const desired = structuredClone(snapshot);
    desired.item[0]!.item.push({
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      name: 'new',
      request: { method: 'GET', url: 'https://example.test/new' }
    } as never);
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan).toMatchObject({ decision: 'apply' });
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/` && env.method === 'get') {
        return jsonResponse({ data: [{ id: folderUid, $kind: 'collection', name: 'payments', items: [] }] });
      }
      if (env.path === `/v3/collections/${uid}/items/` && env.method === 'post') {
        return jsonResponse({ data: { id: '991-dddddddd-dddd-dddd-dddd-dddddddddddd' } });
      }
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, computePayloadDigest(desired)))
      .resolves.toMatchObject({ strategy: 'delta' });
    expect(calls.find((call) => call.method === 'post')?.body).toMatchObject({
      position: { parent: { id: folderUid } }
    });
    expect(calls.some((call) => call.path === '/v3/items/move')).toBe(false);
  });

  it('creates saved responses and scripts with a new request', async () => {
    const createdId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const createdUid = `991-${createdId}`;
    const desired = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: [{
        id: createdId,
        name: 'new',
        event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () {});'] } }],
        request: { method: 'GET', url: 'https://example.test/new' },
        response: [{
          name: 'ok',
          code: 200,
          status: 'OK',
          header: [],
          body: '{}',
          originalRequest: { method: 'GET', url: 'https://example.test/new' }
        }]
      }]
    };
    const snapshot = { ...desired, item: [] };
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan).toMatchObject({ decision: 'apply' });
    const { client, calls } = makeClient((env) => {
      if (env.method === 'get' && env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [] });
      }
      if (env.method === 'post' && env.path === `/v3/collections/${uid}/items/`) {
        const kind = String((env.body as { $kind?: string }).$kind);
        return jsonResponse({ data: { id: kind === 'http-example' ? '991-example-id' : createdUid } });
      }
      if (env.method === 'patch' && env.path === `/v3/collections/${uid}/items/${createdUid}`) {
        return jsonResponse({ data: {} });
      }
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, computePayloadDigest(desired)))
      .resolves.toEqual({ strategy: 'delta', observedPayloadDigest: computePayloadDigest(desired) });
    const creates = calls.filter((call) => call.method === 'post' && call.path.endsWith('/items/'));
    expect(creates.map((call) => (call.body as { $kind?: string }).$kind)).toEqual([
      'http-request',
      'http-example'
    ]);
    expect(creates[1]?.body).toMatchObject({
      position: { parent: { id: createdUid, $kind: 'http-request' } },
      response: { statusCode: 200, statusText: 'OK' }
    });
    expect(calls.find((call) => call.method === 'patch')?.body).toEqual([
      expect.objectContaining({ op: 'add', path: '/scripts' })
    ]);
  });

  it('serializes sibling creates so stable move anchors exist', async () => {
    const snapshot = { info: { name: 'Payments', schema, _postman_id: bare }, item: [] };
    const desired = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: [
        { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', name: 'one', request: { method: 'GET', url: 'https://example.test/one' } },
        { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', name: 'two', request: { method: 'GET', url: 'https://example.test/two' } },
        { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', name: 'three', request: { method: 'GET', url: 'https://example.test/three' } }
      ]
    };
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan.decision).toBe('apply');
    const digest = computePayloadDigest(desired);
    let active = 0;
    let maxActive = 0;
    const { client } = makeClient(async (env) => {
      if (env.method === 'get' && env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [] });
      }
      if (env.method === 'post' && env.path === `/v3/collections/${uid}/items/`) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        const name = String((env.body as { name?: string }).name);
        const idByName: Record<string, string> = {
          one: '991-cccccccc-cccc-cccc-cccc-cccccccccccc',
          two: '991-dddddddd-dddd-dddd-dddd-dddddddddddd',
          three: '991-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
        };
        return jsonResponse({ data: { id: idByName[name] } });
      }
      if (env.method === 'post' && env.path === '/v3/items/move') {
        const moved = (env.body as { items: Array<{ id: string }> }).items.map((item) => item.id);
        return jsonResponse({ data: { moved, failed: [] } });
      }
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toEqual({
      strategy: 'delta', observedPayloadDigest: digest
    });
    expect(maxActive).toBe(1);
    expect(client.collectionWriteMetrics.deltaRoutes).toEqual([
      'POST /v3/collections/{param}/items',
      'POST /v3/collections/{param}/items',
      'POST /v3/items/move',
      'POST /v3/collections/{param}/items',
      'POST /v3/items/move'
    ]);
  });

  it('serializes sibling patches against shared collection state', async () => {
    const ids = [
      requestId,
      'cccccccc-cccc-cccc-cccc-cccccccccccc',
      'dddddddd-dddd-dddd-dddd-dddddddddddd'
    ];
    const snapshot = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: ids.map((id, index) => ({
        id,
        name: `request-${index}`,
        description: 'stale',
        request: { method: 'GET', url: `https://example.test/${index}` }
      }))
    };
    const desired = structuredClone(snapshot);
    for (const item of desired.item) item.description = 'fresh';
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan).toMatchObject({ decision: 'apply' });
    let active = 0;
    let maxActive = 0;
    const { client } = makeClient(async (env) => {
      if (env.method === 'get' && env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: ids.map((id, index) => ({
          id: `991-${id}`,
          $kind: 'http-request',
          name: `request-${index}`
        })) });
      }
      if (env.method === 'patch') {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return jsonResponse({ data: {} });
      }
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, computePayloadDigest(desired)))
      .resolves.toMatchObject({ strategy: 'delta' });
    expect(maxActive).toBe(1);
  });

  it('records create, move, and delete routes only when each granular request is attempted', async () => {
    const oneId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const goneId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const oneUid = `991-${oneId}`;
    const goneUid = `991-${goneId}`;
    const snapshot = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: [
        { id: oneId, name: 'one', request: { method: 'GET', url: 'https://example.test/one' } },
        { id: goneId, name: 'gone', request: { method: 'GET', url: 'https://example.test/gone' } }
      ]
    };
    const desired = {
      info: { name: 'Payments', schema, _postman_id: bare },
      item: [
        { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', name: 'new', request: { method: 'GET', url: 'https://example.test/new' } },
        snapshot.item[0]
      ]
    };
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan).toMatchObject({ decision: 'apply' });
    const digest = computePayloadDigest(desired);
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/` && env.method === 'get') {
        return jsonResponse({ data: [
          { id: oneUid, $kind: 'http-request', name: 'one' },
          { id: goneUid, $kind: 'http-request', name: 'gone' }
        ] });
      }
      if (env.path === `/v3/collections/${uid}/items/` && env.method === 'post') {
        return jsonResponse({ data: { id: '991-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' } });
      }
      if (env.path === '/v3/items/move' && env.method === 'post') {
        const moved = (env.body as { items: Array<{ id: string }> }).items.map((item) => item.id);
        return jsonResponse({ data: { moved, failed: [] } });
      }
      if (env.method === 'patch' || env.method === 'delete') return jsonResponse({ data: {} });
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(desired);
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    expect(client.collectionWriteMetrics.deltaRoutes).toEqual([
      'DELETE /v3/collections/{param}/items/{param}',
      'POST /v3/collections/{param}/items',
      'POST /v3/items/move',
      'POST /v3/items/move'
    ]);
    const move = calls.find((call) => call.path === '/v3/items/move');
    expect(move?.body).toMatchObject({
      toPosition: { collectionId: uid, nextSibling: { id: oneUid } }
    });
    const leaked = client.collectionWriteMetrics.deltaRoutes;
    leaked.push('mutated externally');
    expect(client.collectionWriteMetrics.deltaRoutes).not.toContain('mutated externally');
  });

  it('converges create, delete, and reorder operations against stateful sibling positions', async () => {
    const prefixId = '11111111-1111-4111-8111-111111111111';
    const deletedId = '22222222-2222-4222-8222-222222222222';
    const firstId = '33333333-3333-4333-8333-333333333333';
    const secondId = '44444444-4444-4444-8444-444444444444';
    const createdId = '55555555-5555-4555-8555-555555555555';
    const publicId = (id: string) => `991-${id}`;
    const request = (id: string, name: string) => ({
      id,
      name,
      request: { method: 'GET', url: `https://example.test/${name}` }
    });
    const snapshotItems = [
      request(prefixId, 'prefix'),
      request(deletedId, 'deleted'),
      request(firstId, 'first'),
      request(secondId, 'second')
    ];
    const desiredItems = [
      snapshotItems[0]!,
      request(createdId, 'created'),
      snapshotItems[3]!,
      snapshotItems[2]!
    ];
    const snapshot = { info: { name: 'Payments', schema, _postman_id: bare }, item: snapshotItems };
    const desired = { info: { name: 'Payments', schema, _postman_id: bare }, item: desiredItems };
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan).toMatchObject({ decision: 'apply' });

    const byPublicId = new Map(
      [...snapshotItems, desiredItems[1]!].map((item) => [publicId(item.id), item])
    );
    const order = snapshotItems.map((item) => publicId(item.id));
    const { client } = makeClient((env) => {
      if (env.method === 'get' && env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: order.map((id) => ({ id, $kind: 'http-request' })) });
      }
      if (env.method === 'post' && env.path === `/v3/collections/${uid}/items/`) {
        order.push(publicId(createdId));
        return jsonResponse({ data: { id: publicId(createdId) } });
      }
      if (env.method === 'post' && env.path === '/v3/items/move') {
        const body = env.body as {
          items: Array<{ id: string }>;
          toPosition: { previousSibling?: { id: string }; nextSibling?: { id: string } };
        };
        const id = body.items[0]!.id;
        const from = order.indexOf(id);
        if (from >= 0) order.splice(from, 1);
        const previous = body.toPosition.previousSibling?.id;
        const next = body.toPosition.nextSibling?.id;
        if (previous) {
          order.splice(order.indexOf(previous) + 1, 0, id);
        } else if (next) {
          order.splice(order.indexOf(next), 0, id);
        } else {
          order.push(id);
        }
        return jsonResponse({ data: { moved: [id], failed: [] } });
      }
      if (env.method === 'delete') {
        const id = env.path.split('/').at(-1)!;
        const index = order.indexOf(id);
        if (index >= 0) order.splice(index, 1);
        return jsonResponse({ data: {} });
      }
      if (isPopulatedSyncSnapshot(env)) {
        return syncSnapshotResponse({
          info: desired.info,
          item: order.map((id) => structuredClone(byPublicId.get(id)!))
        });
      }
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, computePayloadDigest(desired)))
      .resolves.toMatchObject({ strategy: 'delta' });
    expect(order).toEqual(desiredItems.map((item) => publicId(item.id)));
  });

  it('records no granular routes for unchanged and pre-mutation fallback decisions', async () => {
    const unchanged = collection('https://example.test/same');
    const fallback: CollectionDeltaPlan = {
      decision: 'fallback' as const,
      reason: 'unsupported-root-attribute' as const,
      changedBytes: 0,
      operations: []
    };
    const { client } = makeClient((env) => {
      if (env.path === `/collection/deepupdate/${bare}`) return jsonResponse({ data: {} });
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });
    await expect(client.applyCollectionDelta(
      uid,
      { decision: 'unchanged', changedBytes: 0, operations: [] },
      unchanged,
      computePayloadDigest(unchanged)
    )).resolves.toMatchObject({ strategy: 'unchanged' });
    await expect(client.applyCollectionDelta(
      uid,
      fallback,
      unchanged,
      computePayloadDigest(unchanged)
    )).resolves.toMatchObject({ strategy: 'whole-fallback' });
    expect(client.collectionWriteMetrics.deltaRoutes).toEqual([]);
  });

  it('fails immediately on terminal delta validation errors without whole fallback', async () => {
    const snapshot = collection('https://example.test/stale');
    const desired = collection('https://example.test/fresh');
    const plan = planCollectionDelta({ snapshot, desired });
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [{ id: requestUid, $kind: 'http-request', name: 'GET /payments' }] });
      }
      if (env.path === `/v3/collections/${uid}/items/${requestUid}`) {
        return jsonResponse({ error: 'invalid patch' }, { status: 400 });
      }
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, computePayloadDigest(desired)))
      .rejects.toMatchObject({ status: 400 });
    expect(calls.some((call) => call.path.includes('/collection/deepupdate/'))).toBe(false);
  });

  it('fails closed and rolls back the supplied snapshot after a final digest mismatch', async () => {
    const snapshot = collection('https://example.test/stale');
    const desired = collection('https://example.test/fresh');
    const plan = planCollectionDelta({ snapshot, desired });
    const digest = computePayloadDigest(desired);
    const { client, calls } = makeClient((env) => {
      if (env.path === `/v3/collections/${uid}/items/`) {
        return jsonResponse({ data: [{ id: requestUid, $kind: 'http-request', name: 'GET /payments' }] });
      }
      if (env.path === `/v3/collections/${uid}/items/${requestUid}`) return jsonResponse({ data: {} });
      if (isPopulatedSyncSnapshot(env)) return syncSnapshotResponse(snapshot);
      if (env.path === `/collection/deepupdate/${bare}`) return jsonResponse({ data: {} });
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(
      client.applyCollectionDelta(uid, plan, desired, digest, {
        collection: snapshot,
        payloadDigest: computePayloadDigest(snapshot)
      })
    ).rejects.toThrow(/delta-digest-mismatch/);
    expect(calls.filter((call) => call.path === `/collection/deepupdate/${bare}`)).toHaveLength(1);
  });
});
