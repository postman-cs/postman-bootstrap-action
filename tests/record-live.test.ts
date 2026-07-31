import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RAW_CASSETTE_DIRECTORY,
  assertLocalRecording,
  loadRecorderEnvironment,
  parseRecordLiveArgs,
  selectRecorderScenario
} from '../scripts/record-live.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'bootstrap-record-live-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('record-live environment', () => {
  it('prefers ambient env, then package .env, then the workspace-root fallback', () => {
    const workspaceRoot = temporaryDirectory();
    const localPackageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    mkdirSync(localPackageRoot, { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, '.env'),
      'SHARED=workspace\nROOT_ONLY=workspace\n',
      'utf8'
    );
    writeFileSync(
      path.join(localPackageRoot, '.env'),
      'SHARED=package\nPACKAGE_ONLY=package\n',
      'utf8'
    );

    const loaded = loadRecorderEnvironment({
      ambientEnv: { SHARED: 'ambient', AMBIENT_ONLY: 'ambient' },
      packageRoot: localPackageRoot,
      workspaceRoot
    });

    expect(loaded.env).toMatchObject({
      SHARED: 'ambient',
      AMBIENT_ONLY: 'ambient',
      PACKAGE_ONLY: 'package',
      ROOT_ONLY: 'workspace'
    });
    expect(loaded.loadedFiles).toEqual([
      path.join(workspaceRoot, '.env'),
      path.join(localPackageRoot, '.env')
    ]);
  });

  it.each([{ CI: '' }, { CI: 'false' }, { CI: 'true' }])(
    'refuses recording whenever CI is set: %j',
    (env) => {
      expect(() => assertLocalRecording(env)).toThrow('Recording live cassettes is disabled in CI');
    }
  );
});

describe('record-live output safety', () => {
  it('keeps the raw cassette directory covered by gitignore', () => {
    const candidate = path.join(packageRoot, RAW_CASSETTE_DIRECTORY, 'fresh-onboard.json');
    expect(() =>
      execFileSync('git', ['check-ignore', '--quiet', '--no-index', candidate], {
        cwd: packageRoot,
        stdio: 'ignore'
      })
    ).not.toThrow();
  });
});

describe('record-live scenarios', () => {
  it('defaults to fresh-onboard and accepts explicit selection', () => {
    expect(parseRecordLiveArgs([])).toEqual({ scenario: 'fresh-onboard' });
    expect(parseRecordLiveArgs(['--scenario', 'fresh-onboard'])).toEqual({
      scenario: 'fresh-onboard'
    });
    expect(parseRecordLiveArgs(['--scenario=fresh-onboard'])).toEqual({
      scenario: 'fresh-onboard'
    });
    expect(selectRecorderScenario('fresh-onboard').name).toBe('fresh-onboard');
  });

  it('fails closed for an unknown scenario', () => {
    expect(() => selectRecorderScenario('unknown')).toThrow(
      'Unknown recording scenario "unknown". Supported scenarios: fresh-onboard'
    );
  });
});
