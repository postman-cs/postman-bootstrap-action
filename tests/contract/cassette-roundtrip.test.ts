/**
 * Proves the cassette record/replay mechanism end-to-end: record a full
 * runAction against the platform fake, then replay the SAME production flow
 * offline from the cassette alone and get identical outputs. The live
 * recording path (record-live) uses this exact transport code, so a green
 * roundtrip here validates the machinery a sandbox recording will rely on.
 */
import { describe, expect, it } from 'vitest';

import { createSecretMasker } from '../../src/lib/secrets.js';
import {
  createEmptyCassette,
  createRecordingFetch,
  createReplayFetch,
  CASSETTE_MINTED_TOKEN
} from './cassette.js';
import { createPlatformFake } from './platform-fake.js';
import { runContractAction } from './harness.js';

const PMAK_ONLY = { 'postman-api-key': 'pmak-test', 'postman-access-token': '' };

describe('contract: cassette roundtrip', () => {
  it('records a {PMAK-only, org} run, redacts secrets, and replays it to identical outputs', async () => {
    const cassette = createEmptyCassette();
    const fake = createPlatformFake({ org: true });
    const recording = createRecordingFetch(
      fake.fetch,
      cassette,
      createSecretMasker(['pmak-test', 'minted-access-token'])
    );

    const recorded = await runContractAction({ inputs: PMAK_ONLY, fetchImpl: recording });
    expect(recorded.error).toBeUndefined();
    expect(recorded.outputs['workspace-id']).toBe('ws-contract');
    expect(cassette.interactions.length).toBeGreaterThan(5);

    // No secret value survives into the serialized cassette.
    const serialized = JSON.stringify(cassette);
    expect(serialized).not.toContain('pmak-test');
    expect(serialized).not.toContain('minted-access-token');
    expect(serialized).toContain(CASSETTE_MINTED_TOKEN);

    // Envelope-aware keys: proxied calls key on service/method/path, not the URL.
    expect(cassette.interactions.some((entry) => entry.key.startsWith('proxy:ums GET'))).toBe(true);
    expect(
      cassette.interactions.some((entry) => entry.key === 'proxy:workspaces POST /workspaces')
    ).toBe(true);

    // Replay the same flow with NO live transport at all.
    const replayed = await runContractAction({
      inputs: PMAK_ONLY,
      fetchImpl: createReplayFetch(structuredClone(cassette))
    });
    expect(replayed.error).toBeUndefined();
    expect(replayed.outputs['workspace-id']).toBe(recorded.outputs['workspace-id']);
    expect(replayed.outputs['spec-id']).toBe(recorded.outputs['spec-id']);
  });

  it('replay fails loudly (with the key inventory) when the platform shape drifts from the cassette', async () => {
    const cassette = createEmptyCassette();
    cassette.interactions.push({ key: 'GET https://api.getpostman.com/me', status: 200, body: '{}' });
    const replay = createReplayFetch(cassette);

    await expect(
      replay('https://api.getpostman.com/unknown-surface', { method: 'POST' })
    ).rejects.toThrow(/no recorded response .*POST https:\/\/api\.getpostman\.com\/unknown-surface/s);
  });
});
