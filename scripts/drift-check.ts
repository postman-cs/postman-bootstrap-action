import { readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Cassette } from '@postman-cse/automation-core/cassette';

import {
  cassetteShape,
  diffCassetteShapes,
  formatDriftReport,
  type DriftFinding
} from './cassette-shape.ts';
import {
  loadRecorderEnvironment,
  recordLiveScenario,
  selectRecorderScenario,
  type LoadedRecorderEnvironment,
  type RecorderEnvironmentOptions
} from './record-live.ts';
import { sanitizeCassette } from './sanitize-cassette.ts';

/**
 * WS9 nightly drift check: re-record a live scenario, sanitize it in memory,
 * and shape-diff it against the committed cassette. Raw material never touches
 * a durable path — the recorder writes into an ephemeral OS temp directory the
 * caller provides, and only the shape comparison is reported.
 *
 * Unlike `record-live` (developer refresh workflow, blocked in CI), the drift
 * check is designed to run in a scheduled monitor: it explicitly opts the
 * environment out of the CI recording block AFTER asserting it will never
 * persist raw captures anywhere durable. It stays report-only: committed
 * cassettes are never rewritten by this path.
 */

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const COMMITTED_CASSETTE_DIRECTORY = path.join(PACKAGE_ROOT, 'tests', 'contract', 'cassettes');

/** Ambient credentials GHA (and local shells) may inject for the drift monitor. */
const DRIFT_MONITOR_CREDENTIAL_ENVIRONMENT = [
  'POSTMAN_API_KEY',
  'POSTMAN_E2E_API_KEY_NON_ORG_MODE',
  'POSTMAN_ACCESS_TOKEN'
] as const;

export interface DriftCheckOptions {
  scenario?: string;
  /** Ephemeral directory for the recorder's raw output; must be a temp path. */
  rawOutputRoot: string;
  loadedEnvironment?: LoadedRecorderEnvironment;
  recordScenario?: typeof recordLiveScenario;
  committedCassetteDirectory?: string;
}

export interface DriftCheckResult {
  scenario: string;
  findings: DriftFinding[];
  interactionCount: number;
}

/**
 * Prove the recorder can only write below an existing OS-managed temp directory.
 * `realpath` is deliberate: macOS commonly presents /var as a symlink to
 * /private/var, and caller-provided symlinks must not escape the temp root.
 */
function assertEphemeralRawOutputRoot(rawOutputRoot: string): void {
  if (!rawOutputRoot || !path.isAbsolute(rawOutputRoot)) {
    throw new Error('Drift check requires an absolute ephemeral rawOutputRoot temp directory');
  }

  let resolvedOutputRoot: string;
  let resolvedTempRoot: string;
  try {
    resolvedOutputRoot = realpathSync(rawOutputRoot);
    resolvedTempRoot = realpathSync(tmpdir());
  } catch {
    throw new Error('Drift check requires an existing ephemeral rawOutputRoot directory under the OS temp root');
  }

  if (!statSync(resolvedOutputRoot).isDirectory()) {
    throw new Error('Drift check requires an existing ephemeral rawOutputRoot directory under the OS temp root');
  }

  const relativeToTempRoot = path.relative(resolvedTempRoot, resolvedOutputRoot);
  if (
    resolvedOutputRoot === resolvedTempRoot ||
    relativeToTempRoot === '' ||
    relativeToTempRoot === '..' ||
    relativeToTempRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToTempRoot)
  ) {
    throw new Error('Drift check requires an ephemeral rawOutputRoot child directory under the OS temp root');
  }
}

export function loadCommittedCassette(directory: string, scenario: string): Cassette {
  const cassettePath = path.join(directory, `${scenario}.json`);
  return JSON.parse(readFileSync(cassettePath, 'utf8')) as Cassette;
}

/**
 * The drift check runs under a scheduled monitor where `CI` is always set.
 * `record-live`'s local-only guard exists to keep raw captures out of CI
 * artifacts; the drift path satisfies that intent by recording into an
 * ephemeral temp directory and never committing or uploading the capture, so
 * it removes only the `CI` marker from its recorder environment copy.
 */
function withoutCiMarker(environment: LoadedRecorderEnvironment): LoadedRecorderEnvironment {
  const env = { ...environment.env };
  delete env.CI;
  return { env, loadedFiles: environment.loadedFiles };
}

/**
 * Load the recorder environment for the GHA drift monitor.
 *
 * `loadRecorderEnvironment` intentionally strips ambient recorder credentials so
 * local `record-live` only reads gitignored `.env`. The cassette-drift workflow
 * has no `.env` and instead injects `POSTMAN_E2E_API_KEY_NON_ORG_MODE` (etc.) via
 * GitHub Actions secrets — re-apply those three ambient names after the base load,
 * then drop `CI` so the recorder's local-only guard accepts the monitor run.
 */
export function loadDriftMonitorEnvironment(
  options: RecorderEnvironmentOptions = {}
): LoadedRecorderEnvironment {
  const loaded = loadRecorderEnvironment(options);
  const ambientEnv = options.ambientEnv ?? process.env;
  const env = { ...loaded.env };

  for (const name of DRIFT_MONITOR_CREDENTIAL_ENVIRONMENT) {
    const value = ambientEnv[name]?.trim();
    if (value) {
      env[name] = value;
    }
  }

  delete env.CI;
  return { env, loadedFiles: loaded.loadedFiles };
}

export async function runDriftCheck(options: DriftCheckOptions): Promise<DriftCheckResult> {
  const scenario = selectRecorderScenario(options.scenario ?? 'fresh-onboard').name;
  const rawOutputRoot = options.rawOutputRoot;
  assertEphemeralRawOutputRoot(rawOutputRoot);
  const committedDirectory = options.committedCassetteDirectory ?? COMMITTED_CASSETTE_DIRECTORY;
  const baseline = loadCommittedCassette(committedDirectory, scenario);

  const environment = options.loadedEnvironment
    ? withoutCiMarker(options.loadedEnvironment)
    : loadDriftMonitorEnvironment();
  const record = options.recordScenario ?? recordLiveScenario;
  const recording = await record(scenario, environment, { rawOutputRoot });

  const sanitized = sanitizeCassette(recording.cassette);
  const findings = diffCassetteShapes(cassetteShape(baseline), cassetteShape(sanitized));
  return { scenario, findings, interactionCount: sanitized.interactions.length };
}

export interface DriftCheckCommandOptions {
  scenario?: string;
  createTemporaryDirectory?: () => Promise<string>;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
  runCheck?: typeof runDriftCheck;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  setExitCode?: (code: number) => void;
}

/** Run the shipped drift command with injectable I/O for deterministic tests. */
export async function runDriftCheckCommand(options: DriftCheckCommandOptions = {}): Promise<number> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const scenario = options.scenario ?? 'fresh-onboard';
  const createTemporaryDirectory =
    options.createTemporaryDirectory ?? (() => mkdtemp(path.join(tmpdir(), 'bootstrap-drift-raw-')));
  const removeTemporaryDirectory =
    options.removeTemporaryDirectory ?? ((directory: string) => rm(directory, { recursive: true, force: true }));
  const runCheck = options.runCheck ?? runDriftCheck;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const setExitCode = options.setExitCode ?? ((code: number) => {
    process.exitCode = code;
  });
  const rawOutputRoot = await createTemporaryDirectory();
  try {
    const result = await runCheck({ scenario, rawOutputRoot });
    if (result.findings.length > 0) {
      stderr.write(`${formatDriftReport(result.findings)}\n`);
      stderr.write(
        `DRIFT_CHECK_FAILED scenario=${result.scenario} findings=${result.findings.length}\n`
      );
      setExitCode(1);
      return 1;
    }
    stdout.write(
      `DRIFT_CHECK_OK scenario=${result.scenario} interactions=${result.interactionCount}\n`
    );
    return 0;
  } finally {
    await removeTemporaryDirectory(rawOutputRoot);
  }
}

async function main(): Promise<void> {
  await runDriftCheckCommand({ scenario: process.argv[2] ?? 'fresh-onboard' });
}

function isEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return pathToFileURL(path.resolve(entrypoint)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
