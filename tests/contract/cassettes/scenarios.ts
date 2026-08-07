/**
 * The WS3 scenario set, declared once and consumed twice: the recorder
 * (`record-fake-cassettes.test.ts`) drives each entry against the platform fake
 * and writes `<name>.json`; the replay suite (`../cassette-scenarios.test.ts`)
 * runs the SAME production flow offline from that committed file with zero live
 * transport.
 *
 * A scenario asserts on two surfaces:
 *  - `expectOutputs` — the action's final outputs/state, i.e. what a caller sees.
 *  - `expectWire` — the recorded interaction keys, i.e. the wire contract the
 *    run is entitled to depend on. Keys are service/method/path triples (plus
 *    canonical query and request-body digest), so this is the assertion a live
 *    re-recording has to keep satisfying.
 *
 * Cassettes here are generated from the deterministic fake, not from a sandbox.
 * The file format and the replay path are identical either way, so a live
 * `record-live` capture can replace a file without touching a test.
 */
import { createHash } from 'node:crypto';

import { expect } from 'vitest';

import type { PlatformFakeOptions } from '../platform-fake.js';
import type { ContractRunResult } from '../harness.js';

export interface CassetteScenario {
  /** Cassette basename under this directory, and the test title. */
  name: string;
  /** Why this scenario exists — the distinct production path it pins. */
  description: string;
  /** Authoritative raw inputs used when recording the cassette. */
  inputs: Readonly<Record<string, string>>;
  /** Sanitized inputs used only when replaying the committed cassette. */
  replayInputs?: Readonly<Record<string, string>>;
  /** Workspace files; omit to use the harness default `openapi.json`. */
  files?: Record<string, string>;
  /** Provider CI env restored after the harness neutralization sweep. */
  env?: Record<string, string>;
  /** Recorder-only: how the platform fake must be configured. */
  fake?: PlatformFakeOptions;
  /** Secret literals that must never survive into the committed cassette. */
  secrets: string[];
  expectOutputs: (result: ContractRunResult) => void;
  expectWire: (keys: readonly string[]) => void;
}

/** Count recorded interaction keys whose prefix matches. */
export function countKeys(keys: readonly string[], prefix: string): number {
  return keys.filter((key) => key.startsWith(prefix)).length;
}

const ACCESS_TOKEN = 'access-token-test';
const PMAK = 'pmak-test';

const WORKSPACE_ID = 'cassette-workspace-1';
const SPECIFICATION_ID = 'cassette-specification-1';
const REFRESH_BASELINE_ID = 'cassette-collection-4';
const REFRESH_SMOKE_ID = 'cassette-collection-5';
const REFRESH_CONTRACT_ID = 'cassette-collection-6';

/**
 * Synthetic platform identity for every committed cassette. Ids are short and
 * obviously fabricated so no committed fixture can be mistaken for live team,
 * user, or asset identity — but they stay positive integers, because
 * `workspace-team-id` is validated as `/^\d+$/` and a negative sub-team id is
 * correctly rejected before the run starts.
 */
const CASSETTE_TEAM_ID = 1001;
const CASSETTE_SQUAD_ID = 1002;

function cassetteFake(options: PlatformFakeOptions): PlatformFakeOptions {
  const org = options.org ?? false;
  return {
    teamId: CASSETTE_TEAM_ID,
    userId: 2001,
    sessionUserId: 2002,
    workspaceId: WORKSPACE_ID,
    specificationId: SPECIFICATION_ID,
    specificationFileId: 'cassette-specification-2',
    collectionId: (_role, sequence) => `cassette-collection-${sequence}`,
    createdCollectionId: 'cassette-collection-1',
    squads: org
      ? [
          {
            id: CASSETTE_SQUAD_ID,
            name: 'Cassette Squad',
            handle: 'cassette-squad',
            organizationId: CASSETTE_TEAM_ID
          }
        ]
      : [],
    ...options
  };
}

function refreshDeepUpdateExistingCollections() {
  const project = 'contract-payments';
  return [
    { id: REFRESH_BASELINE_ID, name: project },
    { id: REFRESH_SMOKE_ID, name: `[Smoke] ${project}` },
    { id: REFRESH_CONTRACT_ID, name: `[Contract] ${project}` }
  ] as const;
}

/**
 * Env every scenario records and replays under.
 *
 * The Postman app-version probe is disabled deliberately. Its provider is a
 * module-level singleton that memoizes the first resolution for the life of the
 * process, so whether the probe appears in a given cassette depends on which
 * scenario ran first in the file — an order dependency that would make these
 * fixtures fragile for no coverage gain. `POSTMAN_GATEWAY_APP_VERSION=off` is the
 * provider's own documented opt-out, not a test seam.
 */
export const CASSETTE_SCENARIO_ENV: Record<string, string> = {
  GITHUB_RUN_ID: 'cassette-run',
  POSTMAN_GATEWAY_APP_VERSION: 'off'
};

/** Every scenario runs on the access token; PMAK-only mint is pinned separately. */
const TOKEN_INPUTS = { 'postman-access-token': ACCESS_TOKEN } as const;

const IMPORT_KEY = 'proxy:sync POST /collection/import';
const DEEP_UPDATE_KEY = 'proxy:sync PUT /collection/deepupdate/';
const WORKSPACE_CREATE_KEY = 'proxy:workspaces POST /workspaces';
const SQUADS_KEY = 'proxy:ums GET /api/teams/';
const SPEC_CREATE_KEY = 'proxy:specification POST /specifications';
const SPEC_TREE_KEY = 'proxy:specification GET /specifications/';
const SPEC_LINK_KEY = 'proxy:specification PUT /specifications/';
/** Direct (non-proxied) PMAK mint. Its response body is replaced by a placeholder. */
const MINT_KEY = 'POST https://api.getpostman.com/service-account-tokens';

function ledgerOf(result: ContractRunResult): {
  mode?: string;
  phase?: string;
  counts?: Record<string, number>;
} {
  return JSON.parse(result.outputs['openapi-operation-ledger-json'] || '{}');
}

function expectThreeCollections(result: ContractRunResult): void {
  for (const role of ['baseline', 'smoke', 'contract'] as const) {
    if (!result.outputs[`${role}-collection-id`]) {
      throw new Error(`expected a ${role}-collection-id output, got ""`);
    }
  }
}

/** A visibility flip on a personal workspace, i.e. the non-org promotion. */
const VISIBILITY_FLIP_KEY = 'proxy:workspaces PUT /workspaces/';

function largeSpec(operationCount: number): string {
  return JSON.stringify(
    {
      openapi: '3.1.0',
      info: { title: 'Large Contract API', version: '1.0.0' },
      paths: Object.fromEntries(
        Array.from({ length: operationCount }, (_, index) => [
          `/resources/${index}`,
          {
            get: {
              operationId: `getResource${index}`,
              summary: `GET /resources/${index}`,
              responses: {
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { type: 'object' } } }
                }
              }
            }
          }
        ])
      )
    },
    null,
    2
  );
}

const LARGE_SPEC_OPERATIONS = 120;

const MULTIFILE_ROOT = 'apis/payments/openapi.yaml';
const MULTIFILE_FILES: Record<string, string> = {
  'apis/payments/components/Payment.yaml': `type: object
required: [id]
properties:
  id:
    type: string
`,
  [MULTIFILE_ROOT]: `openapi: 3.1.0
info:
  title: Payments
  version: 1.0.0
paths:
  /payments:
    get:
      summary: GET /payments
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: './components/Payment.yaml'
`
};

/**
 * The discovery inventory is content-free but byte-exact: the acquirer re-reads
 * every member from disk and rejects a byte-count or digest mismatch, so these
 * are computed from the same strings the harness writes.
 */
function multifileInventory(): string {
  // Paths are workspace-relative (discovery shape). Acquisition re-keys them
  // under the bundle base (dirname(spec-path)) so the Spec Hub create carries
  // exactly one ROOT plus its local $ref dependency — never a second root.
  return JSON.stringify({
    schemaVersion: 1,
    root: MULTIFILE_ROOT,
    format: 'openapi-yaml',
    completeness: 'full',
    provenance: { kind: 'provider', provider: 'aws' },
    files: Object.entries(MULTIFILE_FILES)
      .map(([path, content]) => ({
        path,
        role: path === MULTIFILE_ROOT ? 'root' : 'dependency',
        bytes: Buffer.byteLength(content, 'utf8'),
        sha256: createHash('sha256').update(content, 'utf8').digest('hex')
      }))
      // ASCII ascending — same comparator parseDefinitionInventoryJson enforces.
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  });
}

const PROTO_FILE = `syntax = "proto3";
package payments.v1;

message GetPaymentRequest {
  string id = 1;
}

message Payment {
  string id = 1;
  string status = 2;
}

service Payments {
  rpc GetPayment(GetPaymentRequest) returns (Payment);
}
`;

export const CASSETTE_SCENARIOS: readonly CassetteScenario[] = [
  {
    name: 'fresh-onboard',
    description:
      'A true first run: a PMAK mints the access token, no prior asset ids exist, and every role imports as a whole collection with nothing deep-updated.',
    // PMAK-only is the shape a customer actually hits on run one, and it is the
    // only scenario here that exercises the mint + /me preflight wire surface.
    inputs: {
      'postman-api-key': PMAK,
      'postman-access-token': '',
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update'
    },
    replayInputs: {
      'postman-api-key': '[REDACTED]',
      'postman-access-token': '',
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update'
    },
    fake: cassetteFake({ org: false }),
    secrets: [PMAK, ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['workspace-id']).toBe(WORKSPACE_ID);
      expect(result.outputs['spec-id']).toBe(SPECIFICATION_ID);
      expectThreeCollections(result);
      expect(ledgerOf(result).counts).toMatchObject({
        wholeCollectionImport: 3,
        deepUpdate: 0,
        specHubCollectionGeneration: 0,
        temporaryOpenApiSpecCreate: 0,
        postCreateScriptPatch: 0
      });
    },
    expectWire: (keys) => {
      expect(countKeys(keys, MINT_KEY)).toBe(1);
      expect(countKeys(keys, IMPORT_KEY)).toBe(3);
      expect(countKeys(keys, DEEP_UPDATE_KEY)).toBe(0);
      expect(countKeys(keys, WORKSPACE_CREATE_KEY)).toBe(1);
      expect(countKeys(keys, SPEC_CREATE_KEY)).toBeGreaterThanOrEqual(1);
    }
  },
  {
    name: 'refresh-deep-update',
    description:
      'All three role ids supplied under collection-sync-mode refresh: every role deep-updates in place, zero imports.',
    inputs: {
      ...TOKEN_INPUTS,
      'workspace-id': WORKSPACE_ID,
      'baseline-collection-id': REFRESH_BASELINE_ID,
      'smoke-collection-id': REFRESH_SMOKE_ID,
      'contract-collection-id': REFRESH_CONTRACT_ID,
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update'
    },
    fake: cassetteFake({
      org: false,
      existingCollections: [...refreshDeepUpdateExistingCollections()]
    }),
    secrets: [ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['baseline-collection-id']).toBe(REFRESH_BASELINE_ID);
      expect(result.outputs['smoke-collection-id']).toBe(REFRESH_SMOKE_ID);
      expect(result.outputs['contract-collection-id']).toBe(REFRESH_CONTRACT_ID);
      expect(ledgerOf(result).counts).toMatchObject({ wholeCollectionImport: 0, deepUpdate: 3 });
    },
    expectWire: (keys) => {
      expect(countKeys(keys, DEEP_UPDATE_KEY)).toBe(3);
      expect(countKeys(keys, IMPORT_KEY)).toBe(0);
      // A supplied workspace id must not create a second workspace.
      expect(countKeys(keys, WORKSPACE_CREATE_KEY)).toBe(0);
    }
  },
  {
    name: 'org-mode',
    description:
      'Org account with an explicit sub-team: the workspace is created team-visible against the squad, so no personal->team flip is ever attempted.',
    inputs: {
      ...TOKEN_INPUTS,
      'workspace-team-id': String(CASSETTE_SQUAD_ID),
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update'
    },
    fake: cassetteFake({ org: true }),
    secrets: [ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['workspace-id']).toBe(WORKSPACE_ID);
      expectThreeCollections(result);
    },
    expectWire: (keys) => {
      expect(countKeys(keys, SQUADS_KEY)).toBeGreaterThanOrEqual(1);
      expect(countKeys(keys, WORKSPACE_CREATE_KEY)).toBe(1);
      // The org create body carries squad + team visibility, so the flip that
      // 403s for org service accounts must never be issued.
      expect(countKeys(keys, VISIBILITY_FLIP_KEY)).toBe(0);
    }
  },
  {
    name: 'non-org-visibility-flip',
    description:
      'Non-org account: the workspace is created personal, then promoted to team through the visibility flip.',
    inputs: { ...TOKEN_INPUTS, 'collection-sync-mode': 'refresh', 'spec-sync-mode': 'update' },
    fake: cassetteFake({ org: false }),
    secrets: [ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['workspace-id']).toBe(WORKSPACE_ID);
      expectThreeCollections(result);
    },
    expectWire: (keys) => {
      expect(countKeys(keys, WORKSPACE_CREATE_KEY)).toBe(1);
      expect(countKeys(keys, VISIBILITY_FLIP_KEY)).toBe(1);
      expect(countKeys(keys, SQUADS_KEY)).toBeGreaterThanOrEqual(1);
      // Supplied access token: nothing is minted, unlike the fresh-onboard run.
      expect(countKeys(keys, MINT_KEY)).toBe(0);
    }
  },
  {
    name: 'branch-preview',
    description:
      'Same-repo PR under branch-strategy preview: the run writes a suffixed preview asset set and emits a preview branch decision.',
    inputs: {
      ...TOKEN_INPUTS,
      'workspace-id': WORKSPACE_ID,
      'branch-strategy': 'preview',
      'canonical-branch': 'main',
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update'
    },
    env: {
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'cassette-org/cassette-repo',
      GITHUB_SERVER_URL: 'https://example.invalid',
      GITHUB_REF: 'refs/pull/42/merge',
      GITHUB_REF_NAME: '42/merge',
      GITHUB_HEAD_REF: 'feature/payments',
      GITHUB_SHA: '1111111111111111111111111111111111111111'
    },
    fake: cassetteFake({ org: false }),
    secrets: [ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['sync-status']).toBe('synced');
      const decision = JSON.parse(result.outputs['branch-decision'] || '{}') as {
        tier?: string;
        canonicalBranch?: string;
        identity?: { headBranch?: string; isForkPr?: boolean };
      };
      expect(decision.tier).toBe('preview');
      expect(decision.canonicalBranch).toBe('main');
      expect(decision.identity?.headBranch).toBe('feature/payments');
      expect(decision.identity?.isForkPr).toBe(false);
      expectThreeCollections(result);
    },
    expectWire: (keys) => {
      // A preview run still provisions its own asset set: three imports, and no
      // deep-update against canonical collections it was never handed.
      expect(countKeys(keys, IMPORT_KEY)).toBe(3);
      expect(countKeys(keys, DEEP_UPDATE_KEY)).toBe(0);
    }
  },
  {
    name: 'multifile-openapi',
    description:
      'Multi-file OpenAPI declared through a content-free spec-files-json inventory: the root plus its local $ref closure upload as a file tree.',
    inputs: {
      ...TOKEN_INPUTS,
      'spec-path': MULTIFILE_ROOT,
      'spec-files-json': multifileInventory(),
      'collection-sync-mode': 'refresh',
      'spec-sync-mode': 'update'
    },
    files: MULTIFILE_FILES,
    fake: cassetteFake({ org: false }),
    secrets: [ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['spec-id']).toBe(SPECIFICATION_ID);
      expectThreeCollections(result);
      expect(ledgerOf(result).counts).toMatchObject({ specHubCollectionGeneration: 0 });
    },
    expectWire: (keys) => {
      expect(countKeys(keys, SPEC_CREATE_KEY)).toBeGreaterThanOrEqual(1);
      // Multi-file create verifies through the Spec Hub tree fast path (ROOT + DEFAULT).
      expect(keys.some((key) => key.startsWith(SPEC_TREE_KEY) && key.includes('/tree'))).toBe(true);
      expect(countKeys(keys, IMPORT_KEY)).toBe(3);
      expect(countKeys(keys, SPEC_LINK_KEY)).toBeGreaterThanOrEqual(1);
    }
  },
  {
    name: 'protobuf-grpc',
    description:
      'A .proto definition under protocol grpc: the contract collection is built locally and created through the collection service, never through Spec Hub.',
    inputs: {
      ...TOKEN_INPUTS,
      'spec-path': 'service.proto',
      protocol: 'grpc',
      'protocol-endpoint-url': 'grpcs://grpc.example.test:443'
    },
    files: { 'service.proto': PROTO_FILE },
    fake: cassetteFake({ org: false }),
    secrets: [ACCESS_TOKEN],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['workspace-id']).toBe(WORKSPACE_ID);
      expect(result.outputs['contract-collection-id']).not.toBe('');
      // The non-OpenAPI path deliberately does not touch Spec Hub.
      expect(result.outputs['spec-id']).toBe('');
    },
    expectWire: (keys) => {
      expect(countKeys(keys, SPEC_CREATE_KEY)).toBe(0);
      expect(countKeys(keys, IMPORT_KEY)).toBe(0);
      expect(countKeys(keys, DEEP_UPDATE_KEY)).toBe(0);
      expect(keys.some((key) => key.startsWith('proxy:collection POST'))).toBe(true);
    }
  },
  {
    name: 'large-spec',
    description: `A ${LARGE_SPEC_OPERATIONS}-operation OpenAPI document takes the same single local conversion and three imports as a one-operation document — no hidden batching or truncation.`,
    inputs: { ...TOKEN_INPUTS, protocol: 'openapi', 'collection-sync-mode': 'refresh' },
    files: { 'openapi.json': largeSpec(LARGE_SPEC_OPERATIONS) },
    fake: cassetteFake({ org: false }),
    secrets: [ACCESS_TOKEN, PMAK],
    expectOutputs: (result) => {
      expect(result.error).toBeUndefined();
      expect(result.outputs['spec-id']).toBe(SPECIFICATION_ID);
      expectThreeCollections(result);
      expect(ledgerOf(result).counts).toMatchObject({
        localConversion: 1,
        wholeCollectionImport: 3,
        deepUpdate: 0
      });
    },
    expectWire: (keys) => {
      expect(countKeys(keys, IMPORT_KEY)).toBe(3);
      expect(countKeys(keys, SPEC_CREATE_KEY)).toBeGreaterThanOrEqual(1);
    }
  }
];
