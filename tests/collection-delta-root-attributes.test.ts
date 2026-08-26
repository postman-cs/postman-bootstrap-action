/**
 * Root-attribute delta regression.
 *
 * A change confined to root attributes outside info/item - auth, variable,
 * event - has no granular delta operation. The planner previously returned an
 * `apply` decision carrying zero operations for those inputs, which converges
 * nothing and would leave the remote collection stale while reporting success.
 * Such a change must fall back to the whole-tree write instead.
 */
import { describe, expect, it } from 'vitest';

import { planCollectionDelta } from '../src/lib/spec/collection-delta.js';

const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function request(id: string, name: string, url = `https://example.test/${name}`) {
  return { id, name, request: { method: 'GET', url } };
}

function withRoot(extra: Record<string, unknown>) {
  return {
    info: { name: 'Payments', schema },
    item: [request('i-1', 'payments')],
    ...extra
  };
}

describe('root attribute fallback', () => {
  it('falls back for a root auth change instead of planning a zero-operation apply', () => {
    expect(
      planCollectionDelta({
        snapshot: withRoot({ auth: { type: 'basic' } }),
        desired: withRoot({ auth: { type: 'bearer' } })
      })
    ).toEqual({
      decision: 'fallback',
      reason: 'unsupported-root-attribute',
      changedBytes: 0,
      operations: []
    });
  });

  it('falls back for a root variable change', () => {
    const result = planCollectionDelta({
      snapshot: withRoot({ variable: [{ key: 'host', value: 'a' }] }),
      desired: withRoot({ variable: [{ key: 'host', value: 'b' }] })
    });
    expect(result.decision).toBe('fallback');
    expect(result.operations).toEqual([]);
  });

  it('falls back when a root attribute is added or removed', () => {
    expect(
      planCollectionDelta({ snapshot: withRoot({}), desired: withRoot({ auth: { type: 'bearer' } }) }).decision
    ).toBe('fallback');
    expect(
      planCollectionDelta({ snapshot: withRoot({ auth: { type: 'bearer' } }), desired: withRoot({}) }).decision
    ).toBe('fallback');
  });

  it('never returns an apply decision with an empty operation list', () => {
    const result = planCollectionDelta({
      snapshot: withRoot({ auth: { type: 'basic' } }),
      desired: withRoot({ auth: { type: 'bearer' } })
    });
    expect(result.decision === 'apply' && result.operations.length === 0).toBe(false);
  });

  it('still plans a normal request change when root attributes match', () => {
    const result = planCollectionDelta({
      snapshot: withRoot({ auth: { type: 'basic' } }),
      desired: {
        ...withRoot({ auth: { type: 'basic' } }),
        item: [request('i-1', 'payments', 'https://example.test/payments?v=2')]
      }
    });
    expect(result.decision).toBe('apply');
    expect(result.operations.length).toBeGreaterThan(0);
  });
});