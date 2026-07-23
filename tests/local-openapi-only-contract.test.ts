import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runBootstrap,
  type BootstrapExecutionDependencies,
  type CoreLike,
  type ExecLike,
  type ResolvedInputs
} from '../src/index.js';

const VALID_OPENAPI_SPEC = `{
  "openapi": "3.1.0",
  "info": {
    "title": "Local OpenAPI Only Contract API",
    "version": "1.0.0"
  },
  "paths": {
    "/ping": {
      "get": {
        "operationId": "getPing",
        "summary": "Get ping",
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "status": { "type": "string" }
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

function getSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getSourceFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function createCoreStub(): CoreLike {
  return {
    error: vi.fn(),
    getInput: () => '',
    group: async (_name, fn) => fn(),
    info: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    warning: vi.fn()
  };
}

function createExecStub(): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
  };
}

function createTestInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'local-openapi-contract-api',
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
    specPath: 'openapi.json',
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

describe('OpenAPI Local-Only Architecture Contract', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function withRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
    const repoRoot = await mkdtemp(join(tmpdir(), 'local-openapi-contract-'));
    tempDirs.push(repoRoot);
    await writeFile(join(repoRoot, 'openapi.json'), VALID_OPENAPI_SPEC);
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

  it('enforces no runtime generation mode or kill switch in configuration and contracts', () => {
    const actionYml = readFileSync(join(process.cwd(), 'action.yml'), 'utf8');
    const contractsSource = readFileSync(join(process.cwd(), 'src/contracts.ts'), 'utf8');
    const indexSource = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');

    // action.yml inputs do not contain generation-mode or use-spec-hub kill switch inputs
    expect(actionYml).not.toMatch(/generation-mode/i);
    expect(actionYml).not.toMatch(/use-spec-hub/i);
    expect(actionYml).not.toMatch(/spec-hub-generation/i);

    // contracts.ts does not define generation mode or kill switch properties
    expect(contractsSource).not.toMatch(/generationMode/i);
    expect(contractsSource).not.toMatch(/useSpecHubGeneration/i);
    expect(contractsSource).not.toMatch(/specHubGeneration/i);

    // index.ts does not inspect generation mode inputs or feature flags to choose Spec Hub generation for OpenAPI
    expect(indexSource).not.toMatch(/inputs\.generationMode/i);
    expect(indexSource).not.toMatch(/inputs\.useSpecHub/i);
  });

  it('prohibits arbitrary limit names in the local/prebuilt implementation source code', () => {
    const srcDir = join(process.cwd(), 'src');
    const sourceFiles = getSourceFiles(srcDir);

    const forbiddenLimits = [
      'maxInputBytes',
      'maxFilesPerTree',
      'maxDirectoriesPerTree',
      'maxTreeEntries',
      'maxTreeDepth',
      'maxBytesPerTree',
      'maxPathLength',
      'maxIdLength',
      'MAX_COLLECTION_NAME_LENGTH'
    ];

    const violations: string[] = [];

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf8');
      const relativePath = filePath.replace(`${srcDir}/`, 'src/');

      for (const limitName of forbiddenLimits) {
        if (content.includes(limitName)) {
          violations.push(`${relativePath} contains forbidden limit name: ${limitName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('verifies OpenAPI orchestration does not call generateCollection or syncCollection and uses local whole-collection import/deep-update without post-create script PATCH or v3 per-item creation', async () => {
    await withRepo(async () => {
      const core = createCoreStub();
      const exec = createExecStub();
      const inputs = createTestInputs();

      const generateCollectionSpy = vi.fn().mockRejectedValue(
        new Error('Spec Hub generateCollection must be unreachable for OpenAPI')
      );
      const syncCollectionSpy = vi.fn().mockRejectedValue(
        new Error('Spec Hub syncCollection must be unreachable for OpenAPI')
      );
      const patchCollectionScriptsSpy = vi.fn().mockRejectedValue(
        new Error('patchCollectionScripts must be unreachable for local OpenAPI roles')
      );
      const patchItemScriptsSpy = vi.fn().mockRejectedValue(
        new Error('patchItemScripts must be unreachable for local OpenAPI roles')
      );
      const injectTestsSpy = vi.fn().mockRejectedValue(
        new Error('injectTests must be unreachable for local OpenAPI roles')
      );
      const injectContractTestsSpy = vi.fn().mockRejectedValue(
        new Error('injectContractTests must be unreachable for local OpenAPI roles')
      );
      const createCollectionSpy = vi.fn().mockRejectedValue(
        new Error('createCollection must be unreachable for local OpenAPI roles')
      );
      const createRunOwnedCollectionSpy = vi.fn().mockRejectedValue(
        new Error('createRunOwnedCollection must be unreachable for local OpenAPI roles')
      );

      const importV2CollectionSpy = vi.fn(
        async (_wsId: string, _col: unknown, name: string) => {
          const colId = name.includes('[Contract]')
            ? 'col-contract-id'
            : name.includes('[Smoke]')
              ? 'col-smoke-id'
              : 'col-baseline-id';
          return {
            collectionId: colId,
            journaledRootIds: [colId]
          };
        }
      );

      const deepUpdateV2CollectionSpy = vi.fn(
        async (colUid: string) => colUid
      );

      const uploadSpecSpy = vi.fn().mockResolvedValue('spec-uid-123');
      const uploadSpecWithOutcomeSpy = vi.fn().mockResolvedValue({ specId: 'spec-uid-123', created: true });

      let lastLinked: Array<{
        collectionId: string;
        options?: Record<string, unknown>;
        syncOptions?: { syncExamples: boolean };
      }> = [];

      const listSpecificationCollectionRelationsSpy = vi.fn().mockImplementation(async () => {
        return lastLinked.map((entry) => ({
          collectionId: entry.collectionId,
          state: 'in-sync',
          ...(entry.options ? { options: entry.options } : {}),
          ...(entry.syncOptions ? { syncOptions: entry.syncOptions } : {})
        }));
      });

      const dependencies: BootstrapExecutionDependencies = {
        core,
        exec,
        postman: {
          addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
          createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-created' }),
          findWorkspacesByName: vi.fn().mockResolvedValue([{ id: 'ws-1', name: 'local-openapi-contract-api' }]),
          getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
          getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
          getTeams: vi.fn().mockResolvedValue([]),
          uploadSpec: uploadSpecSpy,
          uploadSpecWithOutcome: uploadSpecWithOutcomeSpy,
          getSpecContent: vi.fn().mockResolvedValue(VALID_OPENAPI_SPEC),
          updateSpec: vi.fn().mockResolvedValue(undefined),
          importV2Collection: importV2CollectionSpy,
          deepUpdateV2Collection: deepUpdateV2CollectionSpy,
          generateCollection: generateCollectionSpy,
          patchCollectionScripts: patchCollectionScriptsSpy,
          patchItemScripts: patchItemScriptsSpy,
          injectTests: injectTestsSpy,
          injectContractTests: injectContractTestsSpy,
          inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
          createCollection: createCollectionSpy,
          createRunOwnedCollection: createRunOwnedCollectionSpy,
          deleteVerifiedRunOwnedCollections: vi.fn().mockResolvedValue(undefined),
          tagCollection: vi.fn().mockResolvedValue(undefined)
        },
        internalIntegration: {
          findWorkspaceForRepo: vi.fn().mockResolvedValue({ state: 'free' }),
          assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
          linkCollectionsToSpecification: vi.fn().mockImplementation(async (
            _specId: string,
            collections: Array<{
              collectionId: string;
              options?: Record<string, unknown>;
              syncOptions?: { syncExamples: boolean };
            }>
          ) => {
            lastLinked = collections.map((entry) => ({ ...entry }));
            return { lockedRetries: 0 };
          }),
          listSpecificationCollectionRelations: listSpecificationCollectionRelationsSpy,
          settleSpecificationCollectionRelations: vi.fn().mockImplementation(async () => {
            const relations = await listSpecificationCollectionRelationsSpy();
            return {
              relations,
              attempts: 1
            };
          }),
          syncCollection: syncCollectionSpy
        },
        io: { which: async () => 'tool' },
        specFetcher: vi.fn()
      };

      const result = await runBootstrap(inputs, dependencies);

      expect(result['workspace-id']).toBe('ws-1');
      expect(result['spec-id']).toBe('spec-uid-123');

      // Spec Hub collection generation and sync must NOT be called
      expect(generateCollectionSpy).not.toHaveBeenCalled();
      expect(syncCollectionSpy).not.toHaveBeenCalled();

      // Post-create script PATCH or per-item creation must NOT be called
      expect(patchCollectionScriptsSpy).not.toHaveBeenCalled();
      expect(patchItemScriptsSpy).not.toHaveBeenCalled();
      expect(injectTestsSpy).not.toHaveBeenCalled();
      expect(injectContractTestsSpy).not.toHaveBeenCalled();
      expect(createCollectionSpy).not.toHaveBeenCalled();
      expect(createRunOwnedCollectionSpy).not.toHaveBeenCalled();

      // Whole-collection import/deep-update MUST be called for local roles
      expect(importV2CollectionSpy.mock.calls.length + deepUpdateV2CollectionSpy.mock.calls.length).toBeGreaterThan(0);

      // Verify canonical spec upload took place exactly once, with no temporary fanout spec creation
      expect(uploadSpecWithOutcomeSpy).toHaveBeenCalledWith(
        'ws-1',
        'local-openapi-contract-api',
        expect.any(String),
        expect.any(String)
      );
      expect(uploadSpecWithOutcomeSpy).toHaveBeenCalledTimes(1);
      expect(uploadSpecSpy).not.toHaveBeenCalled();
    });
  });
});
