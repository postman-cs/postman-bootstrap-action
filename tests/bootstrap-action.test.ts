import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import {
  readResourcesState,
  writeResourcesState
} from '../src/lib/postman/additional-collections.js';
import {
  applyOas30TypeNullLintCompatibility,
  lintSpecViaCli,
  normalizeSpecDocument,
  readActionInputs,
  runAction,
  runBootstrap,
  type CoreLike,
  type ExecLike,
  type IOLike,
  type ResolvedInputs
} from '../src/index.js';

const VALID_SPEC_31 = `{
  "openapi": "3.1.0",
  "info": {
    "title": "Test API",
    "version": "1.0.0"
  },
  "paths": {
    "/payments": {
      "get": {
        "summary": "GET /payments",
        "responses": {
          "200": {
            "description": "OK",
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

const COLLECTION_SCHEMA =
  'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

function createCoreStub(values: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const secrets: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const errors: string[] = [];

  const core: CoreLike = {
    error: (message: string) => {
      errors.push(message);
    },
    getInput: (name: string, options?: { required?: boolean }) => {
      const value = values[name] ?? '';
      if (options?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    group: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    info: (message: string) => {
      infos.push(message);
    },
    setFailed: vi.fn(),
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    setSecret: (secret: string) => {
      secrets.push(secret);
    },
    warning: (message: string) => {
      warnings.push(message);
    }
  };

  return {
    core,
    errors,
    infos,
    outputs,
    secrets,
    warnings
  };
}

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'core-payments',
    syncExamples: true,
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    domain: 'core-banking',
    domainCode: 'AF',
    requesterEmail: 'owner@example.com',
    workspaceAdminUserIds: '101,102',
    repoUrl: 'https://github.com/postman-cs/bootstrap-action-test',
    specUrl: 'https://example.test/openapi.yaml',
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
    integrationBackend: 'bifrost',
    folderStrategy: 'Paths',
    nestedFolderHierarchy: false,
    requestNameSource: 'Fallback',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanGatewayBase: 'https://gateway.postman.com',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
    postmanIapubBase: 'https://iapub.postman.co',
    githubRefName: undefined,
    githubHeadRef: undefined,
    githubRef: undefined,
    githubSha: undefined,
    ...overrides
  };
}

function createExecStub(stdout = '{"violations":[]}'): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout,
      stderr: ''
    })
  };
}

function createIoStub(): IOLike {
  return {
    which: vi.fn().mockResolvedValue('/usr/local/bin/postman')
  };
}

function createGeneratedContractCollection() {
  return {
    info: { name: '[Contract] core-payments' },
    item: [
      {
        name: 'GET /payments',
        request: {
          method: 'GET',
          url: { path: ['payments'] }
        }
      }
    ]
  };
}

function createCuratedCollection(name: string) {
  return {
    info: {
      name,
      schema: COLLECTION_SCHEMA
    },
    item: [
      {
        name: 'GET /curated',
        request: {
          method: 'GET',
          url: 'https://example.test/curated'
        }
      }
    ]
  };
}

function withContractHelpers<T extends Record<string, unknown>>(postman: T): T {
  const existingGetCollection = postman.getCollection as ((uid: string) => Promise<unknown>) | undefined;
  const existingGenerateCollection = postman.generateCollection as ((...args: unknown[]) => Promise<string>) | undefined;
  const generatedIds = new Set<string>();
  const getCollection = vi.fn(async (uid: string) => {
    if (uid.toLowerCase().includes('contract')) return createGeneratedContractCollection();
    if (existingGetCollection) return existingGetCollection(uid);
    return createGeneratedContractCollection();
  });
  const generateCollection = existingGenerateCollection
    ? vi.fn(async (...args: unknown[]) => {
      const id = await existingGenerateCollection(...args);
      if (!generatedIds.has(id)) {
        generatedIds.add(id);
        return id;
      }
      const prefix = String(args[2] || 'collection').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
      const uniqueId = `${id}-${prefix}`;
      generatedIds.add(uniqueId);
      return uniqueId;
    })
    : undefined;
  return {
    ...postman,
    ...(generateCollection ? { generateCollection } : {}),
    getCollection,
    updateCollection: postman.updateCollection ?? vi.fn().mockResolvedValue(undefined)
  };
}

function createRollbackPostman(overrides: Record<string, unknown> = {}) {
  return {
    addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
    createCollection: vi.fn().mockResolvedValue('col-created'),
    createWorkspace: vi.fn(),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    findWorkspacesByName: vi.fn().mockResolvedValue([]),
    generateCollection: vi
      .fn()
      .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
        if (prefix === '') return 'col-baseline-generated';
        if (prefix === '[Smoke]') return 'col-smoke-generated';
        return 'col-contract-generated';
      }),
    getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
    getCollection: vi.fn().mockResolvedValue(createGeneratedContractCollection()),
    getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
    getTeams: vi.fn().mockResolvedValue([]),
    getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
    getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
    injectContractTests: vi.fn().mockResolvedValue([]),
    injectTests: vi.fn().mockResolvedValue(undefined),
    inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
    tagCollection: vi.fn().mockResolvedValue(undefined),
    updateCollection: vi.fn().mockResolvedValue(undefined),
    updateSpec: vi.fn().mockResolvedValue(undefined),
    uploadSpec: vi.fn(),
    ...overrides
  };
}

function createRollbackIntegration(overrides: Record<string, unknown> = {}) {
  return {
    assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
    configureTeamContext: vi.fn(),
    linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
    syncCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

async function runExistingSpecBootstrap(
  postman: ReturnType<typeof createRollbackPostman>,
  options: {
    core?: CoreLike;
    exec?: ExecLike;
    github?: { getRepositoryCustomProperty: (name: string) => Promise<string> };
    inputs?: Partial<ResolvedInputs>;
    internalIntegration?: ReturnType<typeof createRollbackIntegration>;
    resourcesState?: { read: typeof readResourcesState; write: typeof writeResourcesState };
  } = {}
) {
  return await runBootstrap(
    createInputs({
      workspaceId: 'ws-existing',
      specId: 'spec-existing',
      ...options.inputs
    }),
    {
      core: options.core ?? createCoreStub().core,
      exec: options.exec ?? createExecStub(),
      github: options.github,
      internalIntegration: options.internalIntegration,
      io: createIoStub(),
      postman,
      resourcesState: options.resourcesState,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_SPEC_31, { status: 200 })
      )
    }
  );
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
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

describe('bootstrap action', () => {
  afterEach(() => {
    rmSync('.postman', { recursive: true, force: true });
  });

  it('marks secrets as early as input resolution', () => {
    const { core, secrets } = createCoreStub({
      'project-name': 'core-payments',
      'spec-url': 'https://example.test/openapi.yaml',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'postman-access-token'
    });

    const inputs = readActionInputs(core);

    expect(inputs.postmanApiKey).toBe('pmak-test');
    expect(secrets).toEqual([
      'pmak-test',
      'postman-access-token'
    ]);
  });

  it('fails the breaking-change check before Postman resource mutations', async () => {
    const { core, outputs } = createCoreStub();
    const postman = createRollbackPostman({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    });
    const openApiChanges = vi.fn().mockResolvedValue({
      breakingChanges: 1,
      comparison: 'Spec Hub previous version -> incoming spec',
      exitCode: 1,
      logPath: '/tmp/openapi-changes.log',
      message: '1 breaking change marker detected.',
      mode: 'previous-spec',
      status: 'failed',
      summaryPath: '/tmp/openapi-changes-summary.md'
    });

    await expect(
      runBootstrap(
        createInputs({
          breakingChangeMode: 'previous-spec',
          specId: 'spec-existing',
          workspaceId: undefined
        }),
        {
          core,
          exec: createExecStub(),
          internalIntegration: createRollbackIntegration(),
          io: createIoStub(),
          openApiChanges,
          postman,
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(VALID_SPEC_31, { status: 200 })
          )
        }
      )
    ).rejects.toThrow(/OpenAPI breaking-change check failed/);

    expect(openApiChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'previous-spec',
        previousSpecContent: expect.stringContaining('"openapi": "3.1.0"')
      }),
      expect.objectContaining({
        exec: expect.any(Object)
      })
    );
    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.updateSpec).not.toHaveBeenCalled();
    expect(outputs['breaking-change-status']).toBe('failed');
    expect(JSON.parse(outputs['breaking-change-summary-json'])).toMatchObject({
      breakingChanges: 1,
      status: 'failed'
    });
  });

  it('accepts spec-path instead of spec-url', () => {
    const { core } = createCoreStub({
      'project-name': 'core-payments',
      'spec-path': 'apis/core-payments/openapi.yaml',
      'postman-api-key': 'pmak-test'
    });

    const inputs = readActionInputs(core);

    expect(inputs.specPath).toBe('apis/core-payments/openapi.yaml');
    expect(inputs.specUrl).toBe('');
  });

  it('requires exactly one of spec-url or spec-path', () => {
    const neither = createCoreStub({
      'project-name': 'core-payments',
      'postman-api-key': 'pmak-test'
    });
    expect(() => readActionInputs(neither.core)).toThrow(/spec-url or spec-path/);

    const both = createCoreStub({
      'project-name': 'core-payments',
      'spec-url': 'https://example.test/openapi.yaml',
      'spec-path': 'apis/core-payments/openapi.yaml',
      'postman-api-key': 'pmak-test'
    });
    expect(() => readActionInputs(both.core)).toThrow(/not both/);
  });

  it('runs the bootstrap flow end to end and emits outputs', async () => {
    const { core, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const order: string[] = [];
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
          order.push(prefix);
          if (prefix === '') return 'col-baseline';
          if (prefix === '[Smoke]') return 'col-smoke';
          return 'col-contract';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
      configureTeamContext: vi.fn(),
      linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
      syncCollection: vi.fn().mockResolvedValue(undefined)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, {
        status: 200
      })
    );

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      internalIntegration,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(execStub.exec).toHaveBeenCalledWith('postman', [
      'login',
      '--with-api-key',
      'pmak-test'
    ]);
    expect(internalIntegration.assignWorkspaceToGovernanceGroup).toHaveBeenCalledWith(
      'ws-123',
      'core-banking',
      '{"core-banking":"Core Banking"}',
      undefined
    );
    expect(postman.inviteRequesterToWorkspace).toHaveBeenCalledWith(
      'ws-123',
      'owner@example.com'
    );
    expect(postman.addAdminsToWorkspace).toHaveBeenCalledWith('ws-123', '101,102');
    expect(order).toEqual(['', '[Smoke]', '[Contract]']);
    expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledWith(
      'spec-123',
      [
        { collectionId: 'col-baseline', syncOptions: { syncExamples: true } },
        { collectionId: 'col-smoke', syncOptions: { syncExamples: true } },
        { collectionId: 'col-contract', syncOptions: { syncExamples: true } }
      ]
    );
    expect(internalIntegration.syncCollection).toHaveBeenNthCalledWith(
      1,
      'spec-123',
      'col-baseline'
    );
    expect(internalIntegration.syncCollection).toHaveBeenNthCalledWith(
      2,
      'spec-123',
      'col-smoke'
    );
    expect(internalIntegration.syncCollection).toHaveBeenNthCalledWith(
      3,
      'spec-123',
      'col-contract'
    );
    expect(result).toMatchObject({
      'workspace-id': 'ws-123',
      'workspace-name': '[AF] core-payments',
      'spec-id': 'spec-123',
      'baseline-collection-id': 'col-baseline',
      'smoke-collection-id': 'col-smoke',
      'contract-collection-id': 'col-contract'
    });
    expect(outputs['collections-json']).toBe(
      JSON.stringify({
        baseline: 'col-baseline',
        contract: 'col-contract',
        smoke: 'col-smoke'
      })
    );
    expect(outputs['lint-summary-json']).toBe(
      JSON.stringify({
        errors: 0,
        total: 0,
        violations: [],
        warnings: 0
      })
    );
  });

  it('syncs additional local collections without linking them as generated spec collections', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-additional-collections-run-'));
    mkdirSync(join(workspace, 'postman/curated/nested'), { recursive: true });
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      join(workspace, 'postman/curated/payments.json'),
      JSON.stringify(createCuratedCollection('Payments curated'), null, 2)
    );
    writeFileSync(
      join(workspace, 'postman/curated/nested/refunds.yaml'),
      stringifyYaml(createCuratedCollection('Refunds curated'))
    );
    writeFileSync(
      join(workspace, '.postman/resources.yaml'),
      stringifyYaml({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          additionalCollections: {
            '../postman/curated/payments.json': 'col-payments-existing'
          }
        }
      })
    );

    try {
      await withCwd(workspace, async () => {
        const { core } = createCoreStub();
        const postman = createRollbackPostman({
          createCollection: vi.fn().mockResolvedValue('col-refunds-created'),
          updateCollection: vi.fn().mockResolvedValue(undefined)
        });
        const internalIntegration = createRollbackIntegration();

        await runExistingSpecBootstrap(postman, {
          core,
          internalIntegration,
          resourcesState: { read: readResourcesState, write: writeResourcesState },
          inputs: {
            additionalCollectionsDir: 'postman/curated',
            baselineCollectionId: 'col-baseline-existing',
            collectionSyncMode: 'version',
            contractCollectionId: 'col-contract-existing',
            releaseLabel: 'v1',
            smokeCollectionId: 'col-smoke-existing'
          }
        });

        expect(postman.createCollection).toHaveBeenCalledWith(
          'ws-existing',
          expect.objectContaining({
            info: expect.objectContaining({ name: 'Refunds curated' })
          }),
          expect.objectContaining({ onRootCreated: expect.any(Function) })
        );
        expect(postman.updateCollection).toHaveBeenCalledWith(
          'col-payments-existing',
          expect.objectContaining({
            info: expect.objectContaining({ name: 'Payments curated' })
          })
        );
        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8'));
        expect(resources.cloudResources?.additionalCollections).toMatchObject({
          '../postman/curated/nested/refunds.yaml': 'col-refunds-created',
          '../postman/curated/payments.json': 'col-payments-existing'
        });
        expect(resources.workspace).toEqual({ id: 'ws-existing' });
        expect(resources.cloudResources?.specs).toEqual({
          'spec-url:https://example.test/openapi.yaml': 'spec-existing'
        });
        expect(resources.cloudResources?.collections).toMatchObject({
          '../postman/collections/core-payments v1': 'col-baseline-existing',
          '../postman/collections/[Smoke] core-payments v1': 'col-smoke-existing',
          '../postman/collections/[Contract] core-payments v1': 'col-contract-existing'
        });

        expect(postman.injectTests).toHaveBeenCalledTimes(1);
        expect(postman.injectTests).toHaveBeenCalledWith('col-smoke-existing', 'smoke');
        expect(postman.tagCollection).toHaveBeenCalledTimes(3);
        expect(postman.tagCollection).not.toHaveBeenCalledWith(
          'col-payments-existing',
          expect.any(Array)
        );
        expect(postman.tagCollection).not.toHaveBeenCalledWith(
          'col-refunds-created',
          expect.any(Array)
        );
        expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledWith(
          'spec-existing',
          [
            { collectionId: 'col-baseline-existing', syncOptions: { syncExamples: true } },
            { collectionId: 'col-smoke-existing', syncOptions: { syncExamples: true } },
            { collectionId: 'col-contract-existing', syncOptions: { syncExamples: true } }
          ]
        );
        expect(internalIntegration.syncCollection).toHaveBeenCalledTimes(3);
        expect(internalIntegration.syncCollection).not.toHaveBeenCalledWith(
          'spec-existing',
          'col-payments-existing'
        );
        expect(internalIntegration.syncCollection).not.toHaveBeenCalledWith(
          'spec-existing',
          'col-refunds-created'
        );
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uploads the original OpenAPI 3.0 bytes in type null compatibility mode', async () => {
    const source = `openapi: 3.0.3
info: { title: Nullable Test, version: 1.0.0 }
paths:
  /ping:
    get:
      responses:
        '200': { description: OK }
components:
  schemas:
    Criteria:
      type: object
      properties:
        value:
          oneOf:
            - type: string
            - type: 'null'
`;
    const postman = createRollbackPostman({
      uploadSpec: vi.fn().mockResolvedValue('spec-nullable')
    });
    const lintPath = '$.components.schemas.Criteria.properties.value.oneOf[1].type';
    const execStub = createExecStub(JSON.stringify({
      violations: [{
        severity: 'ERROR',
        issue: '"type" property must be equal to one of the allowed values',
        path: lintPath
      }]
    }));

    const result = await runBootstrap(
      createInputs({
        preserveOas30TypeNull: true,
        workspaceId: 'ws-existing'
      }),
      {
        core: createCoreStub().core,
        exec: execStub,
        internalIntegration: createRollbackIntegration(),
        io: createIoStub(),
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(source, { status: 200 }))
      }
    );

    expect(postman.uploadSpec).toHaveBeenCalledWith(
      'ws-existing',
      'core-payments',
      source,
      '3.0'
    );
    expect(result['lint-summary-json']).toContain('"errors":0');
    expect(result['lint-summary-json']).toContain('"severity":"WARNING"');
  });

  it('persists current bootstrap resource state before additional collection mappings', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-additional-fresh-state-'));
    mkdirSync(join(workspace, 'postman/curated'), { recursive: true });
    writeFileSync(
      join(workspace, 'postman/curated/payments.json'),
      JSON.stringify(createCuratedCollection('Payments curated'), null, 2)
    );
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);

    try {
      await withCwd(workspace, async () => {
        const postman = createRollbackPostman({
          createCollection: vi.fn().mockResolvedValue('col-payments-created')
        });

        await runExistingSpecBootstrap(postman, {
          resourcesState: { read: readResourcesState, write: writeResourcesState },
          inputs: {
            additionalCollectionsDir: 'postman/curated',
            baselineCollectionId: 'col-baseline-existing',
            collectionSyncMode: 'version',
            contractCollectionId: 'col-contract-existing',
            releaseLabel: 'v1',
            smokeCollectionId: 'col-smoke-existing',
            specPath: 'openapi.yaml',
            specUrl: ''
          }
        });

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8'));
        expect(resources).toMatchObject({
          workspace: { id: 'ws-existing' },
          cloudResources: {
            specs: {
              '../openapi.yaml': 'spec-existing'
            },
            collections: {
              '../postman/collections/core-payments v1': 'col-baseline-existing',
              '../postman/collections/[Smoke] core-payments v1': 'col-smoke-existing',
              '../postman/collections/[Contract] core-payments v1': 'col-contract-existing'
            },
            additionalCollections: {
              '../postman/curated/payments.json': 'col-payments-created'
            }
          }
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects invalid additional collections before bootstrap side effects', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-additional-invalid-'));
    mkdirSync(join(workspace, 'postman/curated'), { recursive: true });
    writeFileSync(
      join(workspace, 'postman/curated/not-a-collection.json'),
      JSON.stringify({ item: [] }, null, 2)
    );

    try {
      await withCwd(workspace, async () => {
        const execStub = createExecStub();
        const postman = createRollbackPostman({
          createCollection: vi.fn().mockResolvedValue('col-created'),
          updateCollection: vi.fn().mockResolvedValue(undefined)
        });

        await expect(
          runExistingSpecBootstrap(postman, {
            exec: execStub,
            inputs: {
              additionalCollectionsDir: 'postman/curated'
            }
          })
        ).rejects.toThrow(/ADDITIONAL_COLLECTION_INVALID/);

        expect(execStub.exec).not.toHaveBeenCalled();
        expect(postman.createCollection).not.toHaveBeenCalled();
        expect(postman.updateCollection).not.toHaveBeenCalled();
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('uses postman-governance-group repository custom property when no explicit group is provided', async () => {
    const postman = createRollbackPostman({
      uploadSpec: vi.fn().mockResolvedValue('spec-123')
    });
    const internalIntegration = createRollbackIntegration();
    const github = {
      getRepositoryCustomProperty: vi.fn().mockResolvedValue('Core Banking')
    };

    await runExistingSpecBootstrap(postman, {
      github,
      inputs: {
        domain: undefined,
        githubToken: 'gh-token',
        repoSlug: 'postman-cs/bootstrap-action-test'
      },
      internalIntegration
    });

    expect(github.getRepositoryCustomProperty).toHaveBeenCalledWith('postman-governance-group');
    expect(internalIntegration.assignWorkspaceToGovernanceGroup).toHaveBeenCalledWith(
      'ws-existing',
      '',
      '{"core-banking":"Core Banking"}',
      'Core Banking'
    );
  });

  it('uploads the bundled OpenAPI document used for dynamic contract validation', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
          if (prefix === '') return 'col-baseline';
          if (prefix === '[Smoke]') return 'col-smoke';
          return 'col-contract';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const rootSpec = `openapi: 3.1.0
info: { title: Test API, version: 1.0.0 }
paths:
  /payments:
    get:
      summary: GET /payments
      responses:
        '200':
          $ref: 'https://example.test/components.yaml#/components/responses/PaymentList'
`;
    const componentsSpec = `components:
  responses:
    PaymentList:
      description: OK
      content:
        application/json:
          schema:
            type: object
`;
    const specFetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const href = typeof url === 'string'
        ? url
        : url instanceof URL
          ? url.toString()
          : url.url;
      return new Response(href.includes('components.yaml') ? componentsSpec : rootSpec, { status: 200 });
    });

    await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: createIoStub(),
      postman: withContractHelpers(postman),
      specFetcher
    });

    const uploadedContent = vi.mocked(postman.uploadSpec).mock.calls[0]?.[2] as string;
    expect(uploadedContent).not.toContain('components.yaml');
    const uploaded = JSON.parse(uploadedContent) as {
      paths: Record<string, { get: { responses: Record<string, { description?: string }> } }>;
    };
    expect(uploaded.paths['/payments']?.get.responses['200']?.description).toBe('OK');
  });

  it('fails when spec lint returns errors', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub(
      JSON.stringify({
        violations: [
          {
            issue: 'Missing operationId',
            path: '$.paths./payments.get',
            severity: 'ERROR'
          }
        ]
      })
    );
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      })
    ).rejects.toThrow('Spec lint found 1 errors');

    expect(postman.generateCollection).not.toHaveBeenCalled();
  });

  it('restores previous spec content when lint fails after an update', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub(
      JSON.stringify({
        violations: [
          {
            issue: 'Broken schema',
            path: '$.paths./payments.get',
            severity: 'ERROR'
          }
        ]
      })
    );
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      runBootstrap(
        createInputs({ workspaceId: 'ws-existing', specId: 'spec-existing' }),
        {
          core,
          exec: execStub,
          io: ioStub,
          postman: withContractHelpers(postman),
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(VALID_SPEC_31, { status: 200 })
          )
        }
      )
    ).rejects.toThrow('Spec lint found 1 errors');

    expect(postman.getSpecContent).toHaveBeenCalledWith('spec-existing');
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      1,
      'spec-existing',
      VALID_SPEC_31,
      'ws-existing'
    );
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      2,
      'spec-existing',
      VALID_SPEC_31,
      'ws-existing'
    );
  });

  it('snapshots normalized previous spec content before updating an existing spec', async () => {
    const previousRaw = `openapi: 3.1.0
info:
  title: Previous API
  version: 1.0.0
paths:
  /payments:
    get:
      responses:
        '200':
          description: OK
`;
    const expectedPrevious = normalizeSpecDocument(previousRaw, () => undefined);
    const postman = createRollbackPostman({
      getSpecContent: vi.fn().mockResolvedValue(previousRaw)
    });

    await runExistingSpecBootstrap(postman);

    expect(postman.getSpecContent).toHaveBeenCalledWith('spec-existing');
    expect(postman.getSpecContent.mock.invocationCallOrder[0]).toBeLessThan(
      postman.updateSpec.mock.invocationCallOrder[0]
    );
    expect(postman.updateSpec).toHaveBeenCalledTimes(1);
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      1,
      'spec-existing',
      VALID_SPEC_31,
      'ws-existing'
    );
    expect(expectedPrevious).toContain('summary: GET /payments');
  });

  it.each([
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.injectTests).not.toHaveBeenCalled();
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'generation refused',
      name: 'collection generation',
      overrides: {
        generateCollection: vi.fn().mockRejectedValue(new Error('generation refused'))
      }
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.injectTests).not.toHaveBeenCalled();
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'CONTRACT_OPERATION_COVERAGE_FAILED',
      name: 'contract instrumentation coverage',
      overrides: {
        injectContractTests: vi.fn().mockRejectedValue(new Error('CONTRACT_OPERATION_COVERAGE_FAILED'))
      }
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'inject failed',
      name: 'inject tests',
      overrides: {
        injectContractTests: vi.fn().mockResolvedValue([]),
        injectTests: vi.fn().mockRejectedValue(new Error('inject failed'))
      }
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.injectTests).toHaveBeenCalled();
      },
      failure: 'tag failed',
      name: 'tagging',
      overrides: {
        tagCollection: vi.fn().mockRejectedValue(new Error('tag failed'))
      }
    },
    {
      expectedSkippedCalls: (
        postman: ReturnType<typeof createRollbackPostman>,
        internalIntegration?: ReturnType<typeof createRollbackIntegration>
      ) => {
        expect(postman.tagCollection).toHaveBeenCalled();
        expect(internalIntegration?.syncCollection).not.toHaveBeenCalled();
      },
      failure: 'link failed',
      integrationOverrides: {
        linkCollectionsToSpecification: vi.fn().mockRejectedValue(new Error('link failed'))
      },
      name: 'cloud linking',
      overrides: {}
    },
    {
      expectedSkippedCalls: (
        postman: ReturnType<typeof createRollbackPostman>,
        internalIntegration?: ReturnType<typeof createRollbackIntegration>
      ) => {
        expect(postman.tagCollection).toHaveBeenCalled();
        expect(internalIntegration?.syncCollection).toHaveBeenCalledTimes(2);
      },
      failure: 'sync failed',
      integrationOverrides: {
        syncCollection: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('sync failed'))
      },
      name: 'cloud sync',
      overrides: {}
    }
  ])(
    'restores previous spec content and stops downstream work after $name failure',
    async ({ expectedSkippedCalls, failure, integrationOverrides, overrides }) => {
      const { core, outputs, warnings } = createCoreStub();
      const postman = createRollbackPostman(overrides);
      const internalIntegration = integrationOverrides
        ? createRollbackIntegration(integrationOverrides)
        : undefined;

      await expect(
        runExistingSpecBootstrap(postman, {
          core,
          internalIntegration
        })
      ).rejects.toThrow(failure);

      expect(postman.updateSpec).toHaveBeenNthCalledWith(
        1,
        'spec-existing',
        VALID_SPEC_31,
        'ws-existing'
      );
      expect(postman.updateSpec).toHaveBeenLastCalledWith(
        'spec-existing',
        VALID_SPEC_31,
        'ws-existing'
      );
      expect(postman.updateSpec).toHaveBeenCalledTimes(2);
      expectedSkippedCalls(postman, internalIntegration);
      expect(outputs).toEqual({});
      expect(
        warnings.some((warning) =>
          warning.includes('Restored previous Spec Hub content for spec-existing')
          && warning.includes('sha256=')
        )
      ).toBe(true);
    }
  );

  it('restores previous content and preserves the incoming update failure reason when updateSpec fails', async () => {
    const { core, outputs } = createCoreStub();
    const postman = createRollbackPostman({
      updateSpec: vi
        .fn()
        .mockRejectedValueOnce(new Error('incoming update rejected'))
        .mockResolvedValueOnce(undefined)
    });

    await expect(
      runExistingSpecBootstrap(postman, { core })
    ).rejects.toThrow('incoming update rejected');

    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      1,
      'spec-existing',
      VALID_SPEC_31,
      'ws-existing'
    );
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      2,
      'spec-existing',
      VALID_SPEC_31,
      'ws-existing'
    );
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(outputs).toEqual({});
  });

  it('emits rollback failure with previous SHA-256 and original triggering stage', async () => {
    vi.useFakeTimers();
    try {
      const { core, outputs } = createCoreStub();
      const postman = createRollbackPostman({
        tagCollection: vi.fn().mockRejectedValue(new Error('tag stage failed')),
        updateSpec: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue(new Error('restore write failed'))
      });

      const run = runExistingSpecBootstrap(postman, { core });
      const rejection = expect(run).rejects.toThrow(
        /CONTRACT_SPEC_ROLLBACK_FAILED: .*after Tag Collections: tag stage failed.*sha256=[a-f0-9]{64}.*Rollback error: restore write failed/s
      );
      await vi.runAllTimersAsync();
      await rejection;

      expect(postman.updateSpec).toHaveBeenCalledTimes(4);
      expect(outputs).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries rollback restore and then preserves the original downstream failure on success', async () => {
    vi.useFakeTimers();
    try {
      const { core, outputs, warnings } = createCoreStub();
      const postman = createRollbackPostman({
        injectContractTests: vi.fn().mockResolvedValue([]),
        injectTests: vi.fn().mockRejectedValue(new Error('inject retry trigger')),
        updateSpec: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('transient restore lock'))
          .mockResolvedValueOnce(undefined)
      });

      const run = runExistingSpecBootstrap(postman, { core });
      const rejection = expect(run).rejects.toThrow('inject retry trigger');
      await vi.runAllTimersAsync();
      await rejection;

      expect(postman.updateSpec).toHaveBeenCalledTimes(3);
      expect(postman.updateSpec).toHaveBeenNthCalledWith(
        3,
        'spec-existing',
        VALID_SPEC_31,
        'ws-existing'
      );
      expect(outputs).toEqual({});
      expect(
        warnings.some((warning) =>
          warning.includes('Inject Test Scripts: inject retry trigger')
          && warning.includes('sha256=')
        )
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attempt rollback for new spec uploads when a later failure occurs', async () => {
    const { core, outputs } = createCoreStub();
    const postman = createRollbackPostman({
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
      generateCollection: vi.fn().mockRejectedValue(new Error('new upload generation failed')),
      uploadSpec: vi.fn().mockResolvedValue('spec-new')
    });

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: createExecStub(),
        io: createIoStub(),
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      })
    ).rejects.toThrow('new upload generation failed');

    expect(postman.uploadSpec).toHaveBeenCalledWith(
      'ws-new',
      'core-payments',
      VALID_SPEC_31,
      '3.1'
    );
    expect(postman.getSpecContent).not.toHaveBeenCalled();
    expect(postman.updateSpec).not.toHaveBeenCalled();
    expect(outputs).toEqual({});
  });

  it('validates normalized spec structure before upload or update', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn()
    };

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('info:\n  title: Missing version\n', { status: 200 })
        )
      })
    ).rejects.toThrow('Dynamic contract tests require OpenAPI 3.0 or 3.1 (missing openapi)');

    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.updateSpec).not.toHaveBeenCalled();
  });

  it('uses production safe fetch preflight and rejects unsafe spec URLs before Postman mutations', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn(),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn(),
      getTeams: vi.fn(),
      getSpecContent: vi.fn(),
      getWorkspaceGitRepoUrl: vi.fn(),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn(),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn(),
      deleteCollection: vi.fn(),
      getCollection: vi.fn(),
      updateCollection: vi.fn()
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn(),
      configureTeamContext: vi.fn(),
      linkCollectionsToSpecification: vi.fn(),
      syncCollection: vi.fn()
    };

    await expect(
      runBootstrap(createInputs({ specUrl: 'https://2130706433/openapi.yaml' }), {
        core,
        exec: execStub,
        io: ioStub,
        internalIntegration,
        postman,
        specFetcher: fetch
      })
    ).rejects.toThrow('CONTRACT_SPEC_FETCH_BLOCKED');

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.updateSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.getCollection).not.toHaveBeenCalled();
    expect(postman.updateCollection).not.toHaveBeenCalled();
    expect(postman.deleteCollection).not.toHaveBeenCalled();
    expect(postman.injectTests).not.toHaveBeenCalled();
    expect(postman.tagCollection).not.toHaveBeenCalled();
    expect(internalIntegration.assignWorkspaceToGovernanceGroup).not.toHaveBeenCalled();
    expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
    expect(internalIntegration.syncCollection).not.toHaveBeenCalled();
  });

  it('rejects collection ID collisions before collection generation or tagging', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn()
    };

    await expect(runBootstrap(createInputs({
      workspaceId: 'ws-existing',
      specId: 'spec-existing',
      baselineCollectionId: 'col-shared',
      smokeCollectionId: 'col-shared',
      contractCollectionId: 'col-contract-existing'
    }), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_SPEC_31, { status: 200 })
      )
    })).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');

    expect(postman.updateSpec).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.injectTests).not.toHaveBeenCalled();
    expect(postman.tagCollection).not.toHaveBeenCalled();
  });

  it('rejects missing previous spec content before updating an existing Spec Hub spec', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn(),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn(),
      getTeams: vi.fn(),
      getSpecContent: vi.fn().mockResolvedValue(undefined),
      getWorkspaceGitRepoUrl: vi.fn(),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn(),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn()
    };

    await expect(
      runBootstrap(createInputs({ workspaceId: 'ws-existing', specId: 'spec-existing' }), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      })
    ).rejects.toThrow('Unable to verify existing Spec Hub OpenAPI version for spec-id spec-existing');

    expect(postman.getSpecContent).toHaveBeenCalledWith('spec-existing');
    expect(postman.updateSpec).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
  });

  it('rejects existing Spec Hub OpenAPI version mismatches before update', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn(),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn(),
      getTeams: vi.fn(),
      getSpecContent: vi.fn().mockResolvedValue(`openapi: 3.0.3
info:
  title: Previous
  version: 1.0.0
paths:
  /payments:
    get:
      responses:
        '200': { description: OK }
`),
      getWorkspaceGitRepoUrl: vi.fn(),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn(),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn()
    };

    await expect(
      runBootstrap(createInputs({ workspaceId: 'ws-existing', specId: 'spec-existing' }), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      })
    ).rejects.toThrow('Existing Spec Hub spec version 3.0 cannot be updated with OpenAPI 3.1 content');

    expect(postman.getSpecContent).toHaveBeenCalledWith('spec-existing');
    expect(postman.updateSpec).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
  });

  it('warns when a reused workspace is not team-visible', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('personal'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'version',
        releaseLabel: 'v1'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(postman.getWorkspaceVisibility).toHaveBeenCalledWith('ws-existing');
    expect(
      warnings.some(
        (warning) =>
          warning.includes("visibility 'personal'") && warning.includes('API Catalog')
      ),
      `expected personal-visibility warning, got: ${warnings.join(' | ')}`
    ).toBe(true);
  });

  it('reuses existing workspace, spec, and collection ids from explicit inputs in version mode', async () => {
    const { core, infos, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'version',
        releaseLabel: 'v1'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-existing', VALID_SPEC_31, 'ws-existing');
    expect(result).toMatchObject({
      'workspace-id': 'ws-existing',
      'spec-id': 'spec-existing',
      'baseline-collection-id': 'col-baseline-existing',
      'smoke-collection-id': 'col-smoke-existing',
      'contract-collection-id': 'col-contract-existing'
    });
    expect(outputs['collections-json']).toBe(
      JSON.stringify({
        baseline: 'col-baseline-existing',
        contract: 'col-contract-existing',
        smoke: 'col-smoke-existing'
      })
    );
    expect(infos).toContain('Using existing workspace: ws-existing');
    expect(infos).toContain('Using existing baseline collection: col-baseline-existing');
    expect(infos).toContain('Using existing smoke collection: col-smoke-existing');
    expect(infos).toContain('Using existing contract collection: col-contract-existing');
  });

  it('sanitizes spec URLs before writing existing-spec update logs', async () => {
    const { core, infos } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      getCollection: vi.fn().mockResolvedValue(createGeneratedContractCollection()),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateCollection: vi.fn().mockResolvedValue(undefined),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'version',
        releaseLabel: 'v1',
        specUrl: 'https://user:pass@example.test/openapi.yaml?token=secret#frag'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    const infoLog = infos.join('\n');
    expect(infoLog).toContain('Updating existing spec spec-existing from https://example.test/openapi.yaml');
    expect(infoLog).not.toContain('user:pass');
    expect(infoLog).not.toContain('token=secret');
    expect(infoLog).not.toContain('#frag');
  });

  it('refresh mode regenerates collections in place when ids already exist', async () => {
    const { core } = createCoreStub();
    const postman = createRollbackPostman();
    const internalIntegration = createRollbackIntegration();

    const result = await runExistingSpecBootstrap(postman, {
      core,
      internalIntegration,
      inputs: {
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'refresh'
      }
    });

    // Regenerate-in-place via the spec sync route preserves each collection UID;
    // no fresh collection is generated and nothing is deleted (no v2 read/PUT).
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.deleteCollection).not.toHaveBeenCalled();
    expect(internalIntegration.syncCollection).toHaveBeenCalledWith('spec-existing', 'col-baseline-existing');
    expect(internalIntegration.syncCollection).toHaveBeenCalledWith('spec-existing', 'col-smoke-existing');
    expect(internalIntegration.syncCollection).toHaveBeenCalledWith('spec-existing', 'col-contract-existing');
    expect(postman.injectContractTests).toHaveBeenCalledWith('col-contract-existing', expect.anything());
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-existing',
      'smoke-collection-id': 'col-smoke-existing',
      'contract-collection-id': 'col-contract-existing'
    });
  });

  it('refresh mode generates fresh collections when no tracked ids exist', async () => {
    const { core } = createCoreStub();
    const generatedIds = ['col-baseline-new', 'col-smoke-new', 'col-contract-new'];
    const postman = createRollbackPostman({
      generateCollection: vi.fn().mockImplementation(async () => generatedIds.shift() || 'col-fallback')
    });
    const internalIntegration = createRollbackIntegration();

    const result = await runExistingSpecBootstrap(postman, {
      core,
      internalIntegration,
      inputs: { collectionSyncMode: 'refresh' }
    });

    expect(postman.generateCollection).toHaveBeenCalledTimes(3);
    expect(postman.deleteCollection).not.toHaveBeenCalled();
    expect(postman.injectContractTests).toHaveBeenCalledWith('col-contract-new', expect.anything());
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-new',
      'smoke-collection-id': 'col-smoke-new',
      'contract-collection-id': 'col-contract-new'
    });
  });

  it('refresh mode falls back to newly generated collections when sync of tracked targets fails', async () => {
    const { core, warnings } = createCoreStub();
    const generatedIds = ['col-baseline-fresh', 'col-smoke-fresh', 'col-contract-fresh'];
    const postman = createRollbackPostman({
      generateCollection: vi.fn().mockImplementation(async () => generatedIds.shift() || 'col-fallback')
    });
    const internalIntegration = createRollbackIntegration({
      syncCollection: vi.fn().mockImplementation(async (_specId: string, collectionId: string) => {
        if (collectionId.includes('stale')) {
          throw new Error('collection not linked to spec');
        }
        return undefined;
      })
    });

    const result = await runExistingSpecBootstrap(postman, {
      core,
      internalIntegration,
      inputs: {
        baselineCollectionId: 'col-baseline-stale',
        smokeCollectionId: 'col-smoke-stale',
        contractCollectionId: 'col-contract-stale',
        collectionSyncMode: 'refresh'
      }
    });

    // A sync failure on a stale/unlinked collection degrades to a fresh generate
    // (no hard failure, no v2 restore); the fresh ids win.
    expect(postman.generateCollection).toHaveBeenCalledTimes(3);
    expect(postman.deleteCollection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-fresh',
      'smoke-collection-id': 'col-smoke-fresh',
      'contract-collection-id': 'col-contract-fresh'
    });
    expect(
      warnings.some((warning) =>
        warning.includes('Could not regenerate existing') && warning.includes('col-smoke-stale')
      )
    ).toBe(true);
  });

  it('rejects collection ID collisions after refresh before tagging or linking', async () => {
    const { core } = createCoreStub();
    const postman = createRollbackPostman({
      generateCollection: vi.fn().mockResolvedValue('col-shared')
    });
    const internalIntegration = createRollbackIntegration();

    await expect(
      runExistingSpecBootstrap(postman, {
        core,
        internalIntegration,
        inputs: { collectionSyncMode: 'refresh' }
      })
    ).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');

    expect(postman.tagCollection).not.toHaveBeenCalled();
    expect(internalIntegration.linkCollectionsToSpecification).not.toHaveBeenCalled();
    expect(internalIntegration.syncCollection).not.toHaveBeenCalled();
  });

  it('records completed tag side effects when a later tag fails', async () => {
    const { core, warnings } = createCoreStub();
    const postman = createRollbackPostman({
      tagCollection: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('smoke tag rejected'))
    });

    await expect(
      runExistingSpecBootstrap(postman, { core })
    ).rejects.toThrow('smoke tag rejected');

    expect(postman.tagCollection).toHaveBeenCalledTimes(2);
    expect(
      warnings.some((warning) =>
        warning.includes('Completed external side effects before failure')
        && warning.includes('tagCollection(col-baseline-generated, generated-docs)')
      )
    ).toBe(true);
  });

  it('records completed link and sync side effects when later sync fails', async () => {
    const { core, warnings } = createCoreStub();
    const postman = createRollbackPostman();
    const internalIntegration = createRollbackIntegration({
      syncCollection: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('second sync failed'))
    });

    await expect(
      runExistingSpecBootstrap(postman, { core, internalIntegration })
    ).rejects.toThrow('second sync failed');

    expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledTimes(1);
    expect(internalIntegration.syncCollection).toHaveBeenCalledTimes(2);
    expect(
      warnings.some((warning) =>
        warning.includes('Completed external side effects before failure')
        && warning.includes('linkCollectionsToSpecification(spec-existing: col-baseline-generated, col-smoke-generated, col-contract-generated; syncExamples=true)')
        && warning.includes('syncCollection(spec-existing, col-baseline-generated)')
      )
    ).toBe(true);
  });

  it('version mode reuses the current ref resources.yaml mappings instead of a release manifest', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      stringifyYaml({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          specs: { 'spec-url:https://example.test/openapi.yaml#release=release-v1.1.1': 'spec-v111' },
          collections: {
            '../postman/collections/core-payments release-v1.1.1': 'col-baseline-v111',
            '../postman/collections/[Smoke] core-payments release-v1.1.1': 'col-smoke-v111',
            '../postman/collections/[Contract] core-payments release-v1.1.1': 'col-contract-v111'
          }
        }
      })
    );
    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        collectionSyncMode: 'version',
        specSyncMode: 'version',
        releaseLabel: 'release/v1.1.1',
        githubRefName: 'release/v1.1.1',
        githubSha: 'deadbeef'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(postman.updateSpec).toHaveBeenCalledWith(
      'spec-v111',
      VALID_SPEC_31,
      'ws-existing'
    );
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(result['spec-id']).toBe('spec-v111');
    expect(result['baseline-collection-id']).toBe('col-baseline-v111');
    expect(result['smoke-collection-id']).toBe('col-smoke-v111');
    expect(result['contract-collection-id']).toBe('col-contract-v111');
  });

  it('version mode does not persist asset identifiers to repository variables', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockResolvedValueOnce('col-baseline-v111')
        .mockResolvedValueOnce('col-smoke-v111')
        .mockResolvedValueOnce('col-contract-v111'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-v111'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        collectionSyncMode: 'version',
        specSyncMode: 'version',
        releaseLabel: 'v1.1.1',
        githubRefName: 'v1.1.1'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );
  });

  it("version mode doesn't fall back to singleton current spec uid", async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockResolvedValueOnce('col-baseline-v112')
        .mockResolvedValueOnce('col-smoke-v112')
        .mockResolvedValueOnce('col-contract-v112'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-v112'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        collectionSyncMode: 'version',
        specSyncMode: 'version',
        releaseLabel: 'v1.1.2',
        githubRefName: 'v1.1.2'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(postman.updateSpec).not.toHaveBeenCalledWith(
      'spec-current',
      VALID_SPEC_31,
      'ws-existing'
    );
    expect(postman.uploadSpec).toHaveBeenCalledWith(
      'ws-existing',
      'core-payments v1.1.2',
      VALID_SPEC_31,
      '3.1'
    );
    expect(result['spec-id']).toBe('spec-v112');
  });

  it('reuses .postman/resources.yaml for version reruns before creating new assets', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    mkdirSync('.postman', { recursive: true });
    writeFileSync(
      '.postman/resources.yaml',
      stringifyYaml({
        workspace: { id: 'ws-from-file' },
        cloudResources: {
          specs: { 'spec-url:https://example.test/openapi.yaml': 'spec-from-file' },
          collections: {
            '../postman/curated/[Smoke] curated.json': 'col-additional-smoke-legacy',
            '../postman/curated/[Contract] curated.json': 'col-additional-contract-legacy',
            '../postman/collections/core-payments v1': 'col-baseline-from-file',
            '../postman/collections/[Smoke] core-payments v1': 'col-smoke-from-file',
            '../postman/collections/[Contract] core-payments v1': 'col-contract-from-file'
          },
          additionalCollections: {
            '../postman/curated/[Smoke] curated.json': 'col-additional-smoke',
            '../postman/curated/[Contract] curated.json': 'col-additional-contract'
          }
        }
      })
    );

    const result = await runBootstrap(
      createInputs({ collectionSyncMode: 'version', releaseLabel: 'v1' }),
      {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_SPEC_31, { status: 200 })
      )
      }
    );

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-from-file', VALID_SPEC_31, 'ws-from-file');
    expect(result).toMatchObject({
      'workspace-id': 'ws-from-file',
      'spec-id': 'spec-from-file',
      'baseline-collection-id': 'col-baseline-from-file',
      'smoke-collection-id': 'col-smoke-from-file',
      'contract-collection-id': 'col-contract-from-file'
    });
  });

  it('ignores repository-variable asset state when .postman/resources.yaml is absent', async () => {
    const previousRepository = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'postman-cs/bootstrap-action-test';

    try {
      const { core } = createCoreStub();
      const execStub = createExecStub();
      const ioStub = createIoStub();
      const postman = {
        addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
        createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-new' }),
        findWorkspacesByName: vi.fn().mockResolvedValue([{ id: 'ws-from-vars', name: '[AF] core-payments' }]),
        generateCollection: vi
          .fn()
          .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
            if (prefix === '') return 'col-baseline';
            if (prefix === '[Smoke]') return 'col-smoke';
            return 'col-contract';
          }),
        getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
        getTeams: vi.fn().mockResolvedValue([]),
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue('https://github.com/postman-cs/different-repo'),
        getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
        injectContractTests: vi.fn().mockResolvedValue([]),
        injectTests: vi.fn().mockResolvedValue(undefined),
        inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
        tagCollection: vi.fn().mockResolvedValue(undefined),
        uploadSpec: vi.fn().mockResolvedValue('spec-123'),
        updateSpec: vi.fn().mockResolvedValue(undefined),
        getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
      };
      const result = await runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      });

      expect(postman.createWorkspace).toHaveBeenCalled();
      expect(result['workspace-id']).toBe('ws-new');
    } finally {
      if (previousRepository === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = previousRepository;
      }
    }
  });

  it('skips governance assignment when postman-access-token is absent', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(
      createInputs({ postmanAccessToken: undefined }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(postman.createWorkspace).toHaveBeenCalled();
    expect(
      warnings.some((warning) =>
        warning.includes('Skipping cloud spec-to-collection linking and sync because postman-access-token is not configured')
      )
    ).toBe(true);
  });

  it('warns and continues when governance assignment fails', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockRejectedValue(new Error('gateway 404')),
      configureTeamContext: vi.fn(),
      linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
      syncCollection: vi.fn().mockResolvedValue(undefined)
    };

    const result = await runBootstrap(
      createInputs(),
      {
        core,
        exec: execStub,
        io: ioStub,
        internalIntegration,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(internalIntegration.assignWorkspaceToGovernanceGroup).toHaveBeenCalledWith(
      'ws-123',
      'core-banking',
      '{"core-banking":"Core Banking"}',
      undefined
    );
    expect(
      warnings.some((warning) =>
        warning.includes('Failed to assign governance group: gateway 404')
      )
    ).toBe(true);
    expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalled();
  });

  it('passes syncExamples=false when configured', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockResolvedValueOnce('col-baseline')
        .mockResolvedValueOnce('col-smoke')
        .mockResolvedValueOnce('col-contract'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
      configureTeamContext: vi.fn(),
      linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
      syncCollection: vi.fn().mockResolvedValue(undefined)
    };

    await runBootstrap(
      createInputs({ syncExamples: false }),
      {
        core,
        exec: execStub,
        io: ioStub,
        internalIntegration,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(internalIntegration.linkCollectionsToSpecification).toHaveBeenCalledWith(
      'spec-123',
      [
        { collectionId: 'col-baseline', syncOptions: { syncExamples: false } },
        { collectionId: 'col-smoke', syncOptions: { syncExamples: false } },
        { collectionId: 'col-contract', syncOptions: { syncExamples: false } }
      ]
    );
  });

  it('runs without any GitHub dependency', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(
      createInputs(),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(result['spec-id']).toBe('spec-123');
  });

  it('version mode reuses legacy baseline resources.yaml collection paths', async () => {
    const { core, infos } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
          if (prefix === '') return 'col-baseline-v2';
          if (prefix === '[Smoke]') return 'col-smoke-v2';
          return 'col-contract-v2';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-v2'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const resources = {
      workspace: { id: 'ws-current' },
      cloudResources: {
        collections: {
          '../postman/collections/[Baseline] core-payments v2.0.0': 'col-baseline-current',
          '../postman/collections/[Smoke] core-payments v2.0.0': 'col-smoke-current',
          '../postman/collections/[Contract] core-payments v2.0.0': 'col-contract-current'
        }
      }
    };
    mkdirSync('.postman', { recursive: true });
    writeFileSync('.postman/resources.yaml', stringifyYaml(resources));

    const result = await runBootstrap(
      createInputs({
        collectionSyncMode: 'version',
        specSyncMode: 'version',
        releaseLabel: 'v2.0.0'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(result['baseline-collection-id']).toBe('col-baseline-current');
    expect(result['smoke-collection-id']).toBe('col-smoke-current');
    expect(result['contract-collection-id']).toBe('col-contract-current');
    expect(infos).toContain('Resolved baseline-collection-id from .postman/resources.yaml');
    expect(infos).toContain('Resolved smoke-collection-id from .postman/resources.yaml');
    expect(infos).toContain('Resolved contract-collection-id from .postman/resources.yaml');
  });

  it('versioned runs do not emit releases-json or write releases.yaml', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
          if (prefix === '') return 'col-baseline-v2';
          if (prefix === '[Smoke]') return 'col-smoke-v2';
          return 'col-contract-v2';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-v2'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(
      createInputs({
        collectionSyncMode: 'version',
        specSyncMode: 'version',
        releaseLabel: 'v2.0.0'
      }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect('releases-json' in result).toBe(false);
    expect(existsSync('.postman/releases.yaml')).toBe(false);
  });

  it('emits warnings for lint violations but does not fail', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub(
      JSON.stringify({
        violations: [
          { issue: 'Missing description', path: '$.paths./payments.get', severity: 'WARNING' }
        ]
      })
    );
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_SPEC_31, { status: 200 })
      )
    });

    expect(result['workspace-id']).toBe('ws-123');
    expect(warnings.some((w) => w.includes('Missing description'))).toBe(true);
    const lintSummary = JSON.parse(result['lint-summary-json']);
    expect(lintSummary.warnings).toBe(1);
    expect(lintSummary.errors).toBe(0);
  });

  it('skips the CLI lint and warns when postman-api-key is absent (access-token-only)', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(
      createInputs({ postmanApiKey: '', postmanAccessToken: 'pat-only' }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(JSON.parse(result['lint-summary-json'])).toEqual({
      status: 'skipped',
      reason: 'no postman-api-key'
    });
    expect(warnings.some((w) => w.includes('lint skipped'))).toBe(true);
    // No PMAK -> the Postman CLI is never installed or invoked for lint.
    expect(ioStub.which).not.toHaveBeenCalled();
    expect(execStub.getExecOutput).not.toHaveBeenCalled();
  });

  it('auto-detects openapi 3.1 from spec content when openapiVersion input is empty', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn()
        .mockResolvedValueOnce('col-baseline')
        .mockResolvedValueOnce('col-smoke')
        .mockResolvedValueOnce('col-contract'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-31'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(undefined)
    };

    await runBootstrap(
      createInputs({ openapiVersion: '' }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, {
            status: 200
          })
        )
      }
    );

    expect(postman.uploadSpec).toHaveBeenCalledWith(
      'ws-123',
      'core-payments',
      expect.any(String),
      '3.1'
    );
  });

  it('rejects explicit openapi-version when it conflicts with spec content', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn()
        .mockResolvedValueOnce('col-baseline')
        .mockResolvedValueOnce('col-smoke')
        .mockResolvedValueOnce('col-contract'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-30'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      runBootstrap(
        createInputs({ openapiVersion: '3.0' }),
        {
          core,
          exec: execStub,
          io: ioStub,
          postman: withContractHelpers(postman),
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(VALID_SPEC_31, {
              status: 200
            })
          )
        }
      )
    ).rejects.toThrow('openapi-version input 3.0 does not match spec content OpenAPI 3.1');

    expect(postman.uploadSpec).not.toHaveBeenCalled();
  });

  it('normalizeSpecDocument adds summary from operationId or METHOD+path', () => {
    const warn = vi.fn();
    const withId = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: { '/pets': { get: { operationId: 'listPets' } } }
      }),
      warn
    );
    expect(JSON.parse(withId).paths['/pets'].get.summary).toBe('listPets');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('operationId'));

    const warn2 = vi.fn();
    const bare = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: { '/x': { post: {} } }
      }),
      warn2
    );
    expect(JSON.parse(bare).paths['/x'].post.summary).toBe('POST /x');
    expect(warn2).toHaveBeenCalledWith(expect.stringContaining('method + path'));
  });

  it('normalizeSpecDocument truncates long summaries', () => {
    const long = 'x'.repeat(250);
    const warn = vi.fn();
    const out = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        paths: { '/a': { get: { summary: long } } }
      }),
      warn
    );
    const s = JSON.parse(out).paths['/a'].get.summary as string;
    expect(s.length).toBe(200);
    expect(s.endsWith('…')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('truncated'));
  });

  it('normalizeSpecDocument normalises summaries in OAS 3.1 webhooks', () => {
    const warn = vi.fn();
    const out = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'T', version: '1' },
        paths: { '/pets': { get: { summary: 'List pets' } } },
        webhooks: {
          petAdopted: { post: { operationId: 'petAdoptedWebhook' } }
        }
      }),
      warn
    );
    const doc = JSON.parse(out);
    expect(doc.webhooks.petAdopted.post.summary).toBe('petAdoptedWebhook');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('operationId'));
  });

  it('normalizeSpecDocument falls back to METHOD+key for webhooks with no summary or operationId', () => {
    const warn = vi.fn();
    const out = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'T', version: '1' },
        paths: {},
        webhooks: { userCreated: { post: {} } }
      }),
      warn
    );
    const doc = JSON.parse(out);
    expect(doc.webhooks.userCreated.post.summary).toBe('POST userCreated');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('method + path'));
  });

  it('normalizeSpecDocument normalises summaries in OAS 3.1 webhooks (YAML input)', () => {
    const warn = vi.fn();
    const yamlInput = stringifyYaml({
      openapi: '3.1.0',
      info: { title: 'T', version: '1' },
      paths: {},
      webhooks: { orderPlaced: { post: { operationId: 'onOrderPlaced' } } }
    });
    const out = normalizeSpecDocument(yamlInput, warn);
    const doc = parseYaml(out) as Record<string, unknown>;
    const webhooks = doc.webhooks as Record<string, Record<string, Record<string, unknown>>>;
    expect(webhooks.orderPlaced.post.summary).toBe('onOrderPlaced');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('operationId'));
  });

  it('normalizeSpecDocument ignores webhooks field when absent (OAS 3.0 spec)', () => {
    const warn = vi.fn();
    const out = normalizeSpecDocument(
      JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'T', version: '1' },
        paths: { '/a': { get: { summary: 'Get A' } } }
      }),
      warn
    );
    const doc = JSON.parse(out);
    expect(doc.webhooks).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('forwards folderStrategy, nestedFolderHierarchy, and requestNameSource to generateCollection', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    await runBootstrap(
      createInputs({ folderStrategy: 'Tags', nestedFolderHierarchy: true, requestNameSource: 'URL' }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(VALID_SPEC_31, { status: 200 })
        )
      }
    );

    for (const call of postman.generateCollection.mock.calls) {
      expect(call[3]).toBe('Tags');
      expect(call[4]).toBe(true);
      expect(call[5]).toBe('URL');
    }
    expect(postman.generateCollection).toHaveBeenCalledTimes(3);
  });
});

describe('lintSpecViaCli', () => {
  it('parses warning and error counts from postman cli json output', async () => {
    const summary = await lintSpecViaCli(
      {
        exec: createExecStub(
          JSON.stringify({
            violations: [
              { severity: 'ERROR', issue: 'broken' },
              { severity: 'WARNING', issue: 'warn' }
            ]
          })
        )
      },
      'ws-123',
      'spec-123'
    );

    expect(summary).toEqual({
      errors: 1,
      violations: [
        { severity: 'ERROR', issue: 'broken' },
        { severity: 'WARNING', issue: 'warn' }
      ],
      warnings: 1
    });
  });

  it('downgrades only the accepted OpenAPI 3.0 type null lint finding', () => {
    const summary = applyOas30TypeNullLintCompatibility(
      {
        errors: 2,
        violations: [
          {
            severity: 'ERROR',
            issue: '"type" property must be equal to one of the allowed values',
            path: '$.components.schemas.Criteria.properties.value.oneOf[1].type'
          },
          { severity: 'ERROR', issue: 'required property is missing', path: '$.info.title' }
        ],
        warnings: 0
      },
      ['components.schemas.Criteria.properties.value.oneOf.1.type']
    );

    expect(summary.errors).toBe(1);
    expect(summary.warnings).toBe(1);
    expect(summary.violations[0]?.severity).toBe('WARNING');
    expect(summary.violations[1]?.severity).toBe('ERROR');
  });
});

  it('fails with team list when org-mode detected and no workspace-team-id', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('13347347'),
      getTeams: vi.fn().mockResolvedValue([
        { id: 132109, name: 'Field Services', handle: 'fs', organizationId: 13347347 },
        { id: 132118, name: 'Customer Ed', handle: 'ce', organizationId: 13347347 }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher
      })
    ).rejects.toThrow('Org-mode account detected');

    expect(postman.createWorkspace).not.toHaveBeenCalled();
  });

  it('passes workspace-team-id to createWorkspace for org-mode accounts', async () => {
    const { core, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const callOrder: string[] = [];
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      configureTeamContext: vi.fn(() => {
        callOrder.push('configureTeamContext');
      }),
      createWorkspace: vi.fn(async () => {
        callOrder.push('createWorkspace');
        return { id: 'ws-org' };
      }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('13347347'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
      configureTeamContext: vi.fn(() => {
        callOrder.push('internalIntegration.configureTeamContext');
      }),
      linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
      syncCollection: vi.fn().mockResolvedValue(undefined)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await runBootstrap(createInputs({ workspaceTeamId: '132319' }), {
      core,
      exec: execStub,
      io: ioStub,
      internalIntegration,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(postman.configureTeamContext).toHaveBeenCalledWith('132319', true);
    expect(internalIntegration.configureTeamContext).toHaveBeenCalledWith('132319', true);
    expect(callOrder.indexOf('configureTeamContext')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('createWorkspace')).toBeGreaterThan(callOrder.indexOf('configureTeamContext'));
    expect(callOrder.indexOf('createWorkspace')).toBeGreaterThan(
      callOrder.indexOf('internalIntegration.configureTeamContext')
    );
    expect(postman.createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      132319
    );
    expect(outputs['workspace-id']).toBe('ws-org');
  });

  it('skips org-mode detection when workspace-id is already provided', async () => {
    const { core, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('13347347'),
      getTeams: vi.fn().mockResolvedValue([
        { id: 132109, name: 'FS', handle: 'fs', organizationId: 13347347 },
        { id: 132118, name: 'CE', handle: 'ce', organizationId: 13347347 }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await runBootstrap(createInputs({ workspaceId: 'ws-existing' }), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(outputs['workspace-id']).toBe('ws-existing');
  });

  it('warns and proceeds when getTeams fails', async () => {
    const { core } = createCoreStub();
    const warnings: string[] = [];
    core.warning = vi.fn((msg: string) => warnings.push(msg));
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockRejectedValue(new Error('Network error')),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(warnings.some(w => w.includes('Could not check for org-mode'))).toBe(true);
    expect(postman.createWorkspace).toHaveBeenCalled();
  });

  it('throws when workspace-team-id is non-numeric', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await expect(
      runBootstrap(createInputs({ workspaceTeamId: 'not-a-number' }), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher
      })
    ).rejects.toThrow('workspace-team-id must be a numeric sub-team ID');
  });

  it('auto-picks sub-team when a service-account PMAK returns exactly one sub-team carrying organizationId', async () => {
    // Real-world service-account key case: GET /teams returns a single team,
    // the team's organizationId is non-null (parent account is org-mode). Since
    // there is no ambiguity, the action should auto-pick teams[0].id as
    // workspaceTeamId, log an info message, and proceed to createWorkspace
    // instead of throwing and requiring the caller to echo the ID back.
    const { core, infos } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-auto' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('83498'),
      getTeams: vi.fn().mockResolvedValue([
        { id: 83498, name: 'jared-service-account-test', handle: 'jaredserviceaccounttest', organizationId: 987442 }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(postman.createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      83498
    );
    expect(infos.some(msg => msg.includes('Org-mode account detected. Using sub-team 83498 (jared-service-account-test)'))).toBe(true);
  });

  it('throws with team list when org-mode detected with multiple sub-teams and no workspace-team-id', async () => {
    // Ambiguous case: PMAK has access to more than one sub-team. We cannot pick
    // for the caller, so the existing actionable error must still fire and list
    // all available sub-teams.
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-unused' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('83498'),
      getTeams: vi.fn().mockResolvedValue([
        { id: 83498, name: 'jared-service-account-test', handle: 'jaredserviceaccounttest', organizationId: 987442 },
        { id: 83499, name: 'jared-service-account-test-2', handle: 'jaredserviceaccounttest2', organizationId: 987442 }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman: withContractHelpers(postman),
        specFetcher
      })
    ).rejects.toThrow(/Org-mode account detected[\s\S]*83498[\s\S]*jared-service-account-test[\s\S]*83499[\s\S]*jared-service-account-test-2/);

    expect(postman.createWorkspace).not.toHaveBeenCalled();
  });

  it('honors explicit workspace-team-id override even when single org-mode sub-team is present', async () => {
    // Override path: when the caller passes workspaceTeamId explicitly the
    // auto-pick block must be skipped entirely and createWorkspace must receive
    // the caller-supplied ID, not teams[0].id.
    const { core, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-override' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('83498'),
      getTeams: vi.fn().mockResolvedValue([
        { id: 83498, name: 'jared-service-account-test', handle: 'jaredserviceaccounttest', organizationId: 987442 }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await runBootstrap(createInputs({ workspaceTeamId: '999' }), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(postman.createWorkspace).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      999
    );
    expect(outputs['workspace-id']).toBe('ws-override');
  });

  it('does not flag org-mode when a single team has a null organizationId (non-org account)', async () => {
    // Negative case: single-team accounts that are NOT org-mode must keep
    // proceeding to workspace creation. A null organizationId on the one and
    // only team is the authoritative "not org-mode" signal.
    const { core, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-created' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([
        { id: 12345, name: 'solo-team', handle: 'soloteam', organizationId: null }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
      injectContractTests: vi.fn().mockResolvedValue([]),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(VALID_SPEC_31, { status: 200 })
    );

    await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher
    });

    expect(postman.createWorkspace).toHaveBeenCalled();
    expect(outputs['workspace-id']).toBe('ws-created');
  });

describe('runAction credential preflight', () => {
  let specDir: string;

  const NEUTRALIZED_ENV_VARS = [
    'GITHUB_REPOSITORY',
    'GITHUB_SERVER_URL',
    'CI_PROJECT_URL',
    'CI_PROJECT_PATH',
    'CI_PROJECT_NAME',
    'BITBUCKET_GIT_HTTP_ORIGIN',
    'BITBUCKET_WORKSPACE',
    'BITBUCKET_REPO_SLUG',
    'BUILD_REPOSITORY_URI',
    'BUILD_REPOSITORY_NAME',
    'POSTMAN_TEAM_ID',
    'POSTMAN_WORKSPACE_TEAM_ID',
    'WORKSPACE_ADMIN_USER_IDS',
    'GITHUB_TOKEN',
    'GH_FALLBACK_TOKEN'
  ];

  beforeEach(() => {
    __resetIdentityMemo();
    specDir = mkdtempSync(join(tmpdir(), 'bootstrap-preflight-'));
    writeFileSync(join(specDir, 'openapi.json'), VALID_SPEC_31);
    vi.stubEnv('GITHUB_WORKSPACE', specDir);
    for (const name of NEUTRALIZED_ENV_VARS) {
      vi.stubEnv(name, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(specDir, { recursive: true, force: true });
  });

  function baseInputValues(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      'project-name': 'core-payments',
      'spec-path': 'openapi.json',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'access-token-test',
      ...overrides
    };
  }

  function createRunActionCore(values: Record<string, string>, events: string[]) {
    const infos: string[] = [];
    const warnings: string[] = [];
    const outputs: Record<string, string> = {};
    const core: CoreLike = {
      error: () => {},
      getInput: (name: string, options?: { required?: boolean }) => {
        const value = values[name] ?? '';
        if (options?.required && !value) {
          throw new Error(`Input required and not supplied: ${name}`);
        }
        return value;
      },
      group: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      info: (message: string) => {
        infos.push(message);
        events.push(`info:${message}`);
      },
      setFailed: () => {},
      setOutput: (name: string, value: string) => {
        outputs[name] = value;
      },
      setSecret: () => {},
      warning: (message: string) => {
        warnings.push(message);
        events.push(`warning:${message}`);
      }
    };
    return { core, infos, outputs, warnings };
  }

  interface RunActionRouterOptions {
    events: string[];
    meStatus?: number;
    meUser?: Record<string, unknown>;
    sessionStatus?: number;
    sessionBody?: Record<string, unknown>;
    proxyResponse?: (payload: { service?: string; path?: string }) => Response | undefined;
  }

  function createRunActionFetchRouter(options: RunActionRouterOptions): typeof fetch {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    // The gateway generateCollection resolves the new uid via the spec's
    // collection list (newest last), so accumulate one distinct uid per
    // generation to mirror the real store and avoid id collisions.
    const generatedCollections: Array<{ collection: string; name: string }> = [];
    const router = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      options.events.push(`fetch:${method} ${url}`);

      if (url === 'https://api.getpostman.com/me') {
        if (options.meStatus && options.meStatus !== 200) {
          return json({ error: { name: 'AuthenticationError' } }, options.meStatus);
        }
        return json({
          user: options.meUser ?? {
            id: 12345678,
            fullName: 'Ada Lovelace',
            teamId: 10490519,
            teamName: 'jared-demo',
            teamDomain: 'jared-demo'
          }
        });
      }
      if (url === 'https://iapub.postman.co/api/sessions/current') {
        if (options.sessionStatus && options.sessionStatus !== 200) {
          return json({ error: 'denied' }, options.sessionStatus);
        }
        return json(
          options.sessionBody ?? {
            identity: { team: 10490519, domain: 'jared-demo' },
            data: { user: { id: 555, roles: ['admin'] } },
            consumerType: 'service_account'
          }
        );
      }
      if (url === 'https://api.getpostman.com/teams') {
        return json({ data: [] });
      }
      if (url === 'https://api.getpostman.com/service-account-tokens' && method === 'POST') {
        // Re-mint on a gateway auth failure (gateway-only asset flow); PMAK is
        // reserved for exactly this mint + the CLI spec-lint login.
        return json({ access_token: 'reminted-access-token' });
      }
      if (url === 'https://api.getpostman.com/workspaces' && method === 'POST') {
        return json({ workspace: { id: 'ws-runaction' } });
      }
      if (url.startsWith('https://api.getpostman.com/workspaces/ws-runaction')) {
        return json({ workspace: { id: 'ws-runaction', visibility: 'team' } });
      }
      if (url === 'https://api.getpostman.com/specs/spec-runaction/generations/collection') {
        const name = String(
          (JSON.parse(String(init?.body ?? '{}')) as { name?: string }).name ?? ''
        );
        const slot = name.includes('[Smoke]')
          ? 'smoke'
          : name.includes('[Contract]')
            ? 'contract'
            : 'baseline';
        return json({ collection: { id: `col-${slot}` } });
      }
      if (url.startsWith('https://api.getpostman.com/specs?workspaceId=') && method === 'POST') {
        return json({ id: 'spec-runaction' });
      }
      if (url.startsWith('https://api.getpostman.com/specs/spec-runaction')) {
        return json({ id: 'spec-runaction' });
      }
      if (/^https:\/\/api\.getpostman\.com\/collections\/[^/]+\/tags$/.test(url)) {
        return json({});
      }
      if (/^https:\/\/api\.getpostman\.com\/collections\/[^/]+$/.test(url)) {
        if (method === 'GET') {
          return json({ collection: createGeneratedContractCollection() });
        }
        return json({});
      }
      if (url === 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy') {
        const payload = JSON.parse(String(init?.body ?? '{}')) as {
          service?: string;
          method?: string;
          path?: string;
        };
        const svc = String(payload.service ?? '');
        const pmethod = String(payload.method ?? 'get').toLowerCase();
        const ppath = String(payload.path ?? '');
        // Visibility into the gateway-only asset flow for ordering assertions.
        options.events.push(`proxy:${svc} ${pmethod.toUpperCase()} ${ppath}`);
        const custom = options.proxyResponse?.(payload);
        if (custom) return custom;
        // Default gateway router: the access-token asset flow now runs entirely
        // through /ws/proxy (no PMAK fallback), so serve the real envelopes.
        if (svc === 'workspaces') {
          if (pmethod === 'post' && ppath === '/workspaces') return json({ data: { id: 'ws-runaction' } });
          if (pmethod === 'put' && /\/workspaces\/[^/]+\/visibility$/.test(ppath)) return json({ data: { id: 'ws-runaction', visibilityStatus: 'team' } });
          if (pmethod === 'get' && /\/workspaces\/[^/]+\/filesystem$/.test(ppath)) return json({ data: null });
          if (pmethod === 'get' && /\/workspaces\/[^/]+$/.test(ppath)) return json({ data: { id: 'ws-runaction', visibilityStatus: 'team' } });
          if (pmethod === 'get' && ppath.startsWith('/workspaces')) return json({ data: [] });
        }
        if (svc === 'ums' && /\/squads/.test(ppath)) return json({ data: [] });
        if (svc === 'specification') {
          if (pmethod === 'post' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
            const name = String((payload as { body?: { name?: string } }).body?.name ?? '');
            const slot = name.includes('[Smoke]')
              ? 'smoke'
              : name.includes('[Contract]')
                ? 'contract'
                : 'baseline';
            generatedCollections.push({ collection: `col-${slot}`, name });
            return json({ data: { taskId: 'task-1' } });
          }
          if (pmethod === 'get' && /\/tasks/.test(ppath)) return json({ data: { 'task-1': 'completed' } });
          if (pmethod === 'get' && /\/specifications\/[^/]+\/collections$/.test(ppath)) {
            return json({
              data: generatedCollections.map((entry) => ({ ...entry, state: 'in-sync' }))
            });
          }
          if (pmethod === 'get' && /\/specifications\/[^/]+\/files\/[^/]+/.test(ppath)) return json({ data: { id: 'file-root', content: 'openapi: 3.0.0' } });
          if (pmethod === 'get' && /\/specifications\/[^/]+\/files$/.test(ppath)) return json({ data: [{ id: 'file-root', type: 'ROOT' }] });
          if (pmethod === 'patch') return json({ data: { id: 'file-root' } });
          if (pmethod === 'post' && ppath.startsWith('/specifications')) return json({ data: { id: 'spec-runaction' } });
          if (pmethod === 'get' && /\/specifications\/[^/]+$/.test(ppath)) return json({ data: { id: 'spec-runaction' } });
        }
        if (svc === 'collection') {
          // Per-item GET returns the full v3 IR record the contract matcher reads;
          // the list GET returns one leaf covering the spec's single GET /payments
          // operation so injectContractTests' coverage check is satisfied.
          if (pmethod === 'get' && /\/items\/[^/]+$/.test(ppath)) {
            return json({
              data: {
                $kind: 'http-request',
                id: 'item-1',
                name: 'GET /payments',
                method: 'GET',
                url: 'https://example.test/payments'
              }
            });
          }
          if (pmethod === 'get' && /\/items\/$/.test(ppath)) {
            return json({ data: [{ $kind: 'http-request', id: 'item-1', name: 'GET /payments' }] });
          }
          if (pmethod === 'post') return json({ data: { id: '55363555-created' } });
          if (pmethod === 'patch') return json({ data: { id: 'patched' } });
          if (pmethod === 'get' && /\/export$/.test(ppath)) return json({ data: { collection: {} } });
        }
        if (svc === 'tagging') return json({ tags: [{ slug: 'generated-smoke' }] });
        return json({ data: { ok: true } });
      }
      if (url.startsWith('https://dl.pstmn.io/')) {
        return json({ version: '12.0.0' });
      }
      throw new Error(`Unrouted fetch in runAction test: ${method} ${url}`);
    };
    return router as typeof fetch;
  }

  it('runAction logs PMAK and session identity lines before the first workspace call', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs } = createRunActionCore(baseInputValues(), events);

    await runAction(core, createExecStub(), createIoStub());

    expect(outputs['workspace-id']).toBe('ws-runaction');
    const pmakLineIndex = events.findIndex((entry) =>
      entry.startsWith('info:postman: PMAK identity')
    );
    const sessionLineIndex = events.findIndex((entry) =>
      entry.startsWith('info:postman: access-token session identity')
    );
    const createWorkspaceIndex = events.findIndex(
      (entry) => entry === 'proxy:workspaces POST /workspaces'
    );
    expect(pmakLineIndex).toBeGreaterThanOrEqual(0);
    expect(sessionLineIndex).toBeGreaterThan(pmakLineIndex);
    expect(createWorkspaceIndex).toBeGreaterThan(sessionLineIndex);
    expect(infos.some((line) => line.includes('credential preflight OK'))).toBe(true);
  }, 30000);

  it('runAction with PMAK only eagerly mints an access token, runs the org-mode probe, and creates the workspace over the gateway', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core, infos, outputs, warnings } = createRunActionCore(
      baseInputValues({ 'postman-access-token': '' }),
      events
    );

    await runAction(core, createExecStub(), createIoStub());

    // Eager mint happened before the preflight
    const mintFetchIndex = events.findIndex(
      (entry) => entry === 'fetch:POST https://api.getpostman.com/service-account-tokens'
    );
    expect(mintFetchIndex).toBeGreaterThanOrEqual(0);
    expect(
      infos.some((line) => line.includes('minted a short-lived service-account access token'))
    ).toBe(true);
    // Org-mode squad probe ran (needs the minted token)
    expect(events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    // Governance is no longer silently skipped
    expect(
      warnings.some((line) =>
        line.includes('Skipping governance assignment because postman-access-token is not configured')
      )
    ).toBe(false);
    // Workspace creation went through the gateway as usual
    expect(events.some((entry) => entry === 'proxy:workspaces POST /workspaces')).toBe(true);
    expect(outputs['workspace-id']).toBe('ws-runaction');
  }, 30000);

  it('runAction with PMAK only warns up front when the mint fails (service accounts not enabled)', async () => {
    const events: string[] = [];
    const baseRouter = createRunActionFetchRouter({ events });
    const router = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || 'GET').toUpperCase();
      if (url === 'https://api.getpostman.com/service-account-tokens' && method === 'POST') {
        events.push(`fetch:${method} ${url}`);
        return new Response('service accounts not enabled', { status: 400 });
      }
      return baseRouter(input, init);
    }) as typeof fetch;
    vi.stubGlobal('fetch', router);
    const { core, warnings } = createRunActionCore(
      baseInputValues({ 'postman-access-token': '' }),
      events
    );

    // Asset ops are gateway-only, so with no mintable token the run cannot
    // proceed; the eager mint surfaces the actionable warning before it fails.
    await expect(runAction(core, createExecStub(), createIoStub())).rejects.toThrow(
      /service accounts are not enabled/
    );
    expect(
      warnings.some((line) => line.includes('could not mint an access token from the postman-api-key'))
    ).toBe(true);
  }, 30000);


  it('runAction completes when /me and iapub both 404 (preflight non-fatal)', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({ events, meStatus: 404, sessionStatus: 404 })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runAction(core, createExecStub(), createIoStub());

    expect(outputs['workspace-id']).toBe('ws-runaction');
    expect(
      warnings.some((line) => line.includes('could not resolve PMAK identity'))
    ).toBe(true);
    expect(
      warnings.some((line) => line.includes('could not resolve the access-token session identity'))
    ).toBe(true);
  }, 30000);

  it('runAction under credential-preflight=enforce FAILS fast with both parent-org ids named when injected /me teamId differs from iapub identity.team', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        meUser: { id: 1, fullName: 'Ada Lovelace', teamId: 10490519, teamName: 'jared-demo' },
        sessionBody: {
          identity: { team: 13347347, domain: 'field-services-v12-demo' },
          data: { user: { id: 2, roles: ['admin'] } },
          consumerType: 'service_account'
        }
      })
    );
    const { core } = createRunActionCore(
      baseInputValues({ 'credential-preflight': 'enforce' }),
      events
    );

    let thrown: unknown;
    try {
      await runAction(core, createExecStub(), createIoStub());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('credential preflight FAILED');
    expect(message).toContain('10490519');
    expect(message).toContain('13347347');
    expect(
      events.some((entry) => entry === 'proxy:workspaces POST /workspaces')
    ).toBe(false);
  });

  it('runAction under the default (warn) logs a NOTE and continues on that same mismatch (does not fail)', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        meUser: { id: 1, fullName: 'Ada Lovelace', teamId: 10490519, teamName: 'jared-demo' },
        sessionBody: {
          identity: { team: 13347347, domain: 'field-services-v12-demo' },
          data: { user: { id: 2, roles: ['admin'] } },
          consumerType: 'service_account'
        }
      })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runAction(core, createExecStub(), createIoStub());

    expect(outputs['workspace-id']).toBe('ws-runaction');
    const note = warnings.find((line) => line.includes('credential preflight note'));
    expect(note).toBeDefined();
    expect(note).toContain('10490519');
    expect(note).toContain('13347347');
    expect(
      events.some((entry) => entry === 'proxy:workspaces POST /workspaces')
    ).toBe(true);
  }, 30000);

  it('runAction warns when postman-access-token resolves to a non-service-account session token', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        sessionBody: {
          identity: { team: 10490519, domain: 'jared-demo' },
          data: { user: { id: 2, roles: ['admin'] } },
          consumerType: 'user'
        }
      })
    );
    const { core, warnings, outputs } = createRunActionCore(baseInputValues(), events);

    await runAction(core, createExecStub(), createIoStub());

    expect(outputs['workspace-id']).toBe('ws-runaction');
    const warning = warnings.find((line) =>
      line.includes('postman-cs/postman-resolve-service-token-action is the primary CI path')
    );
    expect(warning).toContain('postman-access-token resolved to consumerType user');
    expect(warning).toContain('postman-cs/postman-resolve-service-token-action is the primary CI path');
    expect(warning).toContain('Postman CLI credential store populated by `postman login` is a legacy fallback');
    expect(warning).not.toContain('browser');
    expect(
      warnings.filter((line) =>
        line.includes('Postman CLI credential store populated by `postman login` is a legacy fallback')
      )
    ).toHaveLength(1);
  }, 30000);

  it('runAction rejects credential-preflight=off instead of skipping identity checks', async () => {
    const events: string[] = [];
    vi.stubGlobal('fetch', createRunActionFetchRouter({ events }));
    const { core } = createRunActionCore(
      baseInputValues({ 'credential-preflight': 'off' }),
      events
    );

    await expect(runAction(core, createExecStub(), createIoStub())).rejects.toThrow(
      /Unsupported credential-preflight/
    );
    expect(events).toHaveLength(0);
  });

  it('reactive advice still rewrites a Bifrost UNAUTHENTICATED with default preflight enabled', async () => {
    const events: string[] = [];
    vi.stubGlobal(
      'fetch',
      createRunActionFetchRouter({
        events,
        proxyResponse: (payload) =>
          String(payload.path ?? '').includes('/specifications/')
            ? new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED' } }), {
                status: 401
              })
            : undefined
      })
    );
    const { core } = createRunActionCore(baseInputValues(), events);

    let thrown: unknown;
    try {
      await runAction(core, createExecStub(), createIoStub());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toContain('Bifrost rejected the access token (UNAUTHENTICATED)');
    expect(message).toContain('POST https://api.getpostman.com/service-account-tokens');
    expect(events.some((entry) => entry.includes('iapub.postman.co'))).toBe(true);
  });
});
