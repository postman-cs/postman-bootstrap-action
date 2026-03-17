import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { parse as parseYaml } from 'yaml';

import { openAlphaActionContract } from './contracts.js';
import { GitHubApiClient, type GitHubApiClientAuthMode } from './lib/github/github-api-client.js';
import { createInternalIntegrationAdapter, type InternalIntegrationAdapter } from './lib/postman/internal-integration-adapter.js';
import { PostmanAssetsClient } from './lib/postman/postman-assets-client.js';
import { resolveCanonicalWorkspaceSelection } from './lib/postman/workspace-selection.js';
import { retry } from './lib/retry.js';
import { createSecretMasker } from './lib/secrets.js';

export interface ResolvedInputs {
  projectName: string;
  workspaceId?: string;
  specId?: string;
  baselineCollectionId?: string;
  smokeCollectionId?: string;
  contractCollectionId?: string;
  domain?: string;
  domainCode?: string;
  requesterEmail?: string;
  workspaceAdminUserIds?: string;
  specUrl: string;
  environmentsJson: string;
  systemEnvMapJson: string;
  governanceMappingJson: string;
  postmanApiKey: string;
  postmanAccessToken?: string;
  githubToken?: string;
  ghFallbackToken?: string;
  githubAuthMode: string;
  integrationBackend: string;
}

export interface PlannedOutputs {
  'workspace-id': string;
  'workspace-url': string;
  'workspace-name': string;
  'spec-id': string;
  'baseline-collection-id': string;
  'smoke-collection-id': string;
  'contract-collection-id': string;
  'collections-json': string;
  'spec-server-url': string;
  'lint-summary-json': string;
}

export interface LintViolation {
  issue?: string;
  path?: string;
  severity?: string;
}

export interface LintSummary {
  errors: number;
  violations: LintViolation[];
  warnings: number;
}

interface BootstrapRepositoryVariables {
  lintErrors: number;
  lintWarnings: number;
}

export interface CoreLike {
  error(message: string): void;
  getInput(name: string, options?: { required?: boolean }): string;
  group<T>(name: string, fn: () => Promise<T>): Promise<T>;
  info(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string): void;
  setSecret(secret: string): void;
  warning(message: string): void;
}

export interface ExecLike {
  exec(
    commandLine: string,
    args?: string[],
    options?: Parameters<typeof exec.exec>[2]
  ): ReturnType<typeof exec.exec>;
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: Parameters<typeof exec.getExecOutput>[2]
  ): ReturnType<typeof exec.getExecOutput>;
}

export interface IOLike {
  which(tool: string, check?: boolean): Promise<string>;
}

export interface BootstrapExecutionDependencies {
  core: Pick<
    CoreLike,
    'error' | 'group' | 'info' | 'setOutput' | 'warning'
  >;
  exec: ExecLike;
  github?: Pick<GitHubApiClient, 'setRepositoryVariable' | 'getRepositoryVariable'>;
  io: IOLike;
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    'assignWorkspaceToGovernanceGroup'
  >;
  postman: Pick<
    PostmanAssetsClient,
    | 'addAdminsToWorkspace'
    | 'createWorkspace'
    | 'findWorkspacesByName'
    | 'generateCollection'
    | 'getAutoDerivedTeamId'
    | 'getWorkspaceGitRepoUrl'
    | 'injectTests'
    | 'inviteRequesterToWorkspace'
    | 'tagCollection'
    | 'uploadSpec'
    | 'updateSpec'
  >;
  specFetcher: typeof fetch;
}

function normalizeInputValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function getInput(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
  return normalizeInputValue(env[envName]);
}

function requireInput(
  actionCore: Pick<CoreLike, 'getInput'>,
  name: string
): string {
  return actionCore.getInput(name, { required: true }).trim();
}

function optionalInput(
  actionCore: Pick<CoreLike, 'getInput'>,
  name: string
): string | undefined {
  return normalizeInputValue(actionCore.getInput(name));
}

function parseJsonValue<T>(
  raw: string,
  fallback: T,
  inputName: string
): T {
  try {
    return (JSON.parse(raw || JSON.stringify(fallback)) as T) ?? fallback;
  } catch (error) {
    throw new Error(
      `Invalid JSON for ${inputName}: ${error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function asStringArray(value: unknown, inputName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${inputName} must be a JSON array`);
  }
  return value.map((entry) => String(entry));
}

function asStringMap(value: unknown, inputName: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${inputName} must be a JSON object`);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      String(entry)
    ])
  );
}

export function resolveInputs(
  env: NodeJS.ProcessEnv = process.env
): ResolvedInputs {
  const integrationBackend =
    getInput('integration-backend', env) ??
    openAlphaActionContract.inputs['integration-backend'].default ??
    'bifrost';

  const allowedBackends =
    openAlphaActionContract.inputs['integration-backend'].allowedValues ?? [];
  if (allowedBackends.length > 0 && !allowedBackends.includes(integrationBackend)) {
    throw new Error(
      `Unsupported integration-backend "${integrationBackend}". Supported values: ${allowedBackends.join(', ')}`
    );
  }

  const specUrl = getInput('spec-url', env) ?? '';
  if (specUrl) {
    try {
      const parsedUrl = new URL(specUrl);
      if (parsedUrl.protocol !== 'https:') {
        throw new Error('not https');
      }
    } catch {
      throw new Error(`spec-url must be a valid HTTPS URL, got: ${specUrl}`);
    }
  }

  return {
    projectName: getInput('project-name', env) ?? '',
    workspaceId: getInput('workspace-id', env),
    specId: getInput('spec-id', env),
    baselineCollectionId: getInput('baseline-collection-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    contractCollectionId: getInput('contract-collection-id', env),
    domain: getInput('domain', env),
    domainCode: getInput('domain-code', env),
    requesterEmail: getInput('requester-email', env),
    workspaceAdminUserIds: getInput('workspace-admin-user-ids', env),
    specUrl,
    environmentsJson:
      getInput('environments-json', env) ??
      openAlphaActionContract.inputs['environments-json'].default ??
      '["prod"]',
    systemEnvMapJson:
      getInput('system-env-map-json', env) ??
      openAlphaActionContract.inputs['system-env-map-json'].default ??
      '{}',
    governanceMappingJson:
      getInput('governance-mapping-json', env) ??
      openAlphaActionContract.inputs['governance-mapping-json'].default ??
      '{}',
    postmanApiKey: getInput('postman-api-key', env) ?? '',
    postmanAccessToken: getInput('postman-access-token', env),
    githubToken: getInput('github-token', env),
    ghFallbackToken: getInput('gh-fallback-token', env),
    githubAuthMode:
      getInput('github-auth-mode', env) ??
      openAlphaActionContract.inputs['github-auth-mode'].default ??
      'github_token_first',
    integrationBackend
  };
}

export function createPlannedOutputs(inputs: ResolvedInputs): PlannedOutputs {
  const workspaceName = inputs.domainCode
    ? `[${inputs.domainCode}] ${inputs.projectName}`
    : inputs.projectName;

  return {
    'workspace-id': '',
    'workspace-url': '',
    'workspace-name': workspaceName,
    'spec-id': '',
    'baseline-collection-id': '',
    'smoke-collection-id': '',
    'contract-collection-id': '',
    'collections-json': JSON.stringify({
      baseline: '',
      smoke: '',
      contract: ''
    }),
    'spec-server-url': '',
    'lint-summary-json': JSON.stringify({
      errors: 0,
      total: 0,
      violations: [],
      warnings: 0
    })
  };
}

export function readActionInputs(
  actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>
): ResolvedInputs {
  const projectName = requireInput(actionCore, 'project-name');
  const specUrl = requireInput(actionCore, 'spec-url');
  const postmanApiKey = requireInput(actionCore, 'postman-api-key');
  const postmanAccessToken = optionalInput(actionCore, 'postman-access-token');
  const githubToken = optionalInput(actionCore, 'github-token');
  const ghFallbackToken = optionalInput(actionCore, 'gh-fallback-token');

  actionCore.setSecret(postmanApiKey);
  if (postmanAccessToken) actionCore.setSecret(postmanAccessToken);
  if (githubToken) actionCore.setSecret(githubToken);
  if (ghFallbackToken) actionCore.setSecret(ghFallbackToken);

  const inputs = resolveInputs({
    INPUT_PROJECT_NAME: projectName,
    INPUT_WORKSPACE_ID: optionalInput(actionCore, 'workspace-id'),
    INPUT_SPEC_ID: optionalInput(actionCore, 'spec-id'),
    INPUT_BASELINE_COLLECTION_ID: optionalInput(actionCore, 'baseline-collection-id'),
    INPUT_SMOKE_COLLECTION_ID: optionalInput(actionCore, 'smoke-collection-id'),
    INPUT_CONTRACT_COLLECTION_ID: optionalInput(actionCore, 'contract-collection-id'),
    INPUT_DOMAIN: optionalInput(actionCore, 'domain'),
    INPUT_DOMAIN_CODE: optionalInput(actionCore, 'domain-code'),
    INPUT_REQUESTER_EMAIL: optionalInput(actionCore, 'requester-email'),
    INPUT_WORKSPACE_ADMIN_USER_IDS: optionalInput(
      actionCore,
      'workspace-admin-user-ids'
    ),
    INPUT_SPEC_URL: specUrl,
    INPUT_ENVIRONMENTS_JSON:
      optionalInput(actionCore, 'environments-json') ??
      openAlphaActionContract.inputs['environments-json'].default,
    INPUT_SYSTEM_ENV_MAP_JSON:
      optionalInput(actionCore, 'system-env-map-json') ??
      openAlphaActionContract.inputs['system-env-map-json'].default,
    INPUT_GOVERNANCE_MAPPING_JSON:
      optionalInput(actionCore, 'governance-mapping-json') ??
      openAlphaActionContract.inputs['governance-mapping-json'].default,
    INPUT_POSTMAN_API_KEY: postmanApiKey,
    INPUT_POSTMAN_ACCESS_TOKEN: postmanAccessToken,
    INPUT_GITHUB_TOKEN: githubToken,
    INPUT_GH_FALLBACK_TOKEN: ghFallbackToken,
    INPUT_GITHUB_AUTH_MODE:
      optionalInput(actionCore, 'github-auth-mode') ??
      openAlphaActionContract.inputs['github-auth-mode'].default,
    INPUT_INTEGRATION_BACKEND:
      optionalInput(actionCore, 'integration-backend') ??
      openAlphaActionContract.inputs['integration-backend'].default
  });

  return inputs;
}

function createWorkspaceName(inputs: ResolvedInputs): string {
  return inputs.domainCode
    ? `[${inputs.domainCode}] ${inputs.projectName}`
    : inputs.projectName;
}

async function runGroup<T>(
  actionCore: Pick<CoreLike, 'group'>,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return actionCore.group(name, fn);
}

async function ensurePostmanCli(
  dependencies: Pick<BootstrapExecutionDependencies, 'exec' | 'io'>,
  postmanApiKey: string
): Promise<void> {
  const existing = await dependencies.io.which('postman', false).catch(() => '');
  if (!existing) {
    await dependencies.exec.exec('sh', [
      '-c',
      'curl -o- "https://dl-cli.pstmn.io/install/unix.sh" | sh'
    ]);
  }

  await dependencies.exec.exec('postman', ['login', '--with-api-key', postmanApiKey]);
}

export async function lintSpecViaCli(
  dependencies: Pick<BootstrapExecutionDependencies, 'exec'>,
  workspaceId: string,
  specId: string
): Promise<LintSummary> {
  const result = await dependencies.exec.getExecOutput(
    'postman',
    [
      'spec',
      'lint',
      specId,
      '--workspace-id',
      workspaceId || '',
      '--report-events',
      '-o',
      'json'
    ],
    {
      ignoreReturnCode: true
    }
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    throw new Error(`Spec lint command failed: ${result.stderr}`);
  }

  let parsed: { violations?: LintViolation[] };
  try {
    parsed = JSON.parse(result.stdout || '{}') as { violations?: LintViolation[] };
  } catch {
    throw new Error(
      `Spec lint output is not valid JSON. output: ${result.stdout}, err: ${result.stderr}`
    );
  }

  const violations = parsed.violations || [];
  const errors = violations.filter((entry) => entry.severity === 'ERROR').length;
  const warnings = violations.filter((entry) => entry.severity === 'WARNING').length;

  return {
    errors,
    violations,
    warnings
  };
}

async function fetchSpecDocument(
  specUrl: string,
  specFetcher: typeof fetch
): Promise<string> {
  return retry(
    async () => {
      const response = await specFetcher(specUrl, {
        headers: {
          'User-Agent': 'postman-bootstrap-action'
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch spec from URL: ${response.status}`);
      }

      return response.text();
    },
    {
      maxAttempts: 3,
      delayMs: 3000
    }
  );
}

async function persistBootstrapRepositoryVariables(
  github: Pick<GitHubApiClient, 'setRepositoryVariable'>,
  outputs: PlannedOutputs,
  systemEnvMap: Record<string, string>,
  environments: string[],
  lintSummary: BootstrapRepositoryVariables
): Promise<void> {
  await github.setRepositoryVariable(
    'LINT_WARNINGS',
    String(lintSummary.lintWarnings)
  );
  await github.setRepositoryVariable('LINT_ERRORS', String(lintSummary.lintErrors));
  await github.setRepositoryVariable('POSTMAN_WORKSPACE_ID', outputs['workspace-id']);
  await github.setRepositoryVariable('POSTMAN_SPEC_UID', outputs['spec-id']);
  await github.setRepositoryVariable(
    'POSTMAN_BASELINE_COLLECTION_UID',
    outputs['baseline-collection-id']
  );
  await github.setRepositoryVariable(
    'POSTMAN_SMOKE_COLLECTION_UID',
    outputs['smoke-collection-id']
  );
  await github.setRepositoryVariable(
    'POSTMAN_CONTRACT_COLLECTION_UID',
    outputs['contract-collection-id']
  );

  for (const envName of environments) {
    const systemEnvId = systemEnvMap[envName];
    if (!systemEnvId) {
      continue;
    }
    await github.setRepositoryVariable(
      `POSTMAN_SYSTEM_ENV_${envName.toUpperCase()}`,
      systemEnvId
    );
  }
}

export async function runBootstrap(
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies
): Promise<PlannedOutputs> {
  const outputs = createPlannedOutputs(inputs);
  const environments = asStringArray(
    parseJsonValue(inputs.environmentsJson, ['prod'], 'environments-json'),
    'environments-json'
  );
  const systemEnvMap = asStringMap(
    parseJsonValue(inputs.systemEnvMapJson, {}, 'system-env-map-json'),
    'system-env-map-json'
  );
  const workspaceName = createWorkspaceName(inputs);
  const aboutText = `Auto-provisioned by Postman CS open-alpha for ${inputs.projectName}`;

  await runGroup(dependencies.core, 'Install Postman CLI', async () => {
    await ensurePostmanCli(dependencies, inputs.postmanApiKey);
  });


  const explicitWorkspaceId = inputs.workspaceId;
  let repoWorkspaceId: string | undefined;
  let workspaceId = explicitWorkspaceId;
  if (!workspaceId && dependencies.github) {
    repoWorkspaceId = await dependencies.github.getRepositoryVariable('POSTMAN_WORKSPACE_ID').catch(() => undefined) || undefined;
    workspaceId = repoWorkspaceId;
  }

  let teamId = process.env.POSTMAN_TEAM_ID || '';
  if (!teamId) {
    teamId = await dependencies.postman.getAutoDerivedTeamId() || '';
  }
  const repoUrl = process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
    : '';

  if (!explicitWorkspaceId && repoUrl && inputs.postmanAccessToken && teamId) {
    const selection = await runGroup(
      dependencies.core,
      'Resolve Canonical Workspace',
      async () => resolveCanonicalWorkspaceSelection({
        postman: dependencies.postman,
        workspaceName,
        repoWorkspaceId,
        repoUrl,
        teamId,
        accessToken: inputs.postmanAccessToken!,
        warn: (msg) => dependencies.core.warning(msg),
      })
    );

    if (selection.type === 'existing') {
      workspaceId = selection.workspaceId;
      if (selection.warning) {
        dependencies.core.warning(selection.warning);
      }
      dependencies.core.info(`Using canonical workspace (${selection.source}): ${workspaceId}`);
    } else if (selection.type === 'manual_review') {
      throw new Error(`Workspace selection requires manual review: ${selection.reason}`);
    } else {
      workspaceId = undefined;
    }
  } else if (workspaceId) {
    dependencies.core.info(`Using existing workspace: ${workspaceId}`);
  }

  if (!workspaceId) {
    const workspace = await runGroup(
      dependencies.core,
      'Create Postman Workspace',
      async () => dependencies.postman.createWorkspace(workspaceName, aboutText)
    );
    workspaceId = workspace.id;
  }

  outputs['workspace-id'] = workspaceId || '';
  outputs['workspace-url'] = `https://go.postman.co/workspace/${workspaceId}`;
  outputs['workspace-name'] = workspaceName;


  if (inputs.domain && dependencies.internalIntegration) {
    await runGroup(
      dependencies.core,
      'Assign Workspace to Governance Group',
      async () => {
        try {
          await dependencies.internalIntegration?.assignWorkspaceToGovernanceGroup(
            workspaceId || '',
            inputs.domain || '',
            inputs.governanceMappingJson
          );
        } catch (error) {
          dependencies.core.warning(
            `Failed to assign governance group: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );
  }

  if (inputs.requesterEmail) {
    await runGroup(
      dependencies.core,
      'Invite Requester to Workspace',
      async () => {
        try {
          await dependencies.postman.inviteRequesterToWorkspace(
            workspaceId || '',
            inputs.requesterEmail || ''
          );
        } catch (error) {
          dependencies.core.warning(
            `Failed to invite requester: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );
  }

  const adminIds =
    inputs.workspaceAdminUserIds || process.env.WORKSPACE_ADMIN_USER_IDS || '';
  if (adminIds) {
    await runGroup(
      dependencies.core,
      'Add Team Admins to Workspace',
      async () => {
        try {
          await dependencies.postman.addAdminsToWorkspace(workspaceId || '', adminIds);
        } catch (error) {
          dependencies.core.warning(
            `Failed to add team admins: ${error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );
  }


  let specId = inputs.specId;
  if (!specId && dependencies.github) {
    specId = await dependencies.github.getRepositoryVariable('POSTMAN_SPEC_UID').catch(() => undefined) || undefined;
  }

  let baselineCollectionId = inputs.baselineCollectionId;
  let smokeCollectionId = inputs.smokeCollectionId;
  let contractCollectionId = inputs.contractCollectionId;

  if (dependencies.github) {
    if (!baselineCollectionId) {
      baselineCollectionId =
        (await dependencies.github
          .getRepositoryVariable('POSTMAN_BASELINE_COLLECTION_UID')
          .catch(() => undefined)) || undefined;
    }
    if (!smokeCollectionId) {
      smokeCollectionId =
        (await dependencies.github
          .getRepositoryVariable('POSTMAN_SMOKE_COLLECTION_UID')
          .catch(() => undefined)) || undefined;
    }
    if (!contractCollectionId) {
      contractCollectionId =
        (await dependencies.github
          .getRepositoryVariable('POSTMAN_CONTRACT_COLLECTION_UID')
          .catch(() => undefined)) || undefined;
    }
  }

  const specContent = await runGroup(
    dependencies.core,
    specId ? 'Update Spec in Spec Hub' : 'Upload Spec to Spec Hub',
    async () => {
      const document = await fetchSpecDocument(inputs.specUrl, dependencies.specFetcher);
      if (specId) {
        await dependencies.postman.updateSpec(specId, document, workspaceId);
      } else {
        specId = await dependencies.postman.uploadSpec(
          workspaceId || '',
          inputs.projectName,
          document
        );
      }
      outputs['spec-id'] = specId;
      return document;
    }
  );

  try {
    const spec = (specContent.trim().startsWith('{') ? JSON.parse(specContent) : parseYaml(specContent)) as Record<string, unknown>;
    const servers = Array.isArray(spec.servers) ? spec.servers : [];
    const firstUrl = String((servers[0] as Record<string, unknown>)?.url || '').trim();
    if (firstUrl) {
      outputs['spec-server-url'] = firstUrl;
      dependencies.core.info(`Inferred server URL from spec: ${firstUrl}`);
    }
  } catch {
    dependencies.core.warning('Could not parse servers from OpenAPI spec');
  }

  const lintSummary = await runGroup(
    dependencies.core,
    'Lint Spec via Postman CLI',
    async () => lintSpecViaCli(dependencies, workspaceId || '', outputs['spec-id'])
  );
  outputs['lint-summary-json'] = JSON.stringify({
    errors: lintSummary.errors,
    total: lintSummary.violations.length,
    violations: lintSummary.violations,
    warnings: lintSummary.warnings
  });

  if (lintSummary.errors > 0) {
    lintSummary.violations
      .filter((entry) => entry.severity === 'ERROR')
      .forEach((entry) => {
        dependencies.core.error(`  ${entry.path || '<unknown>'}: ${entry.issue || 'Unknown lint error'}`);
      });
    throw new Error(`Spec lint found ${lintSummary.errors} errors`);
  }

  lintSummary.violations
    .filter((entry) => entry.severity === 'WARNING')
    .forEach((entry) => {
      dependencies.core.warning(
        `  ${entry.path || '<unknown>'}: ${entry.issue || 'Unknown lint warning'}`
      );
    });

  await runGroup(
    dependencies.core,
    'Generate Collections from Spec',
    async () => {
      outputs['baseline-collection-id'] = baselineCollectionId || '';
      outputs['smoke-collection-id'] = smokeCollectionId || '';
      outputs['contract-collection-id'] = contractCollectionId || '';

      if (!outputs['baseline-collection-id']) {
        outputs['baseline-collection-id'] = await dependencies.postman.generateCollection(
          outputs['spec-id'],
          inputs.projectName,
          '[Baseline]'
        );
      } else {
        dependencies.core.info(
          `Using existing baseline collection: ${outputs['baseline-collection-id']}`
        );
      }

      if (!outputs['smoke-collection-id']) {
        outputs['smoke-collection-id'] = await dependencies.postman.generateCollection(
          outputs['spec-id'],
          inputs.projectName,
          '[Smoke]'
        );
      } else {
        dependencies.core.info(
          `Using existing smoke collection: ${outputs['smoke-collection-id']}`
        );
      }

      if (!outputs['contract-collection-id']) {
        outputs['contract-collection-id'] = await dependencies.postman.generateCollection(
          outputs['spec-id'],
          inputs.projectName,
          '[Contract]'
        );
      } else {
        dependencies.core.info(
          `Using existing contract collection: ${outputs['contract-collection-id']}`
        );
      }
    }
  );

  outputs['collections-json'] = JSON.stringify({
    baseline: outputs['baseline-collection-id'],
    contract: outputs['contract-collection-id'],
    smoke: outputs['smoke-collection-id']
  });

  await runGroup(
    dependencies.core,
    'Inject Test Scripts',
    async () => {
      await Promise.all([
        dependencies.postman.injectTests(outputs['smoke-collection-id'], 'smoke'),
        dependencies.postman.injectTests(
          outputs['contract-collection-id'],
          'contract'
        )
      ]);
    }
  );

  await runGroup(
    dependencies.core,
    'Tag Collections',
    async () => {
      await Promise.all([
        dependencies.postman.tagCollection(outputs['baseline-collection-id'], [
          'generated-docs'
        ]),
        dependencies.postman.tagCollection(outputs['smoke-collection-id'], [
          'generated-smoke'
        ]),
        dependencies.postman.tagCollection(outputs['contract-collection-id'], [
          'generated-contract'
        ])
      ]);
    }
  );

  if (dependencies.github) {
    await runGroup(
      dependencies.core,
      'Store Postman UIDs as Repo Variables',
      async () => {
        await persistBootstrapRepositoryVariables(
          dependencies.github as Pick<GitHubApiClient, 'setRepositoryVariable'>,
          outputs,
          systemEnvMap,
          environments,
          {
            lintErrors: lintSummary.errors,
            lintWarnings: lintSummary.warnings
          }
        );
      }
    );
  }

  for (const [name, value] of Object.entries(outputs)) {
    dependencies.core.setOutput(name, value);
  }

  return outputs;
}

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: ExecLike = exec,
  actionIo: IOLike = io
): Promise<PlannedOutputs> {
  const inputs = readActionInputs(actionCore);
  const secretMasker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.githubToken,
    inputs.ghFallbackToken
  ]);
  const postman = new PostmanAssetsClient({
    apiKey: inputs.postmanApiKey,
    secretMasker
  });
  const github =
    inputs.githubToken && process.env.GITHUB_REPOSITORY
      ? new GitHubApiClient({
        authMode: inputs.githubAuthMode as GitHubApiClientAuthMode,
        fallbackToken: inputs.ghFallbackToken,
        repository: process.env.GITHUB_REPOSITORY,
        secretMasker,
        token: inputs.githubToken
      })
      : undefined;
  const internalIntegration =
    inputs.postmanAccessToken
      ? createInternalIntegrationAdapter({
        accessToken: inputs.postmanAccessToken,
        backend: inputs.integrationBackend,
        secretMasker,
        teamId: process.env.POSTMAN_TEAM_ID || ''
      })
      : undefined;

  if (!github) {
    actionCore.info('GitHub repository variable persistence disabled for this run');
  }
  if (inputs.domain && !internalIntegration) {
    actionCore.warning(
      'Skipping governance assignment because postman-access-token is not configured'
    );
  }

  return runBootstrap(inputs, {
    core: actionCore,
    exec: actionExec,
    github,
    io: actionIo,
    internalIntegration,
    postman,
    specFetcher: fetch
  });
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runAction().catch((error) => {
    if (error instanceof Error) {
      core.setFailed(error.message);
      return;
    }
    core.setFailed(String(error));
  });
}
