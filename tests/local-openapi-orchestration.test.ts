import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPlannedOutputs,
  observeLocalOpenApiOperations,
  resolveInputs,
  runBootstrap,
  type BootstrapExecutionDependencies,
  type CoreLike,
  type ExecLike,
  type LocalOpenApiOperationCounts,
  type ResolvedInputs
} from '../src/index.js';

type JsonRecord = Record<string, unknown>;

const VALID_SPEC_31 = `{
  "openapi": "3.1.0",
  "info": {
    "title": "Orchestration API",
    "version": "1.0.0"
  },
  "paths": {
    "/pets": {
      "get": {
        "operationId": "listPets",
        "summary": "List pets",
        "responses": {
          "200": {
            "description": "ok",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": { "type": "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const PREVIOUS_SPEC_31 = `{
  "openapi": "3.1.0",
  "info": {
    "title": "Previous Orchestration API",
    "version": "0.9.0"
  },
  "paths": {
    "/pets": {
      "get": {
        "operationId": "listPets",
        "summary": "List pets",
        "responses": {
          "200": {
            "description": "ok",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object"
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

function createCoreStub(): CoreLike & { outputs: Record<string, string>; warnings: string[] } {
  const outputs: Record<string, string> = {};
  const warnings: string[] = [];
  return {
    error: vi.fn(),
    getInput: () => '',
    group: async (_name, fn) => fn(),
    info: vi.fn(),
    outputs,
    setFailed: vi.fn(),
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setSecret: vi.fn(),
    warning: (message) => {
      warnings.push(String(message));
    },
    warnings
  };
}

function createExecStub(): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  };
}

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'orchestration-api',
    syncExamples: true,
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    domain: 'core-banking',
    domainCode: 'AF',
    requesterEmail: 'owner@example.com',
    workspaceAdminUserIds: '',
    repoUrl: 'https://github.com/postman-cs/bootstrap-action-test',
    specUrl: '',
    specPath: 'openapi.yaml',
    specFilesJson: '',
    protocol: 'auto',
    openapiVersion: '',
    breakingChangeMode: 'off',
    breakingBaselineSpecPath: undefined,
    breakingRulesPath: 'changes-rules.yaml',
    breakingTargetRef: undefined,
    breakingSummaryPath: undefined,
    breakingLogPath: undefined,
    governanceMappingJson: '{"core-banking":"Core Banking"}',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    credentialPreflight: 'warn',
    branchStrategy: 'legacy',
    integrationBackend: 'bifrost',
    folderStrategy: 'Paths',
    nestedFolderHierarchy: false,
    requestNameSource: 'Fallback',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanFallbackBase: 'https://go.postman.co/_api',
    postmanGatewayBase: 'https://gateway.postman.com',
    postmanIapubBase: 'https://iapub.postman.co',
    githubRefName: undefined,
    githubHeadRef: undefined,
    githubRef: undefined,
    githubSha: undefined,
    workspaceId: 'ws-1',
    ...overrides
  };
}

describe('local OpenAPI orchestration', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function withRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'local-openapi-orch-'));
    tempDirs.push(repoRoot);
    await writeFile(path.join(repoRoot, 'openapi.yaml'), VALID_SPEC_31);
    const previous = process.cwd();
    const previousWorkspace = process.env.GITHUB_WORKSPACE;
    process.chdir(repoRoot);
    process.env.GITHUB_WORKSPACE = repoRoot;
    try {
      return await fn(repoRoot);
    } finally {
      process.chdir(previous);
      if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
      else process.env.GITHUB_WORKSPACE = previousWorkspace;
    }
  }

  function buildPostman(events: string[]) {
    const importV2Collection = vi.fn(
      async (_workspaceId: string, collection: unknown, finalName: string) => {
        events.push(`import:${finalName}`);
        const id =
          finalName.includes('[Contract]')
            ? 'col-contract'
            : finalName.includes('[Smoke]')
              ? 'col-smoke'
              : 'col-baseline';
        const payload = collection as { event?: unknown[]; item?: unknown[] };
        expect(Array.isArray(payload.item)).toBe(true);
        return {
          collectionId: id,
          journaledRootIds: [id],
          deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
        };
      }
    );
    const deepUpdateV2Collection = vi.fn(async (collectionUid: string) => {
      events.push(`deepUpdate:${collectionUid}`);
      return collectionUid;
    });
    return {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1' }),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      deleteVerifiedRunOwnedCollections: vi.fn().mockResolvedValue(undefined),
      deepUpdateV2Collection,
      findWorkspacesByName: vi.fn().mockResolvedValue([{ id: 'ws-1', name: 'orchestration-api' }]),
      generateCollection: vi.fn().mockRejectedValue(new Error('generateCollection must be unreachable')),
      getSpecContent: vi.fn().mockResolvedValue(PREVIOUS_SPEC_31),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      importV2Collection,
      injectContractTests: vi.fn().mockRejectedValue(new Error('injectContractTests must be unreachable')),
      injectTests: vi.fn().mockRejectedValue(new Error('injectTests must be unreachable')),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockImplementation(async (id: string, tags: string[]) => {
        events.push(`tag:${id}:${tags.join(',')}`);
      }),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-1'),
      uploadSpecWithOutcome: vi.fn().mockResolvedValue({ specId: 'spec-1', created: true })
    };
  }

  function buildIntegration(events: string[]) {
    let lastLinked: Array<{
      collectionId: string;
      options?: Record<string, unknown>;
      syncOptions?: { syncExamples: boolean };
    }> = [];
    const listSpecificationCollectionRelations = vi.fn().mockImplementation(async () => {
      events.push('readback');
      return lastLinked.map((entry) => ({
        collectionId: entry.collectionId,
        state: 'in-sync',
        ...(entry.options ? { options: entry.options } : {}),
        ...(entry.syncOptions ? { syncOptions: entry.syncOptions } : {})
      }));
    });
    return {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
      configureTeamContext: vi.fn(),
      findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' }),
      linkCollectionsToSpecification: vi.fn().mockImplementation(async (_specId: string, collections: typeof lastLinked) => {
        events.push(`link:${collections.map((c) => c.collectionId).join(',')}`);
        lastLinked = collections.map((entry) => ({ ...entry }));
        for (const entry of collections) {
          expect(entry.options).toEqual(
            expect.objectContaining({
              parametersResolution: 'Example',
              requestNameSource: expect.any(String),
              folderStrategy: expect.any(String)
            })
          );
        }
        return { lockedRetries: 0 };
      }),
      listSpecificationCollectionRelations,
      settleSpecificationCollectionRelations: vi.fn().mockImplementation(
        async (specId: string, expectedIds: string[]) => {
          events.push(`settle:${expectedIds.join(',')}`);
          const relations = await listSpecificationCollectionRelations(specId);
          return { relations, attempts: 1 };
        }
      ),
      syncCollection: vi.fn().mockRejectedValue(new Error('syncCollection must be unreachable for OpenAPI'))
    };
  }

  it('imports one collection per fresh role before link/tags and hard-zeros forbidden spies', async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);

      const outputs = await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: {
          read: () => null,
          write: () => undefined
        },
        specFetcher: vi.fn()
      });

      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deepUpdateV2Collection).not.toHaveBeenCalled();
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.injectTests).not.toHaveBeenCalled();
      expect(postman.injectContractTests).not.toHaveBeenCalled();
      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();

      const importIdx = events.findIndex((e) => e.startsWith('import:'));
      const linkIdx = events.findIndex((e) => e.startsWith('link:'));
      const settleIdx = events.findIndex((e) => e.startsWith('settle:'));
      const readbackIdx = events.indexOf('readback');
      const tagIdx = events.findIndex((e) => e.startsWith('tag:'));
      expect(importIdx).toBeGreaterThanOrEqual(0);
      expect(linkIdx).toBeGreaterThan(importIdx);
      expect(settleIdx).toBeGreaterThan(linkIdx);
      expect(readbackIdx).toBeGreaterThan(settleIdx);
      expect(tagIdx).toBeGreaterThan(readbackIdx);

      const ledger = JSON.parse(
        await readFile(path.join(repoRoot, '.postman/bootstrap-openapi-operation-ledger.json'), 'utf8')
      ) as {
        phase: string;
        counts: Record<string, number>;
        linkRelationStates?: Record<string, string>;
      };
      expect(ledger.phase).toBe('fresh');
      expect(ledger.counts.localConversion).toBe(1);
      expect(ledger.counts.wholeCollectionImport).toBe(3);
      expect(ledger.counts.deepUpdate).toBe(0);
      expect(ledger.counts.specHubCollectionGeneration).toBe(0);
      expect(ledger.counts.specHubCollectionSync).toBe(0);
      expect(ledger.counts.temporaryOpenApiSpecCreate).toBe(0);
      expect(ledger.counts.temporaryOpenApiSpecDelete).toBe(0);
      expect(ledger.counts.v3PerItemCollectionCreate).toBe(0);
      expect(ledger.counts.postCreateScriptPatch).toBe(0);
      expect(ledger.counts.retries).toBe(0);
      expect(ledger.counts.linkRelationSettleReads).toBe(1);
      expect(ledger.linkRelationStates).toEqual({
        'col-baseline': 'in-sync',
        'col-smoke': 'in-sync',
        'col-contract': 'in-sync'
      });
      expect(outputs['openapi-operation-ledger-json']).toContain('"mode":"local"');
      expect(outputs['prebuilt-collections-json']).toContain('"schemaVersion":1');
      const manifest = JSON.parse(
        await readFile(path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json'), 'utf8')
      ) as { collections: Array<{ cloudId: string; role: string }> };
      expect(manifest.collections).toHaveLength(3);
      expect(manifest.collections.map((c) => c.cloudId).sort()).toEqual([
        'col-baseline',
        'col-contract',
        'col-smoke'
      ]);
    });
  });

  it('observes allowed and forbidden dependency invocations before calls, including throws, with this preserved', async () => {
    const counts: LocalOpenApiOperationCounts = {
      localConversion: 0,
      wholeCollectionImport: 0,
      deepUpdate: 0,
      specHubCollectionGeneration: 0,
      specHubCollectionSync: 0,
      temporaryOpenApiSpecCreate: 0,
      temporaryOpenApiSpecDelete: 0,
      v3PerItemCollectionCreate: 0,
      postCreateScriptPatch: 0,
      retries: 0
    };
    const dependency = {
      marker: 'bound',
      importV2Collection() { expect(this.marker).toBe('bound'); },
      generateCollection() { throw new Error('observed throw'); },
      uploadSpec() {},
      deleteSpec() {},
      createRunOwnedCollection() {},
      injectTests() {},
      syncCollection() {}
    };
    const observed = observeLocalOpenApiOperations(dependency, counts);
    observed.importV2Collection();
    expect(() => observed.generateCollection()).toThrow('observed throw');
    observed.uploadSpec();
    observed.deleteSpec();
    observed.createRunOwnedCollection();
    observed.injectTests();
    observed.syncCollection();
    expect(counts).toMatchObject({
      wholeCollectionImport: 1,
      specHubCollectionGeneration: 1,
      temporaryOpenApiSpecCreate: 1,
      temporaryOpenApiSpecDelete: 1,
      v3PerItemCollectionCreate: 1,
      postCreateScriptPatch: 1,
      specHubCollectionSync: 1
    });
  });

  it('keeps local OpenAPI collection generation on one static source and bundled path', async () => {
    const packageRoot = path.resolve(import.meta.dirname, '..');
    const forbidden = [
      'POSTMAN_COLLECTION_GENERATION_MODE',
      'POSTMAN_COLLECTION_GENERATION_FANOUT',
      'bootstrap-fanout',
      'generateCollectionsWithSpecFanout'
    ];
    const files: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory)) {
        const absolute = path.join(directory, entry);
        const metadata = await stat(absolute);
        if (metadata.isDirectory()) await walk(absolute);
        else files.push(absolute);
      }
    };
    await walk(path.join(packageRoot, 'src'));
    await walk(path.join(packageRoot, 'dist'));
    const matches: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const marker of forbidden) {
        if (content.includes(marker)) matches.push(`${path.relative(packageRoot, file)}:${marker}`);
      }
    }
    expect(matches).toEqual([]);
  });

  it('accepts server-normalized durable out-of-sync link readback without syncCollection (Q5)', async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      internalIntegration.settleSpecificationCollectionRelations = vi.fn(
        async (_specId: string, expectedIds: string[]) => {
          events.push(`settle:${expectedIds.join(',')}`);
          expect(expectedIds.sort()).toEqual(['col-baseline', 'col-contract', 'col-smoke']);
          const linked = (
            internalIntegration.linkCollectionsToSpecification as ReturnType<typeof vi.fn>
          ).mock.calls[0]?.[1] as Array<{
            collectionId: string;
            options?: Record<string, unknown>;
            syncOptions?: { syncExamples: boolean };
          }>;
          expect(linked).toHaveLength(3);
          for (const entry of linked) {
            expect(entry.options).toEqual(
              expect.objectContaining({
                parametersResolution: 'Example',
                requestNameSource: expect.any(String),
                folderStrategy: expect.any(String)
              })
            );
            expect(entry.syncOptions).toEqual({ syncExamples: true });
          }
          return {
            relations: linked.map((entry) => ({
              collectionId: entry.collectionId,
              state: 'out-of-sync',
              ...(entry.options
                ? {
                    options: {
                      ...entry.options,
                      serverAddedGenerationDefault: 'enabled'
                    }
                  }
                : {}),
              syncOptions: {
                syncExamples: { value: true, isDisabled: false, reason: '' },
                deleteOrphanedRequests: { value: false, isDisabled: false, reason: '' }
              }
            })),
            attempts: 1
          };
        }
      );

      const outputs = await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: {
          read: () => null,
          write: () => undefined
        },
        specFetcher: vi.fn()
      });

      expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledTimes(1);
      expect(internalIntegration.settleSpecificationCollectionRelations).toHaveBeenCalledTimes(1);
      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();

      const linkIdx = events.findIndex((e) => e.startsWith('link:'));
      const settleIdx = events.findIndex((e) => e.startsWith('settle:'));
      const tagIdx = events.findIndex((e) => e.startsWith('tag:'));
      expect(settleIdx).toBeGreaterThan(linkIdx);
      expect(tagIdx).toBeGreaterThan(settleIdx);
      expect(postman.tagCollection).toHaveBeenCalledTimes(3);

      const ledger = JSON.parse(
        await readFile(path.join(repoRoot, '.postman/bootstrap-openapi-operation-ledger.json'), 'utf8')
      ) as {
        counts: Record<string, number>;
        linkRelationStates?: Record<string, string>;
      };
      expect(ledger.counts.linkRelationSettleReads).toBe(1);
      expect(ledger.counts.retries).toBe(0);
      expect(ledger.counts.specHubCollectionSync).toBe(0);
      expect(ledger.linkRelationStates).toEqual({
        'col-baseline': 'out-of-sync',
        'col-smoke': 'out-of-sync',
        'col-contract': 'out-of-sync'
      });
      expect(outputs['openapi-operation-ledger-json']).toContain('"linkRelationSettleReads":1');
      expect(outputs['openapi-operation-ledger-json']).toContain('"out-of-sync"');
      expect(core.info).toHaveBeenCalledWith(
        expect.stringMatching(
          /OpenAPI link relation settle completed after 1 read\(s\); states=.*out-of-sync/
        )
      );
    });
  });

  it('fails closed on options mismatch after settle without calling syncCollection (Q15)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      internalIntegration.settleSpecificationCollectionRelations = vi.fn(
        async (_specId: string, expectedIds: string[]) => ({
          relations: expectedIds.map((collectionId) => ({
            collectionId,
            state: 'out-of-sync',
            options: { parametersResolution: 'Example', requestNameSource: 'WRONG', folderStrategy: 'Paths' },
            syncOptions: { syncExamples: true }
          })),
          attempts: 1
        })
      );

      await expect(
        runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
          core,
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration,
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: {
            read: () => null,
            write: () => undefined
          },
          specFetcher: vi.fn()
        })
      ).rejects.toThrow(/LOCAL_OPENAPI_LINK_READBACK_FAILED: collection .* options mismatch/);

      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('fails closed on server-normalized syncExamples mismatch without calling syncCollection (Q5)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      internalIntegration.settleSpecificationCollectionRelations = vi.fn(
        async (_specId: string, expectedIds: string[]) => {
          const linked = (
            internalIntegration.linkCollectionsToSpecification as ReturnType<typeof vi.fn>
          ).mock.calls[0]?.[1] as Array<{
            collectionId: string;
            options?: Record<string, unknown>;
          }>;
          return {
            relations: expectedIds.map((collectionId) => ({
              collectionId,
              state: 'out-of-sync',
              options: {
                ...linked.find((entry) => entry.collectionId === collectionId)?.options,
                serverAddedGenerationDefault: 'enabled'
              },
              syncOptions: {
                syncExamples: { value: false, isDisabled: false, reason: '' },
                deleteOrphanedRequests: { value: false, isDisabled: false, reason: '' }
              }
            })),
            attempts: 1
          };
        }
      );

      await expect(
        runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
          core,
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration,
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: {
            read: () => null,
            write: () => undefined
          },
          specFetcher: vi.fn()
        })
      ).rejects.toThrow(/LOCAL_OPENAPI_LINK_READBACK_FAILED: collection .* syncOptions mismatch/);

      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('deep-updates each changed role once and preserves UIDs', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);

      const outputs = await runBootstrap(
        createInputs({
          workspaceId: 'ws-1',
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing',
          collectionSyncMode: 'refresh'
        }),
        {
          core,
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration,
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: {
            read: () => null,
            write: () => undefined
          },
          specFetcher: vi.fn()
        }
      );

      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.importV2Collection).not.toHaveBeenCalled();
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(outputs['baseline-collection-id']).toBe('col-baseline-existing');
      expect(outputs['smoke-collection-id']).toBe('col-smoke-existing');
      expect(outputs['contract-collection-id']).toBe('col-contract-existing');
      const ledger = JSON.parse(outputs['openapi-operation-ledger-json'] || '{}') as {
        phase: string;
        counts: Record<string, number>;
      };
      expect(ledger.phase).toBe('changed-deep-update');
      expect(ledger.counts.deepUpdate).toBe(3);
      expect(ledger.counts.wholeCollectionImport).toBe(0);
      expect(ledger.counts.localConversion).toBe(1);
    });
  });

  it('separates unsafe display names from artifact identity and reuses safe resource paths', async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      let durableState: Record<string, unknown> | null = null;
      const resourcesState = {
        read: () => durableState as never,
        write: (state: Record<string, unknown>) => {
          durableState = structuredClone(state);
        }
      };
      const inputs = createInputs({ projectName: 'Payments:A', workspaceId: 'ws-1' });

      await runBootstrap(inputs, {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState,
        specFetcher: vi.fn()
      });

      const imports = postman.importV2Collection.mock.calls as Array<[string, JsonRecord, string]>;
      expect(imports.map((call) => call[2])).toEqual([
        'Payments:A',
        '[Smoke] Payments:A',
        '[Contract] Payments:A'
      ]);
      expect(imports.map((call) => (call[1].info as JsonRecord).name)).toEqual([
        'Payments:A',
        '[Smoke] Payments:A',
        '[Contract] Payments:A'
      ]);
      const persisted = durableState as { cloudResources?: { collections?: JsonRecord } } | null;
      const collectionPaths = Object.keys(persisted?.cloudResources?.collections ?? {});
      expect(collectionPaths).toHaveLength(3);
      expect(collectionPaths.every((entry) => !entry.includes(':'))).toBe(true);
      const manifest = JSON.parse(
        await readFile(path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json'), 'utf8')
      ) as { collections: Array<{ collectionPath: string }> };
      expect(manifest.collections.every((entry) => !entry.collectionPath.includes(':'))).toBe(true);
      expect(manifest.collections.map((entry) => `../${entry.collectionPath}`).sort()).toEqual(
        collectionPaths.sort()
      );

      await runBootstrap(createInputs({ projectName: 'Payments:A' }), {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState,
        specFetcher: vi.fn()
      });
      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(3);
    });
  });

  it('surfaces sanitized failure ledger and cleans only owned import roots', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      // Canonical workspace UID (owner-prefixed) — must survive partial concurrent failure.
      const canonicalBaselineUid = '12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      // Concurrent role writes: succeed baseline, fail the other roles after drain.
      postman.importV2Collection = vi.fn(
        async (_workspaceId: string, _collection: unknown, finalName: string) => {
          events.push(`import:${finalName}`);
          if (finalName.includes('[Smoke]') || finalName.includes('[Contract]')) {
            throw new Error('import boom token=sekrit');
          }
          return {
            collectionId: canonicalBaselineUid,
            journaledRootIds: [canonicalBaselineUid],
            deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
          };
        }
      );
      const internalIntegration = buildIntegration(events);

      await expect(
        runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
          core,
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration,
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: {
            read: () => null,
            write: () => undefined
          },
          specFetcher: vi.fn()
        })
      ).rejects.toThrow(
        new RegExp(
          `LOCAL_OPENAPI_ORCHESTRATION_FAILED: stage=partial-import ledger=\\[${canonicalBaselineUid}\\]`
        )
      );

      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledWith([canonicalBaselineUid]);
      expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('imports three roles with pairwise-disjoint structural Sync IDs (Q12 collision)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const imported: JsonRecord[] = [];
      postman.importV2Collection = vi.fn(
        async (_workspaceId: string, collection: unknown, finalName: string) => {
          events.push(`import:${finalName}`);
          imported.push(collection as JsonRecord);
          const slot = finalName.includes('[Smoke]')
            ? 'smoke'
            : finalName.includes('[Contract]')
              ? 'contract'
              : 'baseline';
          const id = `12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeee${slot === 'baseline' ? '01' : slot === 'smoke' ? '02' : '03'}`;
          return {
            collectionId: id,
            journaledRootIds: [id],
            deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
          };
        }
      );
      const internalIntegration = buildIntegration(events);

      await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: {
          read: () => null,
          write: () => undefined
        },
        specFetcher: vi.fn()
      });

      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      expect(imported).toHaveLength(3);

      const collectStructural = (collection: JsonRecord): string[] => {
        const ids: string[] = [];
        const info = collection.info && typeof collection.info === 'object' && !Array.isArray(collection.info)
          ? (collection.info as JsonRecord)
          : null;
        if (typeof info?._postman_id === 'string') ids.push(info._postman_id);
        const walk = (items: unknown): void => {
          if (!Array.isArray(items)) return;
          for (const raw of items) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
            const item = raw as JsonRecord;
            if (typeof item.id === 'string') ids.push(item.id);
            walk(item.item);
            if (Array.isArray(item.response)) {
              for (const resp of item.response) {
                if (resp && typeof resp === 'object' && !Array.isArray(resp) && typeof (resp as JsonRecord).id === 'string') {
                  ids.push(String((resp as JsonRecord).id));
                }
              }
            }
          }
        };
        walk(collection.item);
        return ids;
      };

      const idSets = imported.map(collectStructural);
      for (const ids of idSets) expect(ids.length).toBeGreaterThan(0);
      const all = idSets.flat();
      expect(new Set(all).size).toBe(all.length);
    });
  });

  it('does not replace existing IDs when deep-update fails (Q6)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      postman.deepUpdateV2Collection = vi.fn(async (collectionUid: string) => {
        events.push(`deepUpdate:${collectionUid}`);
        if (collectionUid === 'col-smoke-existing') {
          throw new Error('deep update failed');
        }
        return collectionUid;
      });
      const internalIntegration = buildIntegration(events);

      await expect(
        runBootstrap(
          createInputs({
            workspaceId: 'ws-1',
            specId: 'spec-existing',
            baselineCollectionId: 'col-baseline-existing',
            smokeCollectionId: 'col-smoke-existing',
            contractCollectionId: 'col-contract-existing',
            collectionSyncMode: 'refresh'
          }),
          {
            core,
            exec: createExecStub(),
            io: { which: async () => 'tool' },
            internalIntegration,
            postman: postman as unknown as BootstrapExecutionDependencies['postman'],
            resourcesState: {
              read: () => null,
              write: () => undefined
            },
            specFetcher: vi.fn()
          }
        )
      ).rejects.toThrow(/LOCAL_OPENAPI_ORCHESTRATION_FAILED: stage=(deep-update|cloud-collection-write)/);

      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.importV2Collection).not.toHaveBeenCalled();
      expect(postman.deleteVerifiedRunOwnedCollections).not.toHaveBeenCalled();
      expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
    });
  });

  it('starts all three role cloud writes concurrently (Q7)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      let inFlight = 0;
      let maxInFlight = 0;
      postman.importV2Collection = vi.fn(
        async (_workspaceId: string, collection: unknown, finalName: string) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          events.push(`import:${finalName}`);
          const id = finalName.includes('[Contract]')
            ? 'col-contract'
            : finalName.includes('[Smoke]')
              ? 'col-smoke'
              : 'col-baseline';
          void collection;
          return {
            collectionId: id,
            journaledRootIds: [id],
            deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
          };
        }
      );
      const internalIntegration = buildIntegration(events);
      await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: { read: () => null, write: () => undefined },
        specFetcher: vi.fn()
      });
      expect(maxInFlight).toBe(3);
      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
    });
  });

  it('keeps planned outputs wired for prebuilt and operation ledger', () => {
    const planned = createPlannedOutputs(
      resolveInputs({
        INPUT_PROJECT_NAME: 'x',
        INPUT_SPEC_PATH: 'openapi.yaml'
      })
    );
    expect(planned['prebuilt-collections-json']).toBe('');
    expect(planned['openapi-operation-ledger-json']).toBe('');
  });

  it('does not leave package-root .postman or postman residue after orchestration', async () => {
    const packageRoot = path.resolve(import.meta.dirname, '..');
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core: createCoreStub(),
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: { read: () => null, write: () => undefined },
        specFetcher: vi.fn()
      });
    });
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(packageRoot, '.postman'))).toBe(false);
    expect(existsSync(path.join(packageRoot, 'postman'))).toBe(false);
  });
});
