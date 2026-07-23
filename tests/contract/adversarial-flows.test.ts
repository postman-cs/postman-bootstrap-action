/**
 * Tier-2 adversarial full-flow tests: drive the REAL runAction through the
 * failure state machines the unit tests cover only client-by-client -
 * mid-run token expiry (401 -> re-mint -> retry), transient downstream 5xx
 * (backoff -> retry), 423-locked relation link retry, and local OpenAPI
 * import/fail-closed ownership. Fake timers absorb the real backoff sleeps
 * so the suite stays fast.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPlatformFake } from './platform-fake.js';
import { runContractAction, runWithFakeTimers } from './harness.js';

const BOTH = { 'postman-api-key': 'pmak-test', 'postman-access-token': 'stale-token' };

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

    // Fake timers absorb the identity-settle sleeps (spec create + per-collection
    // converge) that would otherwise push this full run past the test timeout.
    const result = await runWithFakeTimers(() =>
      runContractAction({ inputs: BOTH, fetchImpl: fake.fetch })
    );

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(staleRejections).toBe(1);
    expect(fake.state.mintCount).toBe(1);
    expect(fake.state.importPostCount).toBe(3);
    expect(fake.state.generationPostCount).toBe(0);
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
    expect(fake.state.importPostCount).toBe(3);
    expect(fake.state.generationPostCount).toBe(0);
  });

  it('retries a 423-locked specification collection link and completes', async () => {
    let locked = 0;
    const fake = createPlatformFake({
      org: false,
      override: ({ proxy }) => {
        if (
          proxy?.service === 'specification' &&
          proxy.method === 'put' &&
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
    expect(fake.state.importPostCount).toBe(3);
    expect(fake.state.generationPostCount).toBe(0);
    const ledger = JSON.parse(result.outputs['openapi-operation-ledger-json'] || '{}') as {
      counts?: { retries?: number; wholeCollectionImport?: number; specHubCollectionGeneration?: number };
    };
    expect(ledger.counts?.wholeCollectionImport).toBe(3);
    expect(ledger.counts?.specHubCollectionGeneration).toBe(0);
    expect(ledger.counts?.retries).toBeGreaterThanOrEqual(1);
  });

  it('imports three local OpenAPI roles with zero Spec Hub generation/task fanout', async () => {
    const fake = createPlatformFake({
      org: false,
      // Legacy generationTaskStatuses must remain inert for the OpenAPI path.
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
    expect(fake.state.importPostCount).toBe(3);
    expect(fake.state.generationPostCount).toBe(0);
    expect(fake.state.taskPollCount).toBe(0);
    expect(fake.state.deepUpdatePutCount).toBe(0);
    const ledger = JSON.parse(result.outputs['openapi-operation-ledger-json'] || '{}') as {
      counts?: {
        localConversion?: number;
        wholeCollectionImport?: number;
        deepUpdate?: number;
        specHubCollectionGeneration?: number;
        temporaryOpenApiSpecCreate?: number;
        postCreateScriptPatch?: number;
      };
    };
    expect(ledger.counts).toMatchObject({
      localConversion: 1,
      wholeCollectionImport: 3,
      deepUpdate: 0,
      specHubCollectionGeneration: 0,
      temporaryOpenApiSpecCreate: 0,
      postCreateScriptPatch: 0
    });
  });
});
