import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Cassette } from '@postman-cse/automation-core/cassette';

import {
  cassetteShape,
  diffCassetteShapes,
  formatDriftReport,
  type DriftFinding
} from './cassette-shape.js';
import {
  loadRecorderEnvironment,
  recordLiveScenario,
  type LoadedRecorderEnvironment
} from './record-live.js';
import { sanitizeCassette } from './sanitize-cassette.js';

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

export async function runDriftCheck(options: DriftCheckOptions): Promise<DriftCheckResult> {
  const scenario = options.scenario ?? 'fresh-onboard';
  const rawOutputRoot = options.rawOutputRoot;
  if (!rawOutputRoot || !path.isAbsolute(rawOutputRoot)) {
    throw new Error('Drift check requires an absolute ephemeral rawOutputRoot temp directory');
  }
  const committedDirectory = options.committedCassetteDirectory ?? COMMITTED_CASSETTE_DIRECTORY;
  const baseline = loadCommittedCassette(committedDirectory, scenario);

  const environment = withoutCiMarker(options.loadedEnvironment ?? loadRecorderEnvironment());
  const record = options.recordScenario ?? recordLiveScenario;
  const recording = await record(scenario, environment, { rawOutputRoot });

  const sanitized = sanitizeCassette(recording.cassette);
  const findings = diffCassetteShapes(cassetteShape(baseline), cassetteShape(sanitized));
  return { scenario, findings, interactionCount: sanitized.interactions.length };
}

async function main(): Promise<void> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const scenario = process.argv[2] ?? 'fresh-onboard';
  const rawOutputRoot = await mkdtemp(path.join(tmpdir(), 'bootstrap-drift-raw-'));
  try {
    const result = await runDriftCheck({ scenario, rawOutputRoot });
    if (result.findings.length > 0) {
      process.stderr.write(`${formatDriftReport(result.findings)}\n`);
      process.stderr.write(
        `DRIFT_CHECK_FAILED scenario=${result.scenario} findings=${result.findings.length}\n`
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `DRIFT_CHECK_OK scenario=${result.scenario} interactions=${result.interactionCount}\n`
    );
  } finally {
    await rm(rawOutputRoot, { recursive: true, force: true });
  }
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
