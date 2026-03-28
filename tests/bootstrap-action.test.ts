import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    governanceMappingJson: '{"core-banking":"Core Banking"}',
    postmanApiKey: 'pmak-test',
    postmanAccessToken: 'postman-access-token',
    integrationBackend: 'bifrost',
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const internalIntegration = {
      assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
      linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
      syncCollection: vi.fn().mockResolvedValue(undefined)
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', {
        status: 200
      })
    );

    const result = await runBootstrap(createInputs(), {
      core,
      exec: execStub,
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.0.0\ninfo:\n  title: old\n'),
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
          postman,
          specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
            new Response('openapi: 3.1.0', { status: 200 })
          )
        }
      )
    ).rejects.toThrow('Spec lint found 1 errors');

    expect(postman.getSpecContent).toHaveBeenCalledWith('spec-existing');
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      1,
      'spec-existing',
      'openapi: 3.1.0',
      'ws-existing'
    );
    expect(postman.updateSpec).toHaveBeenNthCalledWith(
      2,
      'spec-existing',
      'openapi: 3.0.0\ninfo:\n  title: old\n',
      'ws-existing'
    );
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0'),
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
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('info:\n  title: Missing version\n', { status: 200 })
        )
      })
    ).rejects.toThrow('Spec is missing "openapi" or "swagger" version field');

    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.updateSpec).not.toHaveBeenCalled();
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
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const result = await runBootstrap(
      createInputs({
        workspaceId: 'ws-existing',
        specId: 'spec-existing',
        baselineCollectionId: 'col-baseline-existing',
        smokeCollectionId: 'col-smoke-existing',
        contractCollectionId: 'col-contract-existing',
        collectionSyncMode: 'reuse'
      }),
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
      getTeams: vi.fn().mockResolvedValue([]),
      getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
      injectTests: vi.fn().mockResolvedValue(undefined),
      inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
      tagCollection: vi.fn().mockResolvedValue(undefined),
      uploadSpec: vi.fn(),
      updateSpec: vi.fn().mockResolvedValue(undefined),
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
        )
      }
    );

    expect(postman.updateSpec).toHaveBeenCalledWith(
      'spec-v111',
      'openapi: 3.1.0',
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
  });

  it('reuses .postman/resources.yaml for reruns before creating new assets', async () => {
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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

    const result = await runBootstrap(createInputs({ collectionSyncMode: 'reuse' }), {
      core,
      exec: execStub,
      io: ioStub,
      postman,
      specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response('openapi: 3.1.0', { status: 200 })
      )
    });

    expect(postman.createWorkspace).not.toHaveBeenCalled();
    expect(postman.uploadSpec).not.toHaveBeenCalled();
    expect(postman.generateCollection).not.toHaveBeenCalled();
    expect(postman.updateSpec).toHaveBeenCalledWith('spec-from-file', 'openapi: 3.1.0', 'ws-from-file');
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
        getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
    expect(
      warnings.some((warning) =>
        warning.includes('Skipping cloud spec-to-collection linking and sync because postman-access-token is not configured')
      )
    ).toBe(true);
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };

    const result = await runBootstrap(
      createInputs(),
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
        postman,
        specFetcher: vi.fn<typeof fetch>().mockResolvedValue(
          new Response('openapi: 3.1.0', { status: 200 })
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', { status: 200 })
    );

    await expect(
      runBootstrap(createInputs(), {
        core,
        exec: execStub,
        io: ioStub,
        postman,
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', { status: 200 })
    );

    await runBootstrap(createInputs({ workspaceTeamId: '132319' }), {
      core,
      exec: execStub,
      io: ioStub,
      postman,
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', { status: 200 })
    );

    await runBootstrap(createInputs({ workspaceId: 'ws-existing' }), {
      core,
      exec: execStub,
      io: ioStub,
      postman,
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', { status: 200 })
    );

    await runBootstrap(createInputs(), {
      core,
      exec: execStub,
      io: ioStub,
      postman,
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
      getSpecContent: vi.fn().mockResolvedValue('openapi: 3.1.0')
    };
    const specFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('openapi: 3.1.0', { status: 200 })
    );

    await expect(
      runBootstrap(createInputs({ workspaceTeamId: 'not-a-number' }), {
        core,
        exec: execStub,
        io: ioStub,
        postman,
        specFetcher
      })
    ).rejects.toThrow('workspace-team-id must be a numeric sub-team ID');
  });
