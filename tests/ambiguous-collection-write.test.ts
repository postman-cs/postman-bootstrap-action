/**
 * Ambiguous collection-write recovery contract.
 *
 * A deep update whose transport aborts mid-flight may still have been applied
 * upstream. These tests pin the recovery path: classify the abort as ambiguous,
 * verify convergence by bounded atomic Sync receipt reads, permit at most one
 * idempotent re-PUT, and fail closed when the desired digest never appears.
 * Time is injected, so no test sleeps on wall-clock.
 */
import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '@postman-cs/automation-core';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { renderCollectionSemanticReceipt } from '../src/lib/postman/collection-semantic-receipt.js';
import { computePayloadDigest } from '../src/lib/spec/local-openapi-collection-generation.js';

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

describe('ambiguous transport classification', () => {
  const loadClassifier = async () => import('../src/lib/postman/create-reconciliation.js');

  it('classifies a real runtime AbortError from an aborted fetch as ambiguous', async () => {
    const { isAmbiguousTransportError } = await loadClassifier();
    const controller = new AbortController();
    controller.abort();
    let observed: unknown;
    try {
      await fetch('http://127.0.0.1:1/never', { signal: controller.signal });
    } catch (error) {
      observed = error;
    }
    expect((observed as Error | undefined)?.name).toBe('AbortError');
    expect(isAmbiguousTransportError(observed)).toBe(true);
  });

  it('classifies DOMException aborts and both runtime abort message shapes as ambiguous', async () => {
    const { isAmbiguousTransportError } = await loadClassifier();
    expect(
      isAmbiguousTransportError(new DOMException('This operation was aborted', 'AbortError'))
    ).toBe(true);
    expect(
      isAmbiguousTransportError(new DOMException('The operation was aborted', 'AbortError'))
    ).toBe(true);
    expect(
      isAmbiguousTransportError(
        Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      )
    ).toBe(true);
    expect(
      isAmbiguousTransportError(
        Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' })
      )
    ).toBe(true);
  });

  it('keeps explicit non-transport validation and terminal 4xx failures terminal', async () => {
    const { isAmbiguousTransportError } = await loadClassifier();
    expect(
      isAmbiguousTransportError(
        Object.assign(new Error('SCHEMA_ENFORCED: invalid collection body'), { status: 400 })
      )
    ).toBe(false);
    expect(
      isAmbiguousTransportError(Object.assign(new Error('REJECTED_PATCH'), { status: 422 }))
    ).toBe(false);
    expect(
      isAmbiguousTransportError(Object.assign(new Error('forbidden'), { status: 403 }))
    ).toBe(false);
    expect(isAmbiguousTransportError(new Error('must update at least one attribute'))).toBe(false);
  });
});

describe('ambiguous deep-update recovery', () => {
  const bareId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const recoveryUid = `55363555-${bareId}`;

  function v21(name: string, requestName: string) {
    return {
      info: { name, schema: COLLECTION_SCHEMA, _postman_id: bareId, description: '' },
      item: [
        {
          name: requestName,
          request: { method: 'GET', url: 'https://example.test/payments' }
        }
      ]
    };
  }

  function makeRecoveryClient(
    handler: (env: Envelope, callIndex: number) => Response | Promise<Response>
  ): {
    client: PostmanGatewayAssetsClient;
    calls: RecordedCall[];
    sleeps: number[];
  } {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    let i = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url));
      const env = parsed.pathname === '/ws/proxy'
        ? JSON.parse(String((init as RequestInit).body)) as Envelope
        : {
            service: 'direct',
            method: String((init as RequestInit).method ?? 'GET').toLowerCase(),
            path: `${parsed.pathname}${parsed.search}`
          };
      const headers = Object.fromEntries(
        new Headers((init as RequestInit).headers).entries()
      ) as Record<string, string>;
      calls.push({ ...env, headers });
      return handler(env, i++);
    });
    const gateway = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok-1' }),
      fetchImpl,
      retryBaseDelayMs: 1,
      sleepImpl: async () => undefined
    });
    let clock = 0;
    const client = new PostmanGatewayAssetsClient({
      gateway,
      sleep: async (delayMs: number) => {
        sleeps.push(delayMs);
        clock += delayMs;
      },
      now: () => clock
    });
    return { client, calls, sleeps };
  }

  const isDeepUpdate = (env: Envelope) =>
    env.method === 'put' && env.path === `/collection/deepupdate/${bareId}`;
  const isReceiptRead = (env: Envelope) =>
    env.service === 'direct' &&
    env.method === 'get' &&
    env.path === `/collection/${recoveryUid}/sync?since_id=0&favorite=true&exclude=response%2Crequest`;

  function syncReceipt(document: ReturnType<typeof v21>): Response {
    const committed = structuredClone(document);
    committed.info.description = renderCollectionSemanticReceipt(
      committed.info.description,
      computePayloadDigest(committed)
    );
    return jsonResponse({
      entities: [{
        revision: 1,
        data: {
          uid: recoveryUid,
          name: committed.info.name,
          description: committed.info.description
        }
      }]
    });
  }

  function abortError(message: string): Error {
    return Object.assign(new Error(message), { name: 'AbortError' });
  }

  it('succeeds without a resend when an aborted write becomes digest-visible after delayed reads', async () => {
    const desired = v21('Payments', 'GET /payments');
    const stale = v21('Payments', 'GET /stale');
    const digest = computePayloadDigest(desired);

    let reads = 0;
    let puts = 0;
    const { client, sleeps } = makeRecoveryClient((env) => {
      if (isDeepUpdate(env)) {
        puts += 1;
        throw abortError('This operation was aborted');
      }
      if (isReceiptRead(env)) {
        reads += 1;
        return syncReceipt(reads >= 4 ? desired : stale);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.deepUpdateV2Collection(recoveryUid, desired, digest)).resolves.toBe(
      recoveryUid
    );
    expect(puts).toBe(1);
    expect(reads).toBe(4);
    expect(sleeps).toEqual([2500, 2500, 2500]);
    const metrics = client.collectionWriteMetrics;
    expect(metrics.ambiguousWrites).toBe(1);
    expect(metrics.convergedWithoutResend).toBe(1);
    expect(metrics.resendCount).toBe(0);
    expect(metrics.verifyPolls).toBe(4);
    expect(metrics.recoveryMs).toBe(7500);
  });

  it('permits at most one idempotent re-PUT and still requires a final digest match', async () => {
    const desired = v21('Payments', 'GET /payments');
    const stale = v21('Payments', 'GET /stale');
    const digest = computePayloadDigest(desired);

    let reads = 0;
    let puts = 0;
    const { client, sleeps } = makeRecoveryClient((env) => {
      if (isDeepUpdate(env)) {
        puts += 1;
        if (puts === 1) throw abortError('The operation was aborted');
        return jsonResponse({ data: {} });
      }
      if (isReceiptRead(env)) {
        reads += 1;
        // Desired bytes appear only after the single verified resend.
        return syncReceipt(puts >= 2 ? desired : stale);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.deepUpdateV2Collection(recoveryUid, desired, digest)).resolves.toBe(
      recoveryUid
    );
    expect(puts).toBe(2);
    // Full first budget (5 observations, 4 sleeps) then one converged read.
    expect(reads).toBe(6);
    expect(sleeps).toEqual([2500, 2500, 2500, 2500]);
    const metrics = client.collectionWriteMetrics;
    expect(metrics.resendCount).toBe(1);
    expect(metrics.convergedWithoutResend).toBe(0);
    expect(metrics.verifyPolls).toBe(6);
  });

  it('fails closed after a persistent digest mismatch across both bounded budgets', async () => {
    const desired = v21('Payments', 'GET /payments');
    const stale = v21('Payments', 'GET /stale');
    const digest = computePayloadDigest(desired);

    let reads = 0;
    let puts = 0;
    const { client, sleeps } = makeRecoveryClient((env) => {
      if (isDeepUpdate(env)) {
        puts += 1;
        throw abortError('This operation was aborted');
      }
      if (isReceiptRead(env)) {
        reads += 1;
        return syncReceipt(stale);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.deepUpdateV2Collection(recoveryUid, desired, digest)).rejects.toThrow(
      /ambiguous-deep-update-digest-mismatch/
    );
    expect(puts).toBe(2);
    expect(reads).toBe(10);
    expect(sleeps).toHaveLength(8);
    expect(client.collectionWriteMetrics.resendCount).toBe(1);
  });

  it('never polls or resends after a terminal 4xx deep-update rejection', async () => {
    const desired = v21('Payments', 'GET /payments');
    const digest = computePayloadDigest(desired);

    let reads = 0;
    let puts = 0;
    const { client } = makeRecoveryClient((env) => {
      if (isDeepUpdate(env)) {
        puts += 1;
        return new Response('{"error":"SCHEMA_ENFORCED"}', { status: 400 });
      }
      if (isReceiptRead(env)) {
        reads += 1;
        return syncReceipt(desired);
      }
      return jsonResponse({ data: {} });
    });

    await expect(client.deepUpdateV2Collection(recoveryUid, desired, digest)).rejects.toThrow(
      /400|SCHEMA_ENFORCED|deep-update-transport/i
    );
    expect(puts).toBe(1);
    expect(reads).toBe(0);
    expect(client.collectionWriteMetrics.ambiguousWrites).toBe(0);
  });
});
