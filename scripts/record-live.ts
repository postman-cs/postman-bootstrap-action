import { createEmptyCassette, type Cassette } from '@postman-cse/automation-core/cassette';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

import type { CoreLike, PlannedOutputs, runAction as RunAction } from '../src/index.js';
import { createSanitizableRecordingFetch } from './recording-capture.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const RECORDER_CREDENTIAL_ENVIRONMENT = new Set([
  'POSTMAN_API_KEY',
  'POSTMAN_E2E_API_KEY_NON_ORG_MODE',
  'POSTMAN_ACCESS_TOKEN'
]);

export const RAW_CASSETTE_DIRECTORY = 'integration/cassettes/raw';

interface RecorderScenario {
  name: string;
  apiKeyEnvironment: readonly string[];
  inputs: Readonly<Record<string, string>>;
}

const RECORDER_SCENARIOS: Readonly<Record<string, RecorderScenario>> = {
  'fresh-onboard': {
    name: 'fresh-onboard',
    apiKeyEnvironment: ['POSTMAN_E2E_API_KEY_NON_ORG_MODE', 'POSTMAN_API_KEY'],
    inputs: {
      'project-name': 'postman-actions-cassette-fresh-onboard-v1',
      'spec-path': 'integration/fixtures/rest/openapi.yaml',
      'credential-preflight': 'enforce',
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update',
      'postman-stack': 'prod',
      'postman-region': 'us'
    }
  }
};

export interface RecorderEnvironmentOptions {
  ambientEnv?: NodeJS.ProcessEnv;
  packageRoot?: string;
  workspaceRoot?: string;
}

export interface LoadedRecorderEnvironment {
  env: NodeJS.ProcessEnv;
  loadedFiles: string[];
}

export interface RecordLiveArguments {
  scenario: string;
}

export interface RecordingResult {
  cassette: Cassette;
  outputPath: string;
  outputs: PlannedOutputs;
  scenario: string;
}

export interface RecordLiveRuntimeOptions {
  fetchImpl?: typeof fetch;
  rawOutputRoot?: string;
  runAction?: typeof RunAction;
}

interface MutableSecretMasker {
  add(value: string | undefined): void;
  mask(value: string): string;
}

function readEnvironmentFile(filePath: string): NodeJS.ProcessEnv {
  if (!existsSync(filePath)) return {};
  return parseEnv(readFileSync(filePath, 'utf8'));
}

function withoutRecorderCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !RECORDER_CREDENTIAL_ENVIRONMENT.has(name))
  );
}

export function loadRecorderEnvironment(
  options: RecorderEnvironmentOptions = {}
): LoadedRecorderEnvironment {
  const packageRoot = path.resolve(options.packageRoot ?? PACKAGE_ROOT);
  const workspaceRoot = path.resolve(options.workspaceRoot ?? WORKSPACE_ROOT);
  const workspaceFile = path.join(workspaceRoot, '.env');
  const packageFile = path.join(packageRoot, '.env');
  const loadedFiles = [workspaceFile, packageFile].filter((filePath) => existsSync(filePath));
  const ambientEnv = options.ambientEnv ?? process.env;

  return {
    env: {
      ...readEnvironmentFile(workspaceFile),
      ...readEnvironmentFile(packageFile),
      ...withoutRecorderCredentials(ambientEnv)
    },
    loadedFiles
  };
}

export function assertLocalRecording(env: NodeJS.ProcessEnv): void {
  if (Object.hasOwn(env, 'CI')) {
    throw new Error('Recording live cassettes is disabled in CI; replay a committed sanitized cassette instead.');
  }
}

export function parseRecordLiveArgs(argv: string[]): RecordLiveArguments {
  let scenario = 'fresh-onboard';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--scenario') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--scenario requires a scenario name');
      }
      scenario = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--scenario=')) {
      scenario = argument.slice('--scenario='.length);
      if (!scenario) throw new Error('--scenario requires a scenario name');
      continue;
    }
    throw new Error(`Unknown record-live argument: ${String(argument)}`);
  }
  return { scenario };
}

export function selectRecorderScenario(name: string): RecorderScenario {
  const scenario = RECORDER_SCENARIOS[name];
  if (scenario) return scenario;
  throw new Error(
    `Unknown recording scenario "${name}". Supported scenarios: ${Object.keys(RECORDER_SCENARIOS).join(', ')}`
  );
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, names: readonly string[]): string {
  for (const name of names) {
    const value = String(env[name] ?? '').trim();
    if (value) return value;
  }
  return '';
}

function createRecorderSecretMasker(initialValues: Array<string | undefined>): MutableSecretMasker {
  const secrets = new Set<string>();
  const add = (value: string | undefined): void => {
    const normalized = String(value ?? '').trim();
    if (normalized) secrets.add(normalized);
  };
  for (const value of initialValues) add(value);
  return {
    add,
    mask: (value) =>
      [...secrets]
        .sort((left, right) => right.length - left.length)
        .reduce((masked, secret) => masked.split(secret).join('***'), value)
  };
}

export function loadRunAction(): typeof RunAction {
  const require = createRequire(import.meta.url);
  const artifact = require(path.join(PACKAGE_ROOT, 'dist/index.cjs')) as {
    runAction?: typeof RunAction;
  };
  if (typeof artifact.runAction !== 'function') {
    throw new Error('Committed dist/index.cjs does not export runAction; rebuild the action artifact.');
  }
  return artifact.runAction;
}

function createRecorderCore(
  inputs: Readonly<Record<string, string>>,
  secrets: MutableSecretMasker
): CoreLike & { outputs: Record<string, string> } {
  const outputs: Record<string, string> = {};
  const writeLog = (prefix: string, message: string): void => {
    process.stderr.write(`${prefix}${secrets.mask(message)}\n`);
  };

  return {
    outputs,
    error: (message) => writeLog('error: ', message),
    getInput: (name, options) => {
      const value = inputs[name] ?? '';
      if (options?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    group: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      writeLog('', `[record-live] ${name}`);
      return fn();
    },
    info: (message) => writeLog('', message),
    setFailed: (message) => {
      throw new Error(secrets.mask(message));
    },
    setOutput: (name, value) => {
      outputs[name] = value;
    },
    setSecret: (secret) => secrets.add(secret),
    warning: (message) => writeLog('warning: ', message)
  };
}

function applyRecordingEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of RECORDER_CREDENTIAL_ENVIRONMENT) {
    delete process.env[name];
  }
  Object.assign(process.env, env, {
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_ID: 'cassette-fresh-onboard',
    GITHUB_WORKSPACE: PACKAGE_ROOT,
    POSTMAN_ACTIONS_TELEMETRY: 'off'
  });

  for (const name of [
    'BITBUCKET_GIT_HTTP_ORIGIN',
    'BITBUCKET_REPO_SLUG',
    'BITBUCKET_WORKSPACE',
    'BUILD_REPOSITORY_NAME',
    'BUILD_REPOSITORY_URI',
    'CI_PROJECT_NAME',
    'CI_PROJECT_PATH',
    'CI_PROJECT_URL',
    'GH_FALLBACK_TOKEN',
    'GITHUB_HEAD_REF',
    'GITHUB_REF',
    'GITHUB_REF_NAME',
    'GITHUB_REPOSITORY',
    'GITHUB_SERVER_URL',
    'GITHUB_TOKEN',
    'POSTMAN_TEAM_ID',
    'POSTMAN_WORKSPACE_TEAM_ID',
    'WORKSPACE_ADMIN_USER_IDS'
  ]) {
    delete process.env[name];
  }
}

export async function recordLiveScenario(
  scenarioName: string,
  loadedEnvironment: LoadedRecorderEnvironment = loadRecorderEnvironment(),
  runtime: RecordLiveRuntimeOptions = {}
): Promise<RecordingResult> {
  assertLocalRecording(loadedEnvironment.env);
  const scenario = selectRecorderScenario(scenarioName);
  const apiKey = firstEnvironmentValue(loadedEnvironment.env, scenario.apiKeyEnvironment);
  if (!apiKey) {
    throw new Error(
      `Missing sandbox PMAK. Set ${scenario.apiKeyEnvironment.join(' or ')} in a gitignored .env file.`
    );
  }

  applyRecordingEnvironment(loadedEnvironment.env);
  const accessToken = String(loadedEnvironment.env.POSTMAN_ACCESS_TOKEN ?? '').trim();
  const secrets = createRecorderSecretMasker([apiKey, accessToken]);
  const core = createRecorderCore(
    {
      ...scenario.inputs,
      'postman-api-key': apiKey,
      ...(accessToken ? { 'postman-access-token': accessToken } : {})
    },
    secrets
  );
  const cassette = createEmptyCassette();
  const originalFetch = globalThis.fetch;
  const liveFetch = runtime.fetchImpl ?? originalFetch;
  globalThis.fetch = createSanitizableRecordingFetch(liveFetch, cassette, secrets.mask);

  let outputs: PlannedOutputs;
  let runError: unknown;
  try {
    outputs = await (runtime.runAction ?? loadRunAction())(core);
  } catch (error) {
    runError = error;
    outputs = core.outputs as unknown as PlannedOutputs;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const outputPath = path.join(
    runtime.rawOutputRoot ?? path.join(PACKAGE_ROOT, RAW_CASSETTE_DIRECTORY),
    `${scenario.name}.json`
  );
  await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(cassette, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });

  if (runError) {
    throw new Error(
      `Live scenario ${scenario.name} failed after ${cassette.interactions.length} interaction(s); partial raw cassette: ${outputPath}`,
      { cause: runError }
    );
  }

  return { cassette, outputPath, outputs, scenario: scenario.name };
}

async function main(): Promise<void> {
  const args = parseRecordLiveArgs(process.argv.slice(2));
  const loadedEnvironment = loadRecorderEnvironment();
  const result = await recordLiveScenario(args.scenario, loadedEnvironment);
  process.stdout.write(
    `${JSON.stringify({
      scenario: result.scenario,
      outputPath: path.relative(PACKAGE_ROOT, result.outputPath),
      interactions: result.cassette.interactions.length,
      workspaceId: result.outputs['workspace-id']
    })}\n`
  );
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return pathToFileURL(realpathSync(entrypoint)).href === import.meta.url;
  } catch {
    return path.resolve(entrypoint) === path.resolve(import.meta.filename);
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
