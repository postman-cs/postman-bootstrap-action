import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import * as io from '@actions/io';

import {
  createBootstrapDependencies,
  resolveInputs,
  type ResolvedInputs,
  runBootstrap,
  type BootstrapExecutionDependencies,
  type ExecLike,
  type PlannedOutputs
} from './index.js';
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
  const inputNames = [
    'project-name',
    'spec-url',
    'postman-api-key',
    'postman-access-token',
    'workspace-id',
    'spec-id',
    'baseline-collection-id',
    'smoke-collection-id',
    'contract-collection-id',
    'sync-examples',
    'collection-sync-mode',
    'spec-sync-mode',
    'release-label',
    'domain',
    'domain-code',
    'requester-email',
    'workspace-admin-user-ids',
    'governance-mapping-json',
    'integration-backend',
    'team-id',
    'workspace-team-id',
    'repo-url'
  ];

  const inputEnv: NodeJS.ProcessEnv = { ...env };
  for (const name of inputNames) {
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
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
}

async function writeOptionalFile(filePath: string | undefined, content: string): Promise<void> {
  if (!filePath) {
    return;
  }
  const workspaceRoot = path.resolve(process.cwd());
  const resolved = path.resolve(workspaceRoot, filePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay within workspace: ${filePath}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  runtime: CliRuntime = {}
): Promise<void> {
  const env = runtime.env ?? process.env;
  const config = parseCliArgs(argv, env);
  const inputs = resolveInputs(config.inputEnv);
  const dependencies = createCliDependencies(inputs);

  if (inputs.domain && !dependencies.internalIntegration) {
    dependencies.core.warning(
      'Skipping governance assignment because postman-access-token is not configured'
    );
  }

  const result = await (runtime.executeBootstrap ?? runBootstrap)(inputs, dependencies);

  await writeOptionalFile(config.resultJsonPath, JSON.stringify(result, null, 2));
  await writeOptionalFile(config.dotenvPath, toDotenv(result));

  const writeStdout = runtime.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));
  writeStdout(`${JSON.stringify(result, null, 2)}\n`);
}

const currentModulePath = typeof __filename === 'string' ? __filename : '';
const entrypoint = process.argv[1];

if (entrypoint && currentModulePath === entrypoint) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
