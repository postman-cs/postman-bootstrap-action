import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Cassette } from '@postman-cse/automation-core/cassette';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cassetteShape,
  diffCassetteShapes,
  formatDriftReport,
  schemaEquals,
  schemaSignature
} from '../scripts/cassette-shape.js';
import { loadCommittedCassette, runDriftCheck } from '../scripts/drift-check.js';
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

describe('runDriftCheck', () => {
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
});
