import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Cassette } from '@postman-cse/automation-core/cassette';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cassetteShape,
  diffCassetteShapes,
  formatDriftReport,
  schemaEquals,
  schemaSignature
} from '../scripts/cassette-shape.js';
import {
  loadCommittedCassette,
  loadDriftMonitorEnvironment,
  runDriftCheck,
  runDriftCheckCommand
} from '../scripts/drift-check.js';
import type { RecordingResult } from '../scripts/record-live.js';

const COMMITTED_CASSETTES = path.resolve('tests', 'contract', 'cassettes');

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'bootstrap-drift-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function interaction(overrides: Partial<Cassette['interactions'][number]> = {}): Cassette['interactions'][number] {
  return {
    key: 'GET https://api.getpostman.com/me',
    body: '{"user":{"id":"00000000-0000-4000-8000-000000000001","teamName":"team"}}',
    status: 200,
    requestQuery: '',
    responseHeaders: { 'content-type': 'application/json' },
    ...overrides
  };
}

function cassetteOf(...interactions: Cassette['interactions']): Cassette {
  return { version: 2, interactions };
}

describe('cassette shape extraction', () => {
  it('derives a stable schema skeleton that ignores volatile values', () => {
    const left = cassetteShape(cassetteOf(interaction({ body: '{"a":1,"b":"x","c":[{"d":true}]}' })));
    const right = cassetteShape(cassetteOf(interaction({ body: '{"b":"other","a":99,"c":[{"d":false}]}' })));
    expect(schemaEquals(left.interactions[0]!.bodySchema, right.interactions[0]!.bodySchema)).toBe(true);
    expect(schemaSignature(left.interactions[0]!.bodySchema)).toBe(
      '{a:number,b:string,c:array<{d:boolean}>}'
    );
  });

  it('treats non-JSON bodies as opaque strings and empty bodies as unknown', () => {
    const yaml = cassetteShape(cassetteOf(interaction({ body: 'openapi: 3.0.3' })));
    expect(yaml.interactions[0]!.bodySchema).toEqual({ kind: 'string' });
    const empty = cassetteShape(cassetteOf(interaction({ body: '' })));
    expect(empty.interactions[0]!.bodySchema).toEqual({ kind: 'unknown' });
  });
});

describe('cassette shape diff', () => {
  it('reports no findings for identical shapes even when volatile values differ', () => {
    const baseline = cassetteShape(cassetteOf(interaction({ body: '{"id":"a"}' })));
    const fresh = cassetteShape(cassetteOf(interaction({ body: '{"id":"b"}' })));
    expect(diffCassetteShapes(baseline, fresh)).toEqual([]);
  });

  it('names a missing interaction key exactly', () => {
    const baseline = cassetteShape(
      cassetteOf(interaction(), interaction({ key: 'POST https://api.getpostman.com/import/openapi' }))
    );
    const fresh = cassetteShape(cassetteOf(interaction()));
    const findings = diffCassetteShapes(baseline, fresh);
    expect(findings).toEqual([
      {
        key: 'POST https://api.getpostman.com/import/openapi',
        axis: 'key-set',
        detail: 'interaction missing from live re-recording'
      }
    ]);
  });

  it('names an unexpected new interaction key exactly', () => {
    const baseline = cassetteShape(cassetteOf(interaction()));
    const fresh = cassetteShape(
      cassetteOf(interaction(), interaction({ key: 'DELETE https://api.getpostman.com/collections/x' }))
    );
    const findings = diffCassetteShapes(baseline, fresh);
    expect(findings).toEqual([
      {
        key: 'DELETE https://api.getpostman.com/collections/x',
        axis: 'key-set',
        detail: 'unexpected new interaction in live re-recording'
      }
    ]);
  });

  it('reports repeated-interaction count changes', () => {
    const baseline = cassetteShape(cassetteOf(interaction(), interaction()));
    const fresh = cassetteShape(cassetteOf(interaction()));
    expect(diffCassetteShapes(baseline, fresh)).toEqual([
      {
        key: 'GET https://api.getpostman.com/me',
        axis: 'key-set',
        detail: 'interaction count changed: baseline 2 -> live 1'
      }
    ]);
  });

  it('reports status drift naming both statuses', () => {
    const baseline = cassetteShape(cassetteOf(interaction({ status: 200 })));
    const fresh = cassetteShape(cassetteOf(interaction({ status: 202 })));
    expect(diffCassetteShapes(baseline, fresh)).toEqual([
      {
        key: 'GET https://api.getpostman.com/me',
        axis: 'status',
        detail: 'status changed: baseline 200 -> live 202'
      }
    ]);
  });

  it('reports body-schema drift with the exact key path (hand-edited cassette red proof)', () => {
    const committed = loadCommittedCassette(COMMITTED_CASSETTES, 'fresh-onboard');
    const edited: Cassette = JSON.parse(JSON.stringify(committed)) as Cassette;
    const target = edited.interactions.find((entry) => entry.key === 'GET https://api.getpostman.com/me');
    expect(target).toBeDefined();
    const parsed = JSON.parse(target!.body) as { user: Record<string, unknown> };
    delete parsed.user.teamName;
    parsed.user.renamedTeamName = 'drifted';
    target!.body = JSON.stringify(parsed);

    const findings = diffCassetteShapes(cassetteShape(committed), cassetteShape(edited));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      key: 'GET https://api.getpostman.com/me',
      axis: 'body-schema'
    });
    expect(findings[0]!.detail).toContain('teamName');
    const report = formatDriftReport(findings);
    expect(report).toContain('DRIFT [body-schema] GET https://api.getpostman.com/me');
  });

  it('is clean against every committed cassette compared to itself', () => {
    for (const name of [
      'branch-preview',
      'fresh-onboard',
      'large-spec',
      'multifile-openapi',
      'non-org-visibility-flip',
      'org-mode',
      'protobuf-grpc',
      'refresh-deep-update'
    ]) {
      const cassette = loadCommittedCassette(COMMITTED_CASSETTES, name);
      expect(diffCassetteShapes(cassetteShape(cassette), cassetteShape(cassette)), name).toEqual([]);
    }
  });
});

describe('loadDriftMonitorEnvironment', () => {
  function emptyRoots(): { packageRoot: string; workspaceRoot: string } {
    const workspaceRoot = temporaryDirectory();
    const packageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    mkdirSync(packageRoot, { recursive: true });
    return { packageRoot, workspaceRoot };
  }

  it('preserves the ambient workflow PMAK while removing CI without requiring .env', () => {
    const roots = emptyRoots();
    const loaded = loadDriftMonitorEnvironment({
      ambientEnv: {
        POSTMAN_E2E_API_KEY_NON_ORG_MODE: 'gha-smoke-pmak',
        CI: 'true'
      },
      ...roots
    });

    expect(loaded.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE).toBe('gha-smoke-pmak');
    expect(loaded.env).not.toHaveProperty('CI');
    expect(loaded.loadedFiles).toEqual([]);
  });

  it('strips CI from the resulting env', () => {
    const roots = emptyRoots();
    const loaded = loadDriftMonitorEnvironment({
      ambientEnv: {
        POSTMAN_E2E_API_KEY_NON_ORG_MODE: 'gha-smoke-pmak',
        CI: 'true'
      },
      ...roots
    });

    expect(loaded.env).not.toHaveProperty('CI');
  });

  it('does not invent empty credential keys when ambient lacks them', () => {
    const roots = emptyRoots();
    const loaded = loadDriftMonitorEnvironment({
      ambientEnv: { CI: 'true', OTHER: 'kept' },
      ...roots
    });

    expect(loaded.env).not.toHaveProperty('POSTMAN_API_KEY');
    expect(loaded.env).not.toHaveProperty('POSTMAN_E2E_API_KEY_NON_ORG_MODE');
    expect(loaded.env).not.toHaveProperty('POSTMAN_ACCESS_TOKEN');
    expect(loaded.env.OTHER).toBe('kept');
  });
});

describe('runDriftCheck', () => {
  it('passes the ambient workflow PMAK to the recorder while removing CI', async () => {
    const workspaceRoot = temporaryDirectory();
    const packageRoot = path.join(workspaceRoot, 'cse', 'postman-bootstrap-action');
    mkdirSync(packageRoot, { recursive: true });
    const environment = loadDriftMonitorEnvironment({
      ambientEnv: { POSTMAN_E2E_API_KEY_NON_ORG_MODE: 'gha-smoke-pmak', CI: 'true' },
      packageRoot,
      workspaceRoot
    });
    const committed = loadCommittedCassette(COMMITTED_CASSETTES, 'fresh-onboard');

    await runDriftCheck({
      rawOutputRoot: temporaryDirectory(),
      loadedEnvironment: environment,
      recordScenario: async (scenario, recorderEnvironment): Promise<RecordingResult> => {
        expect(recorderEnvironment?.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE).toBe('gha-smoke-pmak');
        expect(recorderEnvironment?.env).not.toHaveProperty('CI');
        return {
          cassette: committed,
          outputPath: 'unused',
          outputs: {} as RecordingResult['outputs'],
          scenario
        };
      }
    });
  });

  it('re-records through the injected recorder, sanitizes in memory, and reports zero findings for a shape-identical capture', async () => {
    const committed = loadCommittedCassette(COMMITTED_CASSETTES, 'fresh-onboard');
    const rawOutputRoot = temporaryDirectory();
    const result = await runDriftCheck({
      scenario: 'fresh-onboard',
      rawOutputRoot,
      loadedEnvironment: { env: { CI: 'true' }, loadedFiles: [] },
      recordScenario: async (scenario, environment, runtime): Promise<RecordingResult> => {
        expect(scenario).toBe('fresh-onboard');
        // The drift path must strip the CI marker so the recorder's local-only
        // guard does not reject the scheduled monitor run.
        expect(environment?.env).not.toHaveProperty('CI');
        expect(runtime?.rawOutputRoot).toBe(rawOutputRoot);
        return {
          cassette: JSON.parse(JSON.stringify(committed)) as Cassette,
          outputPath: path.join(rawOutputRoot, 'fresh-onboard.json'),
          outputs: {} as RecordingResult['outputs'],
          scenario
        };
      }
    });
    expect(result.findings).toEqual([]);
    expect(result.interactionCount).toBe(committed.interactions.length);
  });

  it('fails loudly with exact keys when the live capture drifts', async () => {
    const committed = loadCommittedCassette(COMMITTED_CASSETTES, 'fresh-onboard');
    const drifted: Cassette = JSON.parse(JSON.stringify(committed)) as Cassette;
    drifted.interactions = drifted.interactions.filter(
      (entry) => entry.key !== 'GET https://api.getpostman.com/me'
    );
    const result = await runDriftCheck({
      scenario: 'fresh-onboard',
      rawOutputRoot: temporaryDirectory(),
      loadedEnvironment: { env: {}, loadedFiles: [] },
      recordScenario: async (scenario): Promise<RecordingResult> => ({
        cassette: drifted,
        outputPath: 'unused',
        outputs: {} as RecordingResult['outputs'],
        scenario
      })
    });
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]).toMatchObject({
      key: 'GET https://api.getpostman.com/me',
      axis: 'key-set',
      detail: 'interaction missing from live re-recording'
    });
  });

  it('rejects a non-absolute raw output root', async () => {
    await expect(
      runDriftCheck({ rawOutputRoot: 'relative/path', loadedEnvironment: { env: {}, loadedFiles: [] } })
    ).rejects.toThrow('absolute ephemeral rawOutputRoot');
  });

  it('rejects a durable absolute raw output root before loading a baseline or invoking the recorder', async () => {
    let recorderCalled = false;
    await expect(
      runDriftCheck({
        rawOutputRoot: path.resolve('tests'),
        committedCassetteDirectory: path.resolve('does-not-exist'),
        loadedEnvironment: { env: {}, loadedFiles: [] },
        recordScenario: async (): Promise<RecordingResult> => {
          recorderCalled = true;
          throw new Error('recorder must not be called');
        }
      })
    ).rejects.toThrow('ephemeral rawOutputRoot child directory under the OS temp root');
    expect(recorderCalled).toBe(false);
  });
});

describe('drift:check entrypoint', () => {
  it('emits every drift line, returns exit 1, and cleans its temporary raw directory', async () => {
    const rawOutputRoot = temporaryDirectory();
    const stderr: string[] = [];
    const exitCodes: number[] = [];
    const status = await runDriftCheckCommand({
      scenario: 'injected-drift',
      createTemporaryDirectory: async () => rawOutputRoot,
      runCheck: async () => ({
        scenario: 'injected-drift',
        interactionCount: 3,
        findings: [
          {
            key: 'GET https://api.getpostman.com/me',
            axis: 'status',
            detail: 'status changed: baseline 200 -> live 500'
          }
        ]
      }),
      stderr: {
        write: (message: string | Uint8Array) => {
          stderr.push(String(message));
          return true;
        }
      },
      setExitCode: (code: number) => exitCodes.push(code)
    });

    expect(status).toBe(1);
    expect(exitCodes).toEqual([1]);
    expect(stderr).toEqual([
      'DRIFT [status] GET https://api.getpostman.com/me — status changed: baseline 200 -> live 500\n',
      'DRIFT_CHECK_FAILED scenario=injected-drift findings=1\n'
    ]);
    expect(existsSync(rawOutputRoot)).toBe(false);
  });

  it('cleans its temporary raw directory when the drift check throws', async () => {
    const rawOutputRoot = temporaryDirectory();
    await expect(
      runDriftCheckCommand({
        createTemporaryDirectory: async () => rawOutputRoot,
        runCheck: async () => {
          throw new Error('injected recorder failure');
        }
      })
    ).rejects.toThrow('injected recorder failure');
    expect(existsSync(rawOutputRoot)).toBe(false);
  });

  it('shipped node --experimental-strip-types entrypoint loads the drift-check module graph', () => {
    const entry = pathToFileURL(path.resolve('scripts/drift-check.ts')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(entry)}).then(() => { console.log('DRIFT_ENTRYPOINT_LOAD_OK'); }).catch((error) => { console.error(error); process.exit(1); })`
      ],
      {
        encoding: 'utf8',
        cwd: path.resolve('.'),
        env: { ...process.env, POSTMAN_ACTIONS_TELEMETRY: 'off' }
      }
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('DRIFT_ENTRYPOINT_LOAD_OK');
    expect(result.stderr + result.stdout).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
  });
});
