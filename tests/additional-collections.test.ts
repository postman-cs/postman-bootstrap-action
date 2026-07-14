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

  it('loads collection v3 directories as single additional collections', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/authored-v3/.resources'), { recursive: true });
    mkdirSync(path.join(workspace, 'postman/additional/authored-v3/Workflows/.resources'), { recursive: true });
    mkdirSync(path.join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/additional/authored-v3/.resources/definition.yaml'),
      stringify({
        $kind: 'collection',
        name: 'Authored v3 regression',
        variables: {
          baseUrl: 'https://example.test',
          bearerToken: ''
        },
        auth: [
          {
            type: 'bearer',
            credentials: {
              token: '{{bearerToken}}'
            }
          }
        ],
        scripts: [
          {
            type: 'http:beforeRequest',
            code: 'pm.collectionVariables.set("ready", "true");',
            language: 'text/javascript'
          }
        ]
      })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/authored-v3/Workflows/.resources/definition.yaml'),
      stringify({
        $kind: 'collection',
        description: 'Workflow lifecycle',
        order: 2000
      })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/authored-v3/Workflows/Create Thing.request.yaml'),
      stringify({
        $kind: 'http-request',
        url: '{{baseUrl}}/things',
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        queryParams: {
          filter: 'status eq "{{testStatus}}"'
        },
        settings: {},
        scripts: [
          {
            type: 'afterResponse',
            code: 'pm.test("created", function () {});',
            language: 'text/javascript'
          }
        ],
        order: 1000
      })
    );
    writeFileSync(
      path.join(workspace, '.postman/resources.yaml'),
      stringify({
        cloudResources: {
          additionalCollections: {
            '../postman/additional/authored-v3': 'col-authored-existing'
          }
        }
      })
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/additional', readResources())
    );

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      existingCollectionId: 'col-authored-existing',
      name: 'Authored v3 regression',
      resourcePath: '../postman/additional/authored-v3'
    });
    expect(loaded[0].collection).toMatchObject({
      $kind: 'collection',
      name: 'Authored v3 regression',
      variables: [
        { key: 'baseUrl', value: 'https://example.test' },
        { key: 'bearerToken', value: '' }
      ],
      auth: {
        type: 'bearer',
        credentials: [{ key: 'token', value: '{{bearerToken}}' }]
      },
      scripts: [
        {
          type: 'beforeRequest',
          code: 'pm.collectionVariables.set("ready", "true");',
          language: 'text/javascript'
        }
      ],
      items: [
        {
          $kind: 'collection',
          name: 'Workflows',
          items: [
            {
              $kind: 'http-request',
              name: 'Create Thing',
              headers: [
                { key: 'Accept', value: 'application/json' },
                { key: 'Content-Type', value: 'application/json' }
              ],
              queryParams: [
                { key: 'filter', value: 'status eq "{{testStatus}}"' }
              ],
              settings: {},
              scripts: [
                {
                  type: 'afterResponse',
                  code: 'pm.test("created", function () {});',
                  language: 'text/javascript'
                }
              ]
            }
          ]
        }
      ]
    });
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
        }),
        expect.objectContaining({ onRootCreated: expect.any(Function) })
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
        }),
        expect.objectContaining({ onRootCreated: expect.any(Function) })
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

  it('loads mixed v2.1 files and collection v3 directories together', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/v3-col/.resources'), { recursive: true });
    mkdirSync(path.join(workspace, 'postman/additional/v2'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/additional/v3-col/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'V3 Mixed' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/v3-col/Ping.request.yaml'),
      stringify({
        $kind: 'http-request',
        method: 'GET',
        url: 'https://example.test/ping',
        order: 1000
      })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/v2/payments.json'),
      JSON.stringify(collection('V2 Mixed'), null, 2)
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/additional', null)
    );

    expect(loaded.map((entry) => entry.name).sort()).toEqual(['V2 Mixed', 'V3 Mixed']);
    expect(loaded.find((entry) => entry.name === 'V3 Mixed')?.collection).toMatchObject({
      $kind: 'collection',
      items: [{ $kind: 'http-request', name: 'Ping' }]
    });
    expect(loaded.find((entry) => entry.name === 'V2 Mixed')?.collection).toMatchObject({
      info: { name: 'V2 Mixed' }
    });
  });

  it('sorts Local View siblings by declared order', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/ordered/.resources'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/additional/ordered/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Ordered' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/ordered/Zebra.request.yaml'),
      stringify({ $kind: 'http-request', method: 'GET', url: 'https://example.test/z', order: 3000 })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/ordered/Alpha.request.yaml'),
      stringify({ $kind: 'http-request', method: 'GET', url: 'https://example.test/a', order: 1000 })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/ordered/Middle.request.yaml'),
      stringify({ $kind: 'http-request', method: 'GET', url: 'https://example.test/m', order: 2000 })
    );

    const loaded = withCwd(workspace, () =>
      loadAdditionalCollectionFiles('postman/additional', null)
    );

    expect((loaded[0].collection.items as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'Alpha',
      'Middle',
      'Zebra'
    ]);
  });

  it('rejects root definition.yaml symlink escapes outside the workspace', () => {
    const workspace = makeTempWorkspace();
    const outside = makeTempWorkspace();
    tempDirs.push(workspace, outside);
    mkdirSync(path.join(workspace, 'postman/additional/escaped/.resources'), { recursive: true });
    writeFileSync(
      path.join(outside, 'definition.yaml'),
      stringify({ $kind: 'collection', name: 'Escaped root' })
    );
    symlinkSync(
      path.join(outside, 'definition.yaml'),
      path.join(workspace, 'postman/additional/escaped/.resources/definition.yaml')
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/must resolve inside/);
  });

  it('rejects nested folder definition.yaml symlink escapes outside the workspace', () => {
    const workspace = makeTempWorkspace();
    const outside = makeTempWorkspace();
    tempDirs.push(workspace, outside);
    mkdirSync(path.join(workspace, 'postman/additional/nested-escape/.resources'), { recursive: true });
    mkdirSync(path.join(workspace, 'postman/additional/nested-escape/Folder/.resources'), {
      recursive: true
    });
    writeFileSync(
      path.join(workspace, 'postman/additional/nested-escape/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Nested escape root' })
    );
    writeFileSync(
      path.join(outside, 'folder-definition.yaml'),
      stringify({ $kind: 'collection', name: 'Escaped folder', order: 1000 })
    );
    symlinkSync(
      path.join(outside, 'folder-definition.yaml'),
      path.join(workspace, 'postman/additional/nested-escape/Folder/.resources/definition.yaml')
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/must resolve inside/);
  });

  it('rejects Local View examples before any Postman mutation', async () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/with-examples/.resources'), {
      recursive: true
    });
    writeFileSync(
      path.join(workspace, 'postman/additional/with-examples/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Has examples' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/with-examples/Create.request.yaml'),
      stringify({
        $kind: 'http-request',
        method: 'POST',
        url: 'https://example.test/things',
        examples: './.resources/Create.resources/examples',
        order: 1000
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/examples/i);

    const postman = {
      createCollection: vi.fn(),
      updateCollection: vi.fn()
    };
    await expect(
      withCwdAsync(workspace, async () => {
        const files = loadAdditionalCollectionFiles('postman/additional', null);
        return syncAdditionalCollections({
          collectionFiles: files,
          core: { info: vi.fn(), warning: vi.fn() },
          postman,
          resourcesState: {},
          workspaceId: 'ws-1'
        });
      })
    ).rejects.toThrow(/examples/i);
    expect(postman.createCollection).not.toHaveBeenCalled();
    expect(postman.updateCollection).not.toHaveBeenCalled();
  });

  it('rejects folder auth and variables before any Postman mutation', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/folder-auth/.resources'), {
      recursive: true
    });
    mkdirSync(path.join(workspace, 'postman/additional/folder-auth/Secure/.resources'), {
      recursive: true
    });
    writeFileSync(
      path.join(workspace, 'postman/additional/folder-auth/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Folder auth root' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/folder-auth/Secure/.resources/definition.yaml'),
      stringify({
        $kind: 'collection',
        order: 1000,
        auth: { type: 'bearer', credentials: { token: 'secret' } },
        variables: { scope: 'folder' }
      })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/folder-auth/Secure/Ping.request.yaml'),
      stringify({ $kind: 'http-request', method: 'GET', url: 'https://example.test/ping', order: 1000 })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/folder.*(auth|variables)|field (auth|variables) cannot be preserved/i);
  });

  it('rejects nested directories without a Local View folder definition', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/malformed/.resources'), { recursive: true });
    mkdirSync(path.join(workspace, 'postman/additional/malformed/Scratch'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/additional/malformed/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Malformed folders' })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/Scratch.*definition\.yaml|definition\.yaml.*Scratch/i);
  });

  it('rejects scalar script paths and unproven folder scripts', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/scalar-script/.resources'), {
      recursive: true
    });
    writeFileSync(
      path.join(workspace, 'postman/additional/scalar-script/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Scalar script' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/scalar-script/Run.request.yaml'),
      stringify({
        $kind: 'http-request',
        method: 'GET',
        url: 'https://example.test/run',
        scripts: './.resources/Run.resources/scripts',
        order: 1000
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/scripts.*inline|path-valued scripts/i);

    rmSync(path.join(workspace, 'postman/additional/scalar-script'), { recursive: true, force: true });
    mkdirSync(path.join(workspace, 'postman/additional/folder-script/.resources'), {
      recursive: true
    });
    mkdirSync(path.join(workspace, 'postman/additional/folder-script/Folder/.resources'), {
      recursive: true
    });
    writeFileSync(
      path.join(workspace, 'postman/additional/folder-script/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Folder script' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/folder-script/Folder/.resources/definition.yaml'),
      stringify({
        $kind: 'collection',
        scripts: [{ type: 'beforeRequest', code: 'pm.variables.set("folder", true);' }],
        order: 1000
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/folder scripts|cannot be preserved/i);
  });

  it('rejects inline definition items and multiple auth profiles', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    const definitionDir = path.join(workspace, 'postman/additional/closed-contract/.resources');
    mkdirSync(definitionDir, { recursive: true });
    writeFileSync(
      path.join(definitionDir, 'definition.yaml'),
      stringify({
        $kind: 'collection',
        name: 'Inline items',
        items: [{ $kind: 'http-request', name: 'Hidden', method: 'GET', url: 'https://example.test' }]
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/items.*directory|inline items/i);

    writeFileSync(
      path.join(definitionDir, 'definition.yaml'),
      stringify({
        $kind: 'collection',
        name: 'Multiple auth',
        auth: [
          { type: 'bearer', credentials: { token: 'one' } },
          { type: 'apikey', credentials: { key: 'two' } }
        ]
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/multiple auth|one auth profile/i);
  });

  it('rejects invalid node kinds, malformed order, and unknown Local View files', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    const collectionDir = path.join(workspace, 'postman/additional/strict-tree');
    mkdirSync(path.join(collectionDir, '.resources'), { recursive: true });
    mkdirSync(path.join(collectionDir, 'Bad Folder/.resources'), { recursive: true });
    writeFileSync(
      path.join(collectionDir, '.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Strict tree' })
    );
    writeFileSync(
      path.join(collectionDir, 'Bad Folder/.resources/definition.yaml'),
      stringify({ $kind: 'http-request', name: 'Not a folder', order: 1000 })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/folder.*\$kind|collection.*folder/i);

    rmSync(path.join(collectionDir, 'Bad Folder'), { recursive: true, force: true });
    writeFileSync(
      path.join(collectionDir, 'Bad.request.yaml'),
      stringify({
        $kind: 'http-request',
        name: 'Bad order',
        method: 'GET',
        url: 'https://example.test',
        order: 'first'
      })
    );
    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/order.*finite number/i);

    rmSync(path.join(collectionDir, 'Bad.request.yaml'));
    writeFileSync(path.join(collectionDir, 'Ignored.yaml'), 'ignored: true\n');
    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/unsupported Local View entry.*Ignored\.yaml/i);
  });

  it('rejects path-valued scripts and unsupported GraphQL fields before mutation', () => {
    const workspace = makeTempWorkspace();
    tempDirs.push(workspace);
    mkdirSync(path.join(workspace, 'postman/additional/path-scripts/.resources'), {
      recursive: true
    });
    writeFileSync(
      path.join(workspace, 'postman/additional/path-scripts/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'Path scripts' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/path-scripts/Run.request.yaml'),
      stringify({
        $kind: 'http-request',
        method: 'GET',
        url: 'https://example.test/run',
        scripts: [{ type: 'afterResponse', path: './.resources/Run.resources/scripts/test.js' }],
        order: 1000
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/path-valued script|inline script|script field path cannot be preserved/i);

    rmSync(path.join(workspace, 'postman/additional/path-scripts'), { recursive: true, force: true });
    mkdirSync(path.join(workspace, 'postman/additional/gql-extra/.resources'), { recursive: true });
    writeFileSync(
      path.join(workspace, 'postman/additional/gql-extra/.resources/definition.yaml'),
      stringify({ $kind: 'collection', name: 'GQL extra' })
    );
    writeFileSync(
      path.join(workspace, 'postman/additional/gql-extra/Query.request.yaml'),
      stringify({
        $kind: 'graphql-request',
        query: '{ ping }',
        variables: '{}',
        url: 'https://example.test/graphql',
        headers: { Authorization: 'Bearer x' },
        order: 1000
      })
    );

    expect(() =>
      withCwd(workspace, () => loadAdditionalCollectionFiles('postman/additional', null))
    ).toThrow(/graphql|cannot be preserved/i);
  });
});
