/**
 * Deterministic cassette generator, not a gate. Records every scenario in the
 * registry against the platform fake and writes `<name>.json` beside this file.
 *
 *   npm run record:cassettes
 *
 * It is skipped unless RECORD_FAKE_CASSETTES=1 so `npm test` never rewrites
 * committed fixtures. Recording is deterministic — fake timers pin the clock,
 * node:crypto randomUUID is sequenced, and the fake's ids are derived from a
 * per-run counter — so a re-record with no source change is a no-op diff.
 *
 * This is the same transport `scripts/record-live.ts` uses against a live
 * sandbox, and it emits the same file format, so a live capture can replace any
 * of these files without touching the replay suite.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyCassette,
  createRecordingFetch,
  type Cassette
} from '@postman-cse/automation-core/cassette';

import { createSecretMasker } from '../../../src/lib/secrets.js';
import { sanitizeCassette, stableCassetteJson } from '../../../scripts/sanitize-cassette.js';
import { createPlatformFake } from '../platform-fake.js';
import { runContractAction, runWithFakeTimers } from '../harness.js';
import { CASSETTE_SCENARIOS, CASSETTE_SCENARIO_ENV } from './scenarios.js';
import { applyRepeatableReads, cassettePath } from './replay.js';

/**
 * `sanitizeCassette` parameterizes path segments via `collectRouteIds`, which
 * misclassifies stable route literals (`filesystem`, `deepupdate`) as entity ids.
 * Restore those literals so replay keys match the action's wire contract.
 */
function repairSanitizedScenarioRouteKeys(cassette: Cassette): Cassette {
  const repairKey = (key: string): string =>
    key
      .replace(
        /PUT \/collection\/cassette-collection-\d+\/(cassette-collection-\d+)/g,
        'PUT /collection/deepupdate/$1'
      )
      .replace(
        /GET \/workspaces\/cassette-workspace-\d+\?(?=.*\bpath=)(?=.*\brepo=)/,
        'GET /workspaces/filesystem?'
      );

  return {
    ...cassette,
    interactions: cassette.interactions.map((interaction) => ({
      ...interaction,
      key: repairKey(interaction.key)
    }))
  };
}

const { uuidSequence } = vi.hoisted(() => ({ uuidSequence: { next: 0 } }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(uuidSequence.next++).padStart(12, '0')}`
  };
});

const ENABLED = process.env.RECORD_FAKE_CASSETTES === '1';

describe.skipIf(!ENABLED)('record: scenario cassettes from the platform fake', () => {
  for (const scenario of CASSETTE_SCENARIOS) {
    it(`records ${scenario.name}`, async () => {
      const cassette = createEmptyCassette();
      const fake = createPlatformFake(scenario.fake ?? {});
      const recording = createRecordingFetch(
        fake.fetch,
        cassette,
        createSecretMasker([...scenario.secrets, 'minted-access-token'])
      );

      uuidSequence.next = 0;
      const result = await runWithFakeTimers(() =>
        runContractAction({
          inputs: scenario.inputs,
          ...(scenario.files ? { files: scenario.files } : {}),
          env: { ...CASSETTE_SCENARIO_ENV, ...(scenario.env ?? {}) },
          fetchImpl: recording
        })
      );

      // A cassette is only worth committing if the run it captured was correct.
      scenario.expectOutputs(result);
      const keys = cassette.interactions.map((interaction) => interaction.key);
      scenario.expectWire(keys);
      expect(keys.length).toBeGreaterThan(5);

      const target = cassettePath(scenario.name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        stableCassetteJson(
          applyRepeatableReads(repairSanitizedScenarioRouteKeys(sanitizeCassette(cassette)))
        )
      );
      expect(resolve(target)).toBe(target);
    }, 120_000);
  }
});
