import { describe, expect, it } from 'vitest';

import {
  COLLECTION_DELTA_MAX_CHANGED_BYTES,
  COLLECTION_DELTA_MAX_OPERATIONS,
  planCollectionDelta
} from '../src/lib/spec/collection-delta.js';
import { computePayloadDigest } from '../src/lib/spec/local-openapi-collection-generation.js';

describe('planCollectionDelta contract root-script pinning', () => {
  const rootScript = (code: string) => ({
    listen: 'test',
    script: { type: 'text/javascript', exec: [code] }
  });

  it('takes whole-update fallback when the consolidated root script changes', () => {
    // The shared validator rides a collection-root event, and no granular root
    // script transport exists, so a runtime change must fall back rather than
    // silently skip re-persisting the validator.
    const snapshot = { ...collection([structuralRequest('item-1', 'pay')]), event: [rootScript('var __contractRoutes = 1;')] };
    const desired = { ...collection([structuralRequest('item-1', 'pay')]), event: [rootScript('var __contractRoutes = 2;')] };
    expect(planCollectionDelta({ snapshot, desired })).toEqual({
      decision: 'fallback',
      reason: 'unsupported-root-attribute',
      changedBytes: 0,
      operations: []
    });
  });

  it('takes script-transform fallback when a folder or request event changes', () => {
    const withEvent = (code: string) => ({
      id: 'folder-1',
      name: 'pay',
      item: [structuralRequest('item-1', 'pay')],
      event: [rootScript(code)]
    });
    const plan = planCollectionDelta({
      snapshot: collection([withEvent('var a = 1;')]),
      desired: collection([withEvent('var a = 2;')])
    });
    expect(plan.decision).toBe('fallback');
    if (plan.decision !== 'fallback') return;
    expect(plan.reason).toBe('unsupported-script-transform');
  });

  it('still applies a description-only change beside a stable root script', () => {
    const event = [rootScript('var __contractRoutes = 1;')];
    const snapshot = { ...collection([structuralRequest('item-1', 'pay', 'before')]), event };
    const desired = { ...collection([structuralRequest('item-1', 'pay', 'after')]), event };
    const plan = planCollectionDelta({ snapshot, desired });
    expect(plan.decision).toBe('apply');
    if (plan.decision !== 'apply') return;
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0]!.kind).toBe('patch');
    expect(plan.operations[0]!.patchFields).toEqual(['description']);
  });
});
const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function collection(items: unknown[] = []) {
  return { info: { name: 'Payments', schema }, item: items };
}

function request(id: string, name: string, url = `https://example.test/${name}`) {
  return { id, name, request: { method: 'GET', url } };
}

function structuralRequest(id: string, name: string, description = '') {
  return {
    id,
    name,
    description,
    request: {
      id: `${id}-request`,
      method: 'GET',
      url: `https://example.test/${name}`,
      body: { mode: 'raw', metadata: { id: `business-${name}` } }
    },
    response: [{ id: `${id}-response`, name: '200', code: 200, body: `{"id":"${name}"}` }]
  };
}

function independentlyRekey(collectionValue: ReturnType<typeof collection>, prefix: string) {
  const value = structuredClone(collectionValue);
  let sequence = 0;
  const visit = (items: unknown[]): void => {
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      item.id = `${prefix}-item-${sequence}`;
      sequence += 1;
      if (item.request && typeof item.request === 'object') {
        (item.request as Record<string, unknown>).id = `${prefix}-request-${sequence}`;
        sequence += 1;
      }
      if (Array.isArray(item.response)) {
        for (const response of item.response as Array<Record<string, unknown>>) {
          response.id = `${prefix}-response-${sequence}`;
          sequence += 1;
        }
      }
      if (Array.isArray(item.item)) visit(item.item);
    }
  };
  visit(value.item);
  return value;
}

describe('planCollectionDelta', () => {
  it('returns unchanged for digest-equal collections before emitting operations', () => {
    const snapshot = collection([request('one', 'one')]);
    const result = planCollectionDelta({ snapshot, desired: structuredClone(snapshot) });
    expect(result).toEqual({ decision: 'unchanged', changedBytes: 0, operations: [] });
  });

  it('uses Sync-canonical root semantics when planning an item patch', () => {
    const snapshot = {
      ...collection([request('one', 'one')]),
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] }
    };
    const desired = {
      ...collection([request('one', 'one', 'https://example.test/changed')]),
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] }
    };

    expect(planCollectionDelta({ snapshot, desired })).toMatchObject({
      decision: 'apply',
      operations: [expect.objectContaining({ kind: 'patch', key: 'id:one' })]
    });
    desired.auth.bearer[0]!.value = '{{different}}';
    expect(planCollectionDelta({ snapshot, desired })).toMatchObject({
      decision: 'fallback',
      reason: 'unsupported-root-attribute'
    });
  });

  it('uses Sync-canonical guarded fields when planning an item patch', () => {
    const snapshotItem = {
      ...request('one', 'one'),
      event: [{ listen: 'test', script: { exec: ['line one', 'line two'] } }],
      response: [{
        id: 'response-a',
        name: 'ok',
        originalRequest: { id: 'request-a', method: 'GET', url: 'https://example.test/one' }
      }]
    };
    const desiredItem = {
      ...request('one', 'one', 'https://example.test/changed'),
      event: [{ listen: 'test', script: { exec: ['line one\nline two'] } }],
      response: [{
        id: 'response-b',
        name: 'ok',
        originalRequest: { id: 'request-b', method: 'GET', url: 'https://example.test/one' }
      }]
    };

    expect(planCollectionDelta({
      snapshot: collection([snapshotItem]),
      desired: collection([desiredItem])
    })).toMatchObject({
      decision: 'apply',
      operations: [expect.objectContaining({ kind: 'patch', key: 'id:one' })]
    });
    desiredItem.event[0]!.script.exec = ['changed'];
    expect(planCollectionDelta({
      snapshot: collection([snapshotItem]),
      desired: collection([desiredItem])
    })).toMatchObject({ decision: 'fallback', reason: 'unsupported-script-transform' });
  });

  it('does not emit patches for Sync-equivalent request representations', () => {
    const snapshot = collection([
      request('one', 'one'),
      { id: 'two', name: 'two', request: { method: 'GET', header: [], url: 'https://example.test/two' } }
    ]);
    const desired = collection([
      { ...request('one', 'one'), description: 'changed' },
      {
        id: 'two',
        name: 'two',
        request: {
          method: 'GET',
          url: { raw: 'https://example.test/two', protocol: 'https', host: ['example', 'test'] }
        }
      }
    ]);

    const result = planCollectionDelta({ snapshot, desired });
    expect(result).toMatchObject({ decision: 'apply' });
    if (result.decision !== 'apply') return;
    expect(result.operations).toEqual([
      expect.objectContaining({ kind: 'patch', key: 'id:one' })
    ]);
  });

  it('does not emit moves for Sync-equivalent folder and request partitions', () => {
    const folderOne = { id: 'folder-one', name: 'Folder one', item: [request('one', 'one')] };
    const folderTwo = { id: 'folder-two', name: 'Folder two', item: [request('two', 'two')] };
    const helper = request('helper', '00 - Resolve Secrets');
    const snapshot = collection([folderOne, folderTwo, helper]);
    const desired = collection([
      helper,
      folderOne,
      { ...folderTwo, description: 'changed' }
    ]);

    const result = planCollectionDelta({ snapshot, desired });
    expect(result).toMatchObject({ decision: 'apply' });
    if (result.decision !== 'apply') return;
    expect(result.operations).toEqual([
      expect.objectContaining({ kind: 'patch', key: 'id:folder-two' })
    ]);
  });

  it('counts only transported patch fields against the changed-byte ceiling', () => {
    const largeUnchangedScript = [{
      listen: 'test',
      script: { exec: ['x'.repeat(COLLECTION_DELTA_MAX_CHANGED_BYTES)] }
    }];
    const snapshotItem = { ...request('one', 'one'), event: largeUnchangedScript };
    const desiredItem = { ...snapshotItem, description: 'changed' };
    const result = planCollectionDelta({
      snapshot: collection([snapshotItem]),
      desired: collection([desiredItem])
    });

    expect(result).toMatchObject({ decision: 'apply' });
    if (result.decision !== 'apply') return;
    expect(result.changedBytes).toBeLessThan(COLLECTION_DELTA_MAX_CHANGED_BYTES);
  });

  it('plans deterministic child-before-parent deletes before create and patch operations', () => {
    const snapshot = collection([
      { id: 'folder', name: 'Old folder', item: [request('old-child', 'old-child')] },
      request('one', 'one', 'https://example.test/stale'),
      request('gone', 'gone')
    ]);
    const desired = collection([
      request('one', 'one', 'https://example.test/stale'),
      { id: 'folder', name: 'Renamed folder', item: [request('new-child', 'new-child')] }
    ]);

    const result = planCollectionDelta({ snapshot, desired });
    expect(result.decision).toBe('apply');
    if (result.decision !== 'apply') return;
    expect(result.operations.map((operation) => operation.kind)).toEqual([
      'delete', 'delete', 'create', 'patch'
    ]);
    expect(result.operations.map((operation) => operation.key)).toEqual([
      'id:old-child', 'id:gone', 'id:new-child', 'id:folder'
    ]);
    expect(result.changedBytes).toBeGreaterThan(0);
  });

  it('allows complete scripts and saved responses on a newly created request', () => {
    const created = {
      ...request('new', 'new'),
      event: [{ listen: 'test', script: { exec: ['pm.test("ok", function () {});'] } }],
      response: [{ name: 'ok', code: 200, body: '{}' }],
      protocolProfileBehavior: { disableBodyPruning: true }
    };
    const result = planCollectionDelta({ snapshot: collection(), desired: collection([created]) });
    expect(result).toMatchObject({
      decision: 'apply',
      operations: [expect.objectContaining({ kind: 'create', key: 'id:new' })]
    });
  });

  it('creates a new folder shell before its independently planned child', () => {
    const result = planCollectionDelta({
      snapshot: collection(),
      desired: collection([{ id: 'folder', name: 'folder', item: [request('child', 'child')] }])
    });
    expect(result).toMatchObject({ decision: 'apply' });
    if (result.decision !== 'apply') return;
    expect(result.operations).toHaveLength(2);
    expect(result.operations[0]).toMatchObject({
      kind: 'create', entityType: 'collection', item: { item: [] }
    });
    expect(result.operations[1]).toMatchObject({
      kind: 'create', entityType: 'http-request', parentKey: 'id:folder'
    });
  });

  it('falls back when the frozen five-operation ceiling is exceeded', () => {
    const result = planCollectionDelta({
      snapshot: collection(),
      desired: collection(Array.from({ length: COLLECTION_DELTA_MAX_OPERATIONS + 1 }, (_, index) =>
        request(`id-${index}`, `request-${index}`)
      ))
    });
    expect(COLLECTION_DELTA_MAX_OPERATIONS).toBe(5);
    expect(result).toMatchObject({ decision: 'fallback', reason: 'operation-count-exceeded' });
  });

  it('falls back when the frozen 64 KiB changed-byte ceiling is exceeded', () => {
    const result = planCollectionDelta({
      snapshot: collection([request('one', 'one')]),
      desired: collection([request('one', 'one', `https://example.test/${'x'.repeat(65 * 1024)}`)])
    });
    expect(COLLECTION_DELTA_MAX_CHANGED_BYTES).toBe(64 * 1024);
    expect(result).toMatchObject({ decision: 'fallback', reason: 'changed-bytes-exceeded' });
  });

  it('falls back instead of guessing a duplicate semantic key or unsupported transform', () => {
    const duplicate = planCollectionDelta({
      snapshot: collection([request('', 'same'), request('', 'same')]),
      desired: collection([request('', 'same'), request('', 'same', 'https://example.test/changed')])
    });
    expect(duplicate).toMatchObject({ decision: 'fallback', reason: 'ambiguous-semantic-key' });

    const response = planCollectionDelta({
      snapshot: collection([request('one', 'one')]),
      desired: collection([{ ...request('one', 'one'), response: [{ name: '200', code: 200 }] }])
    });
    expect(response).toMatchObject({ decision: 'fallback', reason: 'unsupported-response-transform' });

    const script = planCollectionDelta({
      snapshot: collection([request('one', 'one')]),
      desired: collection([{ ...request('one', 'one'), event: [{ listen: 'test', script: { exec: ['pm.test()'] } }] }])
    });
    expect(script).toMatchObject({ decision: 'fallback', reason: 'unsupported-script-transform' });

    const auth = planCollectionDelta({
      snapshot: collection([request('one', 'one')]),
      desired: collection([{ ...request('one', 'one'), auth: { type: 'bearer' } }])
    });
    expect(auth).toMatchObject({ decision: 'fallback', reason: 'unsupported-auth-transform' });

    const example = planCollectionDelta({
      snapshot: collection([request('one', 'one')]),
      desired: collection([{ ...request('one', 'one'), example: { value: 'sample' } }])
    });
    expect(example).toMatchObject({ decision: 'fallback', reason: 'unsupported-example-transform' });

    const workflow = planCollectionDelta({
      snapshot: collection([request('one', 'one')]),
      desired: { ...collection([request('one', 'one')]), workflows: [{ id: 'workflow' }] }
    });
    expect(workflow).toMatchObject({ decision: 'fallback', reason: 'unsupported-workflow-shape' });
  });

  it('has a stable plan and unchanged digest for structurally rekeyed input', () => {
    const snapshot = collection([request('one', 'one')]);
    const desired = collection([request('two', 'one')]);
    expect(computePayloadDigest(snapshot)).toBe(computePayloadDigest(desired));
    expect(planCollectionDelta({ snapshot, desired })).toEqual({
      decision: 'unchanged',
      changedBytes: 0,
      operations: []
    });
  });

  it('normalizes independently rekeyed structural ids before planning bounded patches', () => {
    const snapshot = collection([
      structuralRequest('snapshot-one', 'one'),
      structuralRequest('snapshot-two', 'two'),
      structuralRequest('snapshot-three', 'three'),
      structuralRequest('snapshot-four', 'four'),
      structuralRequest('snapshot-five', 'five')
    ]);
    const unchanged = independentlyRekey(snapshot, 'desired-unchanged');
    expect(planCollectionDelta({ snapshot, desired: unchanged })).toEqual({
      decision: 'unchanged', changedBytes: 0, operations: []
    });

    const oneChanged = independentlyRekey(snapshot, 'desired-one');
    (oneChanged.item[0] as Record<string, unknown>).description = 'changed once';
    (((oneChanged.item[0] as Record<string, unknown>).request as Record<string, unknown>).body as Record<string, unknown>).metadata = {
      id: 'business-one-desired'
    };
    const one = planCollectionDelta({ snapshot, desired: oneChanged });
    expect(one).toMatchObject({ decision: 'apply' });
    if (one.decision !== 'apply') return;
    expect(one.operations).toHaveLength(1);
    expect(one.operations[0]).toMatchObject({
      kind: 'patch',
      sourceId: 'snapshot-one',
      item: { id: 'snapshot-one', request: { id: 'snapshot-one-request' } }
    });
    expect((one.operations[0]?.item.request as Record<string, unknown>).body).toEqual({
      mode: 'raw', metadata: { id: 'business-one-desired' }
    });

    const fiveChanged = independentlyRekey(snapshot, 'desired-five');
    for (const item of fiveChanged.item as Array<Record<string, unknown>>) {
      item.description = `changed ${item.name as string}`;
    }
    const five = planCollectionDelta({ snapshot, desired: fiveChanged });
    expect(five.decision).toBe('apply');
    if (five.decision !== 'apply') return;
    expect(five.operations).toHaveLength(5);
    expect(five.operations.map((operation) => operation.kind)).toEqual([
      'patch', 'patch', 'patch', 'patch', 'patch'
    ]);
    expect(five.operations.map((operation) => operation.sourceId).sort()).toEqual([
      'snapshot-five', 'snapshot-four', 'snapshot-one', 'snapshot-three', 'snapshot-two'
    ]);
  });

  it('plans proven rekeyed sibling moves and bounded add/delete/move combinations', () => {
    const snapshot = collection([
      structuralRequest('snapshot-one', 'one'),
      structuralRequest('snapshot-two', 'two'),
      structuralRequest('snapshot-gone', 'gone')
    ]);
    const reorder = independentlyRekey(snapshot, 'desired-reorder');
    reorder.item = [reorder.item[1]!, reorder.item[0]!, reorder.item[2]!];
    const moved = planCollectionDelta({ snapshot, desired: reorder });
    expect(moved).toMatchObject({ decision: 'apply' });
    if (moved.decision !== 'apply') return;
    expect(moved.operations).toHaveLength(1);
    expect(moved.operations[0]).toMatchObject({ kind: 'move', sourceId: 'snapshot-one', index: 1 });

    const mixed = independentlyRekey(snapshot, 'desired-mixed');
    mixed.item = [
      mixed.item[1]!,
      mixed.item[0]!,
      request('desired-new', 'new')
    ];
    const result = planCollectionDelta({ snapshot, desired: mixed });
    expect(result).toMatchObject({ decision: 'apply' });
    if (result.decision !== 'apply') return;
    expect(result.operations).toHaveLength(3);
    expect(result.operations.map((operation) => operation.kind).sort()).toEqual([
      'create', 'delete', 'move'
    ]);
    expect(result.operations.find((operation) => operation.kind === 'move')).toMatchObject({
      sourceId: 'snapshot-one',
      index: 1
    });

    const crossParentSnapshot = collection([
      { id: 'folder-a', name: 'A', item: [structuralRequest('snapshot-cross', 'cross')] },
      { id: 'folder-b', name: 'B', item: [] }
    ]);
    const crossParentDesired = structuredClone(crossParentSnapshot);
    const movedRequest = (crossParentDesired.item[0] as { item: unknown[] }).item.pop()!;
    (crossParentDesired.item[1] as { item: unknown[] }).item.push(movedRequest);
    const crossParent = planCollectionDelta({ snapshot: crossParentSnapshot, desired: crossParentDesired });
    expect(crossParent).toMatchObject({ decision: 'apply' });
    if (crossParent.decision !== 'apply') return;
    expect(crossParent.operations).toEqual([
      expect.objectContaining({ kind: 'move', sourceId: 'snapshot-cross' })
    ]);
  });

  it('fails closed when independently rekeyed semantic identity is ambiguous', () => {
    const snapshot = collection([
      structuralRequest('snapshot-one', 'duplicate'),
      structuralRequest('snapshot-two', 'duplicate')
    ]);
    const desired = independentlyRekey(snapshot, 'desired-duplicate');
    expect(planCollectionDelta({ snapshot, desired })).toMatchObject({
      decision: 'fallback', reason: 'ambiguous-semantic-key'
    });
  });
});
