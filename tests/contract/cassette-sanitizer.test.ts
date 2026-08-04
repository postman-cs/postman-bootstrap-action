import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CASSETTE_MINTED_TOKEN,
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
  resolveCassetteCliPaths,
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
const BIFROST_URL = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';
const RAW_WORKSPACE_ID = 'ac13d5c7-1c42-4db4-9287-927310770201';
const RAW_SPECIFICATION_ID = 'bc13d5c7-1c42-4db4-9287-927310770201';
const RAW_COLLECTION_ID = 'cc13d5c7-1c42-4db4-9287-927310770201';
const LIVE_PMAK = 'PMAK-live-recording-credential';
const SANITIZED_FAKE_OPTIONS: PlatformFakeOptions = {
  org: true,
  teamId: 1001,
  userId: 2001,
  sessionUserId: 2002,
  workspaceId: 'cassette-workspace-1',
  specificationId: 'cassette-specification-1',
  specificationFileId: 'cassette-specification-2',
  squads: [
    {
      id: 1002,
      name: 'Cassette Squad',
      handle: 'cassette-squad',
      organizationId: 1001
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

  it('redacts concrete local filesystem paths without changing API routes', () => {
    const posixPath = '/Users/operator/work/postman-actions/cassette.json';
    const tempPath = '/private/var/folders/ab/cd/T/cassette.json';
    const windowsPath = 'C:\\Users\\operator\\postman-actions\\cassette.json';
    const uncPath = '\\\\runner\\share\\Users\\operator\\cassette.json';
    const apiRoute = '/v1/workspaces/cassette-workspace-1';
    const raw = {
      version: 2 as const,
      interactions: [{
        key: `GET https://api.getpostman.com${apiRoute}?source=${posixPath}`,
        requestQuery: `temp=${tempPath}&route=${apiRoute}`,
        status: 200,
        body: JSON.stringify({ posixPath, windowsPath, uncPath, apiRoute }),
        responseHeaders: { 'x-debug-path': windowsPath }
      }]
    };

    expect(() => assertCassetteRedacted(raw)).toThrow(/filesystem path|redaction invariant/i);
    const serialized = JSON.stringify(sanitizeCassette(raw));

    expect(serialized).not.toContain(posixPath);
    expect(serialized).not.toContain(tempPath);
    expect(serialized).not.toContain(windowsPath);
    expect(serialized).not.toContain(uncPath);
    expect(serialized).toContain('[REDACTED-LOCAL-PATH]');
    expect(serialized).toContain(apiRoute);
  });

  it('rejects JSON before recursive sanitizer passes exceed safe traversal bounds', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth <= 1_001; depth += 1) nested = { nested };
    const raw = {
      version: 2 as const,
      interactions: [{
        key: 'GET https://api.getpostman.com/poisoned',
        requestQuery: '',
        status: 200,
        body: JSON.stringify(nested),
        responseHeaders: {}
      }]
    };

    expect(() => sanitizeCassette(raw)).toThrow(/safe traversal bounds/i);
    expect(() => assertCassetteRedacted(raw)).toThrow(/safe traversal bounds/i);
  });

  it('resolves only canonical cassette paths under their declared roots', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'cassette-sanitizer-'));
    const rawRoot = join(packageRoot, 'integration/cassettes/raw');
    const committedRoot = join(packageRoot, 'tests/contract/cassettes');
    const rawPath = join(rawRoot, 'recording.raw.json');
    try {
      mkdirSync(rawRoot, { recursive: true });
      mkdirSync(committedRoot, { recursive: true });
      writeFileSync(rawPath, '{}');

      expect(resolveCassetteCliPaths(packageRoot, [
        'integration/cassettes/raw/recording.raw.json'
      ])).toEqual({
        rawPath,
        outputPath: join(committedRoot, 'recording.json')
      });
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('rejects input and output symlink escapes before writing outside the committed root', () => {
    const packageRoot = mkdtempSync(join(tmpdir(), 'cassette-sanitizer-'));
    const rawRoot = join(packageRoot, 'integration/cassettes/raw');
    const committedRoot = join(packageRoot, 'tests/contract/cassettes');
    const outsideRoot = mkdtempSync(join(tmpdir(), 'cassette-sanitizer-outside-'));
    try {
      mkdirSync(rawRoot, { recursive: true });
      mkdirSync(committedRoot, { recursive: true });
      const outsideInput = join(outsideRoot, 'outside.raw.json');
      const outsideOutput = join(outsideRoot, 'outside.json');
      writeFileSync(outsideInput, '{}');
      writeFileSync(join(rawRoot, 'safe.raw.json'), '{}');
      try {
        symlinkSync(outsideInput, join(rawRoot, 'escaped.raw.json'));
        symlinkSync(outsideRoot, join(committedRoot, 'escaped-output'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') return;
        throw error;
      }

      expect(() => resolveCassetteCliPaths(packageRoot, [
        'integration/cassettes/raw/escaped.raw.json'
      ])).toThrow(/Raw cassette input/);
      expect(() => resolveCassetteCliPaths(packageRoot, [
        'integration/cassettes/raw/safe.raw.json',
        'tests/contract/cassettes/escaped-output/outside.json'
      ])).toThrow(/Sanitized cassette output/);
      expect(existsSync(outsideOutput)).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
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

  it('maps paired bare and owner-prefixed collection model IDs to one placeholder', () => {
    const bareCollectionId = RAW_COLLECTION_ID;
    const fullCollectionUid = `12345678-${bareCollectionId}`;
    const raw = {
      version: 2 as const,
      interactions: [{
        key: `proxy:collection PATCH /v3/collections/${fullCollectionUid}`,
        requestQuery: '',
        status: 200,
        body: JSON.stringify({
          data: { id: fullCollectionUid, model_id: bareCollectionId },
          collectionId: bareCollectionId,
          collectionUid: fullCollectionUid
        }),
        responseHeaders: {}
      }]
    };

    const sanitized = sanitizeCassette(raw);
    const response = JSON.parse(sanitized.interactions[0]?.body ?? '') as {
      data: { id: string; model_id: string };
    };
    const serialized = JSON.stringify(sanitized);

    expect(response.data.id).toMatch(/^cassette-collection-\d+$/);
    expect(response.data.model_id).toBe(response.data.id);
    expect(sanitized.interactions[0]?.key).toContain(`/v3/collections/${response.data.id}`);
    expect(serialized).not.toContain(fullCollectionUid);
    expect(serialized).not.toContain(bareCollectionId);
    expect(serialized).not.toContain('12345678');
  });

  it('groups production-shaped collection aliases independently of interaction order', () => {
    const bareCollectionId = 'aaaaaaaa-aaaa-0aaa-7aaa-aaaaaaaaaaaa';
    const fullCollectionUid = `1-${bareCollectionId}`;
    const interactions = [
      {
        key: `proxy:collection PATCH /v3/collections/${fullCollectionUid}`,
        requestQuery: '',
        status: 200,
        body: JSON.stringify({ data: { id: fullCollectionUid }, collectionUid: fullCollectionUid }),
        responseHeaders: {}
      },
      {
        key: 'proxy:sync POST /collection/import',
        requestQuery: '',
        status: 200,
        body: JSON.stringify({ data: { model_id: bareCollectionId }, collectionId: bareCollectionId }),
        responseHeaders: {}
      }
    ];
    const sanitize = (orderedInteractions: typeof interactions) =>
      sanitizeCassette({ version: 2 as const, interactions: orderedInteractions });
    const sanitized = sanitize(interactions);
    const reversed = sanitize([...interactions].reverse());
    const root = sanitized.interactions.find((interaction) => interaction.key.includes('/v3/collections/'));
    const imported = sanitized.interactions.find((interaction) => interaction.key.includes('/collection/import'));
    const rootBody = JSON.parse(root?.body ?? '') as { data: { id: string }; collectionUid: string };
    const importBody = JSON.parse(imported?.body ?? '') as {
      data: { model_id: string };
      collectionId: string;
    };
    const placeholder = rootBody.data.id;
    const normalized = (cassette: Cassette) => stableCassetteJson({
      ...cassette,
      interactions: [...cassette.interactions].sort((left, right) => left.key.localeCompare(right.key))
    });

    expect(placeholder).toMatch(/^cassette-collection-\d+$/);
    expect(rootBody.collectionUid).toBe(placeholder);
    expect(importBody.data.model_id).toBe(placeholder);
    expect(importBody.collectionId).toBe(placeholder);
    expect(root?.key).toContain(`/v3/collections/${placeholder}`);
    expect(normalized(reversed)).toBe(normalized(sanitized));
  });

  it('redacts and rejects production-shaped Postman UIDs in free text', () => {
    const uid = '1-aaaaaaaa-aaaa-0aaa-7aaa-aaaaaaaaaaaa';
    const poisoned = {
      version: 2 as const,
      interactions: [{
        key: 'POST https://api.getpostman.com/poisoned',
        requestQuery: '',
        status: 200,
        body: JSON.stringify({ note: `leaked collection UID: ${uid}` }),
        responseHeaders: {}
      }]
    };

    expect(() => assertCassetteRedacted(poisoned)).toThrow(/Postman UID|redaction invariant/i);
    expect(JSON.stringify(sanitizeCassette(poisoned))).not.toContain(uid);
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

  it('rejects a digest-bearing proxy body without raw request bytes when workspace sanitization requires rekeying', () => {
    const requestBody = proxyBody(`/workspaces/${RAW_WORKSPACE_ID}`, 'patch', {
      workspaceId: RAW_WORKSPACE_ID
    });
    const raw = {
      version: 2 as const,
      interactions: [{
        ...cassetteRequest(BIFROST_URL, 'POST', requestBody),
        status: 200,
        body: JSON.stringify({ data: { id: RAW_WORKSPACE_ID } }),
        responseHeaders: {}
      }]
    };

    expect(() => sanitizeCassette(raw)).toThrow(
      'Cannot sanitize digest-bearing raw cassette interaction without rawRequestBody for safe rekeying'
    );
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

  it('redacts and rekeys a direct service-account token mint request for replay', async () => {
    const mintUrl = 'https://api.getpostman.com/service-account-tokens';
    const liveApiKey = 'PMAK-live-request-api-key';
    const rawRequestBody = JSON.stringify({ apiKey: liveApiKey });
    const sanitizedRequestBody = JSON.stringify({ apiKey: '[REDACTED]' });
    const raw = {
      version: 2 as const,
      interactions: [{
        ...cassetteRequest(mintUrl, 'POST', rawRequestBody),
        rawRequestBody,
        status: 200,
        body: JSON.stringify({ accessToken: 'PMAT-live-minted-access-token' }),
        responseHeaders: {}
      }]
    };

    const sanitized = sanitizeCassette(raw);
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.interactions[0]?.key).toBe(
      cassetteRequest(mintUrl, 'POST', sanitizedRequestBody).key
    );
    expect(JSON.parse(sanitized.interactions[0]?.body ?? '')).toEqual({
      accessToken: CASSETTE_MINTED_TOKEN
    });
    expect(serialized).not.toContain(liveApiKey);
    expect(serialized).not.toContain('rawRequestBody');

    await expect(
      createReplayFetch(sanitized)(mintUrl, {
        method: 'POST',
        body: sanitizedRequestBody
      }).then((response) => response.json())
    ).resolves.toEqual({ accessToken: CASSETTE_MINTED_TOKEN });
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
    const syncModelIds = new Set(
      sanitized.interactions
        .filter((interaction) => interaction.key.startsWith('proxy:sync POST /collection/import'))
        .map((interaction) => {
          const body = JSON.parse(interaction.body) as { model_id?: string };
          return String(body.model_id ?? '');
        })
        .filter(Boolean)
    );
    const rootPatchIds = new Set(
      sanitized.interactions.flatMap((interaction) => {
        const match = /^proxy:collection PATCH \/v3\/collections\/([^ /?#]+)/.exec(interaction.key);
        return match?.[1] ? [match[1]] : [];
      })
    );
    expect(JSON.stringify(raw)).toContain('rawRequestBody');
    expect(JSON.stringify(sanitized)).not.toContain('rawRequestBody');
    expect(JSON.stringify(sanitized)).not.toContain(RAW_WORKSPACE_ID);
    expect(JSON.stringify(sanitized)).not.toContain(LIVE_PMAK);
    expect(syncModelIds.size).toBe(3);
    expect(rootPatchIds).toEqual(syncModelIds);
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

});
