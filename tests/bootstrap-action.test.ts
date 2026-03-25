import { describe, expect, it, vi } from 'vitest';

import {
  lintSpecViaCli,
  readActionInputs,
  runBootstrap,
  type CoreLike,
  type ExecLike,
  type IOLike,
  type ResolvedInputs
} from '../src/index.js';

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
    group: async (_name: string, fn: () => Promise<any>) => fn(),
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
    collectionSyncMode: 'reuse',
    specSyncMode: 'update',
    releaseLabel: undefined,
    setAsCurrent: true,
    domain: 'core-banking',
    domainCode: 'AF',
    requesterEmail: 'owner@example.com',
    workspaceAdminUserIds: '101,102',
    specUrl: 'https://example.test/openapi.yaml',
    environmentsJson: '["prod","stage"]',
    systemEnvMapJson: '{"prod":"sys-prod","stage":"sys-stage"}',
    governanceMappingJson: '{"core-banking":"Core Banking"}',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    githubToken: 'github-token',
    ghFallbackToken: 'github-fallback-token',
    githubAuthMode: 'github_token_first',
    integrationBackend: 'bifrost',
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

describe('bootstrap action', () => {
  it('marks secrets as early as input resolution', () => {
    const { core, secrets } = createCoreStub({
      'project-name': 'core-payments',
      'spec-url': 'https://example.test/openapi.yaml',
      'postman-api-key': 'pmak-test',
      'postman-access-token': 'postman-access-token',
      'github-token': 'github-token',
      'gh-fallback-token': 'github-fallback-token'
    });

    const inputs = readActionInputs(core);

    expect(inputs.postmanApiKey).toBe('pmak-test');
    expect(secrets).toEqual([
      'pmak-test',
      'postman-access-token',
      'github-token',
      'github-fallback-token'
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
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn().mockResolvedValue('')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', {
        status: 200
      })
    );

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      github,
      io: ioStub,
      internalIntegration,
      postman,
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
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'LINT_WARNINGS',
      '0'
    );
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'LINT_ERRORS',
      '0'
    );
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'POSTMAN_WORKSPACE_ID',
      'ws-123'
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
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn(),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn(),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      })
    ).rejects.toThrow('Spec lint found 1 errors');

    expect(postman.generateCollection).not.toHaveBeenCalled();
  });

  it('reuses existing workspace, spec, and collection ids from explicit inputs', async () => {
    const { core, infos, outputs } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn()
    };

    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing'
      }),
      {
        core,
        exec: execStub,
        github,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(github.getRepositoryVariable).toHaveBeenCalledTimes(1);
    expect(github.getRepositoryVariable).toHaveBeenCalledWith('POSTMAN_RELEASES_JSON');
    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-existing', 'openapi: 3.1.0', 'ws-existing');
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

  it('falls back to repository variables for reruns before creating new assets', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn(),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn(async (name: string) => {
        const values: Record<string, string> = {
          POSTMAN_WORKSPACE_ID: 'ws-from-vars',
          POSTMAN_SPEC_UID: 'spec-from-vars',
          POSTMAN_BASELINE_COLLECTION_UID: 'col-baseline-from-vars',
          POSTMAN_SMOKE_COLLECTION_UID: 'col-smoke-from-vars',
          POSTMAN_CONTRACT_COLLECTION_UID: 'col-contract-from-vars'
        };
        return values[name] ?? '';
      })
    };

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      github,
      io: ioStub,
      postman,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('openapi: 3.1.0', { status: 200 })
      )
    });

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-from-vars', 'openapi: 3.1.0', 'ws-from-vars');
    expect(result).toMatchObject({
      'workspace-id': 'ws-from-vars',
      'spec-id': 'spec-from-vars',
      'baseline-collection-id': 'col-baseline-from-vars',
      'smoke-collection-id': 'col-smoke-from-vars',
      'contract-collection-id': 'col-contract-from-vars'
    });
  });

  it('refresh mode regenerates collections even when ids already exist', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const generatedIds = ['col-baseline-refresh', 'col-smoke-refresh', 'col-contract-refresh'];
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn(),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi
        .fn()
        .mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };
    const github = {
      setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
      getRepositoryVariable: vi.fn().mockResolvedValue('')
    };

    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'refresh',
        setAsCurrent: false
      }),
      {
        core,
        exec: execStub,
        github,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(postman.generateCollection).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      'baseline-collection-id': 'col-baseline-refresh',
      'smoke-collection-id': 'col-smoke-refresh',
      'contract-collection-id': 'col-contract-refresh'
    });
    expect(github.setRepositoryVariable).toHaveBeenCalledWith(
      'POSTMAN_BASELINE_COLLECTION_UID',
      'col-baseline-refresh'
    );
  });

  it('version mode creates release-scoped assets and persists a release manifest', async () => {
    const previousRefName = process.env.GITHUB_REF_NAME;
    const previousSha = process.env.GITHUB_SHA;
    process.env.GITHUB_REF_NAME = 'release/v1.1.1';
    process.env.GITHUB_SHA = 'deadbeef';

    try {
      const { core } = createCoreStub();
      const execStub = createExecStub();
      const ioStub = createIoStub();
      const generatedIds = ['col-baseline-v111', 'col-smoke-v111', 'col-contract-v111'];
      const postman = {
        addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
        createWorkspace: vi.fn(),
        findWorkspacesByName: vi.fn().mockResolvedValue([]),
        generateCollection: vi
          .fn()
          .mockImplementation(async () => generatedIds.shift() || 'col-fallback'),
        getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
        injectTests: vi.fn().mockResolvedValue(undefined),
        inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
        tagCollection: vi.fn().mockResolvedValue(undefined),
        uploadSpec: vi.fn().mockResolvedValue('spec-v111'),
        updateSpec: vi.fn().mockResolvedValue(undefined)
      };
      const github = {
        setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
        getRepositoryVariable: vi.fn(async (name: string) =>
          name === 'POSTMAN_RELEASES_JSON' ? JSON.stringify({ releases: {} }) : ''
        )
      };

      const result = await runBootstrap(
        createInputs({
          workspaceId: 'ws-existing',
          collectionSyncMode: 'version',
          specSyncMode: 'version'
        }),
        {
          core,
          exec: execStub,
          github,
          io: ioStub,
          postman,
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response('openapi: 3.1.0', { status: 200 })
          )
        }
      );

      expect(postman.uploadSpec).toHaveBeenCalledWith(
        'ws-existing',
        'core-payments release-v1.1.1',
        'openapi: 3.1.0'
      );
      expect(postman.generateCollection).toHaveBeenNthCalledWith(
        1,
        'spec-v111',
        'core-payments release-v1.1.1',
        '[Baseline]'
      );
      const manifestCall = github.setRepositoryVariable.mock.calls.find(
        ([name]) => name === 'POSTMAN_RELEASES_JSON'
      );
      expect(manifestCall).toBeTruthy();
      expect(JSON.parse(String(manifestCall?.[1]))).toMatchObject({
        current: 'release-v1.1.1',
        releases: {
          'release-v1.1.1': {
            specId: 'spec-v111',
            collections: {
              baseline: 'col-baseline-v111',
              smoke: 'col-smoke-v111',
              contract: 'col-contract-v111'
            },
            source: {
              ref: 'release-v1.1.1',
              sha: 'deadbeef'
            }
          }
        }
      });
      expect(result['spec-id']).toBe('spec-v111');
    } finally {
      if (previousRefName === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = previousRefName;
      if (previousSha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = previousSha;
    }
  });

  it('version mode can keep existing current pointers when set-as-current is false', async () => {
    const previousRefName = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = 'v1.1.1';

    try {
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
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
        injectTests: vi.fn().mockResolvedValue(undefined),
        inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
        tagCollection: vi.fn().mockResolvedValue(undefined),
        uploadSpec: vi.fn().mockResolvedValue('spec-v111'),
        updateSpec: vi.fn().mockResolvedValue(undefined)
      };
      const github = {
        setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
        getRepositoryVariable: vi.fn(async (name: string) =>
          name === 'POSTMAN_RELEASES_JSON'
            ? JSON.stringify({ current: 'v1.1.0', releases: { 'v1.1.0': { collections: {} } } })
            : ''
        )
      };

      await runBootstrap(
        createInputs({
          workspaceId: 'ws-existing',
          collectionSyncMode: 'version',
          specSyncMode: 'version',
          setAsCurrent: false
        }),
        {
          core,
          exec: execStub,
          github,
          io: ioStub,
          postman,
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response('openapi: 3.1.0', { status: 200 })
          )
        }
      );

      const updatedCurrentCalls = github.setRepositoryVariable.mock.calls.filter(([name]) =>
        [
          'POSTMAN_WORKSPACE_ID',
          'POSTMAN_SPEC_UID',
          'POSTMAN_BASELINE_COLLECTION_UID',
          'POSTMAN_SMOKE_COLLECTION_UID',
          'POSTMAN_CONTRACT_COLLECTION_UID',
          'POSTMAN_RELEASE_LABEL'
        ].includes(String(name))
      );
      expect(updatedCurrentCalls).toHaveLength(0);
    } finally {
      if (previousRefName === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = previousRefName;
    }
  });

  it('version mode does not fall back to the singleton current spec uid', async () => {
    const previousRefName = process.env.GITHUB_REF_NAME;
    process.env.GITHUB_REF_NAME = 'v1.1.2';

    try {
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
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
        injectTests: vi.fn().mockResolvedValue(undefined),
        inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
        tagCollection: vi.fn().mockResolvedValue(undefined),
        uploadSpec: vi.fn().mockResolvedValue('spec-v112'),
        updateSpec: vi.fn().mockResolvedValue(undefined)
      };
      const github = {
        setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
        getRepositoryVariable: vi.fn(async (name: string) => {
          if (name === 'POSTMAN_RELEASES_JSON') {
            return JSON.stringify({ releases: {} });
          }
          if (name === 'POSTMAN_SPEC_UID') {
            return 'spec-current';
          }
          return '';
        })
      };

      const result = await runBootstrap(
        createInputs({
          workspaceId: 'ws-existing',
          collectionSyncMode: 'version',
          specSyncMode: 'version'
        }),
        {
          core,
          exec: execStub,
          github,
          io: ioStub,
          postman,
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response('openapi: 3.1.0', { status: 200 })
          )
        }
      );

      expect(postman.updateSpec).not.toHaveBeenCalledWith(
        'spec-current',
        'openapi: 3.1.0',
        'ws-existing'
      );
      expect(postman.uploadSpec).toHaveBeenCalledWith(
        'ws-existing',
        'core-payments v1.1.2',
        'openapi: 3.1.0'
      );
      expect(result['spec-id']).toBe('spec-v112');
    } finally {
      if (previousRefName === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = previousRefName;
    }
  });

  it('creates a new workspace when the repo-variable workspace is linked to a different repository', async () => {
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
        getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue('https://github.com/postman-cs/different-repo'),
        injectTests: vi.fn().mockResolvedValue(undefined),
        inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
        tagCollection: vi.fn().mockResolvedValue(undefined),
        uploadSpec: vi.fn().mockResolvedValue('spec-123'),
        updateSpec: vi.fn().mockResolvedValue(undefined)
      };
      const github = {
        setRepositoryVariable: vi.fn().mockResolvedValue(undefined),
        getRepositoryVariable: vi.fn(async (name: string) => {
          const values: Record<string, string> = {
            POSTMAN_WORKSPACE_ID: 'ws-from-vars'
          };
          return values[name] ?? '';
        })
      };

      const result = await runBootstrap(createInputs(), {
        core,
        exec: execStub,
        github,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      });

      expect(postman.getWorkspaceGitRepoUrl).toHaveBeenCalledWith('ws-from-vars', '12345', 'postman-access-token');
      expect(postman.createWorkspace).toHaveBeenCalled();
      expect(result['workspace-id']).toBe('ws-new');
      expect(postman.updateSpec).not.toHaveBeenCalled();
    } finally {
      if (previousRepository === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = previousRepository;
      }
    }
  });

  it('skips governance assignment when postman-access-token is absent', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };

    const result = await runBootstrap(
      createInputs({ postmanAccessToken: undefined }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(postman.createWorkspace).toHaveBeenCalled();
  });

  it('skips repo variable persistence when github dependency is absent', async () => {
    const { core } = createCoreStub();
    const execStub = createExecStub();
    const ioStub = createIoStub();
    const postman = {
      addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
      createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
      findWorkspacesByName: vi.fn().mockResolvedValue([]),
      generateCollection: vi.fn().mockResolvedValue('col-id'),
      getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };

    const result = await runBootstrap(
      createInputs({ githubToken: undefined }),
      {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(result['workspace-id']).toBe('ws-123');
    expect(result['spec-id']).toBe('spec-123');
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
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn().mockResolvedValue('spec-123'),
      updateSpec: vi.fn().mockResolvedValue(undefined)
    };

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('openapi: 3.1.0', { status: 200 })
      )
    });

    expect(result['workspace-id']).toBe('ws-123');
    expect(warnings.some((w) => w.includes('Missing description'))).toBe(true);
    const lintSummary = JSON.parse(result['lint-summary-json']);
    expect(lintSummary.warnings).toBe(1);
    expect(lintSummary.errors).toBe(0);
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
