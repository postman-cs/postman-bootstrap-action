import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  runBootstrap,
  type CoreLike,
  type ExecLike,
  type IOLike,
  type ResolvedInputs
} from '../src/index.js';
import {
  RESOURCES_STATE_VERSION,
  StateUnreadableError,
  readResourcesState,
  writeResourcesState
} from '../src/lib/postman/additional-collections.js';
import { BRANCH_DECISION_ENV } from '../src/lib/repo/branch-decision.js';

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
    requesterEmail: 'owner@example.com',
    repoUrl: 'https://github.com/postman-cs/bootstrap-action-test',
    specUrl: '',
    specPath: 'openapi.yaml',
    protocol: 'auto',
    openapiVersion: '',
    breakingChangeMode: 'off',
    breakingRulesPath: 'changes-rules.yaml',
    governanceMappingJson: '{}',
    postmanAccessToken: 'access-token',
    credentialPreflight: 'warn',
    branchStrategy: 'legacy',
    integrationBackend: 'bifrost',
    folderStrategy: 'Tags',
    nestedFolderHierarchy: true,
    requestNameSource: 'Fallback',
    postmanRegion: 'us',
    postmanStack: 'prod',
    postmanBifrostBase: 'https://bifrost-premium-https-v4.gw.postman.com',
    postmanFallbackBase: 'https://go.postman.co/_api',
    postmanGatewayBase: 'https://gateway.postman.com',
    postmanIapubBase: 'https://iapub.postman.co',
    workspaceId: '',
    specId: '',
    baselineCollectionId: '',
    smokeCollectionId: '',
    contractCollectionId: '',
    teamId: '12345',
    ...overrides
  };
}

function createDefaultImportV2Collection() {
  return vi.fn().mockImplementation(async (_workspaceId: string, collection: unknown, finalName?: string) => {
    const info = (collection as { info?: { name?: string } } | null)?.info;
    const name = String(finalName || info?.name || '');
    const id = name.includes('[Contract]')
      ? 'col-contract'
      : name.includes('[Smoke]')
        ? 'col-smoke'
        : 'col-baseline';
    return {
      collectionId: id,
      journaledRootIds: [id],
      deleteVerifiedCleanup: vi.fn().mockResolvedValue(undefined)
    };
  });
}

function createPostman() {
  return {
    addAdminsToWorkspace: vi.fn().mockResolvedValue(undefined),
    createWorkspace: vi.fn().mockResolvedValue({ id: 'ws-created' }),
    findWorkspacesByName: vi.fn().mockResolvedValue([]),
    generateCollection: vi.fn().mockRejectedValue(new Error('generateCollection unreachable')),
    getAutoDerivedTeamId: vi.fn().mockResolvedValue('12345'),
    getCollection: vi.fn().mockResolvedValue({
      info: { name: '[Contract] Payments' },
      item: [
        {
          name: 'GET /payments',
          request: { method: 'GET', url: { path: ['payments'] } }
        }
      ]
    }),
    getSpecContent: vi.fn().mockResolvedValue(VALID_SPEC_31),
    getTeams: vi.fn().mockResolvedValue([]),
    getWorkspaceGitRepoUrl: vi.fn().mockResolvedValue(null),
    getWorkspaceVisibility: vi.fn().mockResolvedValue('team'),
    importV2Collection: createDefaultImportV2Collection(),
    deepUpdateV2Collection: vi.fn().mockImplementation(async (collectionUid: string) => collectionUid),
    deleteVerifiedRunOwnedCollections: vi.fn().mockResolvedValue(undefined),
    injectContractTests: vi.fn().mockResolvedValue([]),
    injectTests: vi.fn().mockResolvedValue(undefined),
    inviteRequesterToWorkspace: vi.fn().mockResolvedValue(undefined),
    tagCollection: vi.fn().mockResolvedValue(undefined),
    updateCollectionDescription: vi.fn().mockResolvedValue(undefined),
    updateSpec: vi.fn().mockResolvedValue(undefined),
    uploadSpec: vi.fn().mockResolvedValue('spec-created')
  };
}

function createInternalIntegration() {
  const linked = new Map<string, { options?: Record<string, unknown>; syncOptions?: Record<string, unknown> }>();
  return {
    assignWorkspaceToGovernanceGroup: vi.fn().mockResolvedValue(undefined),
    configureTeamContext: vi.fn(),
    linkCollectionsToSpecification: vi.fn().mockImplementation(
      async (_specId: string, collections: Array<{ collectionId: string; options?: Record<string, unknown>; syncOptions?: Record<string, unknown> }>) => {
        for (const row of collections) {
          linked.set(row.collectionId, {
            ...(row.options ? { options: row.options } : {}),
            ...(row.syncOptions ? { syncOptions: row.syncOptions } : {})
          });
        }
        return { lockedRetries: 0 };
      }
    ),
    listSpecificationCollectionRelations: vi.fn().mockImplementation(async () =>
      [...linked.entries()].map(([collectionId, meta]) => ({
        collectionId,
        state: 'in-sync',
        ...meta
      }))
    ),
    settleSpecificationCollectionRelations: vi.fn().mockImplementation(async () => ({
      relations: [...linked.entries()].map(([collectionId, meta]) => ({
        collectionId,
        state: 'in-sync',
        ...meta
      })),
      attempts: 1
    })),
    syncCollection: vi.fn().mockResolvedValue(undefined)
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

function runDeps(postman = createPostman()) {
  return {
    core: createCoreStub(),
    exec: createExecStub(),
    io: createIoStub(),
    internalIntegration: createInternalIntegration(),
    postman,
    resourcesState: { read: readResourcesState, write: writeResourcesState },
    specFetcher: fetch
  } as unknown as Parameters<typeof runBootstrap>[1];
}

function githubPreviewEnv(workspace: string): Record<string, string> {
  const eventPath = join(workspace, 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({ repository: { default_branch: 'main', full_name: 'org/repo' } })
  );
  return {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'org/repo',
    GITHUB_REF: 'refs/heads/feature/payments',
    GITHUB_REF_NAME: 'feature/payments',
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_SHA: 'abc123',
    // Neutralize the real CI run's PR context: a leaked GITHUB_HEAD_REF would
    // flip these fixtures into pull_request identity (clean('') reads as unset).
    GITHUB_HEAD_REF: '',
    GITHUB_BASE_REF: ''
  };
}

describe('state v2 reader contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env[BRANCH_DECISION_ENV];
  });

  it('missing state file reads as null (first run)', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'state-v2-missing-'));
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    expect(readResourcesState()).toBeNull();
  });

  it('malformed YAML fails loud with CONTRACT_STATE_UNREADABLE instead of reading as absent', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'state-v2-malformed-'));
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(join(workspace, '.postman/resources.yaml'), 'workspace: [unclosed');
    expect(() => readResourcesState()).toThrowError(/CONTRACT_STATE_UNREADABLE/);
    expect(() => readResourcesState()).toThrowError(StateUnreadableError);
  });

  it('non-mapping YAML fails loud with CONTRACT_STATE_UNREADABLE', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'state-v2-scalar-'));
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(join(workspace, '.postman/resources.yaml'), '- just\n- a\n- list\n');
    expect(() => readResourcesState()).toThrowError(/CONTRACT_STATE_UNREADABLE/);
  });

  it('unsupported declared version fails loud', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'state-v2-version-'));
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      join(workspace, '.postman/resources.yaml'),
      stringifyYaml({ version: 99, workspace: { id: 'ws-1' } })
    );
    expect(() => readResourcesState()).toThrowError(/CONTRACT_STATE_UNREADABLE/);
    expect(() => readResourcesState()).toThrowError(/version 99/);
  });

  it('v1 state (no version field) still reads', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'state-v2-v1-'));
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    writeFileSync(
      join(workspace, '.postman/resources.yaml'),
      stringifyYaml({ workspace: { id: 'ws-1' } })
    );
    expect(readResourcesState()).toEqual({ workspace: { id: 'ws-1' } });
  });

  it('writer stamps the current state version', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'state-v2-write-'));
    vi.stubEnv('GITHUB_WORKSPACE', workspace);
    writeResourcesState({ workspace: { id: 'ws-1' } });
    const onDisk = parseYaml(readFileSync(join(workspace, '.postman/resources.yaml'), 'utf8'));
    expect(onDisk.version).toBe(RESOURCES_STATE_VERSION);
    expect(onDisk.workspace).toEqual({ id: 'ws-1' });
  });
});

describe('branch-aware bootstrap runs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env[BRANCH_DECISION_ENV];
  });

  it('preview run creates a suffixed asset set, never writes tracked state, never resolves canonical ids', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'branch-preview-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    mkdirSync(join(workspace, '.postman'), { recursive: true });
    const priorState = stringifyYaml({
      workspace: { id: 'ws-existing' },
      cloudResources: { specs: { '../openapi.yaml': 'spec-canonical' } }
    });
    writeFileSync(join(workspace, '.postman/resources.yaml'), priorState);

    const env = githubPreviewEnv(workspace);
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    await withCwd(workspace, async () => {
      const postman = createPostman();
      const outputs = await runBootstrap(
        createInputs({ branchStrategy: 'preview', workspaceId: 'ws-existing' }),
        runDeps(postman)
      );

      // Suffixed preview naming end-to-end: spec upload used the preview name.
      expect(postman.uploadSpec).toHaveBeenCalledWith(
        'ws-existing',
        expect.stringMatching(/^Payments @feature-payments/),
        expect.any(String),
        '3.1'
      );
      // Canonical spec id from tracked state was NOT resolved/updated.
      expect(postman.updateSpec).not.toHaveBeenCalled();
      expect(outputs['sync-status']).toBe('synced');
      expect(JSON.parse(outputs['branch-decision']).tier).toBe('preview');
      // Local OpenAPI embeds the preview marker in each imported payload description
      // (no post-create updateCollectionDescription fanout).
      expect(postman.updateCollectionDescription).not.toHaveBeenCalled();
      expect(postman.importV2Collection).toHaveBeenCalledTimes(3);
      for (const call of postman.importV2Collection.mock.calls) {
        const collection = call[1] as { info?: { description?: string; name?: string } };
        expect(String(collection.info?.description || '')).toContain('"role":"preview"');
        expect(String(call[2] || collection.info?.name || '')).toMatch(/@feature-payments/);
      }

      // Tracked state untouched byte-for-byte.
      expect(readFileSync(join(workspace, '.postman/resources.yaml'), 'utf8')).toBe(priorState);
    });
  });

  it('preview run with explicit canonical asset id refuses with CONTRACT_BRANCH_CANONICAL_WRITE', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'branch-guard-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    const env = githubPreviewEnv(workspace);
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }

    await withCwd(workspace, async () => {
      await expect(
        runBootstrap(
          createInputs({ branchStrategy: 'preview', specId: 'spec-canonical' }),
          runDeps()
        )
      ).rejects.toThrowError(/CONTRACT_BRANCH_CANONICAL_WRITE/);
    });
  });

  it('channel run prefixes the asset set name', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'branch-channel-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    const eventPath = join(workspace, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ repository: { default_branch: 'main', full_name: 'org/repo' } })
    );
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'org/repo');
    vi.stubEnv('GITHUB_REF', 'refs/heads/develop');
    vi.stubEnv('GITHUB_REF_NAME', 'develop');
    vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_BASE_REF', '');

    await withCwd(workspace, async () => {
      const postman = createPostman();
      const outputs = await runBootstrap(
        createInputs({
          branchStrategy: 'publish-gate',
          channels: 'develop=DEV',
          workspaceId: 'ws-existing'
        }),
        runDeps(postman)
      );
      expect(postman.uploadSpec).toHaveBeenCalledWith(
        'ws-existing',
        expect.stringMatching(/^\[DEV\] Payments/),
        expect.any(String),
        '3.1'
      );
      expect(JSON.parse(outputs['branch-decision']).tier).toBe('channel');
      expect(postman.generateCollection).not.toHaveBeenCalled();
      expect(postman.importV2Collection).toHaveBeenCalled();
      expect(
        postman.importV2Collection.mock.calls.some((call) =>
          String(call[2] || '').includes('[DEV] [Smoke]')
        )
      ).toBe(true);
    });
  });

  it('canonical run under publish-gate behaves like legacy: writes v2 state', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'branch-canonical-'));
    writeFileSync(join(workspace, 'openapi.yaml'), VALID_SPEC_31);
    const eventPath = join(workspace, 'event.json');
    writeFileSync(
      eventPath,
      JSON.stringify({ repository: { default_branch: 'main', full_name: 'org/repo' } })
    );
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_REPOSITORY', 'org/repo');
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('GITHUB_REF_NAME', 'main');
    vi.stubEnv('GITHUB_EVENT_PATH', eventPath);
    vi.stubEnv('GITHUB_HEAD_REF', '');
    vi.stubEnv('GITHUB_BASE_REF', '');

    await withCwd(workspace, async () => {
      const outputs = await runBootstrap(
        createInputs({ branchStrategy: 'publish-gate' }),
        runDeps()
      );
      expect(JSON.parse(outputs['branch-decision']).tier).toBe('canonical');
      const onDisk = parseYaml(
        readFileSync(join(workspace, '.postman/resources.yaml'), 'utf8')
      );
      expect(onDisk.version).toBe(RESOURCES_STATE_VERSION);
      expect(onDisk.workspace.id).toBe('ws-created');
    });
  });
});
