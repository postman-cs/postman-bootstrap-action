import { describe, expect, it, vi } from 'vitest';

import {
  buildTemporarySpecName,
  generateCollectionsWithSpecFanout,
  type CollectionGenerationRole,
  type GenerateCollectionsWithSpecFanoutOptions
} from '../src/lib/postman/collection-generation-fanout.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

const roles: CollectionGenerationRole[] = [
  { role: 'baseline', prefix: '' },
  { role: 'smoke', prefix: '[Smoke]' },
  { role: 'contract', prefix: '[Contract]' }
];

function baseOptions(
  overrides: Partial<GenerateCollectionsWithSpecFanoutOptions> &
    Pick<GenerateCollectionsWithSpecFanoutOptions, 'postman'>
): GenerateCollectionsWithSpecFanoutOptions {
  return {
    assetName: 'Payments',
    canonicalSpecId: 'spec-canonical',
    folderStrategy: 'Paths',
    identity: () => 'run-1',
    nestedFolderHierarchy: true,
    openapiVersion: '3.1',
    requestNameSource: 'Fallback',
    roles,
    source: { kind: 'single', content: 'openapi: 3.1.0' },
    workspaceId: 'workspace-1',
    ...overrides
  };
}

describe('collection generation fan-out', () => {
  it('starts all three generation tasks before any finishes, links temp results, then deletes temp specs', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<string>>>();
    const events: string[] = [];
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async (specId: string) => {
        events.push(`delete:${specId}`);
      }),
      generateCollection: vi.fn(async (specId: string, _name: string, prefix: string) => {
        const role = prefix === '' ? 'baseline' : prefix === '[Smoke]' ? 'smoke' : 'contract';
        events.push(`generate:${role}:${specId}`);
        const task = deferred<string>();
        pending.set(role, task);
        return task.promise;
      }),
      uploadSpecWithOutcome: vi
        .fn()
        .mockResolvedValueOnce({ specId: 'spec-smoke-temp', created: true })
        .mockResolvedValueOnce({ specId: 'spec-contract-temp', created: true })
    };
    const integration = {
      linkCollectionsToSpecification: vi.fn(async () => {
        events.push('link');
      })
    };

    const run = generateCollectionsWithSpecFanout(baseOptions({ integration, postman }));
    await vi.waitFor(() => expect(pending.size).toBe(3));
    expect(events.filter((event) => event.startsWith('delete:'))).toEqual([]);

    pending.get('contract')!.resolve('collection-contract');
    pending.get('baseline')!.resolve('collection-baseline');
    pending.get('smoke')!.resolve('collection-smoke');

    await expect(run).resolves.toMatchObject({
      collections: {
        baseline: 'collection-baseline',
        smoke: 'collection-smoke',
        contract: 'collection-contract'
      },
      diagnostic: { strategy: 'fanout', freshRoles: 3, temporarySpecs: 2 }
    });
    expect(integration.linkCollectionsToSpecification).toHaveBeenCalledWith(
      'spec-canonical',
      expect.arrayContaining([
        { collectionId: 'collection-smoke' },
        { collectionId: 'collection-contract' }
      ])
    );
    expect(events.indexOf('link')).toBeLessThan(events.indexOf('delete:spec-smoke-temp'));
    expect(events.indexOf('link')).toBeLessThan(events.indexOf('delete:spec-contract-temp'));
  });

  it('starts canonical generation and both temporary uploads in parallel', async () => {
    const smokeUpload = deferred<{ specId: string; created: boolean }>();
    const contractUpload = deferred<{ specId: string; created: boolean }>();
    const generateCollection = vi.fn(async (_specId: string, _name: string, prefix: string) =>
      prefix || 'baseline'
    );
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection,
      uploadSpecWithOutcome: vi
        .fn()
        .mockImplementationOnce(() => smokeUpload.promise)
        .mockImplementationOnce(() => contractUpload.promise)
    };

    const run = generateCollectionsWithSpecFanout(
      baseOptions({
        integration: { linkCollectionsToSpecification: vi.fn(async () => undefined) },
        postman
      })
    );

    await vi.waitFor(() => expect(postman.uploadSpecWithOutcome).toHaveBeenCalledTimes(2));
    expect(generateCollection).toHaveBeenCalledWith(
      'spec-canonical',
      'Payments',
      '',
      'Paths',
      true,
      'Fallback'
    );
    smokeUpload.resolve({ specId: 'spec-smoke-temp', created: true });
    contractUpload.resolve({ specId: 'spec-contract-temp', created: true });
    await run;
  });

  it('uses serial canonical generation when the kill switch is off', async () => {
    const active = { value: 0 };
    let maxActive = 0;
    const postman = {
      generateCollection: vi.fn(async (_specId: string, _name: string, prefix: string) => {
        active.value += 1;
        maxActive = Math.max(maxActive, active.value);
        await Promise.resolve();
        active.value -= 1;
        return prefix || 'baseline';
      })
    };

    const result = await generateCollectionsWithSpecFanout(
      baseOptions({ env: { POSTMAN_COLLECTION_GENERATION_FANOUT: 'off' }, postman })
    );

    expect(result.diagnostic.strategy).toBe('serial');
    expect(maxActive).toBe(1);
    expect(postman.generateCollection).toHaveBeenCalledTimes(3);
    expect(postman.generateCollection.mock.calls.map((call) => call[0])).toEqual([
      'spec-canonical',
      'spec-canonical',
      'spec-canonical'
    ]);
  });

  it('uses serial generation for one fresh role or when linking is unavailable', async () => {
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection: vi.fn(async () => 'collection-smoke'),
      uploadSpecWithOutcome: vi.fn()
    };

    const oneRole = await generateCollectionsWithSpecFanout(
      baseOptions({ postman, roles: [roles[1]] })
    );
    expect(oneRole.diagnostic.strategy).toBe('serial');
    expect(postman.uploadSpecWithOutcome).not.toHaveBeenCalled();

    const noIntegration = await generateCollectionsWithSpecFanout(baseOptions({ postman }));
    expect(noIntegration.diagnostic.strategy).toBe('serial');
    expect(postman.uploadSpecWithOutcome).not.toHaveBeenCalled();
  });

  it('cleans temporary collections and specs when one shard fails before linking', async () => {
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection: vi.fn(async (_specId: string, _name: string, prefix: string) => {
        if (prefix === '[Contract]') throw new Error('contract generation failed');
        return prefix === '[Smoke]' ? 'collection-smoke' : 'collection-baseline';
      }),
      uploadSpecWithOutcome: vi
        .fn()
        .mockResolvedValueOnce({ specId: 'spec-smoke-temp', created: true })
        .mockResolvedValueOnce({ specId: 'spec-contract-temp', created: true })
    };
    const integration = { linkCollectionsToSpecification: vi.fn() };

    await expect(
      generateCollectionsWithSpecFanout(baseOptions({ integration, postman }))
    ).rejects.toThrow('contract generation failed');
    expect(postman.deleteCollection).toHaveBeenCalledWith('collection-smoke');
    expect(postman.deleteCollection).not.toHaveBeenCalledWith('collection-baseline');
    expect(postman.deleteSpec).toHaveBeenCalledWith('spec-smoke-temp');
    expect(postman.deleteSpec).toHaveBeenCalledWith('spec-contract-temp');
    expect(integration.linkCollectionsToSpecification).not.toHaveBeenCalled();
  });

  it('rejects collection collisions before linking', async () => {
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection: vi.fn(async () => 'collection-shared'),
      uploadSpecWithOutcome: vi
        .fn()
        .mockResolvedValueOnce({ specId: 'spec-smoke-temp', created: true })
        .mockResolvedValueOnce({ specId: 'spec-contract-temp', created: true })
    };
    const integration = { linkCollectionsToSpecification: vi.fn() };

    await expect(
      generateCollectionsWithSpecFanout(baseOptions({ integration, postman }))
    ).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');
    expect(integration.linkCollectionsToSpecification).not.toHaveBeenCalled();
  });

  it('rejects collisions with already-resolved roles and retries cleanup', async () => {
    const deleteSpec = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary delete failure'))
      .mockResolvedValue(undefined);
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec,
      generateCollection: vi.fn(async (_specId: string, _name: string, prefix: string) =>
        prefix === '[Smoke]' ? 'collection-existing' : 'collection-contract'
      ),
      uploadSpecWithOutcome: vi
        .fn()
        .mockResolvedValueOnce({ specId: 'spec-smoke-temp', created: true })
        .mockResolvedValueOnce({ specId: 'spec-contract-temp', created: true })
    };
    const integration = { linkCollectionsToSpecification: vi.fn() };

    await expect(
      generateCollectionsWithSpecFanout(
        baseOptions({
          cleanupDelayMs: 0,
          integration,
          postman,
          reservedCollectionIds: { baseline: 'collection-existing' },
          roles: roles.slice(1)
        })
      )
    ).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');
    expect(integration.linkCollectionsToSpecification).not.toHaveBeenCalled();
    expect(deleteSpec).toHaveBeenCalledTimes(2);
  });

  it('copies the complete multi-file bundle to each temporary spec', async () => {
    const bundle = { digest: 'bundle-digest' } as never;
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection: vi.fn(async (_specId: string, _name: string, prefix: string) => prefix || 'baseline'),
      uploadSpecBundle: vi
        .fn()
        .mockResolvedValueOnce({ specId: 'spec-smoke-temp', created: true, outcome: { status: 'ok' } })
        .mockResolvedValueOnce({ specId: 'spec-contract-temp', created: true, outcome: { status: 'ok' } })
    };
    const integration = { linkCollectionsToSpecification: vi.fn(async () => undefined) };

    await generateCollectionsWithSpecFanout(
      baseOptions({ integration, postman, source: { kind: 'bundle', bundle } })
    );

    expect(postman.uploadSpecBundle).toHaveBeenCalledTimes(2);
    expect(postman.uploadSpecBundle.mock.calls.every((call) => call[2] === bundle)).toBe(true);
  });

  it('preserves the ownership suffix within the 255-character spec name limit', () => {
    const name = buildTemporarySpecName('x'.repeat(300), 'spec-canonical', 'contract', 'run-1');
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name).toContain('[bootstrap-fanout:spec-canonical:contract:run-1]');
  });

  it('keeps same-identity concurrent temporary names distinct under the 64-character cap', async () => {
    const names: string[] = [];
    let upload = 0;
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection: vi.fn(async (...args: unknown[]) => String(args[2] ?? '') || 'baseline'),
      uploadSpecWithOutcome: vi.fn(async (...args: unknown[]) => {
        const name = String(args[1] ?? '');
        names.push(name);
        upload += 1;
        return { specId: `temp-${upload}`, created: true };
      })
    };
    const options = baseOptions({
      identity: () => 'x'.repeat(120),
      integration: { linkCollectionsToSpecification: vi.fn(async () => undefined) },
      postman
    });

    await Promise.all([
      generateCollectionsWithSpecFanout(options),
      generateCollectionsWithSpecFanout({ ...options, postman })
    ]);

    expect(new Set(names).size).toBe(4);
    expect(names.every((name) => name.includes('[bootstrap-fanout:spec-canonical:'))).toBe(true);
    expect(postman.deleteSpec).toHaveBeenCalledTimes(4);
  });

  it('cleans exact run-owned matches reconciled after ambiguous creates', async () => {
    let upload = 0;
    const postman = {
      deleteCollection: vi.fn(async () => undefined),
      deleteSpec: vi.fn(async () => undefined),
      generateCollection: vi.fn(async (...args: unknown[]) => String(args[2] ?? '') || 'baseline'),
      uploadSpecWithOutcome: vi.fn(async () => {
        upload += 1;
        return { specId: `reconciled-spec-${upload}`, created: false };
      })
    };

    await expect(generateCollectionsWithSpecFanout(baseOptions({
      integration: { linkCollectionsToSpecification: vi.fn(async () => undefined) },
      postman
    }))).resolves.toMatchObject({ diagnostic: { strategy: 'fanout' } });
    expect(postman.deleteSpec).toHaveBeenCalledWith('reconciled-spec-1');
    expect(postman.deleteSpec).toHaveBeenCalledWith('reconciled-spec-2');
    expect(postman.deleteCollection).not.toHaveBeenCalled();
  });
});
