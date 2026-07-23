/**
 * R5 receipt contract for the multi-file Spec Hub capability probe.
 * Rejects missing matrix rows, secret leakage, and unbound commits.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Probe script is plain ESM (.mjs). Keep the contract test adjacent without
// expanding tsconfig to cover scripts/.
// @ts-expect-error -- no declaration for scripts/*.mjs; typed locally below
import * as probeModule from '../scripts/probe-multifile-spec-sync.mjs';

const CAPABILITY_KEYS = probeModule.CAPABILITY_KEYS as string[];
const REQUIRED_LEG_MODES = probeModule.REQUIRED_LEG_MODES as string[];
const REQUIRED_PROBE_IDS = probeModule.REQUIRED_PROBE_IDS as string[];
const validateMultifileSpecSyncReceipt = probeModule.validateMultifileSpecSyncReceipt as (
  receipt: unknown
) => unknown;
const assertMultifileSpecSyncReceiptSourceBinding =
  probeModule.assertMultifileSpecSyncReceiptSourceBinding as (
    receipt: unknown,
    options: {
      headCommit: string;
      repoRoot?: string;
      isAncestor?: (receiptCommit: string, headCommit: string) => boolean;
      changedPaths?: string[];
    }
  ) => unknown;
const isReleaseOnlyDriftPath = probeModule.isReleaseOnlyDriftPath as (relPath: string) => boolean;
const assertReleaseOnlySourceDrift = probeModule.assertReleaseOnlySourceDrift as (
  changedPaths: string[]
) => boolean;
const isTerminalGenerationSuccess = probeModule.isTerminalGenerationSuccess as (
  taskStatus: unknown
) => boolean;
const finalizeGenerationTaskStatus = probeModule.finalizeGenerationTaskStatus as (
  taskStatus: unknown,
  options?: { pollsExhausted?: boolean }
) => string;
const generationOutcomePassed = probeModule.generationOutcomePassed as (gen: {
  status?: number;
  taskStatus?: string;
  collectionId?: string;
}) => boolean;
const shapeOf = probeModule.shapeOf as (value: unknown) => unknown;
const pickCollectionIdForGeneration = probeModule.pickCollectionIdForGeneration as (
  entries: unknown,
  expectedName?: string
) => string;
const cleanupJournaledResources = probeModule.cleanupJournaledResources as (
  journal: { workspaceId?: string; collectionIds?: string[]; specIds?: string[] },
  ops: {
    deleteCollection: (id: string) => Promise<{ status?: number }>;
    deleteSpecification: (id: string) => Promise<{ status?: number }>;
    deleteWorkspace: (id: string) => Promise<{ status?: number }>;
    readWorkspace: (id: string) => Promise<{ status?: number }>;
  }
) => Promise<{ residue: boolean; deletedKinds: string[] }>;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const receiptPath = path.join(repoRoot, 'validation/evidence/multifile-spec-sync.json');

type SnapshotMember = {
  path: string;
  role: 'ROOT' | 'DEFAULT';
  byteLength: number;
  hash: string;
};

type ProbeResult = {
  id: string;
  passed: boolean;
  httpStatuses: number[];
  requestShape: string;
  responseShape: string | Record<string, unknown>;
  observed: Record<string, unknown>;
};

type ReceiptLeg = {
  mode: string;
  teamId: string;
  results: ProbeResult[];
};

type Receipt = {
  schemaVersion: number;
  testedAt: string;
  bootstrapCommit: string;
  legs: ReceiptLeg[];
  capabilities: Record<string, boolean>;
};

function currentBootstrapCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function falseCapabilities(): Record<string, boolean> {
  return Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false]));
}

function sampleSnapshot(): SnapshotMember[] {
  const content = 'type: string\n';
  return [
    {
      path: 'openapi.yaml',
      role: 'ROOT',
      byteLength: content.length,
      hash: createHash('sha256').update(content).digest('hex')
    },
    {
      path: 'components/pet.yaml',
      role: 'DEFAULT',
      byteLength: 12,
      hash: createHash('sha256').update('dependency').digest('hex')
    }
  ];
}

function baseObserved(id: string): Record<string, unknown> {
  if (id === 'P05') {
    return {
      pathPresent: true,
      exactBytes: true,
      identifier: 'uuid',
      fixedContractAccepted: true,
      fixedRequestShape: "{name:'error.yaml',content,type:'DEFAULT',parentId:<components-folder-uuid>}",
      parentIdResolved: true
    };
  }
  if (id === 'P06') {
    return { absentAfterDelete: true };
  }
  if (id === 'P10') {
    const snapshot = sampleSnapshot();
    return {
      bulkStatus: 400,
      bulkLanded: false,
      fullSetUnchanged: true,
      perFileValidLanded: true,
      perFileInvalidStatus: 404,
      atomicBulkProven: false,
      memberCount: snapshot.length,
      beforeSnapshot: snapshot,
      afterSnapshot: snapshot,
      partialApplicationOrder: ['per-file-valid-patch-applied', 'per-file-invalid-patch-rejected']
    };
  }
  return {};
}

function completeResults(overrides: Partial<Record<string, Partial<ProbeResult>>> = {}): ProbeResult[] {
  return REQUIRED_PROBE_IDS.map((id) => {
    const override = overrides[id] || {};
    return {
      id,
      passed: override.passed ?? true,
      httpStatuses: override.httpStatuses ?? [200],
      requestShape: override.requestShape ?? 'POST /specifications',
      responseShape: override.responseShape ?? 'data',
      observed: override.observed ?? baseObserved(id)
    };
  });
}

function completeReceipt(options: {
  capabilities?: Record<string, boolean>;
  resultOverrides?: Partial<Record<string, Partial<ProbeResult>>>;
  commit?: string;
}): Receipt {
  return {
    schemaVersion: 1,
    testedAt: '2026-01-01T00:00:00.000Z',
    bootstrapCommit: options.commit ?? 'a'.repeat(40),
    legs: REQUIRED_LEG_MODES.map((mode) => ({
      mode,
      teamId: mode === 'nonorg' ? '10490519' : '13347347',
      results: completeResults(options.resultOverrides)
    })),
    capabilities: options.capabilities ?? falseCapabilities()
  };
}

describe('multifile-spec-sync probe generation/cleanup helpers', () => {
  it('omits request identifiers from persisted response shapes', () => {
    const shaped = shapeOf({
      requestId: 'request-sensitive-123',
      data: { id: 'safe-model-id', requestId: 'nested-sensitive-456' }
    });

    expect(JSON.stringify(shaped)).not.toMatch(/request[_-]?id/i);
    expect(shaped).toEqual({ data: { id: 'string(13)' } });
  });

  it('requires terminal successful generation for P03/P04-style pass', () => {
    expect(isTerminalGenerationSuccess('completed')).toBe(true);
    expect(isTerminalGenerationSuccess('success')).toBe(true);
    expect(isTerminalGenerationSuccess('pending')).toBe(false);
    expect(isTerminalGenerationSuccess('queued')).toBe(false);
    expect(isTerminalGenerationSuccess('in-progress')).toBe(false);
    expect(isTerminalGenerationSuccess('unknown')).toBe(false);
    expect(isTerminalGenerationSuccess('exhausted')).toBe(false);
    expect(isTerminalGenerationSuccess('failed')).toBe(false);

    expect(
      generationOutcomePassed({
        status: 202,
        taskStatus: 'completed',
        collectionId: 'col-1'
      })
    ).toBe(true);

    for (const taskStatus of ['pending', 'queued', 'in-progress', 'unknown', 'exhausted', 'failed']) {
      expect(
        generationOutcomePassed({
          status: 202,
          taskStatus,
          collectionId: 'col-1'
        }),
        `must reject non-terminal/non-success status ${taskStatus}`
      ).toBe(false);
    }

    expect(
      generationOutcomePassed({
        status: 202,
        taskStatus: 'completed',
        collectionId: ''
      })
    ).toBe(false);
  });

  it('marks exhausted pending/unknown after poll budget and fails generation outcome', () => {
    expect(finalizeGenerationTaskStatus('pending', { pollsExhausted: true })).toBe('exhausted');
    expect(finalizeGenerationTaskStatus('queued', { pollsExhausted: true })).toBe('exhausted');
    expect(finalizeGenerationTaskStatus('in-progress', { pollsExhausted: true })).toBe('exhausted');
    expect(finalizeGenerationTaskStatus('unknown', { pollsExhausted: true })).toBe('unknown');
    expect(finalizeGenerationTaskStatus('completed', { pollsExhausted: true })).toBe('completed');

    expect(
      generationOutcomePassed({
        status: 202,
        taskStatus: finalizeGenerationTaskStatus('pending', { pollsExhausted: true }),
        collectionId: 'stale-col'
      })
    ).toBe(false);
    expect(
      generationOutcomePassed({
        status: 202,
        taskStatus: finalizeGenerationTaskStatus('unknown', { pollsExhausted: true }),
        collectionId: 'stale-col'
      })
    ).toBe(false);
  });

  it('picks the named generated collection when the list contract exposes names', () => {
    expect(
      pickCollectionIdForGeneration(
        [
          { collection: 'old', name: 'mfsync-col-v1' },
          { collection: 'new', name: 'mfsync-col-v2' }
        ],
        'mfsync-col-v2'
      )
    ).toBe('new');
    expect(pickCollectionIdForGeneration([{ id: 'only' }], 'unused-name')).toBe('only');
  });

  it('cleanup attempts every journaled collection/spec/workspace when an earlier delete throws', async () => {
    const attempted: string[] = [];
    const teardown = await cleanupJournaledResources(
      {
        workspaceId: 'ws-1',
        collectionIds: ['c1', 'c2'],
        specIds: ['s1', 's2']
      },
      {
        deleteCollection: async (id) => {
          attempted.push(`collection:${id}`);
          if (id === 'c1') throw new Error('boom-collection');
          return { status: 200 };
        },
        deleteSpecification: async (id) => {
          attempted.push(`specification:${id}`);
          if (id === 's1') throw new Error('boom-spec');
          return { status: 200 };
        },
        deleteWorkspace: async (id) => {
          attempted.push(`workspace:${id}`);
          throw new Error('boom-workspace');
        },
        readWorkspace: async (id) => {
          attempted.push(`workspace-readback:${id}`);
          return { status: 404 };
        }
      }
    );

    expect(attempted).toEqual([
      'collection:c1',
      'collection:c2',
      'specification:s1',
      'specification:s2',
      'workspace:ws-1',
      'workspace-readback:ws-1'
    ]);
    expect(teardown.residue).toBe(false);
    expect(teardown.deletedKinds).toEqual([
      'collection:0',
      'collection:200',
      'specification:0',
      'specification:200',
      'workspace:0',
      'workspace-readback:404'
    ]);
  });

  it('records residue when workspace readback still succeeds after cleanup attempts', async () => {
    const teardown = await cleanupJournaledResources(
      { workspaceId: 'ws-live', collectionIds: ['c1'], specIds: ['s1'] },
      {
        deleteCollection: async () => ({ status: 200 }),
        deleteSpecification: async () => ({ status: 200 }),
        deleteWorkspace: async () => ({ status: 500 }),
        readWorkspace: async () => ({ status: 200 })
      }
    );
    expect(teardown.residue).toBe(true);
  });
});

describe('multifile-spec-sync receipt contract', () => {
  it('rejects missing matrix rows or secrets', () => {
    expect(() =>
      validateMultifileSpecSyncReceipt({
        schemaVersion: 1,
        testedAt: '2026-01-01T00:00:00.000Z',
        bootstrapCommit: 'a'.repeat(40),
        legs: [],
        capabilities: falseCapabilities()
      })
    ).toThrow(/missing leg|legs/i);

    expect(() =>
      validateMultifileSpecSyncReceipt({
        schemaVersion: 1,
        testedAt: '2026-01-01T00:00:00.000Z',
        bootstrapCommit: 'a'.repeat(40),
        legs: REQUIRED_LEG_MODES.map((mode) => ({
          mode,
          teamId: mode === 'nonorg' ? '10490519' : '13347347',
          results: REQUIRED_PROBE_IDS.slice(0, 5).map((id) => ({
            id,
            passed: true,
            httpStatuses: [200],
            requestShape: 'POST /specifications',
            responseShape: 'data',
            observed: baseObserved(id)
          }))
        })),
        capabilities: falseCapabilities()
      })
    ).toThrow(/missing probe|P0/i);

    expect(() =>
      validateMultifileSpecSyncReceipt(
        completeReceipt({
          resultOverrides: {
            P01: {
              observed: { token: 'PMAK-secret-value-should-not-appear' }
            }
          }
        })
      )
    ).toThrow(/secret|token|redact/i);

    expect(() =>
      validateMultifileSpecSyncReceipt(
        completeReceipt({
          resultOverrides: {
            P02: {
              observed: { path: '/Users/someone/secret.yaml' }
            }
          }
        })
      )
    ).toThrow(/secret|redact|Users/i);
  });

  it('rejects P05 pass when fixedContractAccepted is false', () => {
    expect(() =>
      validateMultifileSpecSyncReceipt(
        completeReceipt({
          resultOverrides: {
            P05: {
              passed: true,
              observed: {
                pathPresent: true,
                exactBytes: true,
                identifier: 'uuid',
                fixedContractAccepted: false,
                fixedRequestShape:
                  "{name:'error.yaml',content,type:'DEFAULT',parentId:<components-folder-uuid>}",
                parentIdResolved: true
              }
            }
          }
        })
      )
    ).toThrow(/P05 cannot pass when fixedContractAccepted is false/);
  });

  it('rejects atomicBulk without equal full-set path-role-hash snapshots', () => {
    const before = sampleSnapshot();
    const after = [
      before[0],
      {
        ...before[1],
        hash: createHash('sha256').update('mutated').digest('hex'),
        byteLength: 7
      }
    ];
    const caps = falseCapabilities();
    caps.atomicBulk = true;

    expect(() =>
      validateMultifileSpecSyncReceipt(
        completeReceipt({
          capabilities: caps,
          resultOverrides: {
            P10: {
              passed: true,
              observed: {
                ...baseObserved('P10'),
                atomicBulkProven: true,
                fullSetUnchanged: false,
                beforeSnapshot: before,
                afterSnapshot: after
              }
            }
          }
        })
      )
    ).toThrow(/equal before\/after path-role-hash snapshots/i);

    expect(() =>
      validateMultifileSpecSyncReceipt(
        completeReceipt({
          capabilities: caps,
          resultOverrides: {
            P10: {
              passed: true,
              observed: {
                ...baseObserved('P10'),
                atomicBulkProven: false,
                beforeSnapshot: before,
                afterSnapshot: before
              }
            }
          }
        })
      )
    ).toThrow(/atomicBulk=true requires P10 atomicBulkProven/);

    const accepted = validateMultifileSpecSyncReceipt(
      completeReceipt({
        capabilities: caps,
        resultOverrides: {
          P10: {
            passed: true,
            observed: {
              ...baseObserved('P10'),
              atomicBulkProven: true,
              fullSetUnchanged: true,
              beforeSnapshot: before,
              afterSnapshot: before
            }
          }
        }
      })
    ) as Receipt;
    expect(accepted.capabilities.atomicBulk).toBe(true);
  });

  it('classifies release-only drift paths and rejects behavior-bearing source drift', () => {
    expect(isReleaseOnlyDriftPath('package.json')).toBe(true);
    expect(isReleaseOnlyDriftPath('package-lock.json')).toBe(true);
    expect(isReleaseOnlyDriftPath('CHANGELOG.md')).toBe(true);
    expect(isReleaseOnlyDriftPath('validation/evidence/multifile-spec-sync.json')).toBe(true);
    expect(isReleaseOnlyDriftPath('dist/index.cjs')).toBe(true);
    expect(isReleaseOnlyDriftPath('docs/LIVE_TESTING_RUNBOOK.md')).toBe(true);
    expect(isReleaseOnlyDriftPath('src/index.ts')).toBe(false);
    expect(isReleaseOnlyDriftPath('action.yml')).toBe(false);
    expect(isReleaseOnlyDriftPath('scripts/probe-multifile-spec-sync.mjs')).toBe(false);
    expect(isReleaseOnlyDriftPath('tests/multifile-spec-sync-receipt.test.ts')).toBe(false);
    expect(() =>
      assertReleaseOnlySourceDrift([
        'package.json',
        'dist/cli.cjs',
        'validation/evidence/multifile-spec-sync.json'
      ])
    ).not.toThrow();
    expect(() => assertReleaseOnlySourceDrift(['src/lib/postman/spec-file-reconcile.ts'])).toThrow(
      /behavior-bearing|stale/i
    );
  });

  it('allows ancestor receipt commit only for release-only path drift', () => {
    const receipt = completeReceipt({
      commit: 'b'.repeat(40),
      capabilities: {
        ...falseCapabilities(),
        multiFileCreate: true,
        multiFileRead: true,
        openapiGeneration: true
      }
    });
    const head = 'c'.repeat(40);
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: head,
        isAncestor: () => true,
        changedPaths: [
          'package.json',
          'package-lock.json',
          'dist/index.cjs',
          'validation/evidence/multifile-spec-sync.json',
          'README.md'
        ]
      })
    ).not.toThrow();
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: head,
        isAncestor: () => true,
        changedPaths: ['src/index.ts']
      })
    ).toThrow(/behavior-bearing|stale/i);
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: head,
        isAncestor: () => true,
        changedPaths: ['action.yml']
      })
    ).toThrow(/behavior-bearing|stale/i);
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: head,
        isAncestor: () => true,
        changedPaths: ['scripts/probe-multifile-spec-sync.mjs']
      })
    ).toThrow(/behavior-bearing|stale/i);
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: head,
        isAncestor: () => true,
        changedPaths: ['tests/spec-file-reconcile.test.ts']
      })
    ).toThrow(/behavior-bearing|stale/i);
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: head,
        isAncestor: () => false,
        changedPaths: []
      })
    ).toThrow(/not an ancestor/i);
    expect(() =>
      assertMultifileSpecSyncReceiptSourceBinding(receipt, {
        headCommit: 'b'.repeat(40)
      })
    ).not.toThrow();
  });

  it('requires live evidence receipt bound to committed feature source with P01-P10 pass', { timeout: 30_000 }, () => {
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt;
    const commit = currentBootstrapCommit();
    const validated = assertMultifileSpecSyncReceiptSourceBinding(receipt, {
      headCommit: commit,
      repoRoot
    }) as Receipt;
    expect(validated.bootstrapCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(validated.legs).toHaveLength(2);
    for (const leg of validated.legs) {
      for (const id of REQUIRED_PROBE_IDS) {
        if (id === 'P11') continue;
        const row = leg.results.find((result) => result.id === id);
        expect(row, `${leg.mode} missing ${id}`).toBeTruthy();
        expect(row?.passed, `${leg.mode} ${id} must pass`).toBe(true);
      }
      const p05 = leg.results.find((result) => result.id === 'P05');
      expect(p05?.observed?.fixedContractAccepted, `${leg.mode} P05 fixedContractAccepted`).toBe(
        true
      );
      expect(p05?.observed?.exactBytes, `${leg.mode} P05 exactBytes`).toBe(true);
      const p06 = leg.results.find((result) => result.id === 'P06');
      expect(p06?.observed?.absentAfterDelete, `${leg.mode} P06 absentAfterDelete`).toBe(true);
      const p10 = leg.results.find((result) => result.id === 'P10');
      expect(Array.isArray(p10?.observed?.beforeSnapshot)).toBe(true);
      expect(Array.isArray(p10?.observed?.afterSnapshot)).toBe(true);
      expect(p10?.observed?.beforeSnapshot).toEqual(p10?.observed?.afterSnapshot);
    }
    expect(validated.capabilities.multiFileCreate).toBe(true);
    expect(validated.capabilities.multiFileRead).toBe(true);
    expect(validated.capabilities.openapiGeneration).toBe(true);
    if (validated.capabilities.atomicBulk === true) {
      for (const leg of validated.legs) {
        const p10 = leg.results.find((result) => result.id === 'P10');
        expect(p10?.observed?.atomicBulkProven).toBe(true);
        expect(p10?.observed?.beforeSnapshot).toEqual(p10?.observed?.afterSnapshot);
      }
    }
  });
});
