import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
import * as localCollectionArtifacts from '../src/lib/repo/local-collection-artifacts.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import {
  computePayloadDigest,
  generateLocalOpenApiRolePayloads,
  type CollectionRole
} from '../src/lib/spec/local-openapi-collection-generation.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';

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
    onboardingScope: 'full',
    syncExamples: true,
    collectionSyncMode: 'refresh',
    collectionUpdateStrategy: 'whole',
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
    secretsResolverProvider: 'none',
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
    const storedCollections = new Map<string, JsonRecord>();
    const importV2Collection = vi.fn(
      async (
        _workspaceId: string,
        collection: unknown,
        finalName: string,
        _options?: { deferNominalSemanticVerification?: boolean }
      ) => {
        void _options;
        events.push(`import:${finalName}`);
        const id =
          finalName.includes('[Contract]')
            ? 'col-contract'
            : finalName.includes('[Smoke]')
              ? 'col-smoke'
              : 'col-baseline';
        const payload = collection as { event?: unknown[]; item?: unknown[] };
        expect(Array.isArray(payload.item)).toBe(true);
        storedCollections.set(id, structuredClone(collection as JsonRecord));
        return {
          collectionId: id,
          journaledRootIds: [id],
          deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
        };
      }
    );
    const deepUpdateV2Collection = vi.fn(async (collectionUid: string, collection: unknown, expectedPayloadDigest: string) => {
      void expectedPayloadDigest;
      events.push(`deepUpdate:${collectionUid}`);
      storedCollections.set(collectionUid, structuredClone(collection as JsonRecord));
      return collectionUid;
    });
    return {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-1' }),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      deleteSpec: vi.fn().mockResolvedValue(undefined),
      deleteVerifiedRunOwnedCollections: vi.fn().mockResolvedValue(undefined),
      deepUpdateV2Collection,
      applyCollectionDelta: undefined as unknown as (
        collectionUid: string,
        plan: unknown,
        desiredCollection: unknown,
        expectedPayloadDigest: string,
        rollback?: { collection: unknown; payloadDigest: string }
      ) => Promise<unknown>,
      collectionWriteMetrics: undefined as unknown,
      exportV2Collection: vi.fn(async (collectionUid: string) => {
        events.push(`export:${collectionUid}`);
        return storedCollections.get(collectionUid) ?? { info: { _postman_id: collectionUid, name: `snapshot-${collectionUid}` }, item: [] };
      }),
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
      reconcileDuplicateFinalCollections: vi.fn().mockResolvedValue({}),
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

  async function generateRoleCollections(): Promise<Record<CollectionRole, JsonRecord>> {
    const generated = await generateLocalOpenApiRolePayloads(VALID_SPEC_31, {
      openApiVersion: '3.1',
      requestNameSource: 'Fallback',
      folderStrategy: 'Paths',
      nestedFolderHierarchy: false,
      secretsResolverProvider: 'none',
      names: {
        baseline: 'orchestration-api',
        smoke: '[Smoke] orchestration-api',
        contract: '[Contract] orchestration-api'
      },
      contractIndex: buildContractIndex(parseOpenApiDocument(VALID_SPEC_31))
    });
    return {
      baseline: generated.roles.baseline.collection,
      smoke: generated.roles.smoke.collection,
      contract: generated.roles.contract.collection
    };
  }

  it('imports one collection per fresh role before link/tags and hard-zeros forbidden spies', async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      const originalMaterialize = localCollectionArtifacts.materializeLocalCollectionArtifacts;
      const originalPersist = localCollectionArtifacts.persistLocalOpenApiArtifactManifest;
      vi.spyOn(localCollectionArtifacts, 'materializeLocalCollectionArtifacts').mockImplementation(
        async (...args) => {
          events.push('materialize');
          return originalMaterialize(...args);
        }
      );
      vi.spyOn(localCollectionArtifacts, 'persistLocalOpenApiArtifactManifest').mockImplementation(
        async (...args) => {
          events.push('persist-manifest');
          return originalPersist(...args);
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

      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      for (const call of postman.importV2Collection.mock.calls) {
        expect(call[3]).toEqual({
          convergentLogicalRoot: true,
          deferNominalSemanticVerification: true
        });
      }
      expect(postman.exportV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deepUpdateV2Collection).not.toHaveBeenCalled();
      expect(postman.reconcileDuplicateFinalCollections).not.toHaveBeenCalled();
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.injectTests).not.toHaveBeenCalled();
      expect(postman.injectContractTests).not.toHaveBeenCalled();
      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();

      const materializeIdx = events.indexOf('materialize');
      const importIdx = events.findIndex((e) => e.startsWith('import:'));
      const linkIdx = events.findIndex((e) => e.startsWith('link:'));
      const settleIdx = events.findIndex((e) => e.startsWith('settle:'));
      const readbackIdx = events.indexOf('readback');
      const tagIdx = events.findIndex((e) => e.startsWith('tag:'));
      const persistIdx = events.indexOf('persist-manifest');
      expect(materializeIdx).toBeGreaterThanOrEqual(0);
      expect(importIdx).toBeGreaterThan(materializeIdx);
      expect(linkIdx).toBeGreaterThan(importIdx);
      expect(settleIdx).toBeGreaterThan(linkIdx);
      expect(readbackIdx).toBeGreaterThan(settleIdx);
      expect(tagIdx).toBeGreaterThan(readbackIdx);
      expect(persistIdx).toBeGreaterThan(tagIdx);

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

  it('admits all three fresh import finalizers before any one completes', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      const pending = new Map<string, () => void>();
      const stored = new Map<string, JsonRecord>();
      let allPendingResolve!: () => void;
      const allPending = new Promise<void>((resolve) => { allPendingResolve = resolve; });
      postman.importV2Collection = vi.fn(async (_workspaceId: string, collection: unknown, finalName: string) => {
        const id = finalName.includes('[Contract]') ? 'col-contract' : finalName.includes('[Smoke]') ? 'col-smoke' : 'col-baseline';
        stored.set(id, structuredClone(collection as JsonRecord));
        await new Promise<void>((resolve) => {
          pending.set(id, resolve);
          if (pending.size === 3) allPendingResolve();
        });
        return {
          collectionId: id,
          journaledRootIds: [id],
          deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
        };
      });
      postman.exportV2Collection = vi.fn(async (id: string) => stored.get(id)!);

      const run = runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core: createCoreStub(), exec: createExecStub(), io: { which: async () => 'tool' },
        internalIntegration: buildIntegration(events),
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: { read: () => null, write: () => undefined }, specFetcher: vi.fn()
      });
      await allPending;
      expect(pending.size).toBe(3);
      for (const resolve of pending.values()) resolve();
      await run;
    });
  });

  it('uses semantic Sync receipts instead of fresh export projections for all imported roles', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      const verifyCollectionSemanticReceipt = vi.fn(async (
        _id: string,
        collection: unknown,
        digest: string
      ) => {
        expect(computePayloadDigest(collection as JsonRecord)).toBe(digest);
      });
      Object.assign(postman, { verifyCollectionSemanticReceipt });

      await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core: createCoreStub(), exec: createExecStub(), io: { which: async () => 'tool' },
        internalIntegration: buildIntegration(events),
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: { read: () => null, write: () => undefined }, specFetcher: vi.fn()
      });

      expect(verifyCollectionSemanticReceipt).toHaveBeenCalledTimes(3);
      expect(postman.exportV2Collection).not.toHaveBeenCalled();
    });
  });

  it('fails through owned rollback when an exact final export digest mismatches', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      postman.exportV2Collection = vi.fn(async (id: string) => ({
        info: { _postman_id: id, name: 'mismatched-final' }, item: []
      }));
      const integration = buildIntegration(events);
      await expect(runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core: createCoreStub(), exec: createExecStub(), io: { which: async () => 'tool' },
        internalIntegration: integration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: { read: () => null, write: () => undefined }, specFetcher: vi.fn()
      })).rejects.toThrow(/stage=collection-final-verification.*final export digest mismatch/);
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledWith('ws-1', [
        'col-baseline', 'col-smoke', 'col-contract'
      ]);
      expect(integration.linkCollectionsToSpecification).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('continues default lenient example repair through materialization, linking, and tagging', async () => {
    await withRepo(async (repoRoot) => {
      await writeFile(path.join(repoRoot, 'openapi.yaml'), JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Impossible API', version: '1.0.0' },
        paths: {
          '/impossible': {
            post: {
              operationId: 'createImpossible',
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['code'],
                      properties: { code: { type: 'string', pattern: '^A$', minLength: 2 } }
                    }
                  }
                }
              },
              responses: { '200': { description: 'ok' } }
            }
          }
        }
      }));
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      const materialize = vi.spyOn(localCollectionArtifacts, 'materializeLocalCollectionArtifacts');

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

      expect(materialize).toHaveBeenCalledTimes(1);
      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deepUpdateV2Collection).not.toHaveBeenCalled();
      expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledTimes(1);
      expect(postman.tagCollection).toHaveBeenCalledTimes(3);
      expect(core.warnings).toContainEqual(
        expect.stringMatching(
          /LOCAL_OPENAPI_EXAMPLE_REPAIR_SKIPPED: operation POST \/impossible request example: generated application\/json request body for POST \/impossible could not be safely repaired to satisfy its OpenAPI schema/
        )
      );
    });
  });

  it('compensates journaled fresh imports on link failure before resources/manifest persist', { timeout: 30_000 }, async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      internalIntegration.linkCollectionsToSpecification = vi.fn().mockRejectedValue(new Error('link boom'));
      let durableState: Record<string, unknown> | null = null;
      const resourcesState = {
        read: () => durableState as never,
        write: (state: Record<string, unknown>) => {
          durableState = structuredClone(state);
        }
      };
      const originalPersist = localCollectionArtifacts.persistLocalOpenApiArtifactManifest;
      vi.spyOn(localCollectionArtifacts, 'persistLocalOpenApiArtifactManifest').mockImplementation(
        async (...args) => {
          events.push('persist-manifest');
          return originalPersist(...args);
        }
      );

      await expect(
        runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
          core,
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration,
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState,
          specFetcher: vi.fn()
        })
      ).rejects.toThrow(/link boom/);

      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledTimes(1);
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledWith('ws-1', [
        'col-baseline',
        'col-smoke',
        'col-contract'
      ]);
      expect(postman.tagCollection).not.toHaveBeenCalled();
      const collections =
        (durableState as { cloudResources?: { collections?: Record<string, unknown> } } | null)
          ?.cloudResources?.collections ?? {};
      expect(Object.keys(collections)).toHaveLength(0);
      expect(events).not.toContain('persist-manifest');
      await expect(
        access(path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('compensates only the fresh import when mixed deep-update + import hits tag failure', async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      postman.tagCollection = vi.fn().mockRejectedValue(new Error('tag boom'));
      let durableState: Record<string, unknown> | null = null;
      const resourcesState = {
        read: () => durableState as never,
        write: (state: Record<string, unknown>) => {
          durableState = structuredClone(state);
        }
      };
      const originalPersist = localCollectionArtifacts.persistLocalOpenApiArtifactManifest;
      vi.spyOn(localCollectionArtifacts, 'persistLocalOpenApiArtifactManifest').mockImplementation(
        async (...args) => {
          events.push('persist-manifest');
          return originalPersist(...args);
        }
      );

      await expect(
        runBootstrap(
          createInputs({
            workspaceId: 'ws-1',
            baselineCollectionId: 'col-baseline-existing',
            collectionSyncMode: 'refresh'
          }),
          {
            core,
            exec: createExecStub(),
            io: { which: async () => 'tool' },
            internalIntegration,
            postman: postman as unknown as BootstrapExecutionDependencies['postman'],
            resourcesState,
            specFetcher: vi.fn()
          }
        )
      ).rejects.toThrow(/tag boom/);

      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(2);
      expect(postman.deepUpdateV2Collection).toHaveBeenCalledWith(
        'col-baseline-existing',
        expect.anything(),
        expect.any(String)
      );
      expect(postman.importV2Collection).toHaveBeenCalledTimes(2);
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledTimes(1);
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledWith('ws-1', [
        'col-smoke',
        'col-contract'
      ]);
      const collections =
        (durableState as { cloudResources?: { collections?: Record<string, unknown> } } | null)
          ?.cloudResources?.collections ?? {};
      expect(Object.keys(collections)).toHaveLength(0);
      expect(events).not.toContain('persist-manifest');
      await expect(
        access(path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('persists the local OpenAPI artifact manifest only after tag success', async () => {
    await withRepo(async (repoRoot) => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const internalIntegration = buildIntegration(events);
      const originalPersist = localCollectionArtifacts.persistLocalOpenApiArtifactManifest;
      vi.spyOn(localCollectionArtifacts, 'persistLocalOpenApiArtifactManifest').mockImplementation(
        async (...args) => {
          events.push('persist-manifest');
          return originalPersist(...args);
        }
      );

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

      const tagIdx = events.findIndex((e) => e.startsWith('tag:'));
      const persistIdx = events.indexOf('persist-manifest');
      expect(tagIdx).toBeGreaterThanOrEqual(0);
      expect(persistIdx).toBeGreaterThan(tagIdx);
      const manifestRaw = await readFile(
        path.join(repoRoot, '.postman/local-openapi-artifact-manifest.json'),
        'utf8'
      );
      expect(JSON.parse(manifestRaw)).toMatchObject({ schemaVersion: 1 });
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

      expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledTimes(1);
      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('accepts nested requested options as a requested subset with wrapped leaf values', async () => {
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
            syncOptions?: { syncExamples: boolean };
          }>;
          return {
            relations: expectedIds.map((collectionId) => {
              const requested = linked.find((entry) => entry.collectionId === collectionId);
              return {
                collectionId,
                state: 'in-sync',
                options: {
                  value: {
                    ...(requested?.options ?? {}),
                    serverNestedDefault: true
                  },
                  isDisabled: false,
                  reason: ''
                },
                syncOptions: {
                  syncExamples: { value: true, isDisabled: false, reason: '' },
                  deleteOrphanedRequests: { value: false, isDisabled: false, reason: '' }
                }
              };
            }),
            attempts: 1
          };
        }
      );

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

      expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledTimes(1);
      expect(internalIntegration.syncCollection).not.toHaveBeenCalled();
      expect(postman.tagCollection).toHaveBeenCalledTimes(3);
    });
  });

  it('fails closed when requested syncExamples is absent from server readback', async () => {
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
              options: linked.find((entry) => entry.collectionId === collectionId)?.options,
              syncOptions: {
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

      expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledTimes(1);
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

  it('uses bounded deltas only for auto refreshes and emits the complete sanitized convergence receipt', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      const alterFirstRequest = (collection: JsonRecord): JsonRecord => {
        const altered = structuredClone(collection);
        const visit = (items: unknown[]): boolean => {
          for (const item of items) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const record = item as JsonRecord;
            if (record.request && typeof record.request === 'object') {
              record.description = 'previous request description';
              return true;
            }
            if (Array.isArray(record.item) && visit(record.item)) return true;
          }
          return false;
        };
        expect(visit(altered.item as unknown[])).toBe(true);
        return altered;
      };
      const firstRequestId = (collection: JsonRecord): string => {
        const visit = (items: unknown[]): string | undefined => {
          for (const item of items) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const record = item as JsonRecord;
            if (record.request && typeof record.request === 'object') {
              return typeof record.id === 'string' ? record.id : undefined;
            }
            if (Array.isArray(record.item)) {
              const found = visit(record.item);
              if (found) return found;
            }
          }
          return undefined;
        };
        const value = visit(collection.item as unknown[]);
        if (!value) throw new Error('independent snapshot request id missing');
        return value;
      };
      // This is deliberately independent of runBootstrap's conversion. The
      // converter rekeys structural ids on every invocation.
      const exported = await generateRoleCollections();
      const baselineSnapshot = alterFirstRequest(exported.baseline);
      const baselineSnapshotRequestId = firstRequestId(baselineSnapshot);
      let convergedBaseline: JsonRecord | undefined;
      postman.exportV2Collection = vi.fn(async (collectionUid: string) => {
        if (collectionUid === 'col-baseline-existing') return convergedBaseline ?? baselineSnapshot;
        if (collectionUid === 'col-smoke-existing') return exported.smoke;
        return exported.contract;
      }) as unknown as typeof postman.exportV2Collection;
      postman.applyCollectionDelta = vi.fn(async (_uid: string, rawPlan: unknown, desiredCollection: unknown, digest: string) => {
        const plan = rawPlan as {
          decision: string;
          operations: Array<{ kind: string; sourceId?: string; item: JsonRecord }>;
        };
        if (plan.decision !== 'apply') throw new Error(JSON.stringify(plan));
        expect(plan.operations).toHaveLength(1);
        expect(plan.operations[0]).toMatchObject({
          kind: 'patch',
          sourceId: baselineSnapshotRequestId,
          item: { id: baselineSnapshotRequestId }
        });
        convergedBaseline = structuredClone(desiredCollection as JsonRecord);
        return { strategy: 'delta' as const, observedPayloadDigest: digest };
      });
      postman.collectionWriteMetrics = {
        ambiguousWrites: 1,
        convergedWithoutResend: 1,
        resendCount: 0,
        verifyPolls: 2,
        recoveryMs: 3,
        inventoryReads: 4,
        inventorySleepMs: 5,
        rootResolveMs: 6,
        renameMs: 7,
        electionMs: 8,
        deltaOpsByKind: { create: 0, patch: 1, move: 0, delete: 0 },
        deltaRoutes: ['PATCH /v3/collections/{param}/items/{param}'],
        changedBytes: 9,
        deltaMs: 10,
        fallbackReasons: []
      };

      const outputs = await runBootstrap(
        createInputs({
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing',
          collectionUpdateStrategy: 'auto'
        }),
        {
          core: createCoreStub(),
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration: buildIntegration(events),
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: { read: () => null, write: () => undefined },
          specFetcher: vi.fn()
        }
      );

      expect(postman.applyCollectionDelta).toHaveBeenCalledTimes(1);
      expect(postman.deepUpdateV2Collection).not.toHaveBeenCalled();
      const ledger = JSON.parse(outputs['openapi-operation-ledger-json'] || '{}') as {
        skippedRoles: CollectionRole[];
        convergence: Record<string, unknown> & { roles: Array<Record<string, unknown>> };
      };
      expect(ledger.skippedRoles).toEqual(['smoke', 'contract']);
      expect(ledger.convergence).toMatchObject({
        strategy: 'auto',
        skippedRoles: 2,
        ambiguousWrites: 1,
        convergedWithoutResend: 1,
        resendCount: 0,
        verifyPolls: 2,
        recoveryMs: 3,
        inventoryReads: 4,
        inventorySleepMs: 5,
        rootResolveMs: 6,
        renameMs: 7,
        electionMs: 8,
        deltaOpsByKind: { create: 0, patch: 1, move: 0, delete: 0 },
        deltaRoutes: ['PATCH /v3/collections/{param}/items/{param}'],
        deltaMs: 10,
        fallbackReasons: []
      });
      expect(ledger.convergence.roles).toHaveLength(3);
      for (const role of ledger.convergence.roles) {
        expect(role).toMatchObject({
          changedBytes: expect.any(Number),
          networkMs: expect.any(Number),
          wallMs: expect.any(Number),
          reconciliationMs: expect.any(Number),
          fallbackReason: null
        });
        expect(role.desiredSemanticDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(role.observedSemanticDigest).toBe(role.desiredSemanticDigest);
        expect(role.payloadBytes).toEqual(expect.any(Number));
        expect(role.snapshotMs).toEqual(expect.any(Number));
        expect(role.writeMs).toEqual(expect.any(Number));
      }
      expect(ledger.convergence.roles).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'baseline', outcome: 'delta', operationCount: 1 }),
        expect.objectContaining({ role: 'smoke', outcome: 'unchanged', operationCount: 0, writeMs: 0 }),
        expect.objectContaining({ role: 'contract', outcome: 'unchanged', operationCount: 0, writeMs: 0 })
      ]));
    });
  });

  it('uses hardened whole-tree fallback for unsupported auto deltas while whole never invokes the delta seam', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      const converged = new Map<string, JsonRecord>();
      postman.exportV2Collection = vi.fn(async (uid: string) =>
        converged.get(uid) ?? { info: { _postman_id: uid, name: `stale-${uid}` }, item: [] }
      );
      postman.applyCollectionDelta = vi.fn(async (uid: string, rawPlan: unknown, desiredCollection: unknown) => {
        const plan = rawPlan as { decision: string };
        expect(plan.decision).toBe('fallback');
        converged.set(uid, structuredClone(desiredCollection as JsonRecord));
        return { strategy: 'whole-fallback' as const, fallbackReason: 'unsupported-root-attribute' };
      });

      const outputs = await runBootstrap(
        createInputs({
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing',
          collectionUpdateStrategy: 'auto'
        }),
        {
          core: createCoreStub(),
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration: buildIntegration(events),
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: { read: () => null, write: () => undefined },
          specFetcher: vi.fn()
        }
      );

      expect(postman.applyCollectionDelta).toHaveBeenCalledTimes(3);
      const autoLedger = JSON.parse(outputs['openapi-operation-ledger-json'] || '{}') as {
        convergence: { roles: Array<{ outcome: string; fallbackReason: string | null }>; fallbackReasons: string[] };
      };
      expect(autoLedger.convergence.roles).toEqual(expect.arrayContaining([
        expect.objectContaining({ outcome: 'deep-update', fallbackReason: 'unsupported-root-attribute' })
      ]));
      expect(autoLedger.convergence.fallbackReasons).toEqual(['unsupported-root-attribute']);

      const wholePostman = buildPostman(events);
      wholePostman.applyCollectionDelta = vi.fn();
      await runBootstrap(
        createInputs({
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing',
          collectionUpdateStrategy: 'whole'
        }),
        {
          core: createCoreStub(),
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration: buildIntegration(events),
          postman: wholePostman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: { read: () => null, write: () => undefined },
          specFetcher: vi.fn()
        }
      );
      expect(wholePostman.applyCollectionDelta).not.toHaveBeenCalled();
      expect(wholePostman.deepUpdateV2Collection).toHaveBeenCalledTimes(3);
    });
  });

  it('skips unchanged refresh roles without issuing collection writes', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const snapshots = await generateRoleCollections();
      postman.exportV2Collection = vi.fn(async (collectionUid: string) => {
        if (collectionUid === 'col-baseline-existing') return snapshots.baseline;
        if (collectionUid === 'col-smoke-existing') return snapshots.smoke;
        return snapshots.contract;
      }) as typeof postman.exportV2Collection;
      const outputs = await runBootstrap(
        createInputs({
          workspaceId: 'ws-1',
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing'
        }),
        {
          core,
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration: buildIntegration(events),
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: { read: () => null, write: () => undefined },
          specFetcher: vi.fn()
        }
      );

      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(0);
      expect(postman.importV2Collection).toHaveBeenCalledTimes(0);
      expect(postman.exportV2Collection).toHaveBeenCalledTimes(3);
      expect(outputs['baseline-collection-id']).toBe('col-baseline-existing');
      expect(outputs['smoke-collection-id']).toBe('col-smoke-existing');
      expect(outputs['contract-collection-id']).toBe('col-contract-existing');
      const ledger = JSON.parse(outputs['openapi-operation-ledger-json'] || '{}') as {
        skippedRoles: CollectionRole[];
        counts: Record<string, number>;
        timings: {
          snapshotMsByRole: Record<CollectionRole, number>;
          writeMsByRole: Record<CollectionRole, number>;
        };
      };
      expect(ledger.skippedRoles).toEqual(['baseline', 'smoke', 'contract']);
      expect(ledger.counts.deepUpdate).toBe(0);
      expect(ledger.timings.snapshotMsByRole).toEqual({
        baseline: expect.any(Number),
        smoke: expect.any(Number),
        contract: expect.any(Number)
      });
      expect(ledger.timings.writeMsByRole).toEqual({
        baseline: expect.any(Number),
        smoke: expect.any(Number),
        contract: expect.any(Number)
      });
    });
  });

  it('writes changed roles while skipping equal snapshot digests in the same refresh', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      const snapshots = await generateRoleCollections();
      let smokeReads = 0;
      postman.exportV2Collection = vi.fn(async (collectionUid: string) => {
        if (collectionUid === 'col-baseline-existing') return snapshots.baseline;
        if (collectionUid === 'col-contract-existing') return snapshots.contract;
        smokeReads += 1;
        return smokeReads === 1
          ? { info: { _postman_id: collectionUid, name: `stale-${collectionUid}` }, item: [] }
          : snapshots.smoke;
      }) as typeof postman.exportV2Collection;
      const outputs = await runBootstrap(
        createInputs({
          workspaceId: 'ws-1',
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing'
        }),
        {
          core: createCoreStub(),
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration: buildIntegration(events),
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: { read: () => null, write: () => undefined },
          specFetcher: vi.fn()
        }
      );

      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(1);
      expect(postman.deepUpdateV2Collection).toHaveBeenCalledWith(
        'col-smoke-existing',
        expect.anything(),
        expect.any(String)
      );
      const ledger = JSON.parse(outputs['openapi-operation-ledger-json'] || '{}') as {
        skippedRoles: CollectionRole[];
        counts: Record<string, number>;
      };
      expect(ledger.skippedRoles).toEqual(['baseline', 'contract']);
      expect(ledger.counts.deepUpdate).toBe(1);
    });
  });

  it('exports reusable-root snapshots and final proofs through two bounded concurrent lanes', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const postman = buildPostman(events);
      let snapshotRequests = 0;
      let inFlightSnapshots = 0;
      let maxInFlightSnapshots = 0;
      const converged = new Map<string, JsonRecord>();
      const originalDeepUpdate = postman.deepUpdateV2Collection;
      postman.deepUpdateV2Collection = vi.fn(async (uid: string, collection: unknown, digest: string) => {
        const result = await originalDeepUpdate(uid, collection, digest);
        converged.set(uid, structuredClone(collection as JsonRecord));
        return result;
      }) as typeof postman.deepUpdateV2Collection;
      postman.exportV2Collection = vi.fn(async (collectionUid: string) => {
        snapshotRequests += 1;
        inFlightSnapshots += 1;
        maxInFlightSnapshots = Math.max(maxInFlightSnapshots, inFlightSnapshots);
        await Promise.resolve();
        inFlightSnapshots -= 1;
        return converged.get(collectionUid) ?? { info: { _postman_id: collectionUid, name: `stale-${collectionUid}` }, item: [] };
      });

      await runBootstrap(
        createInputs({
          workspaceId: 'ws-1',
          specId: 'spec-existing',
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing'
        }),
        {
          core: createCoreStub(),
          exec: createExecStub(),
          io: { which: async () => 'tool' },
          internalIntegration: buildIntegration(events),
          postman: postman as unknown as BootstrapExecutionDependencies['postman'],
          resourcesState: { read: () => null, write: () => undefined },
          specFetcher: vi.fn()
        }
      );

      expect(snapshotRequests).toBe(6);
      expect(maxInFlightSnapshots).toBe(2);
      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(3);
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
      expect(postman.deepUpdateV2Collection).not.toHaveBeenCalled();
      expect(postman.applyCollectionDelta).toBeUndefined();
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
      expect(postman.deleteVerifiedRunOwnedCollections).toHaveBeenCalledWith('ws-1', [
        canonicalBaselineUid
      ]);
      expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('retains long masked orchestration causes as one line', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const uniqueSuffix = 'UNIQUE-CAUSE-SUFFIX-BEYOND-240-CHARACTERS';
      const nestedSuffix = 'NESTED-IMPORT-CAUSE-SUFFIX';
      postman.importV2Collection = vi.fn().mockRejectedValue(
        new Error(`import failure ${'x'.repeat(260)}\r\n${uniqueSuffix} token=postman-access-token`, {
          cause: new Error(nestedSuffix)
        })
      );
      const internalIntegration = buildIntegration(events);

      const error = await runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
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
      }).then(
        () => new Error('expected orchestration failure'),
        (cause: unknown) => cause
      );

      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain('LOCAL_OPENAPI_ORCHESTRATION_FAILED');
      expect(message).toContain(uniqueSuffix);
      expect(message).toContain(nestedSuffix);
      expect(message.match(new RegExp(nestedSuffix, 'g'))).toHaveLength(1);
      expect(message).not.toMatch(/[\r\n\u2028\u2029]/);
      expect(message).not.toContain('postman-access-token');
    });
  });

  it('imports three roles with pairwise-disjoint structural Sync IDs (Q12 collision)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const imported: JsonRecord[] = [];
      const finalExports = new Map<string, JsonRecord>();
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
          finalExports.set(id, structuredClone(collection as JsonRecord));
          return {
            collectionId: id,
            journaledRootIds: [id],
            deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
          };
        }
      );
      postman.exportV2Collection = vi.fn(async (id: string) => finalExports.get(id)!);
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

  it('preflights snapshots before writes and restores attempted deep-updates after a smoke failure (Q3)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      postman.deepUpdateV2Collection = vi.fn(async (collectionUid: string, collection: unknown, expectedPayloadDigest: string) => {
        void expectedPayloadDigest;
        events.push(`deepUpdate:${collectionUid}`);
        if (collectionUid === 'col-smoke-existing' && !String(((collection as JsonRecord).info as JsonRecord)?.name).startsWith('snapshot-')) {
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

      // Both lanes drain before rollback. The baseline worker can start contract
      // while smoke is failing, so all attempted writes remain rollback candidates.
      expect(postman.exportV2Collection).toHaveBeenCalledTimes(3);
      expect(events.filter((event) => event.startsWith('export:'))).toEqual([
        'export:col-baseline-existing',
        'export:col-smoke-existing',
        'export:col-contract-existing'
      ]);
      expect(events.findIndex((event) => event.startsWith('deepUpdate:'))).toBeGreaterThan(
        events.findIndex((event) => event === 'export:col-contract-existing')
      );
      expect(postman.deepUpdateV2Collection).toHaveBeenCalledTimes(6);
      expect(postman.deepUpdateV2Collection.mock.calls.map((call) => call[0])).toEqual([
        'col-baseline-existing',
        'col-smoke-existing',
        'col-contract-existing',
        'col-baseline-existing',
        'col-smoke-existing',
        'col-contract-existing'
      ]);
      expect(postman.deepUpdateV2Collection.mock.calls.slice(3).map((call) =>
        String(((call[1] as JsonRecord).info as JsonRecord).name)
      )).toEqual([
        'snapshot-col-baseline-existing',
        'snapshot-col-smoke-existing',
        'snapshot-col-contract-existing'
      ]);
      expect(postman.importV2Collection).not.toHaveBeenCalled();
      expect(postman.deleteVerifiedRunOwnedCollections).not.toHaveBeenCalled();
      expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
    });
  });

  it('rejects a structured-description rollback snapshot before any role mutation', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const structuredSnapshot = {
        info: {
          _postman_id: 'col-contract-existing',
          name: 'snapshot-col-contract-existing',
          description: { content: 'SDK description', type: 'text/plain' }
        },
        item: []
      };
      postman.exportV2Collection = vi.fn(async (collectionUid: string) => {
        events.push(`export:${collectionUid}`);
        if (collectionUid === 'col-contract-existing') {
          const description = structuredSnapshot.info.description;
          if (typeof description !== 'string') {
            throw new Error(
              'COLLECTION_SNAPSHOT_INVALID: structured collection descriptions cannot be restored safely'
            );
          }
          return structuredSnapshot;
        }
        return {
          info: {
            _postman_id: collectionUid,
            name: `snapshot-${collectionUid}`,
            description: 'restorable string description'
          },
          item: []
        };
      });
      const internalIntegration = buildIntegration(events);
      const resourcesWrite = vi.fn();

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
              write: resourcesWrite
            },
            specFetcher: vi.fn()
          }
        )
      ).rejects.toThrow(/COLLECTION_SNAPSHOT_INVALID: structured collection descriptions/);

      expect(postman.exportV2Collection).toHaveBeenCalledTimes(3);
      expect(postman.deepUpdateV2Collection).not.toHaveBeenCalled();
      expect(postman.importV2Collection).not.toHaveBeenCalled();
      expect(postman.deleteVerifiedRunOwnedCollections).not.toHaveBeenCalled();
      expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
      expect(postman.tagCollection).not.toHaveBeenCalled();
      // Workspace discovery is persisted earlier; no collection identity or
      // manifest may be persisted after the collection preflight rejects.
      expect(resourcesWrite).toHaveBeenCalledExactlyOnceWith({ workspace: { id: 'ws-1' } });
    });
  });

  it('admits all three fresh import finalizers simultaneously within one workspace (Q7)', async () => {
    await withRepo(async () => {
      const events: string[] = [];
      const core = createCoreStub();
      const postman = buildPostman(events);
      const pending = new Map<string, () => void>();
      const finalExports = new Map<string, JsonRecord>();
      let allPendingResolve!: () => void;
      const allPending = new Promise<void>((resolve) => { allPendingResolve = resolve; });
      postman.importV2Collection = vi.fn(
        async (_workspaceId: string, collection: unknown, finalName: string) => {
          const id = finalName.includes('[Contract]')
            ? 'col-contract'
            : finalName.includes('[Smoke]')
              ? 'col-smoke'
              : 'col-baseline';
          finalExports.set(id, structuredClone(collection as JsonRecord));
          await new Promise<void>((resolve) => {
            pending.set(id, resolve);
            if (pending.size === 3) allPendingResolve();
          });
          events.push(`import:${finalName}`);
          return {
            collectionId: id,
            journaledRootIds: [id],
            deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
          };
        }
      );
      postman.exportV2Collection = vi.fn(async (id: string) => finalExports.get(id)!);
      const internalIntegration = buildIntegration(events);
      const run = runBootstrap(createInputs({ workspaceId: 'ws-1' }), {
        core,
        exec: createExecStub(),
        io: { which: async () => 'tool' },
        internalIntegration,
        postman: postman as unknown as BootstrapExecutionDependencies['postman'],
        resourcesState: { read: () => null, write: () => undefined },
        specFetcher: vi.fn()
      });
      await allPending;
      expect(pending.size).toBe(3);
      for (const resolve of pending.values()) resolve();
      await run;
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
