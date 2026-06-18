import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadAdditionalCollectionFiles,
  syncAdditionalCollections,
  type PostmanResourcesState
} from '../src/lib/postman/additional-collections.js';

const COLLECTION_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function collection(name: string): Record<string, unknown> {
  return {
    info: {
      name,
      schema: COLLECTION_SCHEMA
    },
    item: [
      {
        name: 'GET /health',
        request: {
          method: 'GET',
          url: 'https://example.test/health'
        },
        response: [
          {
            name: 'ok',
            status: 'OK',
            code: 200
          }
        ]
      }
    ]
  };
}

function makeTempWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'bootstrap-additional-collections-'));
}

function withCwd<T>(dir: string, fn: () => T): T {
  const previous = process.cwd();
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.chdir(dir);
  process.env.GITHUB_WORKSPACE = dir;
  try {
    return fn();
  } finally {
    process.chdir(previous);
    if (previousWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
  }
}

async function withCwdAsync<T>(dir: string, fn: () => Promise<T>): Promise<T> {
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

function readResources(): PostmanResourcesState {
  return parse(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
}

describe('additional local collection provisioning', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads collection JSON/YAML recursively and uses resources.yaml mappings for updates', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated/nested'), { recursive: true });
    mkdirSync(path.join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/payments.json'),
      JSON.stringify({ collection: collection('Payments curated') }, null, 2)
    );
    writeFileSync(
      path.join(workspace, 'postman/curated/nested/refunds.yaml'),
      stringify(collection('Refunds curated'))
    );
    writeFileSync(path.join(workspace, 'postman/curated/README.md'), '# ignored\n');
    writeFileSync(
      path.join(workspace, '.postman/resources.yaml'),
      stringify({
        cloudResources: {
          additionalCollections: {
            '../postman/curated/payments.json': 'col-payments-existing'
          },
          collections: {
            '../postman/curated/nested/refunds.yaml': 'col-refunds-legacy',
            '../postman/curated/payments.json': 'col-payments-legacy'
          }
        }
      })
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/curated', parse(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState)
    );

    expect(loaded.map((entry) => entry.resourcePath)).toEqual([
      '../postman/curated/nested/refunds.yaml',
      '../postman/curated/payments.json'
    ]);
    expect(loaded.map((entry) => entry.existingCollectionId)).toEqual([
      'col-refunds-legacy',
      'col-payments-existing'
    ]);
  });

  it('loads checked-in generated E2E collection artifacts', () => {
    vi.stubEnv('GITHUB_WORKSPACE', process.cwd());

    const loaded = loadAdditionalCollectionFiles(
      'tests/fixtures/additional-collections/generated',
      null
    );

    expect(loaded.map((entry) => entry.resourcePath)).toEqual([
      '../tests/fixtures/additional-collections/generated/baseline.json',
      '../tests/fixtures/additional-collections/generated/nested/smoke.yaml'
    ]);
    expect(loaded.map((entry) => entry.name)).toEqual([
      'E2E Test API generated baseline artifact',
      'E2E Test API generated smoke artifact'
    ]);
    expect(loaded.every((entry) => entry.existingCollectionId === undefined)).toBe(true);
  });

  it('accepts collection items that use the v2.1 string request shorthand', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/string-request.json'),
      JSON.stringify(
        {
          info: {
            name: 'String request curated',
            schema: COLLECTION_SCHEMA
          },
          item: [
            {
              name: 'GET /health',
              request: 'https://example.test/health'
            }
          ]
        },
        null,
        2
      )
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/curated', null)
    );

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('String request curated');
  });

  it('creates and updates collections from real files and persists resource mappings', async () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated/nested'), { recursive: true });
    mkdirSync(path.join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/payments.json'),
      JSON.stringify(collection('Payments curated'), null, 2)
    );
    writeFileSync(
      path.join(workspace, 'postman/curated/nested/refunds.yaml'),
      stringify(collection('Refunds curated'))
    );
    writeFileSync(
      path.join(workspace, '.postman/resources.yaml'),
      stringify({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          collections: {
            '../postman/curated/payments.json': 'col-payments-existing'
          }
        }
      })
    );

    await withCwdAsync(workspace, async () => {
      const resourcesState = parse(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
      const loaded = loadAdditionalCollectionFiles('postman/curated', resourcesState);
      const postman = {
        createCollection: vi.fn().mockResolvedValue('col-refunds-created'),
        updateCollection: vi.fn().mockResolvedValue(undefined)
      };
      const core = {
        info: vi.fn(),
        warning: vi.fn()
      };

      const results = await syncAdditionalCollections({
        collectionFiles: loaded,
        core,
        postman,
        resourcesState,
        workspaceId: 'ws-existing'
      });

      expect(postman.updateCollection).toHaveBeenCalledWith(
        'col-payments-existing',
        expect.objectContaining({
          info: expect.objectContaining({ name: 'Payments curated' })
        })
      );
      expect(postman.createCollection).toHaveBeenCalledWith(
        'ws-existing',
        expect.objectContaining({
          info: expect.objectContaining({ name: 'Refunds curated' })
        })
      );
      expect(results).toEqual([
        expect.objectContaining({
          collectionId: 'col-refunds-created',
          operation: 'created',
          resourcePath: '../postman/curated/nested/refunds.yaml'
        }),
        expect.objectContaining({
          collectionId: 'col-payments-existing',
          operation: 'updated',
          resourcePath: '../postman/curated/payments.json'
        })
      ]);
      const resources = readResources();
      expect(resources.cloudResources?.additionalCollections).toMatchObject({
        '../postman/curated/nested/refunds.yaml': 'col-refunds-created',
        '../postman/curated/payments.json': 'col-payments-existing'
      });
      expect(resources.cloudResources?.collections).toEqual({
        '../postman/curated/payments.json': 'col-payments-existing'
      });
    });
  });

  it('recreates a persisted additional collection mapping when the remote collection is gone', async () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    mkdirSync(path.join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/payments.json'),
      JSON.stringify(collection('Payments curated'), null, 2)
    );
    writeFileSync(
      path.join(workspace, '.postman/resources.yaml'),
      stringify({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          additionalCollections: {
            '../postman/curated/payments.json': 'col-payments-stale'
          }
        }
      })
    );

    await withCwdAsync(workspace, async () => {
      const resourcesState = parse(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
      const loaded = loadAdditionalCollectionFiles('postman/curated', resourcesState);
      const notFound = Object.assign(new Error('not found'), { status: 404 });
      const postman = {
        createCollection: vi.fn().mockResolvedValue('col-payments-recreated'),
        updateCollection: vi.fn().mockRejectedValue(notFound)
      };
      const core = {
        info: vi.fn(),
        warning: vi.fn()
      };

      const results = await syncAdditionalCollections({
        collectionFiles: loaded,
        core,
        postman,
        resourcesState,
        workspaceId: 'ws-existing'
      });

      expect(postman.updateCollection).toHaveBeenCalledWith(
        'col-payments-stale',
        expect.objectContaining({
          info: expect.objectContaining({ name: 'Payments curated' })
        })
      );
      expect(postman.createCollection).toHaveBeenCalledWith(
        'ws-existing',
        expect.objectContaining({
          info: expect.objectContaining({ name: 'Payments curated' })
        })
      );
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('col-payments-stale')
      );
      expect(results).toEqual([
        expect.objectContaining({
          collectionId: 'col-payments-recreated',
          operation: 'created',
          resourcePath: '../postman/curated/payments.json'
        })
      ]);
      expect(readResources().cloudResources?.additionalCollections).toEqual({
        '../postman/curated/payments.json': 'col-payments-recreated'
      });
    });
  });

  it('does not recreate a persisted additional collection mapping for non-404 update failures', async () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    mkdirSync(path.join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/payments.json'),
      JSON.stringify(collection('Payments curated'), null, 2)
    );
    writeFileSync(
      path.join(workspace, '.postman/resources.yaml'),
      stringify({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          additionalCollections: {
            '../postman/curated/payments.json': 'col-payments-existing'
          }
        }
      })
    );

    await withCwdAsync(workspace, async () => {
      const resourcesState = parse(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
      const loaded = loadAdditionalCollectionFiles('postman/curated', resourcesState);
      const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });
      const postman = {
        createCollection: vi.fn().mockResolvedValue('col-payments-recreated'),
        updateCollection: vi.fn().mockRejectedValue(rateLimit)
      };
      const core = {
        info: vi.fn(),
        warning: vi.fn()
      };

      await expect(syncAdditionalCollections({
        collectionFiles: loaded,
        core,
        postman,
        resourcesState,
        workspaceId: 'ws-existing'
      })).rejects.toThrow(/rate limited/);
      expect(postman.createCollection).not.toHaveBeenCalled();
      expect(readResources().cloudResources?.additionalCollections).toEqual({
        '../postman/curated/payments.json': 'col-payments-existing'
      });
    });
  });

  it('rejects unsupported collection schemas before any Postman mutation', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/v3.json'),
      JSON.stringify({
        info: {
          name: 'v3 collection',
          schema: 'https://schema.getpostman.com/json/collection/v3.0.0/collection.json'
        },
        item: []
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/curated', null))
    ).toThrow(/supports only Postman collection schema v2\.1\.0/);
  });

  it('fails a configured missing directory instead of silently skipping it', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/missing', null))
    ).toThrow(/ADDITIONAL_COLLECTIONS_DIR_NOT_FOUND/);
  });

  it('rejects symlink escapes outside the workspace', () => {
    const workspace = makeTempWorkspace();
    const outside = makeTempWorkspace();
    tempDirs.push(workspace, outside);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    writeFileSync(path.join(outside, 'outside.json'), JSON.stringify(collection('Outside')));
    symlinkSync(
      path.join(outside, 'outside.json'),
      path.join(workspace, 'postman/curated/outside.json')
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/curated', null))
    ).toThrow(/must resolve inside/);
  });

  it('skips symlinked directories that would recursively point inside the workspace', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/curated/payments.json'),
      JSON.stringify(collection('Payments curated'), null, 2)
    );
    symlinkSync(
      path.join(workspace, 'postman/curated'),
      path.join(workspace, 'postman/curated/self'),
      'dir'
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/curated', null)
    );

    expect(loaded.map((entry) => entry.resourcePath)).toEqual([
      '../postman/curated/payments.json'
    ]);
  });

  it('follows non-recursive symlinked directories inside the workspace', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/curated'), { recursive: true });
    mkdirSync(path.join(workspace, 'postman/shared'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/shared/refunds.json'),
      JSON.stringify(collection('Refunds curated'), null, 2)
    );
    symlinkSync(
      path.join(workspace, 'postman/shared'),
      path.join(workspace, 'postman/curated/shared'),
      'dir'
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/curated', null)
    );

    expect(loaded.map((entry) => entry.resourcePath)).toEqual([
      '../postman/shared/refunds.json'
    ]);
  });
});
