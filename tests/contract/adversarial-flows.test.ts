/**
 * Tier-2 adversarial full-flow tests: drive the REAL runAction through the
 * failure state machines the unit tests cover only client-by-client -
 * mid-run token expiry (401 -> re-mint -> retry), transient downstream 5xx
 * (backoff -> retry), the 423-locked generation create, and the async
 * generation task poll (pending -> completed). Fake timers absorb the real
 * backoff sleeps so the suite stays fast.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlatformFake } from './platform-fake.js';
import { runContractAction } from './harness.js';

const BOTH = { 'postman-api-key': 'pmak-test', 'postman-access-token': 'stale-token' };

async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = fn();
    // Flush every timer chain (retry backoffs, generation poll sleeps) until
    // the run settles. runAllTimersAsync processes timers scheduled by timers.
    let settled = false;
    const settle = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    while (!settled) {
      await vi.runAllTimersAsync();
      // Yield the microtask queue so `settled` can flip between timer flushes.
      await Promise.resolve();
    }
    return settle;
  } finally {
    vi.useRealTimers();
  }
}

describe('contract: adversarial flows', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-mints the access token on a mid-run 401 UNAUTHENTICATED and retries the same request', async () => {
    let staleRejections = 0;
    const fake = createPlatformFake({
      org: false,
      override: ({ proxy, init }) => {
        if (!proxy) return undefined;
        const token = String(
          (init?.headers as Record<string, string> | undefined)?.['x-access-token'] ?? ''
        );
        if (token === 'stale-token' && proxy.service === 'workspaces' && proxy.method === 'post') {
          staleRejections += 1;
          return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
            status: 401
          });
        }
        return undefined;
      }
    });

    const result = await runContractAction({ inputs: BOTH, fetchImpl: fake.fetch });

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(staleRejections).toBe(1);
    expect(fake.state.mintCount).toBe(1);
  });

  it('retries a transient safe-read 5xx with backoff and completes', async () => {
    let injected = 0;
    const fake = createPlatformFake({
      org: false,
      override: ({ proxy }) => {
        // Wave 2: unsafe creates do not blind-retry. Prove safe GETs still retry.
        if (
          proxy?.service === 'workspaces' &&
          proxy.method === 'get' &&
          proxy.path.startsWith('/workspaces') &&
          injected === 0
        ) {
          injected += 1;
          return new Response('ESOCKETTIMEDOUT', { status: 500 });
        }
        return undefined;
      }
    });

    const result = await runWithFakeTimers(() =>
      runContractAction({
        inputs: { 'postman-api-key': 'pmak-test', 'postman-access-token': 'access-token-test' },
        fetchImpl: fake.fetch
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(injected).toBe(1);
    expect(fake.state.workspaceCreateBodies).toHaveLength(1);
  });

  it('retries a 423-locked generation create and completes', async () => {
    let locked = 0;
    const fake = createPlatformFake({
      org: false,
      override: ({ proxy }) => {
        if (
          proxy?.service === 'specification' &&
          proxy.method === 'post' &&
          /\/specifications\/[^/]+\/collections$/.test(proxy.path) &&
          locked === 0
        ) {
          locked += 1;
          return new Response(JSON.stringify({ error: 'locked' }), { status: 423 });
        }
        return undefined;
      }
    });

    const result = await runWithFakeTimers(() =>
      runContractAction({
        inputs: { 'postman-api-key': 'pmak-test', 'postman-access-token': 'access-token-test' },
        fetchImpl: fake.fetch
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(locked).toBe(1);
    expect(fake.state.generationPostCount).toBeGreaterThanOrEqual(1);
  });

  it('polls the async generation task through pending -> completed', async () => {
    const fake = createPlatformFake({
      org: false,
      generationTaskStatuses: ['pending', 'in-progress', 'completed']
    });

    const result = await runWithFakeTimers(() =>
      runContractAction({
        inputs: { 'postman-api-key': 'pmak-test', 'postman-access-token': 'access-token-test' },
        fetchImpl: fake.fetch
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.taskPollCount).toBeGreaterThanOrEqual(2);
  });
});
