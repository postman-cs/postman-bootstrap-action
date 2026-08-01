/**
 * Shared scaffolding for tests/contract: drives the REAL runAction composition
 * root (mint -> preflight -> org probe -> createBootstrapDependencies ->
 * runBootstrap) with a stubbed global fetch, a tmp workspace, and neutralized
 * CI env. No production seams are touched: the only fake is the transport.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

import { __resetIdentityMemo } from '../../src/lib/postman/credential-identity.js';
import { runAction, type CoreLike, type ExecLike, type IOLike } from '../../src/index.js';

// Preserve the real event-loop yield before Vitest replaces timer globals.
const realSetImmediate = setImmediate;

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
  'GH_FALLBACK_TOKEN',
  // runAction writes the resolved decision here for downstream steps; an
  // inherited value would silently override a scenario's own branch identity.
  'POSTMAN_BRANCH_DECISION'
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
  /**
   * Workspace-relative files to write before the run, nested paths included.
   * Supplying any entry replaces the default single-file `openapi.json` write,
   * so multi-file, .proto, and large-spec scenarios own their whole tree.
   */
  files?: Record<string, string>;
  /**
   * Env applied AFTER the neutralization sweep, so a scenario can restore the
   * provider CI identity (GITHUB_REF/GITHUB_HEAD_REF/...) the sweep blanks.
   */
  env?: Record<string, string>;
}

const MAX_TIMER_FLUSH_PASSES = 100_000;
const REAL_EVENT_LOOP_YIELD_INTERVAL = 10;

/**
 * Run a contract action under vitest fake timers, flushing every timer chain
 * (retry backoffs, generation poll sleeps, identity-settle windows) until the
 * run settles. The production converge/settle sleeps are real seconds; this
 * absorbs them so full-flow contract tests stay fast.
 */
export async function runWithFakeTimers<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-31T00:00:00.000Z'));
  try {
    const pending = fn();
    let settled: { value: T } | { error: unknown } | undefined;
    // Observe rejection immediately so a timer-flush budget failure cannot leave
    // the original action promise as an unhandled rejection.
    void pending.then(
      (value) => {
        settled = { value };
      },
      (error) => {
        settled = { error };
      }
    );
    for (let pass = 0; pass < MAX_TIMER_FLUSH_PASSES && !settled; pass += 1) {
      await vi.runAllTimersAsync();
      // Yield the microtask queue so `settled` can flip between timer flushes.
      await Promise.resolve();
      // Fake timers do not advance libuv I/O; periodically yield a real turn so
      // filesystem-backed action work can complete without making every pass I/O-bound.
      if ((pass + 1) % REAL_EVENT_LOOP_YIELD_INTERVAL === 0) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
    }
    if (!settled) {
      throw new Error(
        `Fake timer flush budget exhausted after ${MAX_TIMER_FLUSH_PASSES} passes: action promise did not settle`
      );
    }
    if ('error' in settled) {
      throw settled.error;
    }
    return settled.value;
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
  // Scenario inventories hash these exact UTF-8 bytes; write them with an
  // explicit encoding so nested multi-file trees stay content-free but byte-exact.
  const files = options.files ?? { 'openapi.json': VALID_SPEC_31 };
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(specDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  const previousCwd = process.cwd();

  __resetIdentityMemo();
  vi.stubEnv('GITHUB_WORKSPACE', specDir);
  vi.stubEnv('GITHUB_RUN_ID', 'contract-test-run');
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
  for (const name of NEUTRALIZED_ENV_VARS) {
    vi.stubEnv(name, '');
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    vi.stubEnv(name, value);
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
