/**
 * Shared scaffolding for tests/contract: drives the REAL runAction composition
 * root (mint -> preflight -> org probe -> createBootstrapDependencies ->
 * runBootstrap) with a stubbed global fetch, a tmp workspace, and neutralized
 * CI env. No production seams are touched: the only fake is the transport.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { __resetIdentityMemo } from '../../src/lib/postman/credential-identity.js';
import { runAction, type CoreLike, type ExecLike, type IOLike } from '../../src/index.js';

export const VALID_SPEC_31 = `{
  "openapi": "3.1.0",
  "info": { "title": "Contract Test API", "version": "1.0.0" },
  "paths": {
    "/payments": {
      "get": {
        "summary": "GET /payments",
        "responses": {
          "200": {
            "description": "OK",
            "content": { "application/json": { "schema": { "type": "object" } } }
          }
        }
      }
    }
  }
}
`;

const NEUTRALIZED_ENV_VARS = [
  'GITHUB_REPOSITORY',
  'GITHUB_SERVER_URL',
  'CI_PROJECT_URL',
  'CI_PROJECT_PATH',
  'CI_PROJECT_NAME',
  'BITBUCKET_GIT_HTTP_ORIGIN',
  'BITBUCKET_WORKSPACE',
  'BITBUCKET_REPO_SLUG',
  'BUILD_REPOSITORY_URI',
  'BUILD_REPOSITORY_NAME',
  'POSTMAN_TEAM_ID',
  'POSTMAN_WORKSPACE_TEAM_ID',
  'WORKSPACE_ADMIN_USER_IDS',
  'GITHUB_TOKEN',
  'GH_FALLBACK_TOKEN'
];

export interface ContractRunResult {
  outputs: Record<string, string>;
  infos: string[];
  warnings: string[];
  error?: unknown;
}

export interface ContractRunOptions {
  /** Action inputs; project-name/spec-path defaults applied. */
  inputs?: Record<string, string>;
  /** The transport to stub as global fetch. */
  fetchImpl: typeof fetch;
}

/**
 * Run a contract action under vitest fake timers, flushing every timer chain
 * (retry backoffs, generation poll sleeps, identity-settle windows) until the
 * run settles. The production converge/settle sleeps are real seconds; this
 * absorbs them so full-flow contract tests stay fast.
 */
export async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = fn();
    let settled = false;
    const settle = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      }
    );
    while (!settled) {
      await vi.runAllTimersAsync();
      // Yield the microtask queue so `settled` can flip between timer flushes.
      await Promise.resolve();
    }
    return settle;
  } finally {
    vi.useRealTimers();
  }
}

export function createExecStub(stdout = '{"violations":[]}'): ExecLike {
  return {
    exec: vi.fn().mockResolvedValue(0),
    getExecOutput: vi.fn().mockResolvedValue({ exitCode: 0, stdout, stderr: '' })
  };
}

export function createIoStub(): IOLike {
  return { which: vi.fn().mockResolvedValue('/usr/local/bin/postman') };
}

/**
 * Run the real runAction against the supplied transport inside a disposable
 * workspace directory. Cleans up env stubs, global stubs, identity memo, and
 * the tmp dir regardless of outcome.
 */
export async function runContractAction(options: ContractRunOptions): Promise<ContractRunResult> {
  const specDir = mkdtempSync(join(tmpdir(), 'bootstrap-contract-'));
  writeFileSync(join(specDir, 'openapi.json'), VALID_SPEC_31);
  const previousCwd = process.cwd();

  __resetIdentityMemo();
  vi.stubEnv('GITHUB_WORKSPACE', specDir);
  vi.stubEnv('GITHUB_RUN_ID', 'contract-test-run');
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
  for (const name of NEUTRALIZED_ENV_VARS) {
    vi.stubEnv(name, '');
  }
  vi.stubGlobal('fetch', options.fetchImpl);
  process.chdir(specDir);

  const values: Record<string, string> = {
    'project-name': 'contract-payments',
    'spec-path': 'openapi.json',
    ...options.inputs
  };

  const outputs: Record<string, string> = {};
  const infos: string[] = [];
  const warnings: string[] = [];
  const core: CoreLike = {
    error: () => {},
    getInput: (name: string, opts?: { required?: boolean }) => {
      const value = values[name] ?? '';
      if (opts?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    group: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    info: (message: string) => {
      infos.push(message);
    },
    setFailed: () => {},
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
    setSecret: () => {},
    warning: (message: string) => {
      warnings.push(message);
    }
  };

  let error: unknown;
  try {
    await runAction(core, createExecStub(), createIoStub());
  } catch (caught) {
    error = caught;
  } finally {
    process.chdir(previousCwd);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    __resetIdentityMemo();
    rmSync(specDir, { recursive: true, force: true });
  }

  return { outputs, infos, warnings, error };
}
