import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parse, stringify } from 'yaml';

import { bootstrapActionContract } from './contracts.js';
import { GitHubApiClient } from './lib/github/github-api-client.js';
import { HttpError } from './lib/http-error.js';
import {
  createBreakingChangeSummaryJson,
  runOpenApiBreakingChangeCheck,
  type BreakingChangeMode,
  type OpenApiBreakingChangeCheckRunner
} from './lib/openapi-changes.js';
import {
  findCloudResourceId,
  loadAdditionalCollectionFiles,
  readResourcesState,
  syncAdditionalCollections,
  writeResourcesState,
  type PostmanResourcesState
} from './lib/postman/additional-collections.js';
import {
  parsePostmanRegion,
  parsePostmanStack,
  resolvePostmanEndpointProfile,
  type PostmanRegion,
  type PostmanStack
} from './lib/postman/base-urls.js';
import {
  getMemoizedSessionIdentity,
  runCredentialPreflight,
  type PreflightMode
} from './lib/postman/credential-identity.js';
import { isAmbiguousTransportError } from './lib/postman/create-reconciliation.js';
import { adviseFromHttpError } from './lib/postman/error-advice.js';
import { createInternalIntegrationAdapter, type InternalIntegrationAdapter } from './lib/postman/internal-integration-adapter.js';
import { classifySafeFetchRetryability } from './lib/spec/safe-spec-fetch.js';
import { safeFetchText } from './lib/spec/safe-spec-fetch.js';
import { PostmanExtensibleCollectionClient } from './lib/postman/postman-ec-client.js';
import { PostmanGatewayAssetsClient } from './lib/postman/postman-gateway-assets-client.js';
import { AccessTokenGatewayClient } from './lib/postman/gateway-client.js';
import { AccessTokenProvider, mintAccessTokenIfNeeded } from './lib/postman/token-provider.js';
import {
  definitionBundleToSnapshot,
  MULTI_FILE_SPEC_SYNC_DEFAULT,
  type SpecBundleMutationOutcome,
  type SpecBundleSnapshot
} from './lib/postman/spec-file-reconcile.js';
import { resolveCanonicalWorkspaceSelection } from './lib/postman/workspace-selection.js';
import { detectRepoContext } from './lib/repo/context.js';
import {
  finalizeLocalOpenApiArtifactManifest,
  deriveArtifactSafeCollectionName,
  materializeLocalCollectionArtifacts,
  persistLocalOpenApiArtifactManifest,
  type FinalizedLocalOpenApiArtifactManifest,
  type MaterializeLocalCollectionArtifactsResult
} from './lib/repo/local-collection-artifacts.js';
import { retry } from './lib/retry.js';
import { createSecretMasker, createMutableSecretMasker, type SecretMasker } from './lib/secrets.js';
import { createTelemetryContext, type TelemetryContext } from '@postman-cse/automation-telemetry-core';
import { resolveActionVersion } from './action-version.js';
import { buildContractIndex, type ContractIndex } from './lib/spec/contract-index.js';
import { acquireDefinitionBundle } from './lib/spec/acquire-definition-bundle.js';
import {
  createDefinitionBundle,
  createDefinitionFile,
  isOpenApiDefinitionFormat,
  type DefinitionBundle,
  type DefinitionFormat
} from './lib/spec/definition-bundle.js';
import {
  buildLocalOpenApiConversionOptions,
  generateLocalOpenApiRolePayloads,
  type CollectionRole,
  type LocalOpenApiRolePayloads
} from './lib/spec/local-openapi-collection-generation.js';
import { loadOpenApiContractSpec, loadOpenApiContractSpecFromPath, normalizeSpecTypeFromContent, parseOpenApiDocument } from './lib/spec/openapi-loader.js';
import { detectSpecType, type SpecType } from './lib/spec/detect-spec-type.js';
import {
  BRANCH_DECISION_ENV,
  channelAssetName,
  parseChannelRules,
  previewAssetName,
  renderAssetMarker,
  resolveBranchIdentity,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
  type BranchDecision,
  type BranchStrategy
} from './lib/repo/branch-decision.js';
import { buildProtocolCollection, type ProtocolCollectionResult } from './lib/protocols/dispatch.js';

export interface ResolvedInputs {
  projectName: string;
  workspaceId?: string;
  specId?: string;
  baselineCollectionId?: string;
  smokeCollectionId?: string;
  contractCollectionId?: string;
  additionalCollectionsDir?: string;
  syncExamples: boolean;
  collectionSyncMode: 'refresh' | 'version';
  specSyncMode: 'update' | 'version';
  releaseLabel?: string;
  domain?: string;
  domainCode?: string;
  governanceGroup?: string;
  requesterEmail?: string;
  workspaceAdminUserIds?: string;
  workspaceTeamId?: string;
  teamId?: string;
  repoUrl?: string;
  repoSlug?: string;
  specUrl: string;
  specPath?: string;
  /** Raw optional discovery inventory JSON; parsed by definition acquisition (Wave 3). */
  specFilesJson?: string;
  protocol: 'auto' | 'openapi' | 'graphql' | 'grpc' | 'soap' | 'asyncapi';
  protocolEndpointUrl?: string;
  openapiVersion: string;
  preserveOas30TypeNull?: boolean;
  breakingChangeMode: BreakingChangeMode;
  breakingBaselineSpecPath?: string;
  breakingRulesPath?: string;
  breakingTargetRef?: string;
  breakingSummaryPath?: string;
  breakingLogPath?: string;
  governanceMappingJson: string;
  postmanApiKey?: string;
  postmanAccessToken?: string;
  credentialPreflight: PreflightMode;
  integrationBackend: string;
  folderStrategy: string;
  nestedFolderHierarchy: boolean;
  requestNameSource: string;
  postmanRegion: PostmanRegion;
  postmanStack: PostmanStack;
  postmanApiBase?: string;
  postmanBifrostBase: string;
  postmanFallbackBase: string;
  postmanGatewayBase: string;
  postmanIapubBase: string;
  githubRefName?: string;
  githubHeadRef?: string;
  githubRef?: string;
  githubSha?: string;
  githubToken?: string;
  ghFallbackToken?: string;
  branchStrategy: BranchStrategy;
  canonicalBranch?: string;
  channels?: string;
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
  'lint-summary-json': string;
  'breaking-change-status': string;
  'breaking-change-summary-json': string;
  'sync-status': string;
  'branch-decision': string;
  'spec-version-tag': string;
  'spec-version-url': string;
  'spec-content-changed'?: string;
  'prebuilt-collections-json'?: string;
  'openapi-operation-ledger-json'?: string;
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
  io: IOLike;
  internalIntegration?: Pick<
    InternalIntegrationAdapter,
    | 'assignWorkspaceToGovernanceGroup'
    | 'linkCollectionsToSpecification'
    | 'syncCollection'
  > &
    Partial<
      Pick<
        InternalIntegrationAdapter,
        | 'configureTeamContext'
        | 'findWorkspaceForRepo'
        | 'listSpecificationCollectionRelations'
        | 'settleSpecificationCollectionRelations'
      >
    >;
  github?: Pick<GitHubApiClient, 'getRepositoryCustomProperty'>;
  postman: Pick<
    PostmanGatewayAssetsClient,
    | 'addAdminsToWorkspace'
    | 'createWorkspace'
    | 'findWorkspacesByName'
    | 'generateCollection'
    | 'getSpecContent'
    | 'getTeams'
    | 'getWorkspaceGitRepoUrl'
    | 'getWorkspaceVisibility'
    | 'inviteRequesterToWorkspace'
    | 'uploadSpec'
    | 'updateSpec'
  > & {
    configureTeamContext?(teamId: string, orgMode: boolean): void;
    injectTests(collectionId: string, type: 'smoke'): Promise<void>;
    tagCollection(collectionId: string, tags: string[]): Promise<void>;
    tagSpecVersion?(specId: string, name: string): Promise<{ id: string; name: string }>;
    listSpecVersionTags?(specId: string): Promise<Array<{ id: string; name: string }>>;
    deleteCollection?(collectionUid: string): Promise<void>;
    deleteSpec?(specId: string): Promise<void>;
    getSpecBundle?(specId: string, format: DefinitionFormat): Promise<DefinitionBundle>;
    reconcileSpecBundle?(
      specId: string,
      target: DefinitionBundle
    ): Promise<SpecBundleMutationOutcome>;
    restoreSpecBundle?(
      specId: string,
      snapshot: SpecBundleSnapshot
    ): Promise<SpecBundleMutationOutcome>;
    uploadSpecBundle?(
      workspaceId: string,
      projectName: string,
      bundle: DefinitionBundle,
      openapiVersion?: '3.0' | '3.1' | string
    ): Promise<{
      specId: string;
      created: boolean;
      priorSnapshot: SpecBundleSnapshot | null;
      outcome: SpecBundleMutationOutcome;
    }>;
    uploadSpecWithOutcome?(
      workspaceId: string,
      projectName: string,
      specContent: string,
      openapiVersion?: '3.0' | '3.1' | string
    ): Promise<{ specId: string; created: boolean }>;
    patchCollectionScripts?(collectionUid: string, scripts: unknown): Promise<void>;
    patchItemScripts?(collectionUid: string, itemId: string, scripts: unknown): Promise<void>;
    injectContractTests?(collectionUid: string, index: ContractIndex): Promise<string[]>;
    adoptGeneratedCollection?(
      specId: string,
      projectName: string,
      prefix: string,
      preferredId?: string
    ): Promise<string>;
    waitForGeneratedCollectionLinks?(specId: string, collectionIds: string[]): Promise<void>;
    createCollection?(
      workspaceId: string,
      collection: unknown,
      options?: { onRootCreated?: (id: string) => void | Promise<void> }
    ): Promise<string>;
    createRunOwnedCollection?(
      workspaceId: string,
      collection: unknown,
      finalName: string
    ): Promise<{
      collectionId: string;
      journaledRootIds: string[];
    }>;
    updateCollection?(collectionUid: string, collection: unknown): Promise<void>;
    updateCollectionDescription?(collectionUid: string, description: string): Promise<void>;
    importV2Collection?(
      workspaceId: string,
      collection: unknown,
      finalName: string
    ): Promise<{
      collectionId: string;
      journaledRootIds: string[];
      deleteVerifiedCleanup?: (ids?: string[]) => Promise<void>;
    }>;
    deepUpdateV2Collection?(
      collectionUid: string,
      collection: unknown,
      expectedPayloadDigest: string
    ): Promise<string>;
    deleteVerifiedRunOwnedCollections?(collectionIds: string[]): Promise<void>;
  };
  ecClient?: Pick<
    PostmanExtensibleCollectionClient,
    | 'createExtensibleCollection'
    | 'populateFromTree'
    | 'getExtensibleCollection'
    | 'deleteExtensibleCollection'
    | 'listExtensibleCollectionItems'
    | 'configureTeamContext'
  >;
  openApiChanges?: OpenApiBreakingChangeCheckRunner;
  resourcesState?: {
    read(): PostmanResourcesState | null;
    write(state: PostmanResourcesState): void;
  };
  specFetcher: typeof fetch;
}

export type LocalOpenApiOperationCounts = {
  localConversion: number;
  wholeCollectionImport: number;
  deepUpdate: number;
  specHubCollectionGeneration: number;
  specHubCollectionSync: number;
  temporaryOpenApiSpecCreate: number;
  temporaryOpenApiSpecDelete: number;
  v3PerItemCollectionCreate: number;
  postCreateScriptPatch: number;
  retries: number;
};

const LOCAL_OPENAPI_OBSERVED_METHODS: Readonly<Record<string, keyof LocalOpenApiOperationCounts>> = {
  importV2Collection: 'wholeCollectionImport',
  deepUpdateV2Collection: 'deepUpdate',
  generateCollection: 'specHubCollectionGeneration',
  syncCollection: 'specHubCollectionSync',
  uploadSpec: 'temporaryOpenApiSpecCreate',
  uploadSpecWithOutcome: 'temporaryOpenApiSpecCreate',
  uploadSpecBundle: 'temporaryOpenApiSpecCreate',
  deleteSpec: 'temporaryOpenApiSpecDelete',
  createCollection: 'v3PerItemCollectionCreate',
  createRunOwnedCollection: 'v3PerItemCollectionCreate',
  injectTests: 'postCreateScriptPatch',
  injectContractTests: 'postCreateScriptPatch',
  patchCollectionScripts: 'postCreateScriptPatch',
  patchItemScripts: 'postCreateScriptPatch'
};

/** Observe local-OpenAPI dependency calls at invocation time, including throws. */
export function observeLocalOpenApiOperations<T extends object>(
  dependency: T,
  counts: LocalOpenApiOperationCounts
): T {
  return new Proxy(dependency, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      const counter = LOCAL_OPENAPI_OBSERVED_METHODS[property];
      return function observed(this: unknown, ...args: unknown[]) {
        if (counter) counts[counter] += 1;
        return Reflect.apply(value, target, args);
      };
    }
  });
}

function resolveResourcesStateStore(dependencies: BootstrapExecutionDependencies) {
  return dependencies.resourcesState ?? {
    read: readResourcesState,
    write: (): void => undefined
  };
}

const GOVERNANCE_GROUP_PROPERTY_NAME = 'postman-governance-group';

/**
 * Convert an unknown caught value, CLI stdout/stderr, or a COMPLETE final
 * operator message (entity fields + cause + remediation) to a single-line,
 * secret-masked string. Normalizes CR, LF, U+2028, and U+2029 to a single
 * space so input-derived fields cannot introduce log-injection separators.
 * No dependency beyond the local masker.
 */
function formatMaskedOneLine(value: unknown, masker?: SecretMasker): string {
  const text = value instanceof Error ? value.message : String(value ?? '');
  const masked = masker ? masker(text) : text;
  return masked.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

function createBootstrapSecretMasker(
  inputs: Pick<
    ResolvedInputs,
    'postmanApiKey' | 'postmanAccessToken' | 'githubToken' | 'ghFallbackToken'
  >
): SecretMasker {
  return createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken,
    inputs.githubToken,
    inputs.ghFallbackToken
  ]);
}

export interface BootstrapDependencyFactories {
  core: Pick<CoreLike, 'error' | 'group' | 'info' | 'setOutput' | 'warning'>;
  exec: ExecLike;
  io: IOLike;
  specFetcher?: typeof fetch;
  /**
   * Registers a re-minted access token with the Actions log scrubber. Wired from
   * `actionCore.setSecret` in runAction so refreshed tokens are masked in logs;
   * defaults to a no-op for the CLI path (which has no GitHub log scrubber).
   */
  setSecret?: (secret: string) => void;
}

function reportRetry(
  core: Pick<CoreLike, 'info'>,
  event: import('./lib/postman/gateway-client.js').RetryEvent
): void {
  core.info(
    `[postman retry] action=bootstrap class=${event.class} status=${event.status ?? 'none'} attempt=${event.attempt} delayMs=${event.delay}`
  );
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

function parseBooleanInput(name: string, value: string | undefined, defaultValue: boolean): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean value: true or false`);
}

function parseCollectionSyncMode(
  value: string | undefined
): 'refresh' | 'version' {
  const v = value?.trim() || bootstrapActionContract.inputs['collection-sync-mode'].default || 'refresh';
  if (v === 'reuse') {
    return 'refresh';
  }
  const allowed = bootstrapActionContract.inputs['collection-sync-mode'].allowedValues ?? [];
  if (allowed.includes(v)) {
    return v as 'refresh' | 'version';
  }
  throw new Error(`Unsupported collection-sync-mode "${v}". Supported values: ${allowed.join(', ')}`);
}

function parseSpecSyncMode(value: string | undefined): 'update' | 'version' {
  const v = value?.trim() || bootstrapActionContract.inputs['spec-sync-mode'].default || 'update';
  const allowed = bootstrapActionContract.inputs['spec-sync-mode'].allowedValues ?? [];
  if (allowed.includes(v)) {
    return v as 'update' | 'version';
  }
  throw new Error(`Unsupported spec-sync-mode "${v}". Supported values: ${allowed.join(', ')}`);
}

function parseBreakingChangeMode(value: string | undefined): BreakingChangeMode {
  return parseEnumInput(
    'breaking-change-mode',
    value,
    (bootstrapActionContract.inputs['breaking-change-mode'].default ?? 'off') as BreakingChangeMode
  );
}

function parseEnumInput<T extends string>(name: string, value: string | undefined, defaultValue: T): T {
  const allowed = bootstrapActionContract.inputs[name].allowedValues ?? [];
  const v = value?.trim() || defaultValue;
  if (allowed.includes(v)) {
    return v as T;
  }
  throw new Error(`Unsupported ${name} "${v}". Supported values: ${allowed.join(', ')}`);
}

function parseWorkspaceTeamId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`workspace-team-id must be a numeric sub-team ID, got: ${value}`);
  }
  return value;
}

function parseGovernanceMappingJson(value: string | undefined): string {
  const mapping = value ?? bootstrapActionContract.inputs['governance-mapping-json'].default ?? '{}';
  try {
    const parsed = JSON.parse(mapping) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return mapping;
  } catch (error) {
    throw new Error('governance-mapping-json must be valid JSON object content', { cause: error });
  }
}

function resolveOpenapiVersion(value: string | undefined): string {
  const allowed = bootstrapActionContract.inputs['openapi-version'].allowedValues ?? [];
  const v = value?.trim() ?? '';
  if (allowed.length > 0 && v && !allowed.includes(v)) {
    throw new Error(
      `Unsupported openapi-version "${v}". Supported values: ${allowed.join(', ')}`
    );
  }
  // Empty string is intentional — signals auto-detect from spec content at runtime.
  return v;
}

function sanitizeUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid OpenAPI URL]';
  }
}

export function resolveInputs(
  env: NodeJS.ProcessEnv = process.env
): ResolvedInputs {
  const repoContext = detectRepoContext(
    {
      repoUrl: getInput('repo-url', env)
    },
    env
  );

  const integrationBackend =
    getInput('integration-backend', env) ??
    bootstrapActionContract.inputs['integration-backend'].default ??
    'bifrost';

  const allowedBackends =
    bootstrapActionContract.inputs['integration-backend'].allowedValues ?? [];
  if (allowedBackends.length > 0 && !allowedBackends.includes(integrationBackend)) {
    throw new Error(
      `Unsupported integration-backend "${integrationBackend}". Supported values: ${allowedBackends.join(', ')}`
    );
  }

  const specUrl = getInput('spec-url', env) ?? '';
  const specPath = getInput('spec-path', env) ?? '';
  const specFilesJson = getInput('spec-files-json', env) ?? '';
  if (specUrl && specPath) {
    throw new Error('Provide either spec-url or spec-path, not both.');
  }
  if (specFilesJson && specUrl) {
    throw new Error(
      'CONTRACT_DEFINITION_INVENTORY_WITH_URL: spec-files-json cannot be combined with spec-url'
    );
  }
  if (specUrl) {
    try {
      const parsedUrl = new URL(specUrl);
      if (parsedUrl.protocol !== 'https:') {
        throw new Error('not https');
      }
    } catch (error) {
      throw new Error(`spec-url must be a valid HTTPS URL, got: ${sanitizeUrlForLog(specUrl)}`, { cause: error });
    }
  }

  const postmanRegion = parsePostmanRegion(getInput('postman-region', env));
  const postmanStack = parsePostmanStack(getInput('postman-stack', env));
  const endpointProfile = resolvePostmanEndpointProfile(postmanStack, postmanRegion);

  return {
    projectName: getInput('project-name', env)
      ?? env.GITHUB_REPOSITORY?.split('/').pop()
      ?? env.CI_PROJECT_NAME
      ?? '',
    workspaceId: getInput('workspace-id', env),
    specId: getInput('spec-id', env),
    baselineCollectionId: getInput('baseline-collection-id', env),
    smokeCollectionId: getInput('smoke-collection-id', env),
    contractCollectionId: getInput('contract-collection-id', env),
    additionalCollectionsDir: getInput('additional-collections-dir', env),
    syncExamples: parseBooleanInput('sync-examples', getInput('sync-examples', env), true),
    collectionSyncMode: parseCollectionSyncMode(getInput('collection-sync-mode', env)),
    specSyncMode: parseSpecSyncMode(getInput('spec-sync-mode', env)),
    releaseLabel: getInput('release-label', env),
    domain: getInput('domain', env),
    domainCode: getInput('domain-code', env),
    governanceGroup: getInput('governance-group', env),
    requesterEmail: getInput('requester-email', env),
    workspaceAdminUserIds:
      getInput('workspace-admin-user-ids', env) || env.WORKSPACE_ADMIN_USER_IDS || '',
    workspaceTeamId: parseWorkspaceTeamId(getInput('workspace-team-id', env) || env.POSTMAN_WORKSPACE_TEAM_ID),
    teamId: getInput('team-id', env) || env.POSTMAN_TEAM_ID || '',
    repoUrl: repoContext.repoUrl || '',
    repoSlug: repoContext.repoSlug || '',
    specUrl,
    specPath,
    specFilesJson,
    protocol: parseEnumInput<'auto' | 'openapi' | 'graphql' | 'grpc' | 'soap' | 'asyncapi'>(
      'protocol',
      getInput('protocol', env),
      'auto'
    ),
    protocolEndpointUrl: getInput('protocol-endpoint-url', env),
    openapiVersion: resolveOpenapiVersion(getInput('openapi-version', env)),
    preserveOas30TypeNull: parseBooleanInput(
      'preserve-oas30-type-null',
      getInput('preserve-oas30-type-null', env),
      false
    ),
    breakingChangeMode: parseBreakingChangeMode(getInput('breaking-change-mode', env)),
    breakingBaselineSpecPath: getInput('breaking-baseline-spec-path', env),
    breakingRulesPath:
      getInput('breaking-rules-path', env) ??
      bootstrapActionContract.inputs['breaking-rules-path'].default,
    breakingTargetRef: getInput('breaking-target-ref', env),
    breakingSummaryPath: getInput('breaking-summary-path', env),
    breakingLogPath: getInput('breaking-log-path', env),
    governanceMappingJson: parseGovernanceMappingJson(getInput('governance-mapping-json', env)),
    postmanApiKey: getInput('postman-api-key', env) || env.POSTMAN_API_KEY || '',
    postmanAccessToken: getInput('postman-access-token', env) || env.POSTMAN_ACCESS_TOKEN,
    credentialPreflight: parseEnumInput<PreflightMode>(
      'credential-preflight',
      getInput('credential-preflight', env),
      (bootstrapActionContract.inputs['credential-preflight'].default ?? 'warn') as PreflightMode
    ),
    integrationBackend,
    folderStrategy:
      parseEnumInput('folder-strategy', getInput('folder-strategy', env), 'Paths'),
    nestedFolderHierarchy: parseBooleanInput('nested-folder-hierarchy', getInput('nested-folder-hierarchy', env), false),
    requestNameSource:
      parseEnumInput('request-name-source', getInput('request-name-source', env), 'Fallback'),
    postmanRegion,
    postmanStack,
    postmanApiBase: endpointProfile.apiBaseUrl,
    postmanBifrostBase: endpointProfile.bifrostBaseUrl,
    postmanFallbackBase: endpointProfile.fallbackBaseUrl,
    postmanGatewayBase: endpointProfile.gatewayBaseUrl,
    postmanIapubBase: endpointProfile.iapubBaseUrl,
    githubRefName: env.GITHUB_REF_NAME,
    githubHeadRef: env.GITHUB_HEAD_REF,
    githubRef: env.GITHUB_REF,
    githubSha: env.GITHUB_SHA,
    githubToken: getInput('github-token', env) || env.GITHUB_TOKEN || '',
    ghFallbackToken: getInput('gh-fallback-token', env) || env.GH_FALLBACK_TOKEN || '',
    branchStrategy: parseEnumInput<BranchStrategy>(
      'branch-strategy',
      getInput('branch-strategy', env),
      'legacy'
    ),
    canonicalBranch: getInput('canonical-branch', env),
    channels: getInput('channels', env)
  };
}

/**
 * Resolve the run's immutable BranchDecision BEFORE any credential is
 * validated or minted (decide step of decide -> execute -> finalize). An
 * inherited POSTMAN_BRANCH_DECISION env decision wins so one decision spans
 * bootstrap, repo-sync, smoke-flow, and insights within a single run.
 */
export function decideBranchTier(
  inputs: Pick<ResolvedInputs, 'branchStrategy' | 'canonicalBranch' | 'channels'>,
  env: NodeJS.ProcessEnv = process.env
): BranchDecision {
  return resolveEffectiveBranchDecision(
    {
      // Tolerate hand-built inputs objects (tests, embedders) that omit the
      // field: absent means legacy, exactly like the action default.
      strategy: inputs.branchStrategy ?? 'legacy',
      identity: resolveBranchIdentity(env, { defaultBranch: inputs.canonicalBranch }),
      canonicalBranch: inputs.canonicalBranch,
      channels: parseChannelRules(inputs.channels)
    },
    env
  );
}

/**
 * Tagged read-only Spec Hub view URL (R20): deep-links the exact published
 * version in CI logs / PR comments via the app's ?tagId=&versionLabel= params.
 */
export function buildSpecVersionUrl(
  workspaceId: string,
  specId: string,
  tagId: string,
  versionLabel: string
): string {
  return (
    'https://go.postman.co/workspace/' + workspaceId +
    '/specification/' + specId +
    '?tagId=' + encodeURIComponent(tagId) +
    '&versionLabel=' + encodeURIComponent(versionLabel)
  );
}

/**
 * Specs retain their branch identity even if a user edits the description. This
 * extension is deliberately applied only to disposable preview/channel copies;
 * canonical source content remains byte-for-byte customer authored.
 */
export function embedSpecBranchMarker(
  content: string,
  decision: BranchDecision,
  repo: string | undefined
): string {
  if ((decision.tier !== 'preview' && decision.tier !== 'channel') || !decision.identity.headBranch || !repo) {
    return content;
  }
  const rawBranch = decision.identity.headBranch;
  const now = new Date().toISOString();
  const marker = {
    repo,
    rawBranch,
    sanitizedBranch: rawBranch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 30),
    role: decision.tier,
    headSha: decision.identity.headSha,
    createdAt: now,
    lastSyncedAt: now
  };
  try {
    if (content.trim().startsWith('{')) {
      return `${JSON.stringify({ ...(JSON.parse(content) as Record<string, unknown>), 'x-postman-onboarding': marker }, null, 2)}\n`;
    }
    const document = parse(content);
    if (!document || typeof document !== 'object' || Array.isArray(document)) return content;
    return stringify({ ...(document as Record<string, unknown>), 'x-postman-onboarding': marker });
  } catch {
    // The contract parser already validated the document. Preserve content if a
    // future format cannot round-trip through YAML instead of risking mutation.
    return content;
  }
}

/** Durable description marker for preview/channel collection roots. */
export function renderCollectionBranchMarker(
  decision: BranchDecision,
  repo: string | undefined,
  now = new Date()
): string | undefined {
  if ((decision.tier !== 'preview' && decision.tier !== 'channel') || !decision.identity.headBranch || !repo) {
    return undefined;
  }
  const rawBranch = decision.identity.headBranch;
  const timestamp = now.toISOString();
  return renderAssetMarker({
    repo,
    rawBranch,
    sanitizedBranch: rawBranch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').slice(0, 30),
    role: decision.tier,
    headSha: decision.identity.headSha,
    createdAt: timestamp,
    lastSyncedAt: timestamp
  });
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
    'lint-summary-json': JSON.stringify({
      errors: 0,
      total: 0,
      violations: [],
      warnings: 0
    }),
    'breaking-change-status': 'skipped',
    'breaking-change-summary-json': JSON.stringify({
      breakingChanges: 0,
      comparison: '',
      exitCode: 0,
      logPath: '',
      message: 'Breaking-change check is disabled.',
      mode: inputs.breakingChangeMode,
      status: 'skipped',
      summaryPath: ''
    }),
    'sync-status': '',
    'branch-decision': '',
    'spec-version-tag': '',
    'spec-version-url': '',
    'spec-content-changed': 'false',
    'prebuilt-collections-json': '',
    'openapi-operation-ledger-json': ''
  };
}

function warnIfDeprecatedAccessToken(
  actionCore: Pick<CoreLike, 'warning'>,
  inputs: Pick<ResolvedInputs, 'postmanAccessToken'>
): void {
  if (!inputs.postmanAccessToken) {
    return;
  }
  const sessionIdentity = getMemoizedSessionIdentity();
  const consumerType = sessionIdentity?.consumerType?.trim();
  if (!consumerType || consumerType.toLowerCase() === 'service_account') {
    return;
  }
  const mask = createSecretMasker([inputs.postmanAccessToken]);
  actionCore.warning(
    mask(
      'postman: deprecation warning - postman-access-token resolved to consumerType ' +
        consumerType +
        '. postman-cs/postman-resolve-service-token-action is the primary CI path for service-account access tokens. ' +
        'The Postman CLI credential store populated by `postman login` is a legacy fallback for migration only.'
    )
  );
}

function isLegacyAccessTokenDeprecationWarning(message: string): boolean {
  return message.includes('Postman CLI credential store populated by `postman login` is a legacy fallback');
}

export function readActionInputs(
  actionCore: Pick<CoreLike, 'getInput' | 'setSecret'>
): ResolvedInputs {
  const projectName = requireInput(actionCore, 'project-name');
  const specUrl = optionalInput(actionCore, 'spec-url') ?? '';
  const specPath = optionalInput(actionCore, 'spec-path') ?? '';
  if (!specUrl && !specPath) {
    throw new Error('One of spec-url or spec-path is required');
  }
  if (specUrl && specPath) {
    throw new Error('Provide either spec-url or spec-path, not both.');
  }
  // Credentials are validated only after BranchDecision resolution in runAction:
  // gated runs intentionally perform credential-free static validation.
  const postmanApiKey =
    optionalInput(actionCore, 'postman-api-key') || process.env.POSTMAN_API_KEY || '';
  const postmanAccessToken =
    optionalInput(actionCore, 'postman-access-token') || process.env.POSTMAN_ACCESS_TOKEN;
  const githubToken = optionalInput(actionCore, 'github-token') || process.env.GITHUB_TOKEN;
  const ghFallbackToken = optionalInput(actionCore, 'gh-fallback-token') || process.env.GH_FALLBACK_TOKEN;

  if (postmanApiKey) actionCore.setSecret(postmanApiKey);
  if (postmanAccessToken) actionCore.setSecret(postmanAccessToken);
  if (githubToken) actionCore.setSecret(githubToken);
  if (ghFallbackToken) actionCore.setSecret(ghFallbackToken);

  const inputs = resolveInputs({
    ...process.env,
    INPUT_PROJECT_NAME: projectName,
    INPUT_WORKSPACE_ID: optionalInput(actionCore, 'workspace-id'),
    INPUT_SPEC_ID: optionalInput(actionCore, 'spec-id'),
    INPUT_BASELINE_COLLECTION_ID: optionalInput(actionCore, 'baseline-collection-id'),
    INPUT_SMOKE_COLLECTION_ID: optionalInput(actionCore, 'smoke-collection-id'),
    INPUT_CONTRACT_COLLECTION_ID: optionalInput(actionCore, 'contract-collection-id'),
    INPUT_ADDITIONAL_COLLECTIONS_DIR: optionalInput(actionCore, 'additional-collections-dir'),
    INPUT_SYNC_EXAMPLES:
      optionalInput(actionCore, 'sync-examples') ??
      bootstrapActionContract.inputs['sync-examples'].default,
    INPUT_COLLECTION_SYNC_MODE:
      optionalInput(actionCore, 'collection-sync-mode') ??
      bootstrapActionContract.inputs['collection-sync-mode'].default,
    INPUT_SPEC_SYNC_MODE:
      optionalInput(actionCore, 'spec-sync-mode') ??
      bootstrapActionContract.inputs['spec-sync-mode'].default,
    INPUT_RELEASE_LABEL: optionalInput(actionCore, 'release-label'),
    INPUT_DOMAIN: optionalInput(actionCore, 'domain'),
    INPUT_DOMAIN_CODE: optionalInput(actionCore, 'domain-code'),
    INPUT_GOVERNANCE_GROUP: optionalInput(actionCore, 'governance-group'),
    INPUT_REQUESTER_EMAIL: optionalInput(actionCore, 'requester-email'),
    INPUT_WORKSPACE_ADMIN_USER_IDS: optionalInput(
      actionCore,
      'workspace-admin-user-ids'
    ),
    INPUT_WORKSPACE_TEAM_ID:
      optionalInput(actionCore, 'workspace-team-id') || process.env.POSTMAN_WORKSPACE_TEAM_ID,
    INPUT_TEAM_ID: process.env.POSTMAN_TEAM_ID,
    INPUT_REPO_URL: optionalInput(actionCore, 'repo-url'),
    INPUT_SPEC_URL: specUrl,
    INPUT_SPEC_PATH: specPath,
    INPUT_SPEC_FILES_JSON: optionalInput(actionCore, 'spec-files-json') ?? '',
    INPUT_GOVERNANCE_MAPPING_JSON:
      optionalInput(actionCore, 'governance-mapping-json') ??
      bootstrapActionContract.inputs['governance-mapping-json'].default,
    INPUT_POSTMAN_API_KEY: postmanApiKey,
    INPUT_POSTMAN_ACCESS_TOKEN: postmanAccessToken,
    INPUT_CREDENTIAL_PREFLIGHT:
      optionalInput(actionCore, 'credential-preflight') ??
      bootstrapActionContract.inputs['credential-preflight'].default,
    INPUT_POSTMAN_REGION:
      optionalInput(actionCore, 'postman-region') ??
      bootstrapActionContract.inputs['postman-region'].default,
    INPUT_POSTMAN_STACK:
      optionalInput(actionCore, 'postman-stack') ??
      bootstrapActionContract.inputs['postman-stack'].default,
    INPUT_INTEGRATION_BACKEND:
      optionalInput(actionCore, 'integration-backend') ??
      bootstrapActionContract.inputs['integration-backend'].default,
    INPUT_FOLDER_STRATEGY:
      optionalInput(actionCore, 'folder-strategy') ??
      bootstrapActionContract.inputs['folder-strategy'].default,
    INPUT_NESTED_FOLDER_HIERARCHY:
      optionalInput(actionCore, 'nested-folder-hierarchy') ??
      bootstrapActionContract.inputs['nested-folder-hierarchy'].default,
    INPUT_REQUEST_NAME_SOURCE:
      optionalInput(actionCore, 'request-name-source') ??
      bootstrapActionContract.inputs['request-name-source'].default,
    INPUT_OPENAPI_VERSION: optionalInput(actionCore, 'openapi-version') ?? '',
    INPUT_PRESERVE_OAS30_TYPE_NULL:
      optionalInput(actionCore, 'preserve-oas30-type-null') ??
      bootstrapActionContract.inputs['preserve-oas30-type-null'].default,
    INPUT_BREAKING_CHANGE_MODE:
      optionalInput(actionCore, 'breaking-change-mode') ??
      bootstrapActionContract.inputs['breaking-change-mode'].default,
    INPUT_BREAKING_BASELINE_SPEC_PATH: optionalInput(actionCore, 'breaking-baseline-spec-path'),
    INPUT_BREAKING_RULES_PATH:
      optionalInput(actionCore, 'breaking-rules-path') ??
      bootstrapActionContract.inputs['breaking-rules-path'].default,
    INPUT_BREAKING_TARGET_REF: optionalInput(actionCore, 'breaking-target-ref'),
    INPUT_BREAKING_SUMMARY_PATH: optionalInput(actionCore, 'breaking-summary-path'),
    INPUT_BREAKING_LOG_PATH: optionalInput(actionCore, 'breaking-log-path'),
    INPUT_GITHUB_TOKEN: githubToken,
    INPUT_GH_FALLBACK_TOKEN: ghFallbackToken,
    INPUT_BRANCH_STRATEGY:
      optionalInput(actionCore, 'branch-strategy') ??
      bootstrapActionContract.inputs['branch-strategy'].default,
    INPUT_CANONICAL_BRANCH: optionalInput(actionCore, 'canonical-branch'),
    INPUT_CHANNELS: optionalInput(actionCore, 'channels')
  });

  return inputs;
}

function createWorkspaceName(inputs: ResolvedInputs): string {
  return inputs.domainCode
    ? `[${inputs.domainCode}] ${inputs.projectName}`
    : inputs.projectName;
}

async function resolveGovernanceGroupName(
  inputs: ResolvedInputs,
  dependencies: Pick<BootstrapExecutionDependencies, 'core' | 'github'>
): Promise<string | undefined> {
  const explicitGroup = normalizeInputValue(inputs.governanceGroup);
  if (explicitGroup) {
    dependencies.core.info(`Resolved governance group from explicit input: ${explicitGroup}`);
    return explicitGroup;
  }

  if (!dependencies.github) {
    return undefined;
  }

  const repository = normalizeInputValue(inputs.repoSlug) || '(unknown repository)';
  try {
    const propertyGroup = normalizeInputValue(
      await dependencies.github.getRepositoryCustomProperty(GOVERNANCE_GROUP_PROPERTY_NAME)
    );
    if (propertyGroup) {
      dependencies.core.info(
        `Resolved governance group from GitHub repository property ${GOVERNANCE_GROUP_PROPERTY_NAME}: ${propertyGroup}`
      );
      return propertyGroup;
    }
  } catch (error) {
    const mask = createBootstrapSecretMasker(inputs);
    const cause = formatMaskedOneLine(error, mask);
    dependencies.core.warning(
      formatMaskedOneLine(
        `Could not read GitHub repository property ${GOVERNANCE_GROUP_PROPERTY_NAME} for repository ${repository}: ${cause}. ` +
          'Remediation: grant the github-token custom-property read permission, or set governance-group explicitly.',
        mask
      )
    );
  }

  return undefined;
}

async function runGroup<T>(
  actionCore: Pick<CoreLike, 'group'>,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  return actionCore.group(name, fn);
}

function normalizeLintPath(value: string): string {
  return value
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/^\./, '');
}

export function applyOas30TypeNullLintCompatibility(
  summary: LintSummary,
  sourceTypeNullPaths: string[]
): LintSummary {
  const acceptedPaths = new Set(sourceTypeNullPaths.map(normalizeLintPath));
  if (acceptedPaths.size === 0) return summary;

  const violations = summary.violations.map((violation) => {
    const path = normalizeLintPath(violation.path ?? '');
    const issue = violation.issue ?? '';
    const isTypeEnumFinding =
      /["']?type["']? property/i.test(issue) &&
      /allowed values|must be equal to one of/i.test(issue);
    if (
      violation.severity === 'ERROR' &&
      acceptedPaths.has(path) &&
      isTypeEnumFinding
    ) {
      return { ...violation, severity: 'WARNING' };
    }
    return violation;
  });

  return {
    errors: violations.filter((entry) => entry.severity === 'ERROR').length,
    violations,
    warnings: violations.filter((entry) => entry.severity === 'WARNING').length
  };
}

function shouldRetrySpecFetch(error: unknown): boolean {
  const retryability = classifySafeFetchRetryability(error);
  return retryability === 'retryable' || retryability === 'unknown';
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
      delayMs: 3000,
      shouldRetry: shouldRetrySpecFetch
    }
  );
}

function normalizeReleaseLabel(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/tags\//, '')
    .replace(/^refs\/pull\//, 'pull-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || undefined;
}

function deriveReleaseLabel(inputs: ResolvedInputs): string | undefined {
  if (inputs.releaseLabel) {
    return normalizeReleaseLabel(inputs.releaseLabel);
  }

  return (
    normalizeReleaseLabel(inputs.githubRefName) ??
    normalizeReleaseLabel(inputs.githubHeadRef) ??
    normalizeReleaseLabel(inputs.githubRef)
  );
}

function createAssetProjectName(
  inputs: ResolvedInputs,
  releaseLabel?: string
): string {
  if (!releaseLabel) {
    return inputs.projectName;
  }

  return `${inputs.projectName} ${releaseLabel}`;
}

const BASELINE_COLLECTION_PREFIX = '';
const LEGACY_BASELINE_COLLECTION_PREFIX = '[Baseline]';
const SMOKE_COLLECTION_PREFIX = '[Smoke]';
const CONTRACT_COLLECTION_PREFIX = '[Contract]';

type GeneratedCollectionPrefix =
  | typeof BASELINE_COLLECTION_PREFIX
  | typeof SMOKE_COLLECTION_PREFIX
  | typeof CONTRACT_COLLECTION_PREFIX;

function normalizedResourcePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function matchesCollectionDirectory(filePath: string, directoryName: string): boolean {
  return normalizedResourcePath(filePath).endsWith(`/collections/${directoryName}`);
}

function matchesBaselineCollectionResource(filePath: string, assetProjectName: string): boolean {
  return (
    matchesCollectionDirectory(filePath, assetProjectName) ||
    matchesCollectionDirectory(filePath, `${LEGACY_BASELINE_COLLECTION_PREFIX} ${assetProjectName}`)
  );
}

function matchesPrefixedCollectionResource(
  filePath: string,
  prefix: typeof SMOKE_COLLECTION_PREFIX | typeof CONTRACT_COLLECTION_PREFIX,
  assetProjectName: string
): boolean {
  return matchesCollectionDirectory(filePath, `${prefix} ${assetProjectName}`);
}

function toResourcesStatePath(filePath: string): string {
  return `../${normalizedResourcePath(filePath).replace(/^\/+/, '')}`;
}

function generatedCollectionResourcePath(
  prefix: GeneratedCollectionPrefix,
  assetProjectName: string
): string {
  const directoryName = prefix ? `${prefix} ${assetProjectName}` : assetProjectName;
  return `../postman/collections/${directoryName}`;
}

function specResourceStatePath(
  inputs: ResolvedInputs,
  releaseLabel?: string
): string | undefined {
  let base: string | undefined;
  if (inputs.specPath) {
    base = toResourcesStatePath(inputs.specPath);
  } else if (inputs.specUrl) {
    base = `spec-url:${sanitizeUrlForLog(inputs.specUrl)}`;
  }
  if (!base) {
    return undefined;
  }
  if (inputs.specSyncMode === 'version') {
    const normalized = normalizeReleaseLabel(releaseLabel);
    if (!normalized) {
      return undefined;
    }
    return `${base}#release=${normalized}`;
  }
  return base;
}

function resolveSpecIdFromResourcesState(
  inputs: ResolvedInputs,
  resourcesState: PostmanResourcesState | null,
  releaseLabel?: string
): string | undefined {
  if (inputs.specId) {
    return inputs.specId;
  }
  const key = specResourceStatePath(inputs, releaseLabel);
  if (!key) {
    return undefined;
  }
  return resourcesState?.cloudResources?.specs?.[key];
}

function recordCurrentBootstrapResources(options: {
  assetProjectName: string;
  inputs: ResolvedInputs;
  outputs: PlannedOutputs;
  persistWorkspaceId: boolean;
  releaseLabel?: string;
  resourcesState: PostmanResourcesState;
}): void {
  const { assetProjectName, inputs, outputs, persistWorkspaceId, releaseLabel, resourcesState } =
    options;
  if (persistWorkspaceId && outputs['workspace-id']) {
    resourcesState.workspace ??= {};
    resourcesState.workspace.id = outputs['workspace-id'];
  }

  const specPath = specResourceStatePath(inputs, releaseLabel);
  if (outputs['spec-id'] && specPath) {
    resourcesState.cloudResources ??= {};
    resourcesState.cloudResources.specs ??= {};
    resourcesState.cloudResources.specs[specPath] = outputs['spec-id'];
  }

  const collectionMappings: Array<[GeneratedCollectionPrefix, string]> = [
    [BASELINE_COLLECTION_PREFIX, outputs['baseline-collection-id']],
    [SMOKE_COLLECTION_PREFIX, outputs['smoke-collection-id']],
    [CONTRACT_COLLECTION_PREFIX, outputs['contract-collection-id']]
  ].filter((entry): entry is [GeneratedCollectionPrefix, string] => Boolean(entry[1]));

  if (collectionMappings.length === 0) {
    return;
  }

  resourcesState.cloudResources ??= {};
  resourcesState.cloudResources.collections ??= {};
  for (const [prefix, collectionId] of collectionMappings) {
    resourcesState.cloudResources.collections[
      generatedCollectionResourcePath(prefix, assetProjectName)
    ] = collectionId;
  }
}

const SPEC_SUMMARY_MAX_LEN = 200;
const SPEC_HTTP_METHODS = new Set([
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'
]);

/** OpenAPI JSON/YAML: fix missing or oversized operation summaries before Spec Hub upload. */
export function normalizeSpecDocument(raw: string, warn: (msg: string) => void): string {
  const head = raw.trimStart();
  let doc: unknown;
  let asJson = false;
  try {
    if (head.startsWith('{') || head.startsWith('[')) {
      doc = JSON.parse(raw) as unknown;
      asJson = true;
    } else {
      doc = parse(raw) as unknown;
    }
  } catch {
    warn('Spec normalization skipped: document is not valid JSON or YAML.');
    return raw;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return raw;
  const root = doc as Record<string, unknown>;
  const paths = root.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return raw;

  // OAS 3.1 webhooks share the same path-item structure as paths.
  const webhooks = root.webhooks;
  const operationMaps: Record<string, unknown>[] = [paths as Record<string, unknown>];
  if (webhooks && typeof webhooks === 'object' && !Array.isArray(webhooks)) {
    operationMaps.push(webhooks as Record<string, unknown>);
  }

  let changed = false;
  for (const operationMap of operationMaps)
  for (const [pathKey, pathItem] of Object.entries(operationMap)) {
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) continue;
    const item = pathItem as Record<string, unknown>;
    for (const method of Object.keys(item)) {
      if (!SPEC_HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = item[method];
      if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
      const o = op as Record<string, unknown>;
      const prev = o.summary;
      let s = typeof o.summary === 'string' ? o.summary.trim() : '';
      const M = method.toUpperCase();
      if (!s && typeof o.operationId === 'string' && o.operationId.trim()) {
        s = o.operationId.trim();
        warn(`Spec normalization: ${M} ${pathKey} — missing summary; using operationId.`);
      }
      if (!s) {
        s = `${M} ${pathKey}`;
        warn(
          `Spec normalization: ${M} ${pathKey} — missing summary and operationId; using method + path.`
        );
      }
      if (s.length > SPEC_SUMMARY_MAX_LEN) {
        const before = s.length;
        s = `${s.slice(0, SPEC_SUMMARY_MAX_LEN - 1)}…`;
        warn(
          `Spec normalization: ${M} ${pathKey} — summary truncated from ${before} to ${SPEC_SUMMARY_MAX_LEN} characters.`
        );
      }
      if (prev !== s && (typeof prev !== 'string' || prev.trim() !== s)) {
        o.summary = s;
        changed = true;
      }
    }
  }
  if (!changed) return raw;
  return asJson ? `${JSON.stringify(doc, null, 2)}\n` : `${stringify(doc, { lineWidth: 0 })}\n`;
}

export async function runBootstrap(
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies
): Promise<PlannedOutputs> {
  // Fire-and-forget usage telemetry wraps the run so a completion event is
  // emitted once, after team_id is resolved, covering early failures too.
  // It can never block, fail, or alter the bootstrap result.
  const telemetry = createTelemetryContext({
    action: 'postman-bootstrap-action',
    actionVersion: resolveActionVersion(),
    logger: dependencies.core
  });
  try {
    const result = await runBootstrapInner(inputs, dependencies, telemetry);
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('success');
    return result;
  } catch (error) {
    telemetry.setAccountType(getMemoizedSessionIdentity()?.consumerType);
    telemetry.emitCompletion('failure');
    // Asset operations run gateway-only. Rewrite recognized HTTP failures with
    // actionable token and role guidance; adapter-advised errors pass through.
    if (error instanceof HttpError) {
      const session = getMemoizedSessionIdentity();
      const advised = adviseFromHttpError(error, {
        operation: 'Postman gateway operation',
        hasAccessToken: Boolean(inputs.postmanAccessToken),
        sessionTeamId: session?.teamId,
        sessionRoles: session?.roles,
        sessionConsumerType: session?.consumerType,
        workspaceTeamId: inputs.workspaceTeamId,
        explicitTeamId: inputs.teamId || undefined,
        mask: createSecretMasker([inputs.postmanAccessToken])
      });
      if (advised) {
        throw advised;
      }
    }
    throw error;
  }
}

type ProvisionedWorkspace = {
  workspaceId: string | undefined;
  /** Whether the resolved id may be durably written to resources.yaml. */
  persistable: boolean;
};

/**
 * Resolve, reuse, or create the Postman workspace (with org-mode sub-team
 * handling and visibility checks), assign governance, invite the requester, and
 * add admins. Shared by the OpenAPI and multi-protocol paths so both provision
 * the workspace identically. Returns the resolved workspace id plus whether that
 * id may be durably persisted (explicit/resources/linked_match/repo_var/clean
 * create are persistable; name_match and reconciled create are not).
 */
async function provisionWorkspace(
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies,
  telemetry: TelemetryContext,
  outputs: PlannedOutputs,
  resourcesState: PostmanResourcesState | null,
  workspaceName: string,
  aboutText: string
): Promise<ProvisionedWorkspace> {
  let explicitWorkspaceId = inputs.workspaceId;
  if (!explicitWorkspaceId && resourcesState?.workspace?.id) {
    explicitWorkspaceId = resourcesState.workspace.id;
    dependencies.core.info('Resolved workspace-id from .postman/resources.yaml');
  }

  const repoWorkspaceId = explicitWorkspaceId;
  let workspaceId = explicitWorkspaceId;
  let workspaceMutationOwned = Boolean(explicitWorkspaceId);

  let teamId = inputs.teamId || '';
  if (!teamId) {
    // Team scope comes from the access token's session (iapub
    // /api/sessions/current), resolved + memoized by the credential preflight
    // both entrypoints run before this. It is the same team resolved by the
    // service-token action.
    teamId = getMemoizedSessionIdentity()?.teamId || '';
  }
  telemetry.setTeamId(teamId);
  const repoUrl = inputs.repoUrl || '';

  // Bifrost enforces global uniqueness of (repo URL, path) -> workspace. Probe
  // before name-based selection/create so a cross-team invisible owner fails
  // admission with zero asset writes, and a visible owner is adopted.
  if (repoUrl && dependencies.internalIntegration?.findWorkspaceForRepo) {
    const probe = await dependencies.internalIntegration.findWorkspaceForRepo(repoUrl);
    if (probe.state === 'linked-invisible') {
      const orgTail = inputs.workspaceTeamId
        ? ' Verify workspace-team-id; if the owner is in another sub-team, ask that sub-team\'s admin to disconnect it.'
        : '';
      throw new Error(
        `REPOSITORY_LINK_CONFLICT_INVISIBLE: Repository ${repoUrl} at path / is linked to workspace ${probe.workspaceId}, but these credentials cannot view it. No Postman assets were changed. Ask its owner or a team admin to disconnect it.${orgTail}`
      );
    }
    if (probe.state === 'linked-visible') {
      workspaceId = probe.workspace.id;
      workspaceMutationOwned = true;
      const nameSuffix = probe.workspace.name ? ` ("${probe.workspace.name}")` : '';
      dependencies.core.info(
        `Repository ${repoUrl} at path / is already linked to workspace ${probe.workspace.id}${nameSuffix}; adopting it as the canonical workspace.`
      );
    } else if (probe.state === 'unknown') {
      dependencies.core.warning(
        `Repository link preflight could not determine ownership for ${repoUrl}: ${probe.reason}. Continuing with normal workspace selection.`
      );
    }
  }

  if (!workspaceId && repoUrl && inputs.postmanAccessToken && teamId) {
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
      workspaceMutationOwned = selection.source !== 'name_match';
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

  // Parse workspace-team-id from already-resolved inputs
  let workspaceTeamId: number | undefined;
  // Org-mode for EC (gRPC) gateway writes, derived from the resolved team scope
  // independently of POSTMAN_TEAM_ID: an explicit workspace-team-id or a detected
  // org-mode account both require the x-entity-team-id sub-team header.
  let ecOrgMode = false;
  if (inputs.workspaceTeamId) {
    workspaceTeamId = parseInt(inputs.workspaceTeamId, 10);
    if (Number.isNaN(workspaceTeamId)) {
      throw new Error(`workspace-team-id must be a numeric sub-team ID, got: ${inputs.workspaceTeamId}`);
    }
    ecOrgMode = true;
  }

  // Org-mode detection: only check if we need to create a workspace (not reuse existing)
  if (!workspaceId && !workspaceTeamId) {
    // The org-account misleading-403 case is caught at the point it happens by
    // adviseWorkspaceFlipForbidden below.
    try {
      const teams = await dependencies.postman.getTeams();
      if (teams.length > 1 && teams.every(t => t.organizationId == null)) {
        dependencies.core.warning(
          'GET /teams returned multiple teams but none include organizationId. ' +
          'Org-mode detection may be degraded due to an upstream API change. ' +
          'If workspace creation fails, set workspace-team-id explicitly.'
        );
      }
      // Org-mode is a property of the account. Any team
      // carrying a non-null organizationId means the parent account is org-mode,
      // even when the service account can operate in only one sub-team.
      const isOrgMode = teams.some(t => t.organizationId != null);
      if (isOrgMode) {
        ecOrgMode = true;
      }

      if (isOrgMode) {
        if (teams.length === 1) {
          // Unambiguous: only one sub-team the key can operate in.
          workspaceTeamId = teams[0].id;
          dependencies.core.info(
            `Org-mode account detected. Using sub-team ${teams[0].id} (${teams[0].name}) for workspace creation.`
          );
        } else {
          const teamList = teams
            .map(t => `  ${t.id}  ${t.name}`)
            .join('\n');
          throw new Error(
            `Org-mode account detected. Workspace creation requires a specific sub-team ID.\n\n` +
            `Available sub-teams:\n${teamList}\n\n` +
            `To fix this, set the workspace-team-id input in your workflow:\n` +
            `  workspace-team-id: '<id>'\n\n` +
            `Or for reuse across runs, create a repository variable and reference it:\n` +
            `  workspace-team-id: \${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}\n\n` +
            `For CLI usage, pass --workspace-team-id <id> or export POSTMAN_WORKSPACE_TEAM_ID=<id>.`
          );
        }
      } else if (teams.length > 1) {
        dependencies.core.warning(
          `API key has access to ${teams.length} teams but org-mode could not be confirmed. ` +
          `Proceeding without teamId. If workspace creation fails, set workspace-team-id explicitly.`
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Org-mode account detected')) {
        throw err;
      }
      const mask = createBootstrapSecretMasker(inputs);
      const cause = formatMaskedOneLine(err, mask);
      const context = workspaceName
        ? `workspace ${workspaceName}`
        : inputs.repoSlug
          ? `repository ${inputs.repoSlug}`
          : `project ${inputs.projectName}`;
      dependencies.core.warning(
        formatMaskedOneLine(
          `Could not check for org-mode sub-teams while provisioning ${context}: ${cause}. ` +
            'Impact: continuing without org-mode team context (orgMode=false). ' +
            'Remediation: set workspace-team-id explicitly if workspace creation fails, or verify the postman-access-token can list teams.',
          mask
        )
      );
    }
  }

  // Re-scope gateway-backed clients to the workspace-owning sub-team before
  // create and all subsequent asset writes. They are constructed before team
  // resolution; on org-mode accounts the gateway requires the sub-team
  // x-entity-team-id.
  const resolvedGatewayTeamId = workspaceTeamId != null ? String(workspaceTeamId) : teamId;
  if (dependencies.ecClient?.configureTeamContext) {
    dependencies.ecClient.configureTeamContext(resolvedGatewayTeamId, ecOrgMode);
  }
  if (dependencies.postman.configureTeamContext) {
    dependencies.postman.configureTeamContext(resolvedGatewayTeamId, ecOrgMode);
  }
  if (dependencies.internalIntegration?.configureTeamContext) {
    dependencies.internalIntegration.configureTeamContext(resolvedGatewayTeamId, ecOrgMode);
  }

  if (!workspaceId) {
    const workspace = await runGroup(
      dependencies.core,
      'Create Postman Workspace',
      async () => dependencies.postman.createWorkspace(workspaceName, aboutText, workspaceTeamId)
    );
    workspaceId = workspace.id;
    workspaceMutationOwned = !workspace.reconciled;
  } else {
    // Reused workspaces skip createWorkspace's visibility enforcement, so a
    // personal-visibility workspace minted by an earlier org-mode run without
    // workspace-team-id would silently stay invisible to teammates and the
    // API Catalog run after run. Surface that loudly.
    const visibility = await dependencies.postman.getWorkspaceVisibility(workspaceId);
    if (visibility && visibility !== 'team') {
      dependencies.core.warning(
        `Workspace ${workspaceId} has visibility '${visibility}', so it does not appear in the API Catalog ` +
          'and teammates or other API keys cannot see it. This usually means an org-mode run created it ' +
          'without workspace-team-id. Recreate it with workspace-team-id set (delete the workspace and ' +
          'clear the POSTMAN_WORKSPACE_ID repository variable), or share it to the team from Workspace Settings.'
      );
    }
  }

  outputs['workspace-id'] = workspaceId || '';
  outputs['workspace-url'] = `https://go.postman.co/workspace/${workspaceId}`;
  outputs['workspace-name'] = workspaceName;

  const governanceGroupName = await resolveGovernanceGroupName(inputs, dependencies);
  const shouldAssignGovernance = Boolean(inputs.domain || governanceGroupName);

  if (shouldAssignGovernance && dependencies.internalIntegration && workspaceMutationOwned) {
    await runGroup(
      dependencies.core,
      'Assign Workspace to Governance Group',
      async () => {
        try {
          await dependencies.internalIntegration?.assignWorkspaceToGovernanceGroup(
            workspaceId || '',
            inputs.domain || '',
            inputs.governanceMappingJson,
            governanceGroupName
          );
        } catch (error) {
          const session = getMemoizedSessionIdentity();
          const mask = createBootstrapSecretMasker(inputs);
          const advised =
            error instanceof HttpError
              ? adviseFromHttpError(error, {
                  operation: 'governance assignment',
                  hasAccessToken: Boolean(inputs.postmanAccessToken),
                  sessionTeamId: session?.teamId,
                  sessionRoles: session?.roles,
                  sessionConsumerType: session?.consumerType,
                  workspaceTeamId: inputs.workspaceTeamId,
                  explicitTeamId: inputs.teamId || undefined,
                  mask
                })
              : undefined;
          const reported = advised ?? error;
          const cause = formatMaskedOneLine(reported, mask);
          const target = governanceGroupName
            ? `group ${governanceGroupName}`
            : inputs.domain
              ? `domain ${inputs.domain}`
              : 'configured governance target';
          dependencies.core.warning(
            formatMaskedOneLine(
              `Failed to assign governance group for workspace ${workspaceId || '(unknown)'} (${target}): ${cause}. ` +
                'Remediation: assign the governance group manually in Postman, or verify the postman-access-token can update workspace governance.',
              mask
            )
          );
        }
      }
    );
  }

  if (inputs.requesterEmail && workspaceMutationOwned) {
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
          const mask = createBootstrapSecretMasker(inputs);
          const cause = formatMaskedOneLine(error, mask);
          dependencies.core.warning(
            formatMaskedOneLine(
              `Failed to invite requester ${inputs.requesterEmail} to workspace ${workspaceId || '(unknown)'}: ${cause}. ` +
                'Remediation: invite the requester manually, or verify the postman-access-token can manage workspace members.',
              mask
            )
          );
        }
      }
    );
  }

  const adminIds = inputs.workspaceAdminUserIds || '';
  if (adminIds && workspaceMutationOwned) {
    await runGroup(
      dependencies.core,
      'Add Team Admins to Workspace',
      async () => {
        try {
          await dependencies.postman.addAdminsToWorkspace(workspaceId || '', adminIds);
        } catch (error) {
          const mask = createBootstrapSecretMasker(inputs);
          const cause = formatMaskedOneLine(error, mask);
          dependencies.core.warning(
            formatMaskedOneLine(
              `Failed to add team admins (${adminIds}) to workspace ${workspaceId || '(unknown)'}: ${cause}. ` +
                `Remediation: add admin user ids ${adminIds} manually, or verify the postman-access-token can manage workspace roles.`,
              mask
            )
          );
        }
      }
    );
  }

  return {
    workspaceId,
    persistable: workspaceMutationOwned
  };
}

function resolveWorkspaceRoot(): string {
  return path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
}

function primitiveMatches(actual: unknown, requested: unknown): boolean {
  if (actual === requested) return true;
  if (typeof requested === 'boolean' && typeof actual === 'string') {
    const lower = actual.trim().toLowerCase();
    if (lower === 'true') return requested === true;
    if (lower === 'false') return requested === false;
  }
  if (typeof requested === 'number' && typeof actual === 'string' && actual.trim() !== '') {
    const num = Number(actual.trim());
    if (!Number.isNaN(num)) return num === requested;
  }
  return false;
}

/**
 * Recursively verifies that every key/value in `requested` is semantically present in `actual`.
 * Tolerates server-added defaults, extra metadata fields, and wrapper objects `{ value: X, ... }` or `{ enabled: X, ... }`.
 * Fails closed if a requested key is missing or semantically differs.
 */
function includesRequestedJsonSemantics(actual: unknown, requested: unknown): boolean {
  if (actual === requested) return true;

  // 1. Primitive requested value (boolean, string, number, null, undefined)
  if (requested === null || requested === undefined || typeof requested !== 'object') {
    if (primitiveMatches(actual, requested)) return true;
    if (typeof actual === 'object' && actual !== null && !Array.isArray(actual)) {
      const record = actual as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, 'value')) {
        return includesRequestedJsonSemantics(record.value, requested);
      }
      if (
        Object.prototype.hasOwnProperty.call(record, 'enabled') &&
        (typeof record.enabled === 'boolean' || typeof record.enabled === 'string' || typeof record.enabled === 'object')
      ) {
        return includesRequestedJsonSemantics(record.enabled, requested);
      }
    }
    return false;
  }

  // 2. Array requested value
  if (Array.isArray(requested)) {
    if (Array.isArray(actual)) {
      if (actual.length !== requested.length) return false;
      return actual.every((item, index) =>
        includesRequestedJsonSemantics(item, requested[index])
      );
    }
    if (typeof actual === 'object' && actual !== null) {
      const record = actual as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(record, 'value')) {
        return includesRequestedJsonSemantics(record.value, requested);
      }
    }
    return false;
  }

  // 3. Object requested value (Record<string, unknown>)
  if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
    return false;
  }

  const actualRecord = actual as Record<string, unknown>;
  const requestedRecord = requested as Record<string, unknown>;
  const requestedKeys = Object.keys(requestedRecord);

  // Try direct key match on actualRecord
  const directMatch = requestedKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(actualRecord, key) &&
      includesRequestedJsonSemantics(actualRecord[key], requestedRecord[key])
  );
  if (directMatch) return true;

  // If direct match failed, but actualRecord has a wrapper envelope, try matching against the envelope value
  if (Object.prototype.hasOwnProperty.call(actualRecord, 'value')) {
    return includesRequestedJsonSemantics(actualRecord.value, requested);
  }
  if (
    Object.prototype.hasOwnProperty.call(actualRecord, 'enabled') &&
    (typeof actualRecord.enabled === 'boolean' || typeof actualRecord.enabled === 'string' || typeof actualRecord.enabled === 'object')
  ) {
    return includesRequestedJsonSemantics(actualRecord.enabled, requested);
  }

  return false;
}

function definitionFormatToSpecType(format: DefinitionFormat): SpecType {
  if (isOpenApiDefinitionFormat(format)) return 'openapi';
  if (format === 'protobuf') return 'grpc';
  if (format === 'wsdl') return 'soap';
  if (format === 'graphql-sdl' || format === 'graphql-introspection-json') return 'graphql';
  if (format === 'asyncapi-json' || format === 'asyncapi-yaml') return 'asyncapi';
  if (format === 'mcp-json') return 'mcp';
  throw new Error(`CONTRACT_DEFINITION_INVENTORY_INVALID: unsupported definition format ${format}`);
}

function assertMultiFileSpecSyncEnabled(bundle: DefinitionBundle): void {
  if (bundle.files.size <= 1) return;
  // Default-on is justified by the committed R5 receipt capability seam
  // (MULTI_FILE_SPEC_SYNC_DEFAULT / resolveMultiFileSpecSyncDefaultFromReceipt).
  // Kill switch POSTMAN_MULTI_FILE_SPEC_SYNC=off always wins.
  const raw = (
    process.env.POSTMAN_MULTI_FILE_SPEC_SYNC ?? MULTI_FILE_SPEC_SYNC_DEFAULT
  )
    .trim()
    .toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') {
    throw new Error(
      'CONTRACT_MULTI_FILE_SPEC_SYNC_DISABLED: multi-file Spec Hub sync is disabled by POSTMAN_MULTI_FILE_SPEC_SYNC=off; ' +
        'unset the kill switch or provide a single-file definition'
    );
  }
}

function requireBundleGatewayOp<T>(fn: T | undefined, name: string): T {
  if (!fn) {
    throw new Error(
      `${name} requires access-token gateway multi-file Spec Hub support (uploadSpecBundle/getSpecBundle/reconcileSpecBundle)`
    );
  }
  return fn;
}

/** Return a new immutable bundle whose root content is replaced; companions stay exact bytes. */
export function withReplacedRootContent(
  bundle: DefinitionBundle,
  rootContent: string
): DefinitionBundle {
  const rootBytes = Buffer.from(rootContent, 'utf8');
  const files = [...bundle.files.values()].map((file) => {
    if (file.path === bundle.rootPath) {
      return createDefinitionFile({
        path: file.path,
        role: 'root',
        bytes: Uint8Array.from(rootBytes)
      });
    }
    return createDefinitionFile({
      path: file.path,
      role: file.role,
      bytes: file.bytes
    });
  });
  return createDefinitionBundle({
    rootPath: bundle.rootPath,
    format: bundle.format,
    completeness: bundle.completeness,
    provenance: {
      source: bundle.provenance.source,
      ...(bundle.provenance.provider ? { provider: bundle.provenance.provider } : {}),
      evidence: [...bundle.provenance.evidence]
    },
    files
  });
}

/**
 * Persist workspace identity after provision without recording new spec/collection
 * outputs. Existing cloudResources from the prior read remain intact for
 * resolution and crash-safe reread; new spec-id/collection ids are recorded only
 * after verified sync + generation/linking.
 */
function persistWorkspaceOnlyState(
  stateStore: { write(state: PostmanResourcesState): void },
  resourcesState: PostmanResourcesState,
  inputs: ResolvedInputs,
  outputs: PlannedOutputs,
  persistWorkspaceId: boolean,
  assetProjectName: string,
  releaseLabel?: string
): void {
  if (!persistWorkspaceId || !outputs['workspace-id']) return;
  // Intentionally omit spec-id / collection outputs so recordCurrentBootstrapResources
  // updates workspace only.
  const workspaceOutputs: PlannedOutputs = {
    ...outputs,
    'spec-id': '',
    'baseline-collection-id': '',
    'smoke-collection-id': '',
    'contract-collection-id': ''
  };
  recordCurrentBootstrapResources({
    assetProjectName,
    inputs,
    outputs: workspaceOutputs,
    persistWorkspaceId,
    releaseLabel,
    resourcesState
  });
  stateStore.write(resourcesState);
}

/**
 * Human-readable note on whether a generated protocol collection executes in the
 * Postman CLI runner, used in the bootstrap log after the collection is built.
 */
function protocolExecutionNote(specType: Exclude<SpecType, 'openapi'>, runnableInCi: boolean): string {
  if (runnableInCi) return 'Runs in Postman CLI / Newman.';
  if (specType === 'asyncapi') {
    return 'WebSocket/Socket.IO/MQTT items are pruned by the Postman CLI runner (WS_NOT_CI_EXECUTABLE); the collection provides schema-validated contract examples for manual and in-app runs.';
  }
  if (specType === 'mcp') {
    return 'MCP items are pruned by the Postman CLI runner; the collection provides statically validated JSON-RPC templates for manual and in-app runs.';
  }
  return 'This protocol is not executable in the Postman CLI runner.';
}

/**
 * Multi-protocol contract path for non-OpenAPI specs (graphql/grpc/soap/asyncapi).
 * Parses the spec, builds and instruments a Postman collection locally, creates it
 * in the provisioned workspace, tags it, and records it as the contract collection.
 * Reuses the same workspace provisioning as the OpenAPI path; it does not touch
 * Spec Hub, breaking-change checks, or collection generation.
 */
async function runProtocolBootstrap(
  specType: Exclude<SpecType, 'openapi'>,
  rawSpecContent: string,
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies,
  outputs: PlannedOutputs,
  telemetry: TelemetryContext,
  definitionBundle?: DefinitionBundle
): Promise<PlannedOutputs> {
  const workspaceName = createWorkspaceName(inputs);
  const aboutText = `Auto-provisioned by Postman for ${inputs.projectName}`;
  const stateStore = resolveResourcesStateStore(dependencies);
  const resourcesState = stateStore.read();
  const writableResourcesState = resourcesState ?? {};

  // Bundle-only: use grpc_service_config.json only when already a DefinitionBundle
  // member. Never probe, stat, or read an adjacent/symlinked sibling from disk.
  let grpcServiceConfigJson: string | undefined;
  if (specType === 'grpc') {
    const fromBundle = definitionBundle?.files.get('grpc_service_config.json')?.content;
    if (fromBundle) {
      grpcServiceConfigJson = fromBundle;
      dependencies.core.info(
        'Found gRPC service config in definition bundle; validating it against the proto contract'
      );
    }
  }

  // Prebuild before workspace side effects so missing/invalid closure fails cleanly.
  const built = await runGroup(
    dependencies.core,
    `Build ${specType.toUpperCase()} Contract Collection`,
    async () =>
      buildProtocolCollection(specType, rawSpecContent, {
        name: inputs.projectName,
        endpointUrl: inputs.protocolEndpointUrl,
        schemaLocation: inputs.specPath || inputs.specUrl,
        grpcServiceConfigJson,
        definitionBundle
      })
  );

  for (const warning of built.warnings) {
    dependencies.core.warning(warning);
  }

  dependencies.core.info(
    `Generated ${built.operationCount} ${specType} contract item(s) (${built.format}). ` +
      protocolExecutionNote(specType, built.runnableInCi)
  );

  if (built.format !== 'v3-ec') {
    throw new Error(
      `CONTRACT_COLLECTION_FORMAT_UNSUPPORTED: protocol builder returned ${built.format}; only v3-ec collections are created (access-token EC API)`
    );
  }

  const provisioned = await provisionWorkspace(
    inputs,
    dependencies,
    telemetry,
    outputs,
    resourcesState,
    workspaceName,
    aboutText
  );
  const workspaceId = provisioned.workspaceId;
  const persistWorkspaceId = provisioned.persistable;
  outputs['workspace-id'] = workspaceId || '';
  persistWorkspaceOnlyState(
    stateStore,
    writableResourcesState,
    inputs,
    outputs,
    persistWorkspaceId,
    inputs.projectName
  );

  const contractCollectionId = await createExtensibleContractCollection(
    workspaceId || '',
    built,
    inputs,
    dependencies,
    writableResourcesState
  );

  outputs['contract-collection-id'] = contractCollectionId;
  outputs['collections-json'] = JSON.stringify({
    baseline: '',
    smoke: '',
    contract: contractCollectionId
  });

  recordCurrentBootstrapResources({
    assetProjectName: inputs.projectName,
    inputs,
    outputs,
    persistWorkspaceId,
    resourcesState: writableResourcesState
  });
  stateStore.write(writableResourcesState);

  for (const [name, value] of Object.entries(outputs)) {
    dependencies.core.setOutput(name, value);
  }
  return outputs;
}

/**
 * Create a v3/Extensible contract collection through the gateway EC API. Used by
 * every protocol: graphql/soap (transformed from v2 via runtime.models) and gRPC
 * (built EC-native). The collection is created empty, then each folder and
 * request item is materialized under it. Requires the EC client (access-token only).
 *
 * Idempotent refresh: an EC contract collection resolved from
 * `contract-collection-id` or `.postman/resources.yaml` is deleted and rebuilt
 * (the EC API has no in-place tree replace, so a clean rebuild is the honest
 * refresh). Atomic: if populating the freshly created collection fails, the
 * half-built collection is deleted before rethrowing so no orphaned, partially
 * populated collection is left behind.
 */
export async function createExtensibleContractCollection(
  workspaceId: string,
  built: ProtocolCollectionResult,
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies,
  resourcesState: PostmanResourcesState
): Promise<string> {
  if (!dependencies.ecClient) {
    throw new Error(
      'EC_REQUIRES_ACCESS_TOKEN: creating an extensible (v3) contract collection requires postman-access-token; ' +
        'provide postman-access-token (resolve-service-token mints one) to enable the contract path.'
    );
  }
  const ecClient = dependencies.ecClient;
  // Two EC tree shapes feed this path: the runtime.models transform output
  // (graphql/soap) is typed at the root (`title`, `payload`, `extensions`); the
  // native gRPC builder uses a v2-style `info.name` envelope. Resolve from both.
  const collectionInfo =
    built.collection.info && typeof built.collection.info === 'object'
      ? (built.collection.info as Record<string, unknown>)
      : undefined;
  const collectionName =
    (typeof built.collection.title === 'string' && built.collection.title.trim()) ||
    (typeof collectionInfo?.name === 'string' && collectionInfo.name.trim()) ||
    `${inputs.projectName} Contract`;
  // Forward the transform's collection-level payload (lifted `variables`, e.g.
  // baseUrl) and extensions (documentation); absent on the gRPC tree (no-op).
  const collectionPayload =
    built.collection.payload && typeof built.collection.payload === 'object'
      ? (built.collection.payload as Record<string, unknown>)
      : undefined;
  const collectionExtensions =
    built.collection.extensions && typeof built.collection.extensions === 'object'
      ? (built.collection.extensions as Record<string, unknown>)
      : undefined;

  // State chain: explicit input -> checked-out resources.yaml. An EC contract
  // collection already on record is refreshed (delete-and-recreate).
  let existingId = inputs.contractCollectionId?.trim() || undefined;
  if (!existingId) {
    existingId = findCloudResourceId(
      resolveResourcesStateStore(dependencies).read()?.cloudResources?.collections,
      (filePath) => filePath.includes(CONTRACT_COLLECTION_PREFIX)
    );
  }

  const label = built.type.toUpperCase();
  return runGroup(
    dependencies.core,
    'Create Contract Collection (EC)',
    async () => {
      if (existingId) {
        try {
          await ecClient.deleteExtensibleCollection(existingId);
          dependencies.core.info(
            `Refreshing ${label} EC contract collection: deleted existing ${existingId} before rebuild.`
          );
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            // Verified gone; replacement is safe.
          } else if (isAmbiguousTransportError(error)) {
            // The delete may have committed. Re-read durable state and live ID
            // before replacement; if the old collection still exists, stop.
            resolveResourcesStateStore(dependencies).read();
            try {
              await ecClient.getExtensibleCollection(existingId);
              throw error;
            } catch (readError) {
              if (!(readError instanceof HttpError && readError.status === 404)) {
                throw readError;
              }
            }
          } else {
            throw error;
          }
        }
      }

      const collectionId = await ecClient.createExtensibleCollection(workspaceId, {
        name: collectionName,
        ...(collectionPayload ? { payload: collectionPayload } : {}),
        ...(collectionExtensions ? { extensions: collectionExtensions } : {})
      });
      // Never invent workspace.id here — persistability is owned by
      // provisionWorkspace + recordCurrentBootstrapResources.
      resourcesState.cloudResources ??= {};
      resourcesState.cloudResources.collections ??= {};
      resourcesState.cloudResources.collections[
        generatedCollectionResourcePath(CONTRACT_COLLECTION_PREFIX, inputs.projectName)
      ] = collectionId;
      resolveResourcesStateStore(dependencies).write(resourcesState);
      let leafCount: number;
      try {
        leafCount = await ecClient.populateFromTree(collectionId, built.collection);
      } catch (error) {
        // Atomic: never leave a half-populated collection behind.
        const mask = createBootstrapSecretMasker(inputs);
        const populationCause = formatMaskedOneLine(error, mask);
        try {
          await ecClient.deleteExtensibleCollection(collectionId);
          dependencies.core.warning(
            formatMaskedOneLine(
              `Populating ${label} EC contract collection ${collectionId} (${collectionName}) failed: ${populationCause}; ` +
                'cleanup deleted the partial collection. ' +
                'Remediation: fix the population failure and rerun; no manual delete needed.',
              mask
            )
          );
        } catch (cleanupError) {
          const cleanupCause = formatMaskedOneLine(cleanupError, mask);
          dependencies.core.warning(
            formatMaskedOneLine(
              `Populating ${label} EC contract collection ${collectionId} (${collectionName}) failed: ${populationCause}; ` +
                `cleanup also failed: ${cleanupCause}. ` +
                `Remediation: delete collection ${collectionId} manually, then fix the population failure and rerun.`,
              mask
            )
          );
        }
        throw error;
      }
      dependencies.core.info(
        `Created ${label} extensible collection ${collectionId} with ${leafCount} request item(s).`
      );
      return collectionId;
    }
  );
}

async function runBootstrapInner(
  inputs: ResolvedInputs,
  dependencies: BootstrapExecutionDependencies,
  telemetry: TelemetryContext
): Promise<PlannedOutputs> {
  const outputs = createPlannedOutputs(inputs);

  // Branch-aware sync: the effective BranchDecision (inherited from the
  // decide step via POSTMAN_BRANCH_DECISION, or resolved locally; legacy under
  // default inputs). The canonical workspace name is computed BEFORE any
  // preview/channel renaming: preview and channel asset sets live in the same
  // canonical workspace.
  const branchDecision = decideBranchTier(inputs);
  const isCanonicalWriter = branchDecision.tier === 'legacy' || branchDecision.tier === 'canonical';
  const canonicalProjectName = inputs.projectName;
  const workspaceName = createWorkspaceName(inputs);
  const aboutText = `Auto-provisioned by Postman for ${inputs.projectName}`;
  if (branchDecision.tier === 'preview' && branchDecision.identity.headBranch) {
    inputs = {
      ...inputs,
      projectName: previewAssetName(inputs.projectName, branchDecision.identity.headBranch)
    };
    dependencies.core.info(`branch-aware sync: preview asset set "${inputs.projectName}"`);
  } else if (branchDecision.tier === 'channel' && branchDecision.channel) {
    inputs = {
      ...inputs,
      projectName: channelAssetName(inputs.projectName, branchDecision.channel.code)
    };
    dependencies.core.info(`branch-aware sync: channel asset set "${inputs.projectName}"`);
  }
  const collectionBranchMarker = renderCollectionBranchMarker(branchDecision, inputs.repoUrl);
  if (branchDecision.tier !== 'legacy') {
    outputs['sync-status'] = 'synced';
    outputs['branch-decision'] = serializeBranchDecision(branchDecision);
  }

  // Runtime guard (state v2): a non-canonical run handed an explicit canonical
  // asset id would mutate canonical assets from a branch. Refuse loud instead
  // of quietly writing. workspace-id is allowed: the workspace is shared
  // infrastructure that preview/channel sets live inside.
  if (!isCanonicalWriter) {
    const explicitCanonicalIds = [
      ['spec-id', inputs.specId],
      ['baseline-collection-id', inputs.baselineCollectionId],
      ['smoke-collection-id', inputs.smokeCollectionId],
      ['contract-collection-id', inputs.contractCollectionId]
    ].filter(([, value]) => Boolean(value));
    if (explicitCanonicalIds.length > 0) {
      throw new Error(
        `CONTRACT_BRANCH_CANONICAL_WRITE: a ${branchDecision.tier} run must not mutate canonical assets, but explicit asset id input(s) were provided: ${explicitCanonicalIds.map(([name]) => name).join(', ')}. Remove them (preview/channel runs discover or create their own suffixed asset sets).`
      );
    }
  }

  const requiresReleaseLabel =
    inputs.collectionSyncMode === 'version' || inputs.specSyncMode === 'version';
  const releaseLabel = requiresReleaseLabel ? deriveReleaseLabel(inputs) : undefined;
  if (requiresReleaseLabel && !releaseLabel) {
    throw new Error(
      'Versioned spec or collection sync requires a release-label or derivable GitHub ref metadata'
    );
  }
  const collectionAssetProjectName =
    branchDecision.tier === 'channel'
      ? canonicalProjectName
      : inputs.collectionSyncMode === 'version'
      ? createAssetProjectName(inputs, releaseLabel)
      : inputs.projectName;
  const artifactProjectName = deriveArtifactSafeCollectionName(collectionAssetProjectName);

  // Validated before any side effect (CLI install, spec upload, workspace
  // create, ...): an invalid additional-collections-dir must fail fast, not
  // after partial provisioning has already run.
  //
  // State v2 (canonical-only): tracked .postman/resources.yaml is written ONLY
  // by canonical/legacy runs, and asset ids are resolved from it ONLY on
  // canonical/legacy runs (ref-aware v1 migration: a branch run with inherited
  // v1 state neither clobbers nor resolves from it). Non-canonical runs keep
  // workspace identity (shared infrastructure) but never canonical asset ids.
  const rawStateStore = resolveResourcesStateStore(dependencies);
  const trackedState = rawStateStore.read();
  const stateStore = isCanonicalWriter
    ? rawStateStore
    : {
        read: rawStateStore.read,
        write: (): void => {
          dependencies.core.info(
            `branch-aware sync: skipping .postman/resources.yaml write on ${branchDecision.tier} run (canonical-only tracked state)`
          );
        }
      };
  const resourcesState = isCanonicalWriter
    ? trackedState
    : trackedState?.workspace
      ? { workspace: trackedState.workspace }
      : null;
  if (!isCanonicalWriter && trackedState?.cloudResources) {
    dependencies.core.info(
      'branch-aware sync: canonical asset ids in .postman/resources.yaml are not resolved on a non-canonical run'
    );
  }
  const writableResourcesState: PostmanResourcesState = resourcesState ?? {};
  const additionalCollections = loadAdditionalCollectionFiles(
    inputs.additionalCollectionsDir,
    resourcesState
  );

  let specId = resolveSpecIdFromResourcesState(inputs, resourcesState, releaseLabel);
  if (!inputs.specId && specId) {
    dependencies.core.info('Resolved spec-id from .postman/resources.yaml');
  }

  let previousSpecContent: string | undefined;
  let previousSpecRollbackHash: string | undefined;
  let previousBundleSnapshot: SpecBundleSnapshot | undefined;
  let createdNewSpec = false;
  let specContentUnchanged = false;
  let detectedOpenapiVersion: '3.0' | '3.1' = '3.0';
  let contractIndex: ContractIndex | undefined;
  let sourceSpecContent = '';
  let sourceTypeNullPaths: string[] = [];
  let preserveSourceSpecBytes = false;
  let bundledCompatibilitySpecContent = '';
  let sourceDefinitionBundle: DefinitionBundle | undefined;
  let uploadDefinitionBundle: DefinitionBundle | undefined;

  // Acquire a confined DefinitionBundle (local) or safe single-root content (URL)
  // before any side effects. Inventory is rejected with spec-url at input resolve.
  const acquired = await runGroup(
    dependencies.core,
    'Read API Spec',
    async () => {
      if (inputs.specPath) {
        const bundle = await acquireDefinitionBundle({
          workspaceRoot: resolveWorkspaceRoot(),
          specPath: inputs.specPath,
          specFilesJson: inputs.specFilesJson
        });
        const root = bundle.files.get(bundle.rootPath);
        if (!root) {
          throw new Error('CONTRACT_DEFINITION_ROOT_MISMATCH: acquired bundle is missing its root file');
        }
        return { bundle, rawSpecContent: root.content };
      }
      if (inputs.specFilesJson) {
        throw new Error(
          'CONTRACT_DEFINITION_INVENTORY_WITH_URL: spec-files-json cannot be combined with spec-url'
        );
      }
      const rawSpecContent =
        dependencies.specFetcher === fetch
          ? await safeFetchText(inputs.specUrl, { depth: 0 })
          : await fetchSpecDocument(inputs.specUrl, dependencies.specFetcher);
      return { bundle: undefined, rawSpecContent };
    }
  );
  sourceDefinitionBundle = acquired.bundle;
  const rawSpecContent = acquired.rawSpecContent;
  const specSourceName = inputs.specPath || inputs.specUrl;
  const resolvedSpecType: SpecType =
    inputs.protocol && inputs.protocol !== 'auto'
      ? inputs.protocol
      : sourceDefinitionBundle
        ? definitionFormatToSpecType(sourceDefinitionBundle.format)
        : detectSpecType(rawSpecContent, specSourceName);
  if (resolvedSpecType !== 'openapi') {
    dependencies.core.info(`Detected ${resolvedSpecType} spec; using multi-protocol contract path`);
    // Protocol collections are local EC generation; protobuf never uploads to Spec Hub.
    return runProtocolBootstrap(
      resolvedSpecType,
      rawSpecContent,
      inputs,
      dependencies,
      outputs,
      telemetry,
      sourceDefinitionBundle
    );
  }

  const useMultiFileSync = Boolean(sourceDefinitionBundle && sourceDefinitionBundle.files.size > 1);

  const specContent = await runGroup(
    dependencies.core,
    'Preflight OpenAPI Contract',
    async () => {
      // Reuse the already-fetched root bytes for the root resource so the spec
      // is read exactly once; external $refs still flow through the real fetcher
      // (or the SSRF-guarded default, preserving the loader's fetch options).
      // The loader normalizes the root URL (drops the hash) before calling
      // fetchText, so match on the same normalized form.
      const normalizeRef = (value: string): string => {
        try {
          const u = new URL(value);
          u.hash = '';
          return u.toString();
        } catch {
          return value;
        }
      };
      const rootKey = inputs.specPath ? undefined : normalizeRef(inputs.specUrl);
      const loaderOptions = {
        preserveOas30TypeNull: Boolean(inputs.preserveOas30TypeNull),
        definitionBundle: sourceDefinitionBundle,
        specFilesJson: inputs.specFilesJson,
        fetchText: async (url: string, fetchOptions: Parameters<typeof safeFetchText>[1]) => {
          if (rootKey && normalizeRef(url) === rootKey) return rawSpecContent;
          if (dependencies.specFetcher === fetch) return safeFetchText(url, fetchOptions);
          return fetchSpecDocument(url, dependencies.specFetcher);
        }
      };
      const loaded = inputs.specPath
        ? await loadOpenApiContractSpecFromPath(inputs.specPath, loaderOptions)
        : await loadOpenApiContractSpec(inputs.specUrl, loaderOptions);
      if (loaded.definitionBundle) {
        sourceDefinitionBundle = loaded.definitionBundle;
      }
      sourceSpecContent = loaded.content;
      sourceTypeNullPaths = loaded.sourceTypeNullPaths;
      preserveSourceSpecBytes = sourceTypeNullPaths.length > 0;
      // Contract validation/index uses the bundled document; Spec Hub sync keeps
      // the original file tree (root may later receive normalize/branch markers).
      const document = normalizeSpecDocument(loaded.bundledContent, (msg) =>
        dependencies.core.warning(msg)
      );
      bundledCompatibilitySpecContent = document;
      contractIndex = buildContractIndex(parseOpenApiDocument(document));
      const incomingSpecType = normalizeSpecTypeFromContent(document);
      detectedOpenapiVersion = incomingSpecType.replace('OPENAPI:', '') as '3.0' | '3.1';
      for (const warning of contractIndex.warnings) {
        dependencies.core.warning(warning);
      }

      if (inputs.openapiVersion && inputs.openapiVersion !== detectedOpenapiVersion) {
        throw new Error(
          `openapi-version input ${inputs.openapiVersion} does not match spec content OpenAPI ${detectedOpenapiVersion}`
        );
      }

      if (specId) {
        if (useMultiFileSync && sourceDefinitionBundle) {
          const priorBundle = await requireBundleGatewayOp(
            dependencies.postman.getSpecBundle,
            'getSpecBundle'
          )(specId, sourceDefinitionBundle.format);
          previousBundleSnapshot = definitionBundleToSnapshot(priorBundle);
          previousSpecRollbackHash = priorBundle.digest;
          const previousRoot = priorBundle.files.get(priorBundle.rootPath)?.content;
          if (!previousRoot) {
            throw new Error(
              `Unable to verify existing Spec Hub OpenAPI version for spec-id ${specId}; clear spec-id to create a fresh spec`
            );
          }
          previousSpecContent = preserveSourceSpecBytes
            ? previousRoot
            : normalizeSpecDocument(previousRoot, (msg) =>
              dependencies.core.warning(`Previous spec normalization: ${msg}`)
            );
          const existingSpecType = normalizeSpecTypeFromContent(previousSpecContent);
          if (existingSpecType !== incomingSpecType) {
            throw new Error(
              `Existing Spec Hub spec version ${existingSpecType.replace('OPENAPI:', '')} cannot be updated with OpenAPI ${detectedOpenapiVersion} content; clear spec-id to create a fresh spec`
            );
          }
        } else {
          const previousRaw = await dependencies.postman.getSpecContent(specId);
          if (!previousRaw) {
            throw new Error(
              `Unable to verify existing Spec Hub OpenAPI version for spec-id ${specId}; clear spec-id to create a fresh spec`
            );
          }
          previousSpecContent = preserveSourceSpecBytes
            ? previousRaw
            : normalizeSpecDocument(previousRaw, (msg) =>
              dependencies.core.warning(`Previous spec normalization: ${msg}`)
            );
          previousSpecRollbackHash = createHash('sha256').update(previousSpecContent).digest('hex');
          const existingSpecType = normalizeSpecTypeFromContent(previousSpecContent);
          if (existingSpecType !== incomingSpecType) {
            throw new Error(
              `Existing Spec Hub spec version ${existingSpecType.replace('OPENAPI:', '')} cannot be updated with OpenAPI ${detectedOpenapiVersion} content; clear spec-id to create a fresh spec`
            );
          }
        }
      }

      dependencies.core.info(
        `Auto-detected OpenAPI version from spec content: ${detectedOpenapiVersion}`
      );
      if (preserveSourceSpecBytes) {
        dependencies.core.info(
          `Preserving original OpenAPI source bytes; accepted ${sourceTypeNullPaths.length} legacy type: null member(s) for internal validation`
        );
        return loaded.content;
      }
      return document;
    }
  );

  const breakingChangeResult = await runGroup(
    dependencies.core,
    'OpenAPI Breaking Change Check',
    async () => (dependencies.openApiChanges ?? runOpenApiBreakingChangeCheck)(
      {
        baselineSpecPath: inputs.breakingBaselineSpecPath,
        // Breaking checks retain the original source tree/root, not upload markers.
        currentSourceContent: sourceSpecContent,
        currentUploadContent: specContent,
        logPath: inputs.breakingLogPath,
        mode: inputs.breakingChangeMode,
        previousSpecContent,
        rulesPath: inputs.breakingRulesPath,
        specPath: inputs.specPath,
        summaryPath: inputs.breakingSummaryPath,
        targetRef: inputs.breakingTargetRef
      },
      {
        core: dependencies.core,
        env: process.env,
        exec: dependencies.exec
      }
    )
  );
  outputs['breaking-change-status'] = breakingChangeResult.status;
  outputs['breaking-change-summary-json'] = createBreakingChangeSummaryJson(breakingChangeResult);
  if (breakingChangeResult.status === 'failed') {
    dependencies.core.setOutput('breaking-change-status', outputs['breaking-change-status']);
    dependencies.core.setOutput('breaking-change-summary-json', outputs['breaking-change-summary-json']);
    throw new Error(
      `OpenAPI breaking-change check failed: ${breakingChangeResult.message || 'breaking changes detected'}`
    );
  }

  const uploadSpecContent = embedSpecBranchMarker(
    specContent,
    branchDecision,
    inputs.repoUrl
  );
  if (sourceDefinitionBundle && useMultiFileSync) {
    // Final immutable upload bundle: companions keep exact source bytes; only
    // the root receives normalize/branch-marker changes.
    uploadDefinitionBundle = withReplacedRootContent(sourceDefinitionBundle, uploadSpecContent);
    assertMultiFileSpecSyncEnabled(uploadDefinitionBundle);
  }

  const provisioned = await provisionWorkspace(
    inputs,
    dependencies,
    telemetry,
    outputs,
    resourcesState,
    workspaceName,
    aboutText
  );
  const workspaceId = provisioned.workspaceId;
  const persistWorkspaceId = provisioned.persistable;
  outputs['workspace-id'] = workspaceId || '';
  // Workspace-only state may persist immediately; spec/collection ids wait.
  persistWorkspaceOnlyState(
    stateStore,
    writableResourcesState,
    inputs,
    outputs,
    persistWorkspaceId,
    collectionAssetProjectName,
    releaseLabel
  );

  let baselineCollectionId = inputs.baselineCollectionId;
  let smokeCollectionId = inputs.smokeCollectionId;
  let contractCollectionId = inputs.contractCollectionId;

  const cloudCollections = resourcesState?.cloudResources?.collections;
  if (!baselineCollectionId) {
    baselineCollectionId = findCloudResourceId(
      cloudCollections,
      (filePath) => matchesBaselineCollectionResource(filePath, artifactProjectName)
    );
    if (baselineCollectionId) {
      dependencies.core.info('Resolved baseline-collection-id from .postman/resources.yaml');
    }
  }
  if (!smokeCollectionId) {
    smokeCollectionId = findCloudResourceId(
      cloudCollections,
      (filePath) => matchesPrefixedCollectionResource(
        filePath,
        SMOKE_COLLECTION_PREFIX,
        artifactProjectName
      )
    );
    if (smokeCollectionId) {
      dependencies.core.info('Resolved smoke-collection-id from .postman/resources.yaml');
    }
  }
  if (!contractCollectionId) {
    contractCollectionId = findCloudResourceId(
      cloudCollections,
      (filePath) => matchesPrefixedCollectionResource(
        filePath,
        CONTRACT_COLLECTION_PREFIX,
        artifactProjectName
      )
    );
    if (contractCollectionId) {
      dependencies.core.info('Resolved contract-collection-id from .postman/resources.yaml');
    }
  }

  const assertDistinctCollectionIds = (
    ids: Record<'baseline' | 'contract' | 'smoke', string | undefined>
  ): void => {
    const seen = new Map<string, string>();
    for (const [slot, id] of Object.entries(ids)) {
      if (!id) continue;
      const previous = seen.get(id);
      if (previous) {
        throw new Error(
          `CONTRACT_COLLECTION_ID_COLLISION: ${previous} and ${slot} collection IDs both resolve to ${id}`
        );
      }
      seen.set(id, slot);
    }
  };

  assertDistinctCollectionIds({
    baseline: baselineCollectionId,
    contract: contractCollectionId,
    smoke: smokeCollectionId
  });

  if (specId) {
    const specSource = inputs.specPath ? `path ${inputs.specPath}` : sanitizeUrlForLog(inputs.specUrl);
    dependencies.core.info(`Updating existing spec ${specId} from ${specSource}`);
  }

  const isSpecUpdate = Boolean(specId);
  let rollbackTriggerStage = 'Post-update bootstrap';
  const completedExternalSideEffects: string[] = [];
  const runRollbackStage = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    rollbackTriggerStage = stage;
    return await fn();
  };
  const restorePreviousSpecContent = async (reason: string): Promise<void> => {
    if (!specId) return;
    if (createdNewSpec) {
      if (!dependencies.postman.deleteSpec) {
        dependencies.core.warning(
          `Incomplete new Spec Hub specification ${specId} was left after failure (${reason}); deleteSpec is unavailable for cleanup`
        );
        return;
      }
      try {
        await runGroup(dependencies.core, 'Delete Failed New Spec', async () => {
          await retry(
            async () => {
              try {
                await dependencies.postman.deleteSpec!(specId || '');
              } catch (deleteError) {
                // Peer election or a prior cleanup may have already removed the
                // loser; 404 is successful idempotent deletion.
                if (deleteError instanceof HttpError && deleteError.status === 404) return;
                const status = (deleteError as { status?: unknown })?.status;
                if (status === 404) return;
                throw deleteError;
              }
            },
            {
              maxAttempts: 3,
              delayMs: 1000
            }
          );
        });
        dependencies.core.warning(
          `Deleted incomplete new Spec Hub specification ${specId} after failure (${reason})`
        );
      } catch (cleanupError) {
        throw new Error(
          `CONTRACT_SPEC_ROLLBACK_FAILED: Failed to delete incomplete new Spec Hub specification ${specId} after ${reason}. ` +
            `digest=${previousSpecRollbackHash || uploadDefinitionBundle?.digest || '<unknown>'}. ` +
            `Rollback error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { cause: cleanupError }
        );
      }
      return;
    }
    if (!isSpecUpdate) return;
    try {
      await runGroup(
        dependencies.core,
        'Restore Previous Spec Content',
        async () => {
          await retry(
            async () => {
              if (previousBundleSnapshot) {
                const outcome = await requireBundleGatewayOp(
                  dependencies.postman.restoreSpecBundle,
                  'restoreSpecBundle'
                )(specId || '', previousBundleSnapshot);
                if (outcome.status !== 'ok' || outcome.verifiedDigest !== previousBundleSnapshot.digest) {
                  throw new Error(
                    `restoreSpecBundle verification failed (expected digest ${previousBundleSnapshot.digest})`
                  );
                }
                return;
              }
              if (previousSpecContent === undefined) {
                throw new Error('No previous Spec Hub snapshot available for restore');
              }
              await dependencies.postman.updateSpec(
                specId || '',
                previousSpecContent || '',
                workspaceId
              );
            },
            { maxAttempts: 3, delayMs: 1000 }
          );
        }
      );
      dependencies.core.warning(
        `Restored previous Spec Hub content for ${specId} after failure (${reason}); ` +
          `previous content sha256=${previousSpecRollbackHash || '<unknown>'}`
      );
    } catch (rollbackError) {
      throw new Error(
        `CONTRACT_SPEC_ROLLBACK_FAILED: Failed to restore previous Spec Hub content for ${specId} after ${reason}. ` +
          `Manually restore content with sha256=${previousSpecRollbackHash || '<unknown>'}. ` +
          `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: rollbackError }
      );
    }
  };

  // Run-owned fresh-import ledger stays live through link readback + tags so
  // failures before resources persist can compensate journaled imports only.
  // Declared outside try so catch can invoke compensation.
  const ownedLedger: string[] = [];
  let artifactRestore: (() => Promise<void>) | undefined;
  let localOpenApiRepoRoot: string | undefined;
  let pendingFinalizedLocalOpenApiManifest: FinalizedLocalOpenApiArtifactManifest | undefined;
  let ownedLocalOpenApiCompensated = false;

  const compensateOwnedLocalOpenApiImports = async (stage: string): Promise<void> => {
    if (ownedLocalOpenApiCompensated) return;
    ownedLocalOpenApiCompensated = true;
    const mask = createBootstrapSecretMasker(inputs);
    if (ownedLedger.length > 0 && dependencies.postman.deleteVerifiedRunOwnedCollections) {
      try {
        await dependencies.postman.deleteVerifiedRunOwnedCollections([...ownedLedger]);
      } catch (cleanupError) {
        dependencies.core.warning(
          formatMaskedOneLine(
            `Owned OpenAPI import cleanup failed at ${stage}: ${formatMaskedOneLine(cleanupError, mask)}`,
            mask
          )
        );
      }
    }
    if (artifactRestore) {
      await artifactRestore().catch(() => undefined);
      artifactRestore = undefined;
    }
    if (localOpenApiRepoRoot) {
      await rm(path.join(localOpenApiRepoRoot, '.postman', 'local-openapi-artifact-manifest.json'), {
        force: true
      }).catch(() => undefined);
    }
  };

  const failOwned = async (stage: string, cause: unknown): Promise<never> => {
    const mask = createBootstrapSecretMasker(inputs);
    const sanitizedCause = formatMaskedOneLine(cause, mask).slice(0, 240);
    await compensateOwnedLocalOpenApiImports(stage);
    throw new Error(
      `LOCAL_OPENAPI_ORCHESTRATION_FAILED: stage=${stage} ledger=[${ownedLedger.join(',')}] cause=${sanitizedCause}`
    );
  };

  try {
  await runRollbackStage(
    specId ? 'Update Spec in Spec Hub' : 'Upload Spec to Spec Hub',
    async () => runGroup(
      dependencies.core,
      specId ? 'Update Spec in Spec Hub' : 'Upload Spec to Spec Hub',
      async () => {
        const assetName = createAssetProjectName(
          inputs,
          inputs.specSyncMode === 'version' ? releaseLabel : undefined
        );
        if (useMultiFileSync && uploadDefinitionBundle) {
          if (specId) {
            const outcome: SpecBundleMutationOutcome = await requireBundleGatewayOp(
              dependencies.postman.reconcileSpecBundle,
              'reconcileSpecBundle'
            )(specId, uploadDefinitionBundle);
            previousBundleSnapshot = outcome.priorSnapshot;
            previousSpecRollbackHash = outcome.priorSnapshot.digest;
            if (outcome.status === 'verification-needed') {
              throw new Error(
                `Spec Hub multi-file reconcile needs verification for ${specId}: ${outcome.reason}`
              );
            }
            if (!outcome.changed) {
              specContentUnchanged = true;
              dependencies.core.info(
                `Spec content unchanged (full-set digest match); skipping Spec Hub update and version tag for ${specId}.`
              );
            } else {
              dependencies.core.info(
                `Updated multi-file spec ${specId} (detected version: ${detectedOpenapiVersion}; digest ${outcome.verifiedDigest}).`
              );
            }
          } else {
            const uploaded = await requireBundleGatewayOp(
              dependencies.postman.uploadSpecBundle,
              'uploadSpecBundle'
            )(workspaceId || '', assetName, uploadDefinitionBundle, detectedOpenapiVersion);
            if (uploaded.outcome.status === 'verification-needed') {
              throw new Error(
                `Spec Hub multi-file create needs verification: ${uploaded.outcome.reason}`
              );
            }
            specId = uploaded.specId;
            createdNewSpec = uploaded.created;
            previousBundleSnapshot = uploaded.priorSnapshot ?? undefined;
            previousSpecRollbackHash = uploaded.priorSnapshot?.digest || '';
          }
        } else if (specId) {
          // Single-file wrapper path (URL and local one-file).
          if (
            previousSpecContent !== undefined &&
            createHash('sha256').update(uploadSpecContent).digest('hex') ===
              createHash('sha256').update(previousSpecContent).digest('hex')
          ) {
            specContentUnchanged = true;
            dependencies.core.info(
              `Spec content unchanged (sha256 match); skipping Spec Hub update and version tag for ${specId}.`
            );
          } else {
            dependencies.core.info(
              `Updating existing spec ${specId} (detected version: ${detectedOpenapiVersion}). ` +
                `Note: the spec type (OPENAPI:3.0 / OPENAPI:3.1) is set at creation and cannot be changed on update. ` +
                `If you changed OpenAPI versions, clear the spec-id input to create a fresh spec.`
            );
            await dependencies.postman.updateSpec(specId, uploadSpecContent, workspaceId);
          }
        } else {
          if (dependencies.postman.uploadSpecWithOutcome) {
            const uploaded = await dependencies.postman.uploadSpecWithOutcome(
              workspaceId || '',
              assetName,
              uploadSpecContent,
              detectedOpenapiVersion
            );
            specId = uploaded.specId;
            createdNewSpec = uploaded.created;
          } else {
            specId = await dependencies.postman.uploadSpec(
              workspaceId || '',
              assetName,
              uploadSpecContent,
              detectedOpenapiVersion
            );
            createdNewSpec = true;
          }
        }
        outputs['spec-id'] = specId;
        // Defer resources-state persistence of spec-id until verified sync +
        // generation/linking succeed (workspace-only state already written).
      }
    )
  );

  // Repo-sync owns tag publication. Its finalize boundary certifies the whole
  // onboarding run rather than only this spec upload.
  outputs['spec-content-changed'] = isCanonicalWriter && !specContentUnchanged ? 'true' : 'false';

  outputs['lint-summary-json'] = JSON.stringify({
    status: 'skipped',
    reason: 'bootstrap does not invoke the Postman CLI lint'
  });

  let localOpenApiGenerationOptions: ReturnType<typeof buildLocalOpenApiConversionOptions> | undefined;
  let observedLocalOpenApiPostman = dependencies.postman;
  let observedLocalOpenApiIntegration = dependencies.internalIntegration;
  let openApiOperationLedger:
    | {
        schemaVersion: 1;
        mode: 'local';
        phase: 'fresh' | 'changed-deep-update' | 'mixed-import-deep-update';
        roleCount: number;
        counts: Record<string, number>;
        timings: { conversionMs: number; importMs: number; totalMs: number };
        linkRelationStates?: Record<string, string>;
      }
    | undefined;
  void openApiOperationLedger;
  if (specContentUnchanged) {
    // A canonical no-op has no new spec changelog group. Keep the existing
    // collection identities but do not regenerate them from unchanged input.
    outputs['baseline-collection-id'] = baselineCollectionId || '';
    outputs['smoke-collection-id'] = smokeCollectionId || '';
    outputs['contract-collection-id'] = contractCollectionId || '';
    dependencies.core.info('Spec content unchanged; skipping collection regeneration and version finalization.');
  } else await runRollbackStage(
    'Generate Collections from Spec',
    async () => runGroup(
      dependencies.core,
      'Generate Collections from Spec',
      async () => {
        const assetProjectName = collectionAssetProjectName;
        const orchestrationStarted = Date.now();
        type CollectionOutputKey =
          | 'baseline-collection-id'
          | 'smoke-collection-id'
          | 'contract-collection-id';
        const collectionRoles: Array<{
          role: CollectionRole;
          prefix: GeneratedCollectionPrefix;
          existingId: string | undefined;
          outputKey: CollectionOutputKey;
        }> = [
          {
            role: 'baseline',
            prefix: BASELINE_COLLECTION_PREFIX,
            existingId: baselineCollectionId,
            outputKey: 'baseline-collection-id'
          },
          {
            role: 'smoke',
            prefix: SMOKE_COLLECTION_PREFIX,
            existingId: smokeCollectionId,
            outputKey: 'smoke-collection-id'
          },
          {
            role: 'contract',
            prefix: CONTRACT_COLLECTION_PREFIX,
            existingId: contractCollectionId,
            outputKey: 'contract-collection-id'
          }
        ];

        if (!contractIndex) {
          throw new Error('CONTRACT_PLAN_MISSING: Contract plan was not created during OpenAPI preflight');
        }
        if (!dependencies.postman.importV2Collection || !dependencies.postman.deepUpdateV2Collection) {
          throw new Error(
            'LOCAL_OPENAPI_ORCHESTRATION_FAILED: importV2Collection/deepUpdateV2Collection require access-token gateway support'
          );
        }

        const roleNames = {} as Record<CollectionRole, string>;
        const artifactRoleNames = {} as Record<CollectionRole, string>;
        for (const role of collectionRoles) {
          const effectivePrefix =
            branchDecision.tier === 'channel' && branchDecision.channel
              ? channelAssetName(role.prefix, branchDecision.channel.code).trim()
              : role.prefix;
          // Artifact paths reject control characters; normalize identity separators.
          roleNames[role.role] = [effectivePrefix, assetProjectName]
            .filter(Boolean)
            .join(' ')
            .replace(/[\r\n\u2028\u2029]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          artifactRoleNames[role.role] = [effectivePrefix, artifactProjectName]
            .filter(Boolean)
            .join(' ')
            .trim();
        }

        const conversionOptions = {
          openApiVersion: detectedOpenapiVersion,
          requestNameSource: inputs.requestNameSource as 'URL' | 'Fallback',
          folderStrategy: inputs.folderStrategy as 'Paths' | 'Tags',
          nestedFolderHierarchy: inputs.nestedFolderHierarchy,
          names: roleNames,
          ...(collectionBranchMarker ? { description: collectionBranchMarker } : {}),
          contractIndex
        };
        localOpenApiGenerationOptions = buildLocalOpenApiConversionOptions(conversionOptions);

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
        observedLocalOpenApiPostman = observeLocalOpenApiOperations(dependencies.postman, counts);
        observedLocalOpenApiIntegration = dependencies.internalIntegration
          ? observeLocalOpenApiOperations(dependencies.internalIntegration, counts)
          : undefined;
        let conversionMs: number;
        let importCount = 0;
        let updateCount = 0;

        let payloads: LocalOpenApiRolePayloads;
        const conversionStarted = Date.now();
        try {
          counts.localConversion += 1;
          payloads = await generateLocalOpenApiRolePayloads(bundledCompatibilitySpecContent, conversionOptions);
          conversionMs = Math.max(0, Date.now() - conversionStarted);
        } catch (error) {
          await failOwned('local-conversion', error);
          throw error;
        }
        for (const warning of payloads.warnings) {
          dependencies.core.warning(warning);
        }

        const repoRoot = resolveWorkspaceRoot();
        localOpenApiRepoRoot = repoRoot;
        const runTempDir = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'bootstrap-local-openapi-'));
        let materialized: MaterializeLocalCollectionArtifactsResult;
        try {
          materialized = await materializeLocalCollectionArtifacts({
            repoRoot,
            runTempDir,
            roles: collectionRoles.map((role) => ({
              role: role.role,
              collectionName: artifactRoleNames[role.role],
              collection: payloads.roles[role.role].collection,
              payloadDigest: payloads.roles[role.role].payloadDigest
            })),
            ...(inputs.specPath
              ? {
                  specPath: inputs.specPath,
                  options: { ...(localOpenApiGenerationOptions as Record<string, unknown>) },
                  syncOptions: { syncExamples: inputs.syncExamples }
                }
              : {})
          });
          artifactRestore = materialized.restore;
        } catch (error) {
          await failOwned('materialize-artifacts', error);
          throw error;
        }

        const importStarted = Date.now();
        type RoleWriteResult =
          | {
              role: CollectionRole;
              outputKey: CollectionOutputKey;
              kind: 'import';
              collectionId: string;
              journaledRootIds: string[];
            }
          | {
              role: CollectionRole;
              outputKey: CollectionOutputKey;
              kind: 'deep-update';
              collectionId: string;
            };
        const writeRole = async (role: (typeof collectionRoles)[number]): Promise<RoleWriteResult> => {
          const payload = payloads.roles[role.role];
          const finalName = roleNames[role.role];
          const useDeepUpdate =
            Boolean(role.existingId) && inputs.collectionSyncMode === 'refresh';
          if (useDeepUpdate) {
            const preservedId = await observedLocalOpenApiPostman.deepUpdateV2Collection!(
              role.existingId!,
              payload.collection,
              payload.payloadDigest
            );
            return {
              role: role.role,
              outputKey: role.outputKey,
              kind: 'deep-update',
              collectionId: preservedId
            };
          }
          const imported = await observedLocalOpenApiPostman.importV2Collection!(
            workspaceId || '',
            payload.collection,
            finalName
          );
          return {
            role: role.role,
            outputKey: role.outputKey,
            kind: 'import',
            collectionId: imported.collectionId,
            journaledRootIds: [...imported.journaledRootIds]
          };
        };
        // These writes share one workspace mutation and inventory surface. Keep
        // them serial to avoid self-generated import bursts, but continue after
        // a failure so every started role has a settled cleanup decision.
        const settledWrites: PromiseSettledResult<RoleWriteResult>[] = [];
        for (const role of collectionRoles) {
          try {
            settledWrites.push({ status: 'fulfilled', value: await writeRole(role) });
          } catch (reason) {
            settledWrites.push({ status: 'rejected', reason });
          }
        }
        const importMs = Math.max(0, Date.now() - importStarted);

        const roleOrder = collectionRoles.map((role) => role.role);
        const fulfilledByRole = new Map<CollectionRole, RoleWriteResult>();
        const failures: unknown[] = [];
        for (let i = 0; i < settledWrites.length; i += 1) {
          const settled = settledWrites[i]!;
          const role = roleOrder[i]!;
          if (settled.status === 'fulfilled') {
            fulfilledByRole.set(role, settled.value);
          } else {
            failures.push(settled.reason);
          }
        }
        for (const role of collectionRoles) {
          const result = fulfilledByRole.get(role.role);
          if (!result) continue;
          outputs[result.outputKey] = result.collectionId;
          if (result.kind === 'import') {
            for (const id of result.journaledRootIds) {
              if (!ownedLedger.includes(id)) ownedLedger.push(id);
            }
            importCount += 1;
            dependencies.core.info(
              `Imported ${result.role} collection ${result.collectionId} from local OpenAPI payload`
            );
          } else {
            updateCount += 1;
            dependencies.core.info(
              `Deep-updated existing ${result.role} collection ${result.collectionId} from local OpenAPI payload`
            );
          }
        }
        if (failures.length > 0) {
          await failOwned(
            importCount > 0 && updateCount > 0
              ? 'mixed-import-deep-update'
              : importCount > 0
                ? 'partial-import'
                : updateCount > 0
                  ? 'deep-update'
                  : 'cloud-collection-write',
            failures[0]
          );
        }

        const finalized = finalizeLocalOpenApiArtifactManifest(materialized.manifest, {
          baseline: outputs['baseline-collection-id'],
          smoke: outputs['smoke-collection-id'],
          contract: outputs['contract-collection-id']
        });
        // Persist only after verified link readback + tags succeed (before resources write).
        pendingFinalizedLocalOpenApiManifest = finalized;
        outputs['prebuilt-collections-json'] = JSON.stringify(finalized);

        const phase: 'fresh' | 'changed-deep-update' | 'mixed-import-deep-update' =
          importCount > 0 && updateCount > 0
            ? 'mixed-import-deep-update'
            : updateCount > 0
              ? 'changed-deep-update'
              : 'fresh';
        const ledger = {
          schemaVersion: 1 as const,
          mode: 'local' as const,
          phase,
          roleCount: 3,
          counts,
          timings: {
            conversionMs,
            importMs,
            totalMs: Math.max(0, Date.now() - orchestrationStarted)
          }
        };
        openApiOperationLedger = ledger;
        outputs['openapi-operation-ledger-json'] = JSON.stringify(ledger);
        const ledgerRel = path.join('.postman', 'bootstrap-openapi-operation-ledger.json');
        const ledgerAbs = path.join(repoRoot, ledgerRel);
        await mkdir(path.dirname(ledgerAbs), { recursive: true });
        await writeFile(ledgerAbs, `${JSON.stringify(ledger)}\n`, 'utf8');

        dependencies.core.info(
          `Local OpenAPI orchestration phase=${phase} imports=${importCount} deepUpdates=${updateCount} conversionMs=${conversionMs} importMs=${importMs}`
        );
      }
    )
  );

  outputs['collections-json'] = JSON.stringify({
    baseline: outputs['baseline-collection-id'],
    contract: outputs['contract-collection-id'],
    smoke: outputs['smoke-collection-id']
  });

  rollbackTriggerStage = 'Validate Collection Outputs';
  assertDistinctCollectionIds({
    baseline: outputs['baseline-collection-id'],
    contract: outputs['contract-collection-id'],
    smoke: outputs['smoke-collection-id']
  });

  if (additionalCollections.length > 0) {
    await runRollbackStage(
      'Sync Additional Collections',
      async () => runGroup(
        dependencies.core,
        'Sync Additional Collections',
        async () => {
          const additionalResults = await syncAdditionalCollections({
            collectionFiles: additionalCollections,
            core: dependencies.core,
            postman: dependencies.postman,
            resourcesState: writableResourcesState,
            writeResourcesState: () => undefined,
            workspaceId: workspaceId || ''
          });
          for (const result of additionalResults) {
            if (collectionBranchMarker) {
              if (!dependencies.postman.updateCollectionDescription) {
                throw new Error('Branch-scoped collections require updateCollectionDescription support');
              }
              await dependencies.postman.updateCollectionDescription(result.collectionId, collectionBranchMarker);
            }
            completedExternalSideEffects.push(
              `${result.operation}AdditionalCollection(${result.collectionId} from ${result.displayPath})`
            );
          }
        }
      )
    );
  }

  const linkedCollectionIds = [
    outputs['baseline-collection-id'],
    outputs['smoke-collection-id'],
    outputs['contract-collection-id']
  ].filter(Boolean);

  if (linkedCollectionIds.length > 0) {
    if (observedLocalOpenApiIntegration) {
      const localIntegration = observedLocalOpenApiIntegration;
      await runRollbackStage(
        'Link Collections to Specification',
        async () => runGroup(
          dependencies.core,
          'Link Collections to Specification',
          async () => {
            const linkOptions = localOpenApiGenerationOptions ?? buildLocalOpenApiConversionOptions({
              openApiVersion: detectedOpenapiVersion,
              requestNameSource: inputs.requestNameSource as 'URL' | 'Fallback',
              folderStrategy: inputs.folderStrategy as 'Paths' | 'Tags',
              nestedFolderHierarchy: inputs.nestedFolderHierarchy,
              names: {
                baseline: collectionAssetProjectName,
                smoke: `[Smoke] ${collectionAssetProjectName}`,
                contract: `[Contract] ${collectionAssetProjectName}`
              },
              contractIndex: contractIndex!
            });
            const expectedSyncOptions = { syncExamples: inputs.syncExamples };
            const linkResult = await localIntegration.linkCollectionsToSpecification(
              outputs['spec-id'],
              linkedCollectionIds.map((collectionId) => ({
                collectionId,
                options: { ...linkOptions },
                syncOptions: expectedSyncOptions
              }))
            );
            const lockedRetries =
              linkResult && typeof linkResult === 'object' && 'lockedRetries' in linkResult
                ? Number((linkResult as { lockedRetries?: unknown }).lockedRetries ?? 0)
                : 0;
            if (
              openApiOperationLedger &&
              Number.isFinite(lockedRetries) &&
              lockedRetries > 0
            ) {
              const nextCounts = {
                ...openApiOperationLedger.counts,
                retries: Number(openApiOperationLedger.counts.retries ?? 0) + lockedRetries
              };
              openApiOperationLedger = {
                ...openApiOperationLedger,
                counts: nextCounts
              };
              outputs['openapi-operation-ledger-json'] = JSON.stringify(openApiOperationLedger);
              const ledgerRel = path.join('.postman', 'bootstrap-openapi-operation-ledger.json');
              const ledgerAbs = path.join(resolveWorkspaceRoot(), ledgerRel);
              await mkdir(path.dirname(ledgerAbs), { recursive: true });
              await writeFile(ledgerAbs, `${JSON.stringify(openApiOperationLedger)}\n`, 'utf8');
            }
            completedExternalSideEffects.push(
              `linkCollectionsToSpecification(${outputs['spec-id']}: ${linkedCollectionIds.join(', ')}; syncExamples=${inputs.syncExamples})`
            );

            const settleRelations =
              localIntegration.settleSpecificationCollectionRelations?.bind(
                localIntegration
              );
            if (!settleRelations) {
              throw new Error(
                'LOCAL_OPENAPI_LINK_READBACK_FAILED: settleSpecificationCollectionRelations is required'
              );
            }
            const expectedIds = [...new Set(linkedCollectionIds)];
            if (expectedIds.length !== 3) {
              throw new Error(
                `LOCAL_OPENAPI_LINK_READBACK_FAILED: expected exactly 3 distinct collection ids, observed ${expectedIds.length}`
              );
            }
            // GET-only bounded wait for Spec Hub relation propagation. Never call syncCollection.
            const settled = await settleRelations(outputs['spec-id'], expectedIds);
            const settleAttempts = Number(settled?.attempts ?? 0);
            const relations = Array.isArray(settled?.relations) ? settled.relations : [];
            const byId = new Map(
              relations
                .filter((row) => expectedIds.includes(row.collectionId))
                .map((row) => [row.collectionId, row] as const)
            );
            if (byId.size !== 3) {
              throw new Error(
                `LOCAL_OPENAPI_LINK_READBACK_FAILED: expected 3 linked collections, observed ${byId.size}`
              );
            }
            const recognizedStates = new Set(['in-sync', 'out-of-sync']);
            const linkRelationStates: Record<string, string> = {};
            for (const collectionId of expectedIds) {
              const row = byId.get(collectionId);
              if (!row) {
                throw new Error(
                  `LOCAL_OPENAPI_LINK_READBACK_FAILED: missing relation for collection ${collectionId}`
                );
              }
              const state = String(row.state || '').trim();
              // Local import+link forbids Spec Hub sync; out-of-sync is a durable verified link.
              if (!recognizedStates.has(state)) {
                throw new Error(
                  `LOCAL_OPENAPI_LINK_READBACK_FAILED: collection ${collectionId} state=${state || '<empty>'}`
                );
              }
              linkRelationStates[collectionId] = state;
              if (!includesRequestedJsonSemantics(row.options, linkOptions)) {
                throw new Error(
                  `LOCAL_OPENAPI_LINK_READBACK_FAILED: collection ${collectionId} options mismatch`
                );
              }
              if (!includesRequestedJsonSemantics(row.syncOptions, expectedSyncOptions)) {
                throw new Error(
                  `LOCAL_OPENAPI_LINK_READBACK_FAILED: collection ${collectionId} syncOptions mismatch`
                );
              }
            }
            if (openApiOperationLedger && Number.isFinite(settleAttempts) && settleAttempts > 0) {
              openApiOperationLedger = {
                ...openApiOperationLedger,
                counts: {
                  ...openApiOperationLedger.counts,
                  linkRelationSettleReads: settleAttempts
                },
                linkRelationStates
              };
              outputs['openapi-operation-ledger-json'] = JSON.stringify(openApiOperationLedger);
              const ledgerRel = path.join('.postman', 'bootstrap-openapi-operation-ledger.json');
              const ledgerAbs = path.join(resolveWorkspaceRoot(), ledgerRel);
              await mkdir(path.dirname(ledgerAbs), { recursive: true });
              await writeFile(ledgerAbs, `${JSON.stringify(openApiOperationLedger)}\n`, 'utf8');
            }
            dependencies.core.info(
              `OpenAPI link relation settle completed after ${settleAttempts} read(s); states=${expectedIds
                .map((id) => `${id}:${linkRelationStates[id]}`)
                .join(',')}`
            );
          }
        )
      );
    } else {
      dependencies.core.warning(
        'Skipping cloud spec-to-collection linking because postman-access-token is not configured'
      );
    }
  }

  await runRollbackStage(
    'Tag Collections',
    async () => runGroup(
      dependencies.core,
      'Tag Collections',
      async () => {
        await dependencies.postman.tagCollection(outputs['baseline-collection-id'], [
          'generated-docs'
        ]);
        completedExternalSideEffects.push(
          `tagCollection(${outputs['baseline-collection-id']}, generated-docs)`
        );
        await dependencies.postman.tagCollection(outputs['smoke-collection-id'], [
          'generated-smoke'
        ]);
        completedExternalSideEffects.push(
          `tagCollection(${outputs['smoke-collection-id']}, generated-smoke)`
        );
        await dependencies.postman.tagCollection(outputs['contract-collection-id'], [
          'generated-contract'
        ]);
        completedExternalSideEffects.push(
          `tagCollection(${outputs['contract-collection-id']}, generated-contract)`
        );
      }
    )
  );

  // Persist digest-bound manifest with cloud IDs only after link readback + tags.
  if (pendingFinalizedLocalOpenApiManifest && localOpenApiRepoRoot) {
    await persistLocalOpenApiArtifactManifest(
      localOpenApiRepoRoot,
      pendingFinalizedLocalOpenApiManifest
    );
  }

  // Persist spec-id + collection resources only after verified linking.
  // generation/linking succeed. Workspace-only state was written earlier.
  recordCurrentBootstrapResources({
    assetProjectName: artifactProjectName,
    inputs,
    outputs,
    persistWorkspaceId,
    releaseLabel,
    resourcesState: writableResourcesState
  });
  stateStore.write(writableResourcesState);
  createdNewSpec = false;

  } catch (error) {
    const mask = createBootstrapSecretMasker(inputs);
    const reason = formatMaskedOneLine(error, mask);
    // Link/tag (or any post-import) failure before resources persist: compensate
    // journaled fresh imports only, restore local trees/workflows, drop manifest.
    await compensateOwnedLocalOpenApiImports(rollbackTriggerStage);
    if (completedExternalSideEffects.length > 0) {
      dependencies.core.warning(
        formatMaskedOneLine(
          `Completed external side effects before failure at stage ${rollbackTriggerStage} (cause: ${reason}); ` +
            `these are not automatically rolled back: ${completedExternalSideEffects.join('; ')}. ` +
            'Remediation: inspect and reconcile the listed concrete resources before rerun.',
          mask
        )
      );
    }
    await restorePreviousSpecContent(`${rollbackTriggerStage}: ${reason}`);
    throw error;
  }

  for (const [name, value] of Object.entries(outputs)) {
    dependencies.core.setOutput(name, value);
  }

  return outputs;
}

/**
 * Gated tier (publish-gate / fork-PR / tag): credential-free static validation
 * only. Fetches or reads the spec, parses it, and runs the local contract
 * index build (which performs the full static lint pass). No token is ever
 * minted and no Postman API is called: zero writes by construction.
 */
export async function runGatedValidation(
  inputs: ResolvedInputs,
  decision: BranchDecision,
  actionCore: Pick<CoreLike, 'info' | 'setOutput' | 'warning'>
): Promise<PlannedOutputs> {
  actionCore.info(`branch-aware sync: gated run (${decision.reason}) — credential-free static validation, zero workspace writes`);

  const outputs = createPlannedOutputs(inputs);
  outputs['sync-status'] = 'skipped-branch-gate';
  outputs['branch-decision'] = serializeBranchDecision(decision);

  let violations: string[] = [];
  let validated = false;
  try {
    let content: string | undefined;
    let bundle: DefinitionBundle | undefined;
    if (inputs.specPath) {
      bundle = await acquireDefinitionBundle({
        workspaceRoot: resolveWorkspaceRoot(),
        specPath: inputs.specPath,
        specFilesJson: inputs.specFilesJson
      });
      content = bundle.files.get(bundle.rootPath)?.content;
    } else if (inputs.specUrl) {
      content = await safeFetchText(inputs.specUrl, { depth: 0 });
    }
    if (content) {
      const specType = bundle
        ? definitionFormatToSpecType(bundle.format)
        : detectSpecType(content, inputs.specPath);
      if (specType === 'openapi') {
        const document = parseOpenApiDocument(content);
        const index = buildContractIndex(document);
        violations = index.warnings;
        validated = true;
      } else {
        actionCore.info(`branch gate: static lint for spec type ${specType} runs through its protocol builder on publish; parse-only gate applied`);
        validated = true;
      }
    } else {
      actionCore.info('branch gate: no spec-url/spec-path provided; nothing to validate');
    }
  } catch (error) {
    // Static validation failures must fail the gated run loudly: the branch is
    // shipping a spec that cannot parse.
    throw new Error(
      `branch gate: static validation failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  outputs['lint-summary-json'] = JSON.stringify({
    status: validated ? 'static-only' : 'skipped',
    reason: 'branch-gated run: governance lint requires upload and runs on publish/preview syncs',
    errors: 0,
    warnings: violations.length,
    total: violations.length,
    violations: violations.map((issue) => ({ issue, severity: 'WARNING' }))
  });

  for (const [name, value] of Object.entries(outputs)) {
    actionCore.setOutput(name, value);
  }
  return outputs;
}

export async function runAction(
  actionCore: CoreLike = core,
  actionExec: ExecLike = exec,
  actionIo: IOLike = io
): Promise<PlannedOutputs> {
  const inputs = readActionInputs(actionCore);

  // Decide step (branch-aware sync): resolve the immutable BranchDecision from
  // provider CI env BEFORE any credential validation or token mint. Gated runs
  // exit here with credential-free static validation only -- provably zero
  // workspace writes because no token is ever minted.
  const branchDecision = decideBranchTier(inputs);
  process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
  if (branchDecision.tier === 'gated') {
    return runGatedValidation(inputs, branchDecision, actionCore);
  }
  if (!inputs.postmanApiKey && !inputs.postmanAccessToken) {
    throw new Error('One of postman-api-key or postman-access-token is required for a writing sync.');
  }
  if (branchDecision.tier !== 'legacy') {
    actionCore.info(`branch-aware sync: tier=${branchDecision.tier} (${branchDecision.reason})`);
  }

  await mintAccessTokenIfNeeded(
    inputs,
    {
      info: (message) => actionCore.info(message),
      warning: (message) => actionCore.warning(message)
    },
    (secret) => actionCore.setSecret(secret),
    undefined,
    (event) => reportRetry(actionCore, event)
  );
  if (!inputs.postmanAccessToken) {
    throw new Error('Could not obtain postman-access-token from the configured postman-api-key.');
  }

  // Resolve the access-token identity before any write. Independent of
  // getTeams()/orgMode below.
  await runCredentialPreflight({
    iapubBaseUrl: inputs.postmanIapubBase,
    postmanAccessToken: inputs.postmanAccessToken,
    mode: inputs.credentialPreflight,
    mask: createSecretMasker([inputs.postmanAccessToken]),
    log: {
      info: (message) => actionCore.info(message),
      warning: (message) => {
        if (!isLegacyAccessTokenDeprecationWarning(message)) {
          actionCore.warning(message);
        }
       }
    },
    onRetry: (event) => reportRetry(actionCore, event)
  });
  warnIfDeprecatedAccessToken(actionCore, inputs);

  // Early org-mode detection for proper adapter configuration. Enumerates squads
  // over the access-token gateway `ums` service (org id from the preflight's
  // memoized session); a non-org account returns no squads.
  let orgMode = false;
  if (inputs.postmanAccessToken) {
    try {
      const probeProvider = new AccessTokenProvider({
        accessToken: inputs.postmanAccessToken,
        apiKey: inputs.postmanApiKey,
        apiBaseUrl: inputs.postmanApiBase,
        onToken: (token) => actionCore.setSecret(token)
      });
      const probeGateway = new PostmanGatewayAssetsClient({
        gateway: new AccessTokenGatewayClient({
          tokenProvider: probeProvider,
          bifrostBaseUrl: inputs.postmanBifrostBase,
          fallbackBaseUrl: inputs.postmanFallbackBase,
          teamId: inputs.teamId || '',
          orgMode: false,
          secretMasker: createSecretMasker([inputs.postmanAccessToken])
        })
      });
      const teams = await probeGateway.getTeams();
      orgMode = teams.some(t => t.organizationId != null);
    } catch (error) {
      // Org-mode detection failure is not fatal; default to false
      const mask = createBootstrapSecretMasker(inputs);
      const cause = formatMaskedOneLine(error, mask);
      const context = inputs.workspaceTeamId
        ? `workspace-team-id ${inputs.workspaceTeamId}`
        : inputs.repoSlug
          ? `repository ${inputs.repoSlug}`
          : `project ${inputs.projectName}`;
      actionCore.warning(
        formatMaskedOneLine(
          `Could not probe org-mode teams for ${context}: ${cause}. ` +
            'Impact: defaulting orgMode=false for adapter configuration. ' +
            'Remediation: set workspace-team-id explicitly if org-mode workspace operations fail, or verify credential access to the ums teams endpoint.',
          mask
        )
      );
    }
  }

  const dependencies = createBootstrapDependencies(inputs, {
    core: actionCore,
    exec: actionExec,
    io: actionIo,
    specFetcher: fetch,
    setSecret: (secret: string) => actionCore.setSecret(secret)
  }, orgMode);

  if ((inputs.domain || inputs.governanceGroup) && !dependencies.internalIntegration) {
    actionCore.warning(
      'Skipping governance assignment because postman-access-token is not configured'
    );
  }

  return runBootstrap(inputs, dependencies);
}

/**
 * Build the routing `postman` facade. Every asset operation routes through the
 * access-token gateway. A gateway error surfaces rather than switching
 * credentials or transports.
 */
export function createRoutingPostmanClient(options: {
  gateway?: PostmanGatewayAssetsClient;
}): BootstrapExecutionDependencies['postman'] {
  const { gateway } = options;

  const requireAccessToken = (operation: string) => async (): Promise<never> => {
    throw new Error(
      `${operation} requires an access token. ` +
        'Mint a service-account token with postman-resolve-service-token-action.'
    );
  };

  if (!gateway) {
    // Writing runs validate the access token before constructing dependencies;
    // keep this defensive facade for direct embedders.
    return {
      configureTeamContext: (_teamId: string, _orgMode: boolean): void => {
        void _teamId;
        void _orgMode;
      },
      uploadSpec: requireAccessToken('uploadSpec'),
      uploadSpecWithOutcome: requireAccessToken('uploadSpecWithOutcome'),
      uploadSpecBundle: requireAccessToken('uploadSpecBundle'),
      updateSpec: requireAccessToken('updateSpec'),
      getSpecContent: requireAccessToken('getSpecContent'),
      getSpecBundle: requireAccessToken('getSpecBundle'),
      reconcileSpecBundle: requireAccessToken('reconcileSpecBundle'),
      restoreSpecBundle: requireAccessToken('restoreSpecBundle'),
      deleteSpec: requireAccessToken('deleteSpec'),
      generateCollection: requireAccessToken('generateCollection'),
      adoptGeneratedCollection: requireAccessToken('adoptGeneratedCollection'),
      waitForGeneratedCollectionLinks: requireAccessToken('waitForGeneratedCollectionLinks'),
      createWorkspace: requireAccessToken('createWorkspace'),
      getWorkspaceVisibility: requireAccessToken('getWorkspaceVisibility'),
      getWorkspaceGitRepoUrl: requireAccessToken('getWorkspaceGitRepoUrl'),
      findWorkspacesByName: requireAccessToken('findWorkspacesByName'),
      getTeams: requireAccessToken('getTeams'),
      addAdminsToWorkspace: requireAccessToken('addAdminsToWorkspace'),
      inviteRequesterToWorkspace: requireAccessToken('inviteRequesterToWorkspace'),
      injectTests: requireAccessToken('injectTests'),
      tagCollection: requireAccessToken('tagCollection'),
      tagSpecVersion: requireAccessToken('tagSpecVersion'),
      listSpecVersionTags: requireAccessToken('listSpecVersionTags'),
      deleteCollection: requireAccessToken('deleteCollection'),
      injectContractTests: requireAccessToken('injectContractTests'),
      createCollection: requireAccessToken('createCollection'),
      updateCollection: requireAccessToken('updateCollection'),
      updateCollectionDescription: requireAccessToken('updateCollectionDescription'),
      importV2Collection: requireAccessToken('importV2Collection'),
      deepUpdateV2Collection: requireAccessToken('deepUpdateV2Collection'),
      deleteVerifiedRunOwnedCollections: requireAccessToken('deleteVerifiedRunOwnedCollections')
    };
  }

  return {
    // Gateway-only: a failure here is authoritative and never switches credentials.
    uploadSpec: (workspaceId, projectName, specContent, openapiVersion) =>
      gateway.uploadSpec(workspaceId, projectName, specContent, openapiVersion ?? '3.0'),
    uploadSpecWithOutcome: (workspaceId, projectName, specContent, openapiVersion) =>
      gateway.uploadSpecWithOutcome(workspaceId, projectName, specContent, openapiVersion ?? '3.0'),
    uploadSpecBundle: (workspaceId, projectName, bundle, openapiVersion) =>
      gateway.uploadSpecBundle(workspaceId, projectName, bundle, openapiVersion ?? '3.0'),
    generateCollection: (specId, projectName, prefix, folderStrategy, nestedFolderHierarchy, requestNameSource) =>
      gateway.generateCollection(specId, projectName, prefix, folderStrategy, nestedFolderHierarchy, requestNameSource),
    adoptGeneratedCollection: (specId, projectName, prefix, preferredId) =>
      gateway.adoptGeneratedCollection(specId, projectName, prefix, preferredId),
    waitForGeneratedCollectionLinks: (specId, collectionIds) =>
      gateway.waitForGeneratedCollectionLinks(specId, collectionIds),
    updateSpec: (specId, specContent, workspaceId) =>
      gateway.updateSpec(specId, specContent, workspaceId),
    getSpecContent: (specId) => gateway.getSpecContent(specId),
    getSpecBundle: (specId, format) => gateway.getSpecBundle(specId, format),
    reconcileSpecBundle: (specId, target) => gateway.reconcileSpecBundle(specId, target),
    restoreSpecBundle: (specId, snapshot) => gateway.restoreSpecBundle(specId, snapshot),
    deleteSpec: (specId) => gateway.deleteSpec(specId),
    createWorkspace: (name, about, targetTeamId) =>
      gateway.createWorkspace(name, about, targetTeamId),
    getWorkspaceVisibility: (workspaceId) => gateway.getWorkspaceVisibility(workspaceId),
    getWorkspaceGitRepoUrl: (workspaceId, teamId, accessToken) =>
      gateway.getWorkspaceGitRepoUrl(workspaceId, teamId, accessToken),
    findWorkspacesByName: (name) => gateway.findWorkspacesByName(name),
    configureTeamContext: (teamId, orgMode) => gateway.configureTeamContext(teamId, orgMode),

    // Gateway-only asset mutation over the v3 collection-items and tagging surfaces.
    injectTests: (collectionId, type) => gateway.injectTests(collectionId, type),
    tagSpecVersion: (specId, name) => gateway.tagSpecVersion(specId, name),
    listSpecVersionTags: (specId) => gateway.listSpecVersionTags(specId),
    tagCollection: (collectionId, tags) => gateway.tagCollection(collectionId, tags),
    // Sub-team (squad) enumeration over the gateway `ums` service. Access-token
    // only, so org-mode detection uses the session's parent organization.
    getTeams: () => gateway.getTeams(),
    // Gateway-only workspace roles, member resolution, and collection deletion.
    // v3 collection delete are live-proven (probe-workspace-roles-gateway.ts,
    // probe-god-members.ts, probe-collection-v3-crud.ts, 2026-06-30). Role values
    // are the string enum names the gateway requires (numeric ids are rejected).
    addAdminsToWorkspace: (workspaceId, adminIds) => gateway.addAdminsToWorkspace(workspaceId, adminIds),
    inviteRequesterToWorkspace: (workspaceId, email) => gateway.inviteRequesterToWorkspace(workspaceId, email),
    deleteCollection: (collectionUid) => gateway.deleteCollection(collectionUid),

    // Gateway-only v3-native contract test injection over `/scripts`.
    injectContractTests: (collectionUid, index) => gateway.injectContractTests(collectionUid, index),
    createCollection: (workspaceId, collection, options) =>
      gateway.createCollection(workspaceId, collection, options),
    updateCollection: (collectionUid, collection) => gateway.updateCollection(collectionUid, collection),
    updateCollectionDescription: (collectionUid, description) =>
      gateway.updateCollectionDescription(collectionUid, description),
    importV2Collection: (workspaceId, collection, finalName) =>
      gateway.importV2Collection(workspaceId, collection, finalName),
    deepUpdateV2Collection: (collectionUid, collection, expectedPayloadDigest) =>
      gateway.deepUpdateV2Collection(collectionUid, collection, expectedPayloadDigest),
    deleteVerifiedRunOwnedCollections: (collectionIds) =>
      gateway.deleteVerifiedRunOwnedCollections(collectionIds)
  };
}

export function createBootstrapDependencies(
  inputs: ResolvedInputs,
  factories: BootstrapDependencyFactories,
  orgMode = false
): BootstrapExecutionDependencies {
  const mutableMasker = createMutableSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken
  ]);
  const secretMasker = mutableMasker.mask;

  const tokenProvider = new AccessTokenProvider({
    accessToken: inputs.postmanAccessToken,
    apiKey: inputs.postmanApiKey,
    apiBaseUrl: inputs.postmanApiBase,
    onToken: (token) => {
      factories.setSecret?.(token);
      mutableMasker.add(token);
    },
    onRetry: (event) => reportRetry(factories.core, event)
  });

  const gatewayClient = inputs.postmanAccessToken
    ? new AccessTokenGatewayClient({
        tokenProvider,
        bifrostBaseUrl: inputs.postmanBifrostBase,
        fallbackBaseUrl: inputs.postmanFallbackBase,
        teamId: inputs.teamId || '',
        orgMode,
        secretMasker,
        onRetry: (event) => reportRetry(factories.core, event)
      })
    : undefined;
  const gatewayAssets = gatewayClient
    ? new PostmanGatewayAssetsClient({
        gateway: gatewayClient,
        ...(process.env.GITHUB_RUN_ID
          ? {
              createIdentity: () =>
                `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`
            }
          : {}),
        onRetry: (event) => reportRetry(factories.core, event)
      })
    : undefined;

  const postman = createRoutingPostmanClient({ gateway: gatewayAssets });

  const internalIntegration =
    inputs.postmanAccessToken
      ? createInternalIntegrationAdapter({
        accessToken: inputs.postmanAccessToken,
        tokenProvider,
        backend: inputs.integrationBackend,
        bifrostBaseUrl: inputs.postmanBifrostBase,
        gatewayBaseUrl: inputs.postmanGatewayBase,
        orgMode,
        secretMasker,
        teamId: inputs.teamId || ''
      })
      : undefined;
  // gRPC contract collections use the v3/Extensible Collection schema, which the
  // public v2.1.0 collections API rejects; they are created through the gateway
  // EC API instead, which is access-token only.
  const ecClient =
    inputs.postmanAccessToken
      ? new PostmanExtensibleCollectionClient({
        accessToken: inputs.postmanAccessToken,
        tokenProvider,
        bifrostBaseUrl: inputs.postmanBifrostBase,
        orgMode,
        secretMasker,
        teamId: inputs.teamId || '',
        validationReporter: (message) => factories.core.warning(message)
      })
      : undefined;
  const github =
    (inputs.githubToken || inputs.ghFallbackToken) && inputs.repoSlug
      ? new GitHubApiClient({
        repository: inputs.repoSlug,
        token: inputs.githubToken || '',
        fallbackToken: inputs.ghFallbackToken,
        secretMasker
      })
      : undefined;

  return {
    core: factories.core,
    ecClient,
    exec: factories.exec,
    github,
    io: factories.io,
    internalIntegration,
    postman,
    resourcesState: {
      read: readResourcesState,
      write: writeResourcesState
    },
    specFetcher: factories.specFetcher ?? fetch
  };
}
