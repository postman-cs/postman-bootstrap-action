import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  createExtensibleContractCollection,
  runBootstrap,
  type CoreLike,
  type ExecLike,
  type IOLike,
  type ResolvedInputs
} from '../src/index.js';
import {
  readResourcesState,
  writeResourcesState,
  type PostmanResourcesState
} from '../src/lib/postman/additional-collections.js';

const VALID_SPEC_31 = `{
  "openapi": "3.1.0",
  "info": { "title": "Payments", "version": "1.0.0" },
  "paths": {
    "/payments": {
      "get": {
        "operationId": "listPayments",
        "summary": "List payments",
        "responses": { "200": { "description": "ok" } }
      }
    }
  }
}`;

function createCoreStub(): CoreLike & { infos: string[] } {
  const infos: string[] = [];
  return {
    getInput: vi.fn().mockReturnValue(''),
    info: (message: string) => {
      infos.push(message);
    },
    warning: vi.fn(),
    error: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    group: vi.fn(async (_name, fn) => fn()),
    infos
  };
}

function createExecStub(): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{"violations":[]}', stderr: '' })
  };
}

function createIoStub(): IOLike {
  return { which: vi.fn().mockResolvedValue('/usr/local/bin/postman') };
}

function createInputs(overrides: Partial<ResolvedInputs> = {}): ResolvedInputs {
  return {
    projectName: 'Payments',
    syncExamples: true,
    collectionSyncMode: 'refresh',
    specSyncMode: 'update',
    releaseLabel: undefined,
    domain: 'core-banking',
    domainCode: 'AF',
    requesterEmail: 'owner@example.com',
    workspaceAdminUserIds: '101,102',
    repoUrl: 'https://github.com/postman-cs/bootstrap-action-test',
    specUrl: '',
    specPath: 'openapi.yaml',
    protocol: 'auto',
    openapiVersion: '',
    breakingChangeMode: 'off',
    breakingBaselineSpecPath: undefined,
    breakingRulesPath: 'changes-rules.yaml',
    breakingTargetRef: undefined,
    breakingSummaryPath: undefined,
    breakingLogPath: undefined,
    governanceMappingJson: '{"core-banking":"Core Banking"}',
    postmanApiKey: '',
    postmanAccessToken: 'access-token',
    credentialPreflight: 'warn',
    integrationBackend: 'bifrost',
    folderStrategy: 'Tags',
    nestedFolderHierarchy: true,
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
    workspaceId: '',
    specId: '',
    baselineCollectionId: '',
    smokeCollectionId: '',
    contractCollectionId: '',
    teamId: '12345',
    ...overrides
  };
}

function createGeneratedContractCollection() {
  return {
    info: { name: '[Contract] Payments' },
    item: [
      {
        name: 'GET /payments',
        request: { method: 'GET', url: { path: ['payments'] } }
      }
    ]
  };
}

function createPostman(overrides: Record<string, unknown> = {}) {
  return {
    addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-created' }),
    findWorkspacesByName: vi.fn().mockResolvedValue([]),
    generateCollection: vi
      .fn()
      .mockImplementation(async (_specId: string, _projectName: string, prefix: string) => {
        if (prefix === '') return 'col-baseline';
        if (prefix === '[Smoke]') return 'col-smoke';
        return 'col-contract';
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
    updateSpec: vi.fn().mockResolvedValue(undefined),
    uploadSpec: vi.fn().mockResolvedValue('spec-created'),
    ...overrides
  };
}

function createInternalIntegration(overrides: Record<string, unknown> = {}) {
  return {
    assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
    configureTeamContext: vi.fn(),
    linkCollectionsToSpecification: vi.fn().mockResolvedValue(undefined),
    syncCollection: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
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

describe('bootstrap persistability and exact-source spec state', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('version release v2 with a legacy bare v1 mapping uploads a new spec and records the v2 release key without mutating v1', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-spec-v2-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      join(workspace, '.postman/resources.yaml'),
      stringifyYaml({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          specs: {
            '../openapi.yaml': 'spec-v1'
          }
        }
      })
    );

    try {
      await withCwd(workspace, async () => {
        const postman = createPostman({
          createWorkspace: vi.fn().mockRejectedValue(new Error('must not create workspace')),
          uploadSpec: vi.fn().mockResolvedValue('spec-v2')
        });
        const internalIntegration = createInternalIntegration();

        const outputs = await runBootstrap(
          createInputs({
            workspaceId: 'ws-existing',
            specSyncMode: 'version',
            releaseLabel: 'v2'
          }),
          {
            core: createCoreStub(),
            exec: createExecStub(),
            io: createIoStub(),
            postman: postman as never,
            resourcesState: { read: readResourcesState, write: writeResourcesState },
            internalIntegration: internalIntegration as never,
            specFetcher: vi.fn()
          }
        );

        expect(postman.uploadSpec).toHaveBeenCalledTimes(1);
        expect(postman.updateSpec).not.toHaveBeenCalledWith('spec-v1', expect.anything(), expect.anything());
        expect(outputs['spec-id']).toBe('spec-v2');

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
        expect(resources.cloudResources?.specs).toEqual({
          '../openapi.yaml': 'spec-v1',
          '../openapi.yaml#release=v2': 'spec-v2'
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rerun same version key reuses/updates exactly that spec', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-spec-v2-rerun-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      join(workspace, '.postman/resources.yaml'),
      stringifyYaml({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          specs: {
            '../openapi.yaml': 'spec-v1',
            '../openapi.yaml#release=v2': 'spec-v2'
          },
          collections: {
            '../postman/collections/Payments': 'col-baseline',
            '../postman/collections/[Smoke] Payments': 'col-smoke',
            '../postman/collections/[Contract] Payments': 'col-contract'
          }
        }
      })
    );

    try {
      await withCwd(workspace, async () => {
        const postman = createPostman({
          createWorkspace: vi.fn().mockRejectedValue(new Error('must not create workspace')),
          uploadSpec: vi.fn().mockRejectedValue(new Error('must not upload')),
          generateCollection: vi.fn().mockRejectedValue(new Error('must not generate'))
        });

        const outputs = await runBootstrap(
          createInputs({
            workspaceId: 'ws-existing',
            specSyncMode: 'version',
            releaseLabel: 'v2',
            baselineCollectionId: 'col-baseline',
            smokeCollectionId: 'col-smoke',
            contractCollectionId: 'col-contract'
          }),
          {
            core: createCoreStub(),
            exec: createExecStub(),
            io: createIoStub(),
            postman: postman as never,
            resourcesState: { read: readResourcesState, write: writeResourcesState },
            internalIntegration: createInternalIntegration() as never,
            specFetcher: vi.fn()
          }
        );

        expect(postman.uploadSpec).not.toHaveBeenCalled();
        expect(postman.updateSpec).toHaveBeenCalledWith(
          'spec-v2',
          expect.stringContaining('"openapi": "3.1.0"'),
          'ws-existing'
        );
        expect(outputs['spec-id']).toBe('spec-v2');

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
        expect(resources.cloudResources?.specs).toEqual({
          '../openapi.yaml': 'spec-v1',
          '../openapi.yaml#release=v2': 'spec-v2'
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('update mode chooses exact matching source even if another map entry comes first', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-spec-exact-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      join(workspace, '.postman/resources.yaml'),
      stringifyYaml({
        workspace: { id: 'ws-existing' },
        cloudResources: {
          specs: {
            '../other.yaml': 'spec-other-first',
            '../openapi.yaml': 'spec-exact'
          },
          collections: {
            '../postman/collections/Payments': 'col-baseline',
            '../postman/collections/[Smoke] Payments': 'col-smoke',
            '../postman/collections/[Contract] Payments': 'col-contract'
          }
        }
      })
    );

    try {
      await withCwd(workspace, async () => {
        const postman = createPostman({
          createWorkspace: vi.fn().mockRejectedValue(new Error('must not create workspace')),
          uploadSpec: vi.fn().mockRejectedValue(new Error('must not upload')),
          generateCollection: vi.fn().mockRejectedValue(new Error('must not generate'))
        });

        const outputs = await runBootstrap(
          createInputs({
            workspaceId: 'ws-existing',
            specSyncMode: 'update',
            baselineCollectionId: 'col-baseline',
            smokeCollectionId: 'col-smoke',
            contractCollectionId: 'col-contract'
          }),
          {
            core: createCoreStub(),
            exec: createExecStub(),
            io: createIoStub(),
            postman: postman as never,
            resourcesState: { read: readResourcesState, write: writeResourcesState },
            internalIntegration: createInternalIntegration() as never,
            specFetcher: vi.fn()
          }
        );

        expect(postman.updateSpec).toHaveBeenCalledWith(
          'spec-exact',
          expect.stringContaining('"openapi": "3.1.0"'),
          'ws-existing'
        );
        expect(postman.updateSpec).not.toHaveBeenCalledWith(
          'spec-other-first',
          expect.anything(),
          expect.anything()
        );
        expect(outputs['spec-id']).toBe('spec-exact');
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('name_match full run outputs workspace ID but does not persist workspace.id and skips admin/governance/requester mutations', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-name-match-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);

    try {
      await withCwd(workspace, async () => {
        const core = createCoreStub();
        const postman = createPostman({
          createWorkspace: vi.fn().mockRejectedValue(new Error('must not create workspace')),
          findWorkspacesByName: vi.fn().mockResolvedValue([
            { id: 'ws-name-matched', name: '[AF] Payments' }
          ]),
          getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
          uploadSpec: vi.fn().mockResolvedValue('spec-created')
        });
        const internalIntegration = createInternalIntegration();

        const outputs = await runBootstrap(createInputs(), {
          core,
          exec: createExecStub(),
          io: createIoStub(),
          postman: postman as never,
          resourcesState: { read: readResourcesState, write: writeResourcesState },
          internalIntegration: internalIntegration as never,
          specFetcher: vi.fn()
        });

        expect(outputs['workspace-id']).toBe('ws-name-matched');
        expect(core.infos.some((line) => line.includes('name_match'))).toBe(true);
        expect(postman.addAdminsToWorkspace).not.toHaveBeenCalled();
        expect(postman.inviteRequesterToWorkspace).not.toHaveBeenCalled();
        expect(internalIntegration.assignWorkspaceToGovernanceGroup).not.toHaveBeenCalled();

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
        expect(resources.workspace?.id).toBeUndefined();
        expect(resources.cloudResources?.specs).toEqual({
          '../openapi.yaml': 'spec-created'
        });
        expect(resources.cloudResources?.collections).toMatchObject({
          '../postman/collections/Payments': 'col-baseline',
          '../postman/collections/[Smoke] Payments': 'col-smoke',
          '../postman/collections/[Contract] Payments': 'col-contract'
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('reconciled create does not persist workspace.id', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-reconciled-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);

    try {
      await withCwd(workspace, async () => {
        const postman = createPostman({
          createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-reconciled', reconciled: true }),
          findWorkspacesByName: vi.fn().mockResolvedValue([]),
          uploadSpec: vi.fn().mockResolvedValue('spec-created')
        });
        const internalIntegration = createInternalIntegration();

        const outputs = await runBootstrap(createInputs(), {
          core: createCoreStub(),
          exec: createExecStub(),
          io: createIoStub(),
          postman: postman as never,
          resourcesState: { read: readResourcesState, write: writeResourcesState },
          internalIntegration: internalIntegration as never,
          specFetcher: vi.fn()
        });

        expect(outputs['workspace-id']).toBe('ws-reconciled');
        expect(postman.addAdminsToWorkspace).not.toHaveBeenCalled();
        expect(postman.inviteRequesterToWorkspace).not.toHaveBeenCalled();
        expect(internalIntegration.assignWorkspaceToGovernanceGroup).not.toHaveBeenCalled();

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
        expect(resources.workspace?.id).toBeUndefined();
        expect(resources.cloudResources?.specs).toEqual({
          '../openapi.yaml': 'spec-created'
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('clean create and explicit workspace state still persist workspace.id', async () => {
    const cleanWorkspace = mkdtempSync(join(tmpdir(), 'bootstrap-clean-create-'));
    writeFileSync(join(cleanWorkspace, 'openapi.yaml'), VALID_SPEC_31);

    try {
      await withCwd(cleanWorkspace, async () => {
        const postman = createPostman({
          createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-clean' }),
          findWorkspacesByName: vi.fn().mockResolvedValue([]),
          uploadSpec: vi.fn().mockResolvedValue('spec-created')
        });

        await runBootstrap(createInputs(), {
          core: createCoreStub(),
          exec: createExecStub(),
          io: createIoStub(),
          postman: postman as never,
          resourcesState: { read: readResourcesState, write: writeResourcesState },
          internalIntegration: createInternalIntegration() as never,
          specFetcher: vi.fn()
        });

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
        expect(resources.workspace).toEqual({ id: 'ws-clean' });
        expect(postman.addAdminsToWorkspace).toHaveBeenCalledWith('ws-clean', '101,102');
        expect(postman.inviteRequesterToWorkspace).toHaveBeenCalledWith('ws-clean', 'owner@example.com');
      });
    } finally {
      rmSync(cleanWorkspace, { recursive: true, force: true });
    }

    const explicitWorkspace = mkdtempSync(join(tmpdir(), 'bootstrap-explicit-ws-'));
    writeFileSync(join(explicitWorkspace, 'openapi.yaml'), VALID_SPEC_31);

    try {
      await withCwd(explicitWorkspace, async () => {
        const postman = createPostman({
          createWorkspace: vi.fn().mockRejectedValue(new Error('must not create workspace')),
          uploadSpec: vi.fn().mockResolvedValue('spec-created')
        });

        await runBootstrap(createInputs({ workspaceId: 'ws-explicit' }), {
          core: createCoreStub(),
          exec: createExecStub(),
          io: createIoStub(),
          postman: postman as never,
          resourcesState: { read: readResourcesState, write: writeResourcesState },
          internalIntegration: createInternalIntegration() as never,
          specFetcher: vi.fn()
        });

        const resources = parseYaml(readFileSync('.postman/resources.yaml', 'utf8')) as PostmanResourcesState;
        expect(resources.workspace).toEqual({ id: 'ws-explicit' });
      });
    } finally {
      rmSync(explicitWorkspace, { recursive: true, force: true });
    }
  });

  it('EC path cannot reintroduce workspace.id when absent', async () => {
    const writes: PostmanResourcesState[] = [];
    const resourcesState: PostmanResourcesState = {
      cloudResources: {
        collections: {}
      }
    };
    const ecClient = {
      createExtensibleCollection: vi.fn().mockResolvedValue('ec-new'),
      deleteExtensibleCollection: vi.fn().mockResolvedValue(undefined),
      getExtensibleCollection: vi.fn(),
      populateFromTree: vi.fn().mockResolvedValue(1)
    };

    await createExtensibleContractCollection(
      'ws-1',
      { type: 'grpc', collection: { title: 'EC Contract' }, format: 'v3-ec' } as never,
      { projectName: 'Payments' } as never,
      {
        core: createCoreStub(),
        exec: createExecStub(),
        io: createIoStub(),
        postman: {} as never,
        ecClient: ecClient as never,
        resourcesState: {
          read: () => resourcesState,
          write: (state) => writes.push(structuredClone(state))
        },
        specFetcher: vi.fn()
      },
      resourcesState
    );

    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.workspace?.id).toBeUndefined();
    }
    expect(resourcesState.workspace?.id).toBeUndefined();
    expect(resourcesState.cloudResources?.collections).toMatchObject({
      '../postman/collections/[Contract] Payments': 'ec-new'
    });
  });
});
