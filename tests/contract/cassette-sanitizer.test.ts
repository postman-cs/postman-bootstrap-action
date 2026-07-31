import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  cassetteRequest,
  createEmptyCassette,
  createReplayFetch,
  type Cassette
} from '@postman-cse/automation-core/cassette';
import { describe, expect, it, vi } from 'vitest';

import { createSecretMasker } from '../../src/lib/secrets.js';
import { createSanitizableRecordingFetch } from '../../scripts/recording-capture.js';
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
const RAW_SPECIFICATION_ID = 'bc13d5c7-1c42-4db4-9287-927310770201';
const RAW_COLLECTION_ID = 'cc13d5c7-1c42-4db4-9287-927310770201';
const LIVE_PMAK = 'PMAK-live-recording-credential';
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

function proxyBody(path: string, method = 'get', body?: unknown): string {
  return JSON.stringify({ service: 'workspaces', method, path, ...(body === undefined ? {} : { body }) });
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
  raw: Cassette;
  outputs: Record<string, string>;
  liveFetch: ReturnType<typeof vi.fn>;
}> {
  const raw = createEmptyCassette();
  const liveFetch = vi.fn(createPlatformFake({
    ...SANITIZED_FAKE_OPTIONS,
    workspaceId: RAW_WORKSPACE_ID,
    specificationId: RAW_SPECIFICATION_ID,
    collectionId: (_role, sequence) =>
      `${RAW_COLLECTION_ID.slice(0, -12)}${String(sequence).padStart(12, '0')}`
  }).fetch);
  const recording = createSanitizableRecordingFetch(
    liveFetch,
    raw,
    createSecretMasker([LIVE_PMAK, 'minted-access-token'])
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
  return { raw, cassette: sanitizeCassette(raw), outputs: recorded.outputs, liveFetch };
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

  it('rekeys a digest-bearing proxy body after replacing a returned workspace ID', async () => {
    const createBody = proxyBody('/workspaces', 'post');
    const followUpBody = proxyBody(`/workspaces/${RAW_WORKSPACE_ID}`, 'patch', {
      workspaceId: RAW_WORKSPACE_ID
    });
    const raw = {
      version: 2 as const,
      interactions: [
        {
          ...cassetteRequest(BIFROST_URL, 'POST', createBody),
          status: 201,
          body: JSON.stringify({ data: { id: RAW_WORKSPACE_ID } }),
          responseHeaders: {}
        },
        {
          ...cassetteRequest(BIFROST_URL, 'POST', followUpBody),
          rawRequestBody: followUpBody,
          status: 200,
          body: '{"ok":true}',
          responseHeaders: {}
        }
      ]
    };

    const sanitized = sanitizeCassette(raw);
    const returnedWorkspaceId = ((await new Response(sanitized.interactions[0]?.body).json()) as {
      data: { id: string };
    }).data.id;
    const sanitizedFollowUpBody = proxyBody(`/workspaces/${returnedWorkspaceId}`, 'patch', {
      workspaceId: returnedWorkspaceId
    });

    expect(returnedWorkspaceId).toMatch(/^cassette-workspace-\d+$/);
    expect(sanitized.interactions[1]?.key).not.toBe(raw.interactions[1].key);
    expect(sanitized.interactions[1]?.key).toBe(
      cassetteRequest(BIFROST_URL, 'POST', sanitizedFollowUpBody).key
    );
    expect(JSON.stringify(sanitized)).not.toContain('rawRequestBody');

    const replay = createReplayFetch(sanitized);
    await expect(
      replay(BIFROST_URL, { method: 'POST', body: createBody }).then((response) => response.json())
    ).resolves.toEqual({ data: { id: returnedWorkspaceId } });
    await expect(
      replay(BIFROST_URL, { method: 'POST', body: sanitizedFollowUpBody }).then((response) => response.json())
    ).resolves.toEqual({ ok: true });
  });

  it('keeps request-only generated collection IDs stable while rekeying returned workspace IDs', async () => {
    const generatedCollectionId = 'd013d5c7-1c42-4db4-9287-927310770201';
    const createBody = proxyBody('/workspaces', 'post');
    const importBody = proxyBody('/collection/import', 'post', {
      workspaceId: RAW_WORKSPACE_ID,
      collectionId: generatedCollectionId
    });
    const raw = {
      version: 2 as const,
      interactions: [
        {
          ...cassetteRequest(BIFROST_URL, 'POST', createBody),
          status: 201,
          body: JSON.stringify({ data: { id: RAW_WORKSPACE_ID } }),
          responseHeaders: {}
        },
        {
          ...cassetteRequest(BIFROST_URL, 'POST', importBody),
          rawRequestBody: importBody,
          status: 201,
          body: JSON.stringify({ data: { imported: true } }),
          responseHeaders: {}
        }
      ]
    };

    const sanitized = sanitizeCassette(raw);
    const returnedWorkspaceId = JSON.parse(sanitized.interactions[0]?.body ?? '') as {
      data: { id: string };
    };
    const replayImportBody = proxyBody('/collection/import', 'post', {
      workspaceId: returnedWorkspaceId.data.id,
      collectionId: generatedCollectionId
    });

    expect(returnedWorkspaceId.data.id).toMatch(/^cassette-workspace-\d+$/);
    expect(sanitized.interactions[1]?.key).toBe(
      cassetteRequest(BIFROST_URL, 'POST', replayImportBody).key
    );
    expect(sanitized.interactions[1]?.key).toContain(
      cassetteRequest(BIFROST_URL, 'POST', replayImportBody).requestBodySha256 ?? ''
    );
    expect(sanitized.interactions[1]?.key).not.toBe(raw.interactions[1].key);

    const replay = createReplayFetch(sanitized);
    await replay(BIFROST_URL, { method: 'POST', body: createBody });
    await expect(
      replay(BIFROST_URL, { method: 'POST', body: replayImportBody }).then((response) => response.json())
    ).resolves.toEqual({ data: { imported: true } });
  });

  it('redacts named request credentials before recomputing a digest-bearing proxy key', async () => {
    const liveApiKey = 'PMAK-live-request-api-key';
    const liveAccessToken = 'PMAT-live-request-access-token';
    const rawRequestBody = proxyBody('/collection/import', 'post', {
      apiKey: liveApiKey,
      accessToken: liveAccessToken
    });
    const raw = {
      version: 2 as const,
      interactions: [{
        ...cassetteRequest(BIFROST_URL, 'POST', rawRequestBody),
        rawRequestBody,
        status: 200,
        body: '{"ok":true}',
        responseHeaders: {}
      }]
    };
    const sanitizedRequestBody = proxyBody('/collection/import', 'post', {
      apiKey: '[REDACTED]',
      accessToken: '[REDACTED]'
    });

    const sanitized = sanitizeCassette(raw);

    expect(sanitized.interactions[0]?.key).toBe(
      cassetteRequest(BIFROST_URL, 'POST', sanitizedRequestBody).key
    );
    expect(JSON.stringify(sanitized)).not.toContain(liveApiKey);
    expect(JSON.stringify(sanitized)).not.toContain(liveAccessToken);
    expect(JSON.stringify(sanitized)).not.toContain('rawRequestBody');

    await expect(
      createReplayFetch(sanitized)(BIFROST_URL, {
        method: 'POST',
        body: sanitizedRequestBody
      }).then((response) => response.json())
    ).resolves.toEqual({ ok: true });
  });

  it('rejects raw capture metadata and semantic numeric IDs in hand-poisoned cassettes', () => {
    const poisoned = (body: object, extra: object = {}) => ({
      version: 2 as const,
      interactions: [{
        key: 'POST https://api.getpostman.com/poisoned',
        requestQuery: '',
        status: 200,
        body: JSON.stringify(body),
        responseHeaders: {},
        ...extra
      }]
    });

    for (const body of [
      { workspaceId: 4815162342 },
      { specificationId: 4815162342 },
      { collectionId: 4815162342 }
    ]) {
      expect(() => assertCassetteRedacted(poisoned(body))).toThrow(/ID|identity|redact/i);
    }
    expect(() => assertCassetteRedacted(poisoned({}, { rawRequestBody: '{"secret":"live"}' }))).toThrow(
      /rawRequestBody|raw capture/i
    );
  });

  it('round-trips a sanitized platform-fake recording through the full action flow', async () => {
    const { raw, cassette: sanitized, outputs: recordedOutputs, liveFetch } =
      await recordSanitizedFakeCassette();
    expect(JSON.stringify(raw)).toContain('rawRequestBody');
    expect(JSON.stringify(sanitized)).not.toContain('rawRequestBody');
    expect(JSON.stringify(sanitized)).not.toContain(RAW_WORKSPACE_ID);
    expect(JSON.stringify(sanitized)).not.toContain(LIVE_PMAK);
    liveFetch.mockClear();
    uuidSequence.next = 0;
    const replayed = await runWithFakeTimers(() =>
      runContractAction({
        inputs: { 'postman-api-key': '[REDACTED]', 'postman-access-token': '' },
        env: { GITHUB_RUN_ID: 'cassette-run' },
        fetchImpl: createReplayFetch(structuredClone(sanitized))
      })
    );

    expect(replayed.error).toBeUndefined();
    expect(recordedOutputs['workspace-id']).toBe(RAW_WORKSPACE_ID);
    expect(recordedOutputs['spec-id']).toBe(RAW_SPECIFICATION_ID);
    expect(replayed.outputs['workspace-id']).toMatch(/^cassette-workspace-\d+$/);
    expect(replayed.outputs['spec-id']).toMatch(/^cassette-specification-\d+$/);
    expect(replayed.outputs['workspace-id']).not.toBe(RAW_WORKSPACE_ID);
    expect(replayed.outputs['spec-id']).not.toBe(RAW_SPECIFICATION_ID);
    expect(liveFetch).not.toHaveBeenCalled();
  });

  it('loads the committed sanitized live fresh-onboard cassette', () => {
    const cassette = JSON.parse(readFileSync(COMMITTED_LIVE_CASSETTE, 'utf8')) as Cassette;

    expect(cassette.version).toBe(2);
    expect(cassette.recordedAt).toBe('2000-01-01T00:00:00.000Z');
    expect(cassette.interactions).toHaveLength(50);
    expect(() => assertCassetteRedacted(cassette)).not.toThrow();
  });
});
