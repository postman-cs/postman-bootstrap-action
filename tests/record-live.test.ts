import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createReplayFetch } from '@postman-cse/automation-core/cassette';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RAW_CASSETTE_DIRECTORY,
  assertLocalRecording,
  loadRunAction,
  loadRecorderEnvironment,
  parseRecordLiveArgs,
  recordLiveScenario,
  selectRecorderScenario
} from '../scripts/record-live.js';
import { sanitizeCassetteFile } from '../scripts/sanitize-cassette.js';
import type { PlannedOutputs } from '../src/index.js';

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
  it('prefers ambient ordinary environment variables over package and workspace .env values', () => {
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

  it('ignores ambient PMAK and access-token credentials', () => {
    const workspaceRoot = temporaryDirectory();
    const localPackageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    mkdirSync(localPackageRoot, { recursive: true });

    const loaded = loadRecorderEnvironment({
      ambientEnv: {
        POSTMAN_API_KEY: 'ambient-pmak',
        POSTMAN_E2E_API_KEY_NON_ORG_MODE: 'ambient-e2e-pmak',
        POSTMAN_ACCESS_TOKEN: 'ambient-access-token'
      },
      packageRoot: localPackageRoot,
      workspaceRoot
    });

    expect(loaded.env).not.toHaveProperty('POSTMAN_API_KEY');
    expect(loaded.env).not.toHaveProperty('POSTMAN_E2E_API_KEY_NON_ORG_MODE');
    expect(loaded.env).not.toHaveProperty('POSTMAN_ACCESS_TOKEN');
  });

  it('loads credentials from .env with package precedence over workspace', () => {
    const workspaceRoot = temporaryDirectory();
    const localPackageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    mkdirSync(localPackageRoot, { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, '.env'),
      'POSTMAN_API_KEY=workspace-pmak\nPOSTMAN_E2E_API_KEY_NON_ORG_MODE=workspace-e2e-pmak\nPOSTMAN_ACCESS_TOKEN=workspace-access-token\n',
      'utf8'
    );
    writeFileSync(
      path.join(localPackageRoot, '.env'),
      'POSTMAN_API_KEY=package-pmak\nPOSTMAN_ACCESS_TOKEN=package-access-token\n',
      'utf8'
    );

    const loaded = loadRecorderEnvironment({
      ambientEnv: {
        POSTMAN_API_KEY: 'ambient-pmak',
        POSTMAN_E2E_API_KEY_NON_ORG_MODE: 'ambient-e2e-pmak',
        POSTMAN_ACCESS_TOKEN: 'ambient-access-token'
      },
      packageRoot: localPackageRoot,
      workspaceRoot
    });

    expect(loaded.env).toMatchObject({
      POSTMAN_API_KEY: 'package-pmak',
      POSTMAN_E2E_API_KEY_NON_ORG_MODE: 'workspace-e2e-pmak',
      POSTMAN_ACCESS_TOKEN: 'package-access-token'
    });
  });

  it.each([{ CI: '' }, { CI: 'false' }, { CI: 'true' }])(
    'refuses recording whenever CI is set: %j',
    (env) => {
      expect(() => assertLocalRecording(env)).toThrow('Recording live cassettes is disabled in CI');
    }
  );
});

describe('record-live output safety', () => {
  it('loads and invokes the committed dist runAction export', async () => {
    const runAction = loadRunAction();
    const core = {
      error: vi.fn(),
      getInput: vi.fn(() => ''),
      group: vi.fn(),
      info: vi.fn(),
      setFailed: vi.fn(),
      setOutput: vi.fn(),
      setSecret: vi.fn(),
      warning: vi.fn()
    };

    await expect(runAction(core)).rejects.toThrow();
    expect(core.getInput).toHaveBeenCalled();
  });

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
  it('does not expose an ambient access token to the injected action', async () => {
    const workspaceRoot = temporaryDirectory();
    const localPackageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    const rawOutputRoot = path.join(workspaceRoot, 'raw');
    const previousAccessToken = process.env.POSTMAN_ACCESS_TOKEN;
    mkdirSync(localPackageRoot, { recursive: true });
    writeFileSync(path.join(localPackageRoot, '.env'), 'POSTMAN_API_KEY=PMAK-test-key\n', 'utf8');

    try {
      process.env.POSTMAN_ACCESS_TOKEN = 'ambient-access-token';
      const loadedEnvironment = loadRecorderEnvironment({
        packageRoot: localPackageRoot,
        workspaceRoot
      });
      const runAction = vi.fn(async (): Promise<PlannedOutputs> => {
        expect(process.env.POSTMAN_ACCESS_TOKEN).toBeUndefined();
        return {} as PlannedOutputs;
      });

      await recordLiveScenario('fresh-onboard', loadedEnvironment, { rawOutputRoot, runAction });

      expect(runAction).toHaveBeenCalledOnce();
    } finally {
      if (previousAccessToken === undefined) {
        delete process.env.POSTMAN_ACCESS_TOKEN;
      } else {
        process.env.POSTMAN_ACCESS_TOKEN = previousAccessToken;
      }
    }
  });

  it('rejects in CI before invoking the action or fetch or writing a raw cassette', async () => {
    const rawOutputRoot = path.join(temporaryDirectory(), 'raw');
    const runAction = vi.fn();
    const fetchImpl = vi.fn();

    await expect(
      recordLiveScenario(
        'fresh-onboard',
        { env: { CI: 'true', POSTMAN_API_KEY: 'PMAK-test-key' }, loadedFiles: [] },
        { rawOutputRoot, runAction, fetchImpl }
      )
    ).rejects.toThrow('Recording live cassettes is disabled in CI');

    expect(runAction).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(existsSync(path.join(rawOutputRoot, 'fresh-onboard.json'))).toBe(false);
  });

  it('records, sanitizes, and replays the shipped recorder path without live replay calls', async () => {
    const workspaceRoot = temporaryDirectory();
    const localPackageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    const rawOutputRoot = path.join(workspaceRoot, 'raw');
    const committedOutputPath = path.join(workspaceRoot, 'committed', 'fresh-onboard.json');
    const liveWorkspaceId = '12345678-1234-4234-8234-123456789abc';
    const createUrl = 'https://example.test/workspaces';
    mkdirSync(localPackageRoot, { recursive: true });
    writeFileSync(path.join(localPackageRoot, '.env'), 'POSTMAN_API_KEY=PMAK-test-key\n', 'utf8');
    const loadedEnvironment = loadRecorderEnvironment({
      ambientEnv: { POSTMAN_API_KEY: 'PMAK-ambient-key' },
      packageRoot: localPackageRoot,
      workspaceRoot
    });
    const liveFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === createUrl) {
        return new Response(JSON.stringify({ data: { id: liveWorkspaceId }, apiKey: 'PMAK-live-key' }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response('ok', { status: 200 });
    });
    const runAction = async (): Promise<PlannedOutputs> => {
      const created = await globalThis.fetch(createUrl, { method: 'POST' });
      const body = (await created.json()) as { data: { id: string } };
      await globalThis.fetch(`${createUrl}/${body.data.id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ workspaceId: body.data.id, enabled: true })
      });
      return {} as PlannedOutputs;
    };

    const recorded = await recordLiveScenario('fresh-onboard', loadedEnvironment, {
      fetchImpl: liveFetch,
      rawOutputRoot,
      runAction
    });
    const raw = JSON.parse(readFileSync(recorded.outputPath, 'utf8')) as {
      interactions: Array<{ rawRequestBody?: string }>;
    };

    expect(recorded.outputPath).toBe(path.join(rawOutputRoot, 'fresh-onboard.json'));
    expect(raw.interactions[1]?.rawRequestBody).toContain(liveWorkspaceId);

    const sanitized = sanitizeCassetteFile(recorded.outputPath, committedOutputPath);
    const committed = readFileSync(committedOutputPath, 'utf8');
    expect(committed).not.toContain('PMAK-');
    expect(committed).not.toContain('rawRequestBody');

    const replay = createReplayFetch(structuredClone(sanitized));
    const replayedCreate = await replay(createUrl, { method: 'POST' });
    const replayedBody = (await replayedCreate.json()) as { data: { id: string } };
    await expect(
      replay(`${createUrl}/${replayedBody.data.id}/settings`, {
        method: 'PATCH',
        body: JSON.stringify({ workspaceId: replayedBody.data.id, enabled: true })
      }).then((response) => response.text())
    ).resolves.toBe('ok');
    expect(liveFetch).toHaveBeenCalledTimes(2);
  });

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
