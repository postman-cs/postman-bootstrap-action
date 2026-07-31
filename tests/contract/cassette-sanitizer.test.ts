import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cassetteRequest,
  createEmptyCassette,
  createRecordingFetch,
  createReplayFetch,
  type Cassette
} from '@postman-cse/automation-core/cassette';
import { describe, expect, it, vi } from 'vitest';

import { createSecretMasker } from '../../src/lib/secrets.js';
import {
  assertCassetteRedacted,
  sanitizeCassette,
  stableCassetteJson
} from '../../scripts/sanitize-cassette.js';
import { createPlatformFake, type PlatformFakeOptions } from './platform-fake.js';
import { runContractAction, runWithFakeTimers } from './harness.js';

const { uuidSequence } = vi.hoisted(() => ({ uuidSequence: { next: 0 } }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(uuidSequence.next++).padStart(12, '0')}`
  };
});

const POISONED_FIXTURE = resolve('tests/fixtures/poisoned-cassette.json');
const COMMITTED_LIVE_CASSETTE = resolve('tests/contract/cassettes/fresh-onboard-live.json');
const BIFROST_URL = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';
const RAW_WORKSPACE_ID = 'ac13d5c7-1c42-4db4-9287-927310770201';
const SANITIZED_FAKE_OPTIONS: PlatformFakeOptions = {
  org: true,
  teamId: -1001,
  userId: -2001,
  sessionUserId: -2002,
  workspaceId: 'cassette-workspace-1',
  specificationId: 'cassette-specification-1',
  specificationFileId: 'cassette-specification-2',
  squads: [
    {
      id: -1002,
      name: 'Cassette Squad',
      handle: 'cassette-squad',
      organizationId: -1001
    }
  ],
  collectionId: (_role: 'baseline' | 'smoke' | 'contract', sequence: number) =>
    `cassette-collection-${sequence}`
};

function proxyBody(path: string, method = 'get'): string {
  return JSON.stringify({ service: 'workspaces', method, path });
}

function rawCassette(): Cassette {
  const createRequest = cassetteRequest(BIFROST_URL, 'POST', proxyBody('/workspaces', 'post'));
  const readRequest = cassetteRequest(
    BIFROST_URL,
    'POST',
    proxyBody(`/workspaces/${RAW_WORKSPACE_ID}`)
  );

  return {
    version: 2,
    recordedAt: '2026-07-31T19:45:00.000Z',
    interactions: [
      {
        ...createRequest,
        status: 201,
        statusText: 'Created',
        body: JSON.stringify({
          data: {
            id: RAW_WORKSPACE_ID,
            teamId: 12345678,
            userId: 76543210,
            email: 'operator@example.com',
            repository: 'https://github.com/example/private-repo',
            runId: '9876543210',
            createdAt: '2026-07-31T19:45:00.000Z'
          }
        }),
        responseHeaders: {
          authorization: 'Bearer live-access-token',
          date: 'Fri, 31 Jul 2026 19:45:00 GMT',
          'x-api-key': 'PMAK-hand-poisoned-redaction-ratchet'
        }
      },
      {
        ...readRequest,
        status: 200,
        body: JSON.stringify({ data: { id: RAW_WORKSPACE_ID } }),
        responseHeaders: { 'content-type': 'application/json' }
      }
    ]
  };
}

async function recordSanitizedFakeCassette(): Promise<{
  cassette: Cassette;
  outputs: Record<string, string>;
}> {
  const raw = createEmptyCassette();
  const recording = createRecordingFetch(
    createPlatformFake(SANITIZED_FAKE_OPTIONS).fetch,
    raw,
    createSecretMasker(['pmak-test', 'minted-access-token'])
  );

  uuidSequence.next = 0;
  const recorded = await runWithFakeTimers(() =>
    runContractAction({
      inputs: { 'postman-api-key': 'pmak-test', 'postman-access-token': '' },
      env: { GITHUB_RUN_ID: 'cassette-run' },
      fetchImpl: recording
    })
  );
  expect(recorded.error).toBeUndefined();
  return { cassette: sanitizeCassette(raw), outputs: recorded.outputs };
}

describe('contract: cassette sanitizer', () => {
  it('keeps a hand-poisoned negative fixture red', () => {
    const poisoned = JSON.parse(readFileSync(POISONED_FIXTURE, 'utf8')) as Cassette;

    expect(() => assertCassetteRedacted(poisoned)).toThrow(/PMAK|secret|redact/i);
  });

  it('parameterizes volatile values, redacts secrets, and emits stable JSON', () => {
    const sanitized = sanitizeCassette(rawCassette());
    const serialized = stableCassetteJson(sanitized);

    expect(() => assertCassetteRedacted(sanitized)).not.toThrow();
    expect(serialized).not.toContain(RAW_WORKSPACE_ID);
    expect(serialized).not.toContain('12345678');
    expect(serialized).not.toContain('76543210');
    expect(serialized).not.toContain('operator@example.com');
    expect(serialized).not.toContain('github.com/example/private-repo');
    expect(serialized).not.toContain('live-access-token');
    expect(serialized).not.toContain('PMAK-');
    expect(serialized).toBe(stableCassetteJson(sanitizeCassette(rawCassette())));
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it('replays parameterized response IDs through matching parameterized interaction keys', async () => {
    const sanitized = sanitizeCassette(rawCassette());
    const replay = createReplayFetch(structuredClone(sanitized));

    const created = await replay(BIFROST_URL, {
      method: 'POST',
      body: proxyBody('/workspaces', 'post')
    });
    const createdBody = (await created.json()) as { data: { id: string } };
    expect(createdBody.data.id).toMatch(/^cassette-workspace-\d+$/);

    const readBody = proxyBody(`/workspaces/${createdBody.data.id}`);
    expect(cassetteRequest(BIFROST_URL, 'POST', readBody).key).toBe(
      sanitized.interactions[1]?.key
    );
    await expect(
      replay(BIFROST_URL, { method: 'POST', body: readBody }).then((response) => response.json())
    ).resolves.toEqual({ data: { id: createdBody.data.id } });
  });

  it('round-trips a sanitized platform-fake recording through the full action flow', async () => {
    const { cassette: sanitized, outputs: recordedOutputs } =
      await recordSanitizedFakeCassette();
    uuidSequence.next = 0;
    const replayed = await runWithFakeTimers(() =>
      runContractAction({
        inputs: { 'postman-api-key': 'pmak-test', 'postman-access-token': '' },
        env: { GITHUB_RUN_ID: 'cassette-run' },
        fetchImpl: createReplayFetch(structuredClone(sanitized))
      })
    );

    expect(replayed.error).toBeUndefined();
    expect(replayed.outputs['workspace-id']).toBe(recordedOutputs['workspace-id']);
    expect(replayed.outputs['spec-id']).toBe(recordedOutputs['spec-id']);
  });

  it('loads the committed sanitized live fresh-onboard cassette', () => {
    const cassette = JSON.parse(readFileSync(COMMITTED_LIVE_CASSETTE, 'utf8')) as Cassette;

    expect(cassette.version).toBe(2);
    expect(cassette.recordedAt).toBe('2000-01-01T00:00:00.000Z');
    expect(cassette.interactions).toHaveLength(50);
    expect(() => assertCassetteRedacted(cassette)).not.toThrow();
  });
});
