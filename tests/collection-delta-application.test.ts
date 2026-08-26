import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '@postman-cs/automation-core';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { planCollectionDelta } from '../src/lib/spec/collection-delta.js';
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
  body?: unknown;
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, ...init });
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
      if (env.path === `/v3/collections/${bare}/export`) return jsonResponse({ data: { collection: desired } });
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    const patch = calls.find((call) => call.method === 'patch');
    expect(patch?.path).toBe(`/v3/collections/${uid}/items/${requestUid}`);
    expect(patch?.headers['x-entity-type']).toBe('http-request');
    expect(calls.filter((call) => call.path.endsWith('/export'))).toHaveLength(1);
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
      if (env.path === `/v3/collections/${bare}/export`) return jsonResponse({ data: { collection: desired } });
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    expect(calls.filter((call) => call.method === 'patch')).toHaveLength(1);
    expect(client.collectionWriteMetrics.ambiguousWrites).toBe(1);
  });

  it('creates independent siblings with bounded concurrency of two', async () => {
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
        return jsonResponse({ data: { id: `${active + 800}-new-item` } });
      }
      if (env.path === `/v3/collections/${bare}/export`) return jsonResponse({ data: { collection: desired } });
      return jsonResponse({ error: `unexpected ${env.path}` }, { status: 500 });
    });

    await expect(client.applyCollectionDelta(uid, plan, desired, digest)).resolves.toMatchObject({ strategy: 'delta' });
    expect(maxActive).toBe(2);
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
      if (env.path === `/v3/collections/${bare}/export`) return jsonResponse({ data: { collection: snapshot } });
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
