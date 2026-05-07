import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../src/lib/http-error.js';
import {
  lintSpecViaCli,
  normalizeSpecDocument,
  readActionInputs,
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
    openapiVersion: '',
    governanceMappingJson: '{"core-banking":"Core Banking"}',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    integrationBackend: 'bifrost',
    folderStrategy: 'Paths',
    nestedFolderHierarchy: false,
    requestNameSource: 'Fallback',
    postmanApiBase: 'https://api.getpostman.com',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanGatewayBase: 'https://gateway.postman.com',
    postmanCliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh',
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

function collectionNotFound(uid: string): HttpError {
  return new HttpError({
    method: 'PUT',
    status: 404,
    statusText: 'Not Found',
    url: `https://api.getpostman.com/collections/${uid}`
  });
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
    createWorkspace: vi.fn(),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    findWorkspacesByName: vi.fn().mockResolvedValue([]),
    generateCollection: vi
      .fn()
      .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
        if (prefix === '[Baseline]') return 'col-baseline-generated';
        if (prefix === '[Smoke]') return 'col-smoke-generated';
        return 'col-contract-generated';
      }),
    getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
    getCollection: vi.fn().mockResolvedValue(createGeneratedContractCollection()),
    getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
    getTeams: vi.fn().mockResolvedValue([]),
    getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
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
    inputs?: Partial<ResolvedInputs>;
    internalIntegration?: ReturnType<typeof createRollbackIntegration>;
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
      internalIntegration: options.internalIntegration,
      io: createIoStub(),
      postman,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_SPEC_31, { status: 200 })
      )
    }
  );
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
          if (prefix === '[Baseline]') return 'col-baseline';
          if (prefix === '[Smoke]') return 'col-smoke';
          return 'col-contract';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
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

    expect(execStub.exec).toHaveBeenCalledWith('postman', ['login', '--with-api-key', 'pmak-test']);
    expect(internalIntegration.assignWorkspaceToGovernanceGroup).toHaveBeenCalledWith(
      'ws-123',
      'core-banking',
      '{"core-banking":"Core Banking"}'
    );
    expect(postman.inviteRequesterToWorkspace).toHaveBeenCalledWith(
      'ws-123',
      'owner@example.com'
    );
    expect(postman.addAdminsToWorkspace).toHaveBeenCalledWith('ws-123', '101,102');
    expect(order).toEqual(['[Baseline]', '[Smoke]', '[Contract]']);
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
          if (prefix === '[Baseline]') return 'col-baseline';
          if (prefix === '[Smoke]') return 'col-smoke';
          return 'col-contract';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
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
        expect(postman.updateCollection).not.toHaveBeenCalled();
        expect(postman.injectTests).not.toHaveBeenCalled();
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'CONTRACT_OPERATION_COVERAGE_FAILED',
      name: 'contract instrumentation coverage',
      overrides: {
        getCollection: vi.fn().mockResolvedValue({
          info: { name: '[Contract] core-payments' },
          item: []
        })
      }
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.updateCollection).not.toHaveBeenCalled();
        expect(postman.injectTests).not.toHaveBeenCalled();
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'contract fetch failed',
      name: 'contract collection fetch',
      overrides: {
        getCollection: vi.fn().mockRejectedValue(new Error('contract fetch failed'))
      }
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.injectTests).not.toHaveBeenCalled();
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'contract update failed',
      name: 'contract collection update',
      overrides: {
        updateCollection: vi.fn().mockRejectedValue(new Error('contract update failed'))
      }
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'inject failed',
      name: 'inject tests',
      overrides: {
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
    },
    {
      expectedSkippedCalls: (postman: ReturnType<typeof createRollbackPostman>) => {
        expect(postman.injectTests).not.toHaveBeenCalled();
        expect(postman.tagCollection).not.toHaveBeenCalled();
      },
      failure: 'baseline refresh update failed',
      inputs: {
        baselineCollectionId: 'col-baseline-existing',
        contractCollectionId: 'col-contract-existing',
        smokeCollectionId: 'col-smoke-existing'
      },
      name: 'non-404 refresh update',
      overrides: {
        updateCollection: vi.fn().mockImplementation(async (uid: string) => {
          if (uid === 'col-baseline-existing') {
            throw new Error('baseline refresh update failed');
          }
          return undefined;
        })
      }
    }
  ])(
    'restores previous spec content and stops downstream work after $name failure',
    async ({ expectedSkippedCalls, failure, inputs, integrationOverrides, overrides }) => {
      const { core, outputs, warnings } = createCoreStub();
      const postman = createRollbackPostman(overrides);
      const internalIntegration = integrationOverrides
        ? createRollbackIntegration(integrationOverrides)
        : undefined;

      await expect(
        runExistingSpecBootstrap(postman, {
          core,
          inputs,
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

  it('does not update durable refresh collections when contract instrumentation fails', async () => {
    const postman = createRollbackPostman({
      getCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-contract-generated') {
          return { info: { name: '[Contract] core-payments' }, item: [] };
        }
        return createGeneratedContractCollection();
      }),
      updateCollection: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      runExistingSpecBootstrap(postman, {
        inputs: {
          baselineCollectionId: 'col-baseline-existing',
          contractCollectionId: 'col-contract-existing',
          smokeCollectionId: 'col-smoke-existing'
        }
      })
    ).rejects.toThrow('CONTRACT_OPERATION_COVERAGE_FAILED');

    expect(postman.updateCollection).not.toHaveBeenCalled();
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-baseline-generated');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-smoke-generated');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-contract-generated');
  });

  it('restores already-updated durable refresh collections when a later refresh update fails', async () => {
    const oldBaseline = { info: { name: 'old baseline' }, item: [{ name: 'old baseline item' }] };
    const newBaseline = { info: { name: 'new baseline' }, item: [{ name: 'new baseline item' }] };
    const oldSmoke = { info: { name: 'old smoke' }, item: [{ name: 'old smoke item' }] };
    const newSmoke = { info: { name: 'new smoke' }, item: [{ name: 'new smoke item' }] };
    const postman = createRollbackPostman({
      getCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-baseline-generated') return newBaseline;
        if (uid === 'col-smoke-generated') return newSmoke;
        if (uid === 'col-baseline-existing') return oldBaseline;
        if (uid === 'col-smoke-existing') return oldSmoke;
        return createGeneratedContractCollection();
      }),
      updateCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-smoke-existing') {
          throw new Error('smoke refresh failed');
        }
        return undefined;
      })
    });

    await expect(
      runExistingSpecBootstrap(postman, {
        inputs: {
          baselineCollectionId: 'col-baseline-existing',
          contractCollectionId: 'col-contract-existing',
          smokeCollectionId: 'col-smoke-existing'
        }
      })
    ).rejects.toThrow('smoke refresh failed');

    const baselineUpdates = vi.mocked(postman.updateCollection).mock.calls
      .filter(([uid]) => uid === 'col-baseline-existing');
    expect(baselineUpdates).toHaveLength(2);
    expect(baselineUpdates[0]?.[1]).toMatchObject(newBaseline);
    expect(baselineUpdates[1]?.[1]).toMatchObject(oldBaseline);
    expect(postman.updateCollection).not.toHaveBeenCalledWith(
      'col-contract-existing',
      expect.anything()
    );
  });

  it('preserves saved response examples when restoring durable refresh collections', async () => {
    const oldBaseline = {
      info: { name: 'old baseline' },
      item: [
        {
          name: 'old baseline item',
          request: { method: 'GET', url: { path: ['payments'] } },
          response: [{ name: 'saved example', code: 200, body: '{"ok":true}' }]
        }
      ]
    };
    const newBaseline = {
      info: { name: 'new baseline' },
      item: [
        {
          name: 'new baseline item',
          request: { method: 'GET', url: { path: ['payments'] } },
          response: [{ name: 'generated example', code: 200, body: '{}' }]
        }
      ]
    };
    const oldSmoke = { info: { name: 'old smoke' }, item: [{ name: 'old smoke item' }] };
    const newSmoke = { info: { name: 'new smoke' }, item: [{ name: 'new smoke item' }] };
    const postman = createRollbackPostman({
      getCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-baseline-generated') return newBaseline;
        if (uid === 'col-smoke-generated') return newSmoke;
        if (uid === 'col-baseline-existing') return oldBaseline;
        if (uid === 'col-smoke-existing') return oldSmoke;
        return createGeneratedContractCollection();
      }),
      updateCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-smoke-existing') {
          throw new Error('smoke refresh failed');
        }
        return undefined;
      })
    });

    await expect(
      runExistingSpecBootstrap(postman, {
        inputs: {
          baselineCollectionId: 'col-baseline-existing',
          contractCollectionId: 'col-contract-existing',
          smokeCollectionId: 'col-smoke-existing'
        }
      })
    ).rejects.toThrow('smoke refresh failed');

    const baselineUpdates = vi.mocked(postman.updateCollection).mock.calls
      .filter(([uid]) => uid === 'col-baseline-existing');
    expect(baselineUpdates).toHaveLength(2);
    expect(baselineUpdates[0]?.[1]).toMatchObject({
      item: [expect.not.objectContaining({ response: expect.anything() })]
    });
    expect(baselineUpdates[1]?.[1]).toMatchObject({
      item: [expect.objectContaining({ response: oldBaseline.item[0].response })]
    });
  });

  it('detects stale-refresh fallback ID collisions before durable collection updates', async () => {
    const postman = createRollbackPostman({
      generateCollection: vi.fn().mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
        if (prefix === '[Baseline]') return 'col-smoke-existing';
        if (prefix === '[Smoke]') return 'col-smoke-generated';
        return 'col-contract-generated';
      }),
      getCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-baseline-existing') {
          throw collectionNotFound(uid);
        }
        return createGeneratedContractCollection();
      }),
      updateCollection: vi.fn().mockResolvedValue(undefined)
    });

    await expect(
      runExistingSpecBootstrap(postman, {
        inputs: {
          baselineCollectionId: 'col-baseline-existing',
          contractCollectionId: 'col-contract-existing',
          smokeCollectionId: 'col-smoke-existing'
        }
      })
    ).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');

    expect(postman.updateCollection).not.toHaveBeenCalled();
  });

  it('restores durable refresh updates before failing a late fallback ID collision', async () => {
    const oldBaseline = { info: { name: 'old baseline' }, item: [{ name: 'old baseline item' }] };
    const newBaseline = { info: { name: 'new baseline' }, item: [{ name: 'new baseline item' }] };
    const oldSmoke = { info: { name: 'old smoke' }, item: [{ name: 'old smoke item' }] };
    const newSmoke = { info: { name: 'new smoke' }, item: [{ name: 'new smoke item' }] };
    const oldContract = createGeneratedContractCollection();
    let contractExistingReads = 0;
    const postman = createRollbackPostman({
      generateCollection: vi.fn().mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
        if (prefix === '[Baseline]') return 'col-baseline-generated';
        if (prefix === '[Smoke]') return 'col-contract-existing';
        return 'col-contract-generated';
      }),
      getCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-baseline-generated') return newBaseline;
        if (uid === 'col-smoke-existing') return oldSmoke;
        if (uid === 'col-baseline-existing') return oldBaseline;
        if (uid === 'col-contract-existing') {
          contractExistingReads += 1;
          return contractExistingReads === 1 ? newSmoke : oldContract;
        }
        return createGeneratedContractCollection();
      }),
      updateCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-smoke-existing') {
          throw collectionNotFound(uid);
        }
        return undefined;
      })
    });

    await expect(
      runExistingSpecBootstrap(postman, {
        inputs: {
          baselineCollectionId: 'col-baseline-existing',
          contractCollectionId: 'col-contract-existing',
          smokeCollectionId: 'col-smoke-existing'
        }
      })
    ).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');

    const baselineUpdates = vi.mocked(postman.updateCollection).mock.calls
      .filter(([uid]) => uid === 'col-baseline-existing');
    expect(baselineUpdates).toHaveLength(2);
    expect(baselineUpdates[0]?.[1]).toMatchObject(newBaseline);
    expect(baselineUpdates[1]?.[1]).toMatchObject(oldBaseline);
  });

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
      getCollection: vi.fn().mockResolvedValue(createGeneratedContractCollection()),
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

  it('refresh mode regenerates collections even when ids already exist', async () => {
    const { core, infos } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const generatedIds = ['col-baseline-refresh', 'col-smoke-refresh', 'col-contract-refresh'];
    const fetchedCollections = new Map(
      generatedIds.map((id, index) => [
        id,
        {
          info: {
            name: ['[Baseline]', '[Smoke]', '[Contract]'][index]
          },
          item: [
            {
              name: 'Generated request',
              request: {
                method: 'GET',
                url: 'https://example.test'
              }
            }
          ]
        }
      ])
    );
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getCollection: vi.fn().mockImplementation(async (uid: string) => fetchedCollections.get(uid)),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateCollection: vi.fn().mockResolvedValue(undefined),
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
    collectionSyncMode: 'refresh',
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

    expect(postman.generateCollection).toHaveBeenCalledTimes(3);
    expect(postman.updateCollection).toHaveBeenNthCalledWith(
      1,
      'col-baseline-existing',
      expect.any(Object)
    );
    expect(postman.updateCollection).toHaveBeenNthCalledWith(
      2,
      'col-smoke-existing',
      expect.any(Object)
    );
    expect(postman.updateCollection).toHaveBeenNthCalledWith(
      3,
      'col-contract-existing',
      expect.any(Object)
    );
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-baseline-refresh');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-smoke-refresh');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-contract-refresh');
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-existing',
      'smoke-collection-id': 'col-smoke-existing',
      'contract-collection-id': 'col-contract-existing'
    });
    expect(infos).toContain(
      'Refreshed existing [Smoke] collection col-smoke-existing with temporary collection col-smoke-refresh'
    );
  });

  it('refresh mode promotes generated collections when no tracked ids exist', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const generatedIds = ['col-baseline-new', 'col-smoke-new', 'col-contract-new'];
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateCollection: vi.fn().mockResolvedValue(undefined),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        collectionSyncMode: 'refresh'
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

    expect(postman.updateCollection).toHaveBeenCalledTimes(1);
    expect(postman.updateCollection).toHaveBeenCalledWith('col-contract-new', expect.any(Object));
    expect(postman.deleteCollection).not.toHaveBeenCalled();
    expect(
      warnings.some((warning) => warning.includes('deleteCollection is unavailable'))
    ).toBe(false);
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-new',
      'smoke-collection-id': 'col-smoke-new',
      'contract-collection-id': 'col-contract-new'
    });
  });

  it('refresh mode falls back to newly generated collections when tracked targets are stale', async () => {
    const { core, warnings } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const generatedIds = ['col-baseline-fresh', 'col-smoke-fresh', 'col-contract-fresh'];
    const fetchedCollections = new Map(
      generatedIds.map((id, index) => [
        id,
        {
          info: {
            name: ['[Baseline]', '[Smoke]', '[Contract]'][index]
          },
          item: [
            {
              name: 'Generated request',
              request: {
                method: 'GET',
                url: 'https://example.test'
              }
            }
          ]
        }
      ])
    );
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getCollection: vi.fn().mockImplementation(async (uid: string) => fetchedCollections.get(uid)),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (!uid.includes('stale')) return undefined;
        throw new HttpError({
          method: 'PUT',
          url: 'https://api.getpostman.com/collections/stale',
          status: 404,
          statusText: 'Not Found',
          responseBody: '{"error":{"message":"missing"}}'
        });
      }),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };

    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-stale',
        smokeCollectionId: 'col-smoke-stale',
        contractCollectionId: 'col-contract-stale',
        collectionSyncMode: 'refresh'
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

    expect(postman.deleteCollection).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-fresh',
      'smoke-collection-id': 'col-smoke-fresh',
      'contract-collection-id': 'col-contract-fresh'
    });
    expect(
      warnings.some((warning) =>
        warning.includes('Existing [Smoke] collection col-smoke-stale was not found during refresh')
      )
    ).toBe(true);
  });

  it('warns without failing when temporary collection cleanup fails after a successful refresh', async () => {
    const { core, warnings } = createCoreStub();
    const generatedIds = ['col-baseline-temp', 'col-smoke-temp', 'col-contract-temp'];
    const fetchedCollections = new Map(
      generatedIds.map((id, index) => [
        id,
        {
          info: { name: ['[Baseline]', '[Smoke]', '[Contract]'][index] },
          item: [{ name: 'GET /payments', request: { method: 'GET', url: { path: ['payments'] } } }]
        }
      ])
    );
    const postman = createRollbackPostman({
      deleteCollection: vi.fn().mockRejectedValue(new Error('cleanup denied')),
      generateCollection: vi.fn().mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getCollection: vi.fn().mockImplementation(async (uid: string) => fetchedCollections.get(uid)),
      updateCollection: vi.fn().mockResolvedValue(undefined)
    });

    const result = await runExistingSpecBootstrap(postman, {
      core,
      inputs: {
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'refresh'
      }
    });

    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-existing',
      'smoke-collection-id': 'col-smoke-existing',
      'contract-collection-id': 'col-contract-existing'
    });
    expect(postman.deleteCollection).toHaveBeenCalledTimes(3);
    expect(
      warnings.filter((warning) => warning.includes('Failed to delete temporary collection'))
    ).toHaveLength(3);
  });

  it('attempts cleanup and records residual temporary collections when refresh fails after partial updates', async () => {
    const { core, warnings } = createCoreStub();
    const generatedIds = ['col-baseline-temp', 'col-smoke-temp', 'col-contract-temp'];
    const fetchedCollections = new Map(
      generatedIds.map((id, index) => [
        id,
        {
          info: { name: ['[Baseline]', '[Smoke]', '[Contract]'][index] },
          item: [{ name: 'GET /payments', request: { method: 'GET', url: { path: ['payments'] } } }]
        }
      ])
    );
    const postman = createRollbackPostman({
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      generateCollection: vi.fn().mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getCollection: vi.fn().mockImplementation(async (uid: string) => fetchedCollections.get(uid)),
      updateCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-contract-existing') {
          throw new Error('contract refresh update failed');
        }
        return undefined;
      })
    });

    await expect(
      runExistingSpecBootstrap(postman, {
        core,
        inputs: {
          baselineCollectionId: 'col-baseline-existing',
          smokeCollectionId: 'col-smoke-existing',
          contractCollectionId: 'col-contract-existing',
          collectionSyncMode: 'refresh'
        }
      })
    ).rejects.toThrow('contract refresh update failed');

    expect(postman.deleteCollection).toHaveBeenCalledWith('col-baseline-temp');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-smoke-temp');
    expect(postman.deleteCollection).toHaveBeenCalledWith('col-contract-temp');
    expect(
      warnings.some((warning) =>
        warning.includes('Refresh failed after temporary collection generation')
        && warning.includes('col-contract-temp')
      )
    ).toBe(true);
  });

  it('rejects collection ID collisions after refresh fallback before tagging or linking', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const generatedIds = ['col-shared', 'col-smoke-temp', 'col-contract-temp'];
    const fetchedCollections = new Map(
      generatedIds.map((id) => [
        id,
        {
          info: { name: id },
          item: [
            {
              name: 'Generated request',
              request: {
                method: 'GET',
                url: { path: ['payments'] }
              }
            }
          ]
        }
      ])
    );
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      deleteCollection: vi.fn().mockResolvedValue(undefined),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getCollection: vi.fn().mockImplementation(async (uid: string) => fetchedCollections.get(uid)),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn(),
      updateCollection: vi.fn().mockImplementation(async (uid: string) => {
        if (uid === 'col-baseline-stale') {
          throw new HttpError({
            method: 'PUT',
            url: 'https://api.getpostman.com/collections/col-baseline-stale',
            status: 404,
            statusText: 'Not Found',
            responseBody: '{"error":{"message":"missing"}}'
          });
        }
        return undefined;
      }),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
      linkCollectionsToSpecification: vi.fn(),
      syncCollection: vi.fn()
    };

    await expect(runBootstrap(createInputs({
      workspaceId: 'ws-existing',
      specId: 'spec-existing',
      baselineCollectionId: 'col-baseline-stale',
      smokeCollectionId: 'col-shared',
      contractCollectionId: 'col-contract-existing',
      collectionSyncMode: 'refresh'
    }), {
      core,
      exec: execStub,
      io: ioStub,
      internalIntegration,
      postman: withContractHelpers(postman),
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_SPEC_31, { status: 200 })
      )
    })).rejects.toThrow('CONTRACT_COLLECTION_ID_COLLISION');

    expect(postman.injectTests).not.toHaveBeenCalled();
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
          specs: { '../index.yaml': 'spec-v111' },
          collections: {
            '../postman/collections/[Baseline] core-payments release-v1.1.1': 'col-baseline-v111',
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
          specs: { '../index.yaml': 'spec-from-file' },
          collections: {
            '../postman/collections/[Baseline] core-payments': 'col-baseline-from-file',
            '../postman/collections/[Smoke] core-payments': 'col-smoke-from-file',
            '../postman/collections/[Contract] core-payments': 'col-contract-from-file'
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
            if (prefix === '[Baseline]') return 'col-baseline';
            if (prefix === '[Smoke]') return 'col-smoke';
            return 'col-contract';
          }),
        getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
        getTeams: vi.fn().mockResolvedValue([]),
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue('https://github.com/postman-cs/different-repo'),
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
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockRejectedValue(new Error('gateway 404')),
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
      '{"core-banking":"Core Banking"}'
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
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
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

  it('version mode reuses current resources.yaml collections on the checked-out ref', async () => {
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
          if (prefix === '[Baseline]') return 'col-baseline-v2';
          if (prefix === '[Smoke]') return 'col-smoke-v2';
          return 'col-contract-v2';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
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
          '../postman/collections/[Baseline] core-payments': 'col-baseline-current',
          '../postman/collections/[Smoke] core-payments': 'col-smoke-current',
          '../postman/collections/[Contract] core-payments': 'col-contract-current'
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
          if (prefix === '[Baseline]') return 'col-baseline-v2';
          if (prefix === '[Smoke]') return 'col-smoke-v2';
          return 'col-contract-v2';
        }),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
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
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-org' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-1'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('13347347'),
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
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

    await runBootstrap(createInputs({ workspaceTeamId: '132319' }), {
      core,
      exec: execStub,
      io: ioStub,
      postman: withContractHelpers(postman),
      specFetcher
    });

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

  it('detects org-mode when a service-account PMAK returns exactly one sub-team carrying organizationId', async () => {
    // Real-world service-account key case: GET /teams returns a single team,
    // but that team's organizationId is non-null because the parent account is
    // org-mode. Previously isOrgMode only fired for teams.length > 1, so the
    // action fell through to POST /workspaces and got a non-descriptive
    // "Workspace creation failed" error. The actionable error must fire here.
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
        { id: 83498, name: 'jared-service-account-test', handle: 'jaredserviceaccounttest', organizationId: 987442 }
      ]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
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
    ).rejects.toThrow(/Org-mode account detected[\s\S]*83498[\s\S]*jared-service-account-test/);

    expect(postman.createWorkspace).not.toHaveBeenCalled();
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
