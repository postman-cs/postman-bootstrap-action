/**
 * WS3 scenario suite: replay every committed cassette through the REAL runAction
 * with ZERO live transport, and assert the run's final outputs plus the wire
 * contract it depended on.
 *
 * "Zero live transport" is structural, not aspirational. The only fetch the run
 * can see is `createReplayFetch` over a committed JSON file, and that transport
 * is fail-closed: an unknown interaction key or an exhausted queue throws with
 * the recorded key inventory. So a production change that reaches for a route
 * the cassette never recorded fails this suite instead of silently escaping to
 * the network.
 *
 * Cassettes are generated from the deterministic platform fake today
 * (`npm run record:cassettes`). The file format and this replay path are what
 * `scripts/record-live.ts` produces from a live sandbox, so a sanitized live
 * capture drops in without a test change.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReplayFetch } from '@postman-cse/automation-core/cassette';

import { runContractAction, runWithFakeTimers } from './harness.js';
import { createPlatformFake } from './platform-fake.js';
import { CASSETTE_SCENARIOS, CASSETTE_SCENARIO_ENV } from './cassettes/scenarios.js';
import {
  isRepeatableRead,
  listCommittedCassetteJsonFiles,
  readCassette
} from './cassettes/replay.js';

// The recorded request keys include a digest of every request body, and the
// production flow puts generated UUIDs into some of those bodies. Replay must
// therefore reproduce the same UUID sequence the recording saw, exactly as the
// recorder does.
const { uuidSequence } = vi.hoisted(() => ({ uuidSequence: { next: 0 } }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(uuidSequence.next++).padStart(12, '0')}`
  };
});

describe('contract: cassette scenario suite (offline replay)', () => {
  for (const scenario of CASSETTE_SCENARIOS) {
    describe(scenario.name, () => {
      it(scenario.description, async () => {
        const cassette = readCassette(scenario.name);
        expect(cassette.version).toBe(2);
        expect(cassette.interactions.length).toBeGreaterThan(5);

        let replayedCalls = 0;
        const replay = createReplayFetch(structuredClone(cassette));
        const countedReplay = ((input: RequestInfo | URL, init?: RequestInit) => {
          replayedCalls += 1;
          return replay(input, init);
        }) as typeof fetch;

        uuidSequence.next = 0;
        const result = await runWithFakeTimers(() =>
          runContractAction({
            inputs: scenario.replayInputs ?? scenario.inputs,
            ...(scenario.files ? { files: scenario.files } : {}),
            env: { ...CASSETTE_SCENARIO_ENV, ...(scenario.env ?? {}) },
            fetchImpl: countedReplay
          })
        );

        scenario.expectOutputs(result);
        scenario.expectWire(cassette.interactions.map((interaction) => interaction.key));

        // Every byte of platform state this run observed came from the cassette.
        expect(replayedCalls).toBeGreaterThan(5);
      }, 120_000);

      it('keeps every interaction one-shot except the allowlisted constant reads', () => {
        // repeatLast is the only way an interaction can serve more than one
        // request, so it must never spread past the documented allowlist.
        const repeating = readCassette(scenario.name)
          .interactions.filter((interaction) => interaction.repeatLast)
          .map((interaction) => interaction.key);
        expect(repeating.filter((key) => !isRepeatableRead(key))).toEqual([]);
      });

      it('never leaks a credential into the committed fixture', () => {
        const serialized = JSON.stringify(readCassette(scenario.name));
        for (const secret of scenario.secrets) {
          expect(serialized).not.toContain(secret);
        }
        expect(serialized).not.toContain('minted-access-token');
        expect(serialized).not.toMatch(/PMAK-/i);
      });
    });
  }

  it('covers the full WS3 scenario set exactly once', () => {
    const names = CASSETTE_SCENARIOS.map((scenario) => scenario.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([
      'branch-preview',
      'fresh-onboard',
      'large-spec',
      'multifile-openapi',
      'non-org-visibility-flip',
      'org-mode',
      'protobuf-grpc',
      'refresh-deep-update'
    ]);
    expect(listCommittedCassetteJsonFiles()).toEqual(names.map((name) => `${name}.json`).sort());
  });

  it('resolves committed cassette files from module location after cwd changes', () => {
    const previous = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'cassette-cwd-'));
    try {
      process.chdir(tempDir);
      expect(readCassette('fresh-onboard').interactions.length).toBeGreaterThan(5);
      expect(listCommittedCassetteJsonFiles()).toContain('fresh-onboard.json');
      expect(realpathSync(process.cwd())).toBe(realpathSync(tempDir));
    } finally {
      process.chdir(previous);
      rmSync(tempDir, { recursive: true, force: true });
    }
    expect(realpathSync(process.cwd())).toBe(realpathSync(previous));
  });

  it('applies the fresh-onboard assertions unchanged to the lagged stateful fake', async () => {
    const scenario = CASSETTE_SCENARIOS.find((entry) => entry.name === 'fresh-onboard');
    expect(scenario).toBeDefined();
    const fake = createPlatformFake({
      ...scenario!.fake,
      pageSize: 1,
      importElection: { importedVisibleAfterObservations: 7 }
    });

    uuidSequence.next = 0;
    const result = await runWithFakeTimers(() =>
      runContractAction({
        inputs: scenario!.inputs,
        env: { ...CASSETTE_SCENARIO_ENV, ...(scenario!.env ?? {}) },
        fetchImpl: fake.fetch
      })
    );

    scenario!.expectOutputs(result);
    expect(fake.state.collectionObservationCount).toBeGreaterThan(6);
    expect(fake.state.collectionTransitions).toEqual(
      expect.arrayContaining([expect.stringMatching(/^visible:.*:observation=8$/)])
    );
    expect(fake.state.paginationCursorsIssued).toBeGreaterThan(0);
  }, 120_000);
});
