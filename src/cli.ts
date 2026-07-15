import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import * as io from '@actions/io';

import {
  createBootstrapDependencies,
  decideBranchTier,
  mintAccessTokenIfNeeded,
  resolveInputs,
  runGatedValidation,
  type ResolvedInputs,
  runBootstrap,
  type BootstrapExecutionDependencies,
  type ExecLike,
  type PlannedOutputs
} from './index.js';
import { BRANCH_DECISION_ENV, serializeBranchDecision } from './lib/repo/branch-decision.js';
import { runCredentialPreflight } from './lib/postman/credential-identity.js';
import { createSecretMasker } from './lib/secrets.js';

interface CliConfig {
  inputEnv: NodeJS.ProcessEnv;
  resultJsonPath: string;
  dotenvPath?: string;
}

export interface CliRuntime {
  env?: NodeJS.ProcessEnv;
  executeBootstrap?: typeof runBootstrap;
  writeStdout?: (chunk: string) => void;
}

type ReporterCore = BootstrapExecutionDependencies['core'];

const HELP_TEXT = `Usage: postman-bootstrap [options]

Bootstrap Postman workspaces, specs, and collections from OpenAPI.

Options:
  --help                         Show this help and exit
  --version                      Show version and exit
  --result-json <path>           Write JSON result (default: postman-bootstrap-result.json)
  --dotenv-path <path>           Optional dotenv output path
  --<input-name> <value>         Action input as kebab-case flag (same names as action.yml)

Examples:
  postman-bootstrap --help
  postman-bootstrap --project-name demo --spec-path ./openapi.yaml ...
`;

function wantsHelp(argv: string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

function wantsVersion(argv: string[]): boolean {
  return argv.includes('--version') || argv.includes('-V');
}

function resolvePackageVersion(): string {
  const candidates: string[] = [];
  // Present in the esbuild CJS bundle (dist/cli.cjs -> ../package.json).
  if (typeof __filename === 'string' && __filename) {
    candidates.push(path.join(path.dirname(__filename), '..', 'package.json'));
  }
  // vitest/ESM and local smoke: package.json at cwd.
  candidates.push(path.join(process.cwd(), 'package.json'));

  for (const packageJsonPath of candidates) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (packageJson.name === '@postman-cse/onboarding-bootstrap' && packageJson.version) {
        return String(packageJson.version).trim();
      }
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

export class ConsoleReporter implements ReporterCore {
  public error(message: string): void {
    console.error(message);
  }

  public async group<T>(name: string, fn: () => Promise<T>): Promise<T> {
    console.error(`[group] ${name}`);
    return await fn();
  }

  public info(message: string): void {
    console.error(message);
  }

  public setOutput(): void {
  }

  public warning(message: string): void {
    console.error(`warning: ${message}`);
  }
}

function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === `--${name}`) {
      return argv[index + 1];
    }
    if (arg?.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function normalizeCliFlag(name: string): string {
  return `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
}

const cliInputNames = [
  'project-name',
  'spec-url',
  'spec-path',
  'protocol',
  'protocol-endpoint-url',
  'postman-api-key',
  'postman-access-token',
  'credential-preflight',
  'branch-strategy',
  'canonical-branch',
  'channels',
  'workspace-id',
  'spec-id',
  'baseline-collection-id',
  'smoke-collection-id',
  'contract-collection-id',
  'additional-collections-dir',
  'sync-examples',
  'collection-sync-mode',
  'spec-sync-mode',
  'release-label',
  'domain',
  'domain-code',
  'governance-group',
  'requester-email',
  'workspace-admin-user-ids',
  'governance-mapping-json',
  'github-token',
  'gh-fallback-token',
  'integration-backend',
  'folder-strategy',
  'nested-folder-hierarchy',
  'request-name-source',
  'workspace-team-id',
  'repo-url',
  'openapi-version',
  'breaking-change-mode',
  'breaking-baseline-spec-path',
  'breaking-rules-path',
  'breaking-target-ref',
  'breaking-summary-path',
  'breaking-log-path',
  'postman-region',
  'postman-stack'
] as const;

const execFileAsync = promisify(execFile);

function toCommandLabel(commandLine: string, args: string[], secretMasker: (value: string) => string): string {
  const rendered = [commandLine, ...args].join(' ');
  return secretMasker(rendered);
}

export function createCliExec(secretMasker: (value: string) => string): ExecLike {
  const execCommand = async (
    commandLine: string,
    args: string[] = [],
    options?: Parameters<ExecLike['exec']>[2]
  ): Promise<number> => {
    const output = await getExecOutput(commandLine, args, {
      ...options,
      ignoreReturnCode: true
    });
    if (output.exitCode !== 0 && !options?.ignoreReturnCode) {
      throw new Error(`Command failed with exit code ${output.exitCode}: ${toCommandLabel(commandLine, args, secretMasker)}`);
    }
    return output.exitCode;
  };

  const getExecOutput = async (
    commandLine: string,
    args: string[] = [],
    options?: Parameters<ExecLike['getExecOutput']>[2]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    const cwd = options?.cwd;
    const env = options?.env ? { ...process.env, ...options.env } : process.env;
    const commandLabel = toCommandLabel(commandLine, args, secretMasker);
    process.stderr.write(`[command] ${commandLabel}\n`);

    try {
      const result = await execFileAsync(commandLine, args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true
      });
      const stdout = String(result.stdout ?? '');
      const stderr = String(result.stderr ?? '');
      if (stdout) {
        process.stderr.write(secretMasker(stdout));
      }
      if (stderr) {
        process.stderr.write(secretMasker(stderr));
      }
      return {
        exitCode: 0,
        stdout,
        stderr
      };
    } catch (error) {
      const execError = error as {
        code?: number | string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        message?: string;
      };
      const stdout = String(execError.stdout ?? '');
      const stderr = String(execError.stderr ?? '');
      const fallbackMessage = execError.message ? `${execError.message}\n` : '';
      if (stdout) {
        process.stderr.write(secretMasker(stdout));
      }
      if (stderr) {
        process.stderr.write(secretMasker(stderr));
      } else if (fallbackMessage) {
        process.stderr.write(secretMasker(fallbackMessage));
      }
      const numericCode =
        typeof execError.code === 'number'
          ? execError.code
          : Number.parseInt(String(execError.code ?? '1'), 10) || 1;
      if (!options?.ignoreReturnCode) {
        throw new Error(`Command failed with exit code ${numericCode}: ${commandLabel}`, { cause: error });
      }
      return {
        exitCode: numericCode,
        stdout,
        stderr
      };
    }
  };

  return {
    exec: execCommand,
    getExecOutput
  };
}

export function createCliDependencies(
  inputs: ResolvedInputs
): BootstrapExecutionDependencies {
  const secretMasker = createSecretMasker([
    inputs.postmanApiKey,
    inputs.postmanAccessToken
  ]);
  const cliExec = createCliExec(secretMasker);

  return createBootstrapDependencies(inputs, {
    core: new ConsoleReporter(),
    exec: cliExec,
    io,
    specFetcher: fetch
  });
}

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const inputEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of cliInputNames) {
    const value = readFlag(argv, name);
    if (value !== undefined) {
      inputEnv[normalizeCliFlag(name)] = value;
    }
  }

  return {
    inputEnv,
    resultJsonPath: readFlag(argv, 'result-json') ?? 'postman-bootstrap-result.json',
    dotenvPath: readFlag(argv, 'dotenv-path')
  };
}

export function toDotenv(outputs: PlannedOutputs): string {
  return Object.entries(outputs)
    .map(([key, value]) => [
      `POSTMAN_BOOTSTRAP_${key.replace(/-/g, '_').toUpperCase()}`,
      value
    ] as const)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function ensureInsideWorkspace(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Output path must stay within workspace');
  }
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!pathExists(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function pathExists(candidate: string): boolean {
  if (existsSync(candidate)) {
    return true;
  }
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function checkedRealPath(existingPath: string, workspaceRealPath: string): string {
  try {
    return realpathSync(existingPath);
  } catch (error) {
    if (lstatSync(existingPath).isSymbolicLink()) {
      const linkTarget = readlinkSync(existingPath);
      const resolvedTarget = path.resolve(path.dirname(existingPath), linkTarget);
      ensureInsideWorkspace(workspaceRealPath, resolvedTarget);
    }
    throw error;
  }
}

function assertOutputFileAllowed(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const workspaceRoot = path.resolve(process.cwd());
  const workspaceRealPath = realpathSync(workspaceRoot);
  const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(workspaceRoot, filePath);
  const existingPath = nearestExistingPath(resolved);
  ensureInsideWorkspace(workspaceRealPath, checkedRealPath(existingPath, workspaceRealPath));
  return resolved;
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  const resolved = assertOutputFileAllowed(filePath);
  if (!resolved) {
    return;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  ensureInsideWorkspace(realpathSync(path.resolve(process.cwd())), realpathSync(path.dirname(resolved)));
  await writeFile(resolved, content, 'utf8');
}

function requireCliInput(name: string, value: string | undefined): void {
  if (!value) {
    throw new Error(`${name} is required`);
  }
}

function validateCliInputs(inputs: ResolvedInputs): void {
  requireCliInput('project-name', inputs.projectName);
  if (!inputs.specUrl && !inputs.specPath) {
    throw new Error('One of spec-url or spec-path is required');
  }
  if (inputs.specUrl && inputs.specPath) {
    throw new Error('Provide either spec-url or spec-path, not both.');
  }
  // postman-api-key is optional: a run may be access-token-primary (the gateway
  // client handles asset ops, and the PMAK-only spec lint skips with a warning).
  // Require only that at least one credential is present, mirroring index.ts so
  // both entries agree -- a hard PMAK requirement here would reject a valid
  // access-token-only run before bootstrap starts.
  if (!inputs.postmanApiKey && !inputs.postmanAccessToken) {
    throw new Error('One of postman-api-key or postman-access-token is required.');
  }
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime: CliRuntime = {}
): Promise<void> {
  const writeStdout = runtime.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  if (wantsHelp(argv) && wantsVersion(argv)) {
    throw new Error('Cannot use --help and --version together');
  }
  if (wantsHelp(argv)) {
    writeStdout(HELP_TEXT);
    return;
  }
  if (wantsVersion(argv)) {
    writeStdout(`${resolvePackageVersion()}\n`);
    return;
  }

  const env = runtime.env ?? process.env;
  const config = parseCliArgs(argv, env);
  const inputs = resolveInputs(config.inputEnv);
  validateCliInputs(inputs);
  assertOutputFileAllowed(config.resultJsonPath);
  assertOutputFileAllowed(config.dotenvPath);

  // Decide step (branch-aware sync): resolve the immutable BranchDecision
  // BEFORE any credential validation or token mint — the CLI entry must gate
  // exactly as runAction does (dist/cli.cjs is what CI and e2e invoke).
  const branchDecision = decideBranchTier(inputs, config.inputEnv);
  if (branchDecision.tier === 'gated') {
    const gatedReporter = new ConsoleReporter();
    const gated = await runGatedValidation(inputs, branchDecision, {
      info: (m: string) => gatedReporter.info(m),
      warning: (m: string) => gatedReporter.warning(m),
      setOutput: () => undefined
    });
    await writeOptionalFile(config.resultJsonPath, JSON.stringify(gated, null, 2));
    await writeOptionalFile(config.dotenvPath, toDotenv(gated));
    writeStdout(`${JSON.stringify(gated, null, 2)}\n`);
    return;
  }
  if (branchDecision.tier !== 'legacy') {
    process.env[BRANCH_DECISION_ENV] = serializeBranchDecision(branchDecision);
  }

  // PMAK-only runs: mint the access token up front (mirrors runAction) so the
  // dependencies built below get the full access-token surface (governance
  // adapter, EC client) instead of silently downgrading.
  const mintReporter = new ConsoleReporter();
  await mintAccessTokenIfNeeded(inputs, mintReporter);

  const dependencies = createCliDependencies(inputs);

  // Proactive credential preflight: resolve and cross-check both identities
  // once, before any spec fetch or write. The CLI entry must run this exactly
  // as runAction does, or dist/cli.cjs (what CI and the e2e harness invoke)
  // would skip the preflight that dist/index.cjs performs.
  await runCredentialPreflight({
    apiBaseUrl: inputs.postmanApiBase,
    iapubBaseUrl: inputs.postmanIapubBase,
    postmanApiKey: inputs.postmanApiKey,
    postmanAccessToken: inputs.postmanAccessToken,
    workspaceTeamId: inputs.workspaceTeamId,
    explicitTeamId: inputs.teamId || undefined,
    mode: inputs.credentialPreflight,
    mask: createSecretMasker([inputs.postmanApiKey, inputs.postmanAccessToken]),
    log: dependencies.core
  });

  if ((inputs.domain || inputs.governanceGroup) && !dependencies.internalIntegration) {
    dependencies.core.warning(
      'Skipping governance assignment because postman-access-token is not configured'
    );
  }

  const result = await (runtime.executeBootstrap ?? runBootstrap)(inputs, dependencies);

  await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
  await writeOptionalFile(config.dotenvPath, toDotenv(result));

  writeStdout(`${JSON.stringify(result, null, 2)}\n`);
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

function isEntrypoint(currentPath: string, entrypointPath: string | undefined): boolean {
  if (!currentPath || !entrypointPath) {
    return false;
  }
  try {
    return realpathSync(currentPath) === realpathSync(entrypointPath);
  } catch {
    return path.resolve(currentPath) === path.resolve(entrypointPath);
  }
}

if (isEntrypoint(currentModulePath, entrypoint)) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
