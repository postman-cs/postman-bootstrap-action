/**
 * Live, end-to-end validation of the multi-protocol contract path against a real
 * Postman sandbox team. For each non-OpenAPI protocol it:
 *   1. builds + instruments a collection from the bundled fixture (the exact
 *      production dispatch path),
 *   2. creates it in a freshly provisioned throwaway workspace:
 *        - v2.1.0 (graphql/soap) via PostmanAssetsClient.createCollection
 *          (public collections API),
 *        - v3/EC (grpc) via PostmanExtensibleCollectionClient through the gateway
 *          (the only path that accepts grpc-request items),
 *   3. reads the collection back and asserts items + test events survived. For
 *      gRPC the readback is the flat EC item list
 *      (`GET /collections/:id/items/`): it asserts (a) the grpc-request leaf
 *      count equals the built operation count, (b) every leaf is a
 *      `grpc-request`, and (c) each leaf carries `extensions.events` with the
 *      mapped test script,
 *   4. tears down every asset it created (collections, then the workspace).
 *
 * It is a manual proof harness, not part of the unit suite. Drive it with a
 * sandbox key (+ access token for the gRPC EC path) in the environment:
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *   POSTMAN_ACCESS_TOKEN="<minted access token>" \
 *     node --experimental-strip-types scripts/live-protocol-validation.ts
 *
 * The non-org key is read from POSTMAN_API_KEY (fallback
 * POSTMAN_E2E_API_KEY_NON_ORG_MODE). Without a key the script exits 0 with a skip
 * notice so it is safe to invoke unconditionally. Without POSTMAN_ACCESS_TOKEN
 * the gRPC EC leg is skipped with a notice (graphql/soap still run).
 *
 * Org-mode leg (S4): when POSTMAN_E2E_API_KEY_ORG_MODE and
 * ORG_MODE_WORKSPACE_TEAM_ID are both set, a second leg runs against the org-mode
 * sandbox, scoping the EC client to that sub-team (x-entity-team-id). Per
 * AGENTS.md the org-mode team is run-scoped teardown ONLY (no full wipe); this
 * harness deletes exactly the workspace + collections it created.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';
import { PostmanExtensibleCollectionClient } from '../src/lib/postman/postman-ec-client.js';
import { buildProtocolCollection, type ProtocolSpecType } from '../src/lib/protocols/dispatch.js';

// Resolve fixtures from PROTOCOL_FIXTURES_DIR when set (the bundled runner sets
// it because import.meta.url is unavailable in the CJS bundle); otherwise fall
// back to the repo layout relative to this source file.
const fixtures =
  process.env.PROTOCOL_FIXTURES_DIR ||
  path.resolve(process.cwd(), 'fixtures');

interface Case {
  type: ProtocolSpecType;
  fixture: string;
  endpointUrl: string;
}

const CASES: Case[] = [
  { type: 'graphql', fixture: 'graphql/telecom.graphql', endpointUrl: '{{baseUrl}}/graphql' },
  { type: 'soap', fixture: 'soap/stockquote.wsdl', endpointUrl: '{{baseUrl}}/soap' },
  { type: 'grpc', fixture: 'grpc/routeguide.proto', endpointUrl: 'grpc://{{host}}:443' }
];

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function leafItemCount(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const record = node as Record<string, unknown>;
  const items = Array.isArray(record.item) ? record.item : null;
  if (!items) return record.request ? 1 : 0;
  return items.reduce((sum: number, child) => sum + leafItemCount(child), 0);
}

function eventCount(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  const record = node as Record<string, unknown>;
  let count = Array.isArray(record.event) ? record.event.length : 0;
  const items = Array.isArray(record.item) ? record.item : [];
  for (const child of items) count += eventCount(child);
  return count;
}

/** True when an EC item record carries at least one extensions.events entry. */
function ecItemHasEvents(item: JsonRecord): boolean {
  const ext = asRecord(item.extensions);
  return Array.isArray(ext?.events) && ext.events.length > 0;
}

interface LegOptions {
  label: string;
  apiKey: string;
  orgMode: boolean;
  workspaceTeamId?: number;
}

/**
 * Run one full protocol-validation leg against a single sandbox key/team.
 * Returns the number of validation failures observed in this leg.
 */
async function runLeg(options: LegOptions): Promise<number> {
  const { label, apiKey, orgMode } = options;
  console.log(`\n========== [leg:${label}] org-mode=${orgMode} ==========`);

  const client = new PostmanAssetsClient({ apiKey });
  const teamId = await client.getAutoDerivedTeamId();
  console.log(`[setup] Resolved team id: ${teamId ?? '(none)'}`);

  // Non-org-mode sandbox keys infer the team from the key and reject an explicit
  // teamId ("Team inside this team is not enabled"); org-mode keys require the
  // numeric sub-team. Pass the sub-team only for the org-mode leg.
  const explicitTeamId = options.workspaceTeamId;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceName = `protocol-live-validation-${label}-${stamp}`;
  const workspace = await client.createWorkspace(
    workspaceName,
    'Disposable workspace for postman-actions multi-protocol live validation',
    explicitTeamId
  );
  console.log(`[setup] Created workspace ${workspace.id} (${workspaceName})`);

  // The gRPC EC path is access-token only. Use POSTMAN_ACCESS_TOKEN if present,
  // otherwise mint one from the PMAK (same POST /service-account-tokens the
  // resolve-service-token action uses) so the gRPC leg runs from a key alone.
  let accessToken = process.env.POSTMAN_ACCESS_TOKEN || '';
  if (!accessToken) {
    try {
      accessToken = await mintAccessToken(apiKey);
      console.log('[setup] Minted access token from PMAK for the gRPC EC leg.');
    } catch (error) {
      console.log(`[setup] Could not mint access token (${error instanceof Error ? error.message : String(error)}); gRPC EC leg will be skipped.`);
    }
  }
  // Scope the EC client to the workspace-owning sub-team on the org-mode leg
  // (mirrors the production index.ts configureTeamContext re-scope after team
  // resolution); the non-org leg lets bifrost infer the team from the token.
  const ecTeamId = orgMode && options.workspaceTeamId != null
    ? String(options.workspaceTeamId)
    : teamId ?? '';
  const ecClient = accessToken
    ? new PostmanExtensibleCollectionClient({
        accessToken,
        teamId: ecTeamId,
        orgMode
      })
    : undefined;

  const createdCollections: string[] = [];
  const createdEcCollections: string[] = [];
  let failures = 0;

  try {
    for (const testCase of CASES) {
      const content = readFileSync(path.join(fixtures, testCase.fixture), 'utf8');
      const built = buildProtocolCollection(testCase.type, content, {
        name: `Live ${testCase.type}`,
        endpointUrl: testCase.endpointUrl,
        schemaLocation: testCase.fixture
      });

      const localItems = leafItemCount(built.collection);
      const localEvents = eventCount(built.collection);
      console.log(
        `\n[${testCase.type}] built ${built.operationCount} op(s), ${localItems} leaf item(s), ` +
          `${localEvents} event(s), format=${built.format}, runnableInCi=${built.runnableInCi}`
      );
      for (const warning of built.warnings) console.log(`  [warn] ${warning}`);

      if (built.format === 'v3-ec') {
        if (!ecClient) {
          console.log('  [skip] No POSTMAN_ACCESS_TOKEN set; skipping gRPC EC create leg.');
          continue;
        }
        try {
          const collectionId = await ecClient.createExtensibleCollection(workspace.id, {
            name: `Live ${testCase.type} Contract`
          });
          createdEcCollections.push(collectionId);
          const leaves = await ecClient.populateFromTree(collectionId, built.collection);
          console.log(`  [ok] Gateway accepted EC collection ${collectionId} with ${leaves} item(s)`);

          // Real readback: the flat EC item list, not a count of what we built.
          const remoteItems = await ecClient.listExtensibleCollectionItems(collectionId);
          const leavesList = remoteItems.filter((item) => item.type !== 'folder');
          const grpcLeaves = leavesList.filter((item) => item.type === 'grpc-request');
          const leavesWithEvents = grpcLeaves.filter(ecItemHasEvents);
          console.log(
            `  [readback] EC item list: ${remoteItems.length} item(s), ${grpcLeaves.length} grpc-request ` +
              `leaf(s), ${leavesWithEvents.length} carrying extensions.events`
          );

          // (a) grpc-request leaf count == built operation count.
          if (grpcLeaves.length !== built.operationCount) {
            failures += 1;
            console.error(
              `  [FAIL] grpc leaf count != built ops: remote=${grpcLeaves.length} built=${built.operationCount}`
            );
          }
          // (b) every leaf is a grpc-request (no foreign leaf types).
          if (grpcLeaves.length !== leavesList.length) {
            failures += 1;
            console.error(
              `  [FAIL] non-grpc leaf present: leaves=${leavesList.length} grpc=${grpcLeaves.length}`
            );
          }
          // (c) each grpc leaf carries the mapped test event.
          if (leavesWithEvents.length !== grpcLeaves.length) {
            failures += 1;
            console.error(
              `  [FAIL] grpc leaves missing extensions.events: ${grpcLeaves.length - leavesWithEvents.length} of ${grpcLeaves.length}`
            );
          }
          if (leaves < localItems) {
            failures += 1;
            console.error(`  [FAIL] populated fewer items than built: built=${localItems} created=${leaves}`);
          }
        } catch (error) {
          failures += 1;
          console.error(`  [FAIL] EC create rejected the ${testCase.type} collection: ${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }

      let uid: string;
      try {
        uid = await client.createCollection(workspace.id, built.collection);
        createdCollections.push(uid);
        console.log(`  [ok] Postman accepted collection: ${uid}`);
      } catch (error) {
        failures += 1;
        console.error(`  [FAIL] createCollection rejected the ${testCase.type} wire shape: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const fetched = await client.getCollection(uid);
      const remoteItems = leafItemCount(asCollection(fetched));
      const remoteEvents = eventCount(asCollection(fetched));
      console.log(`  [readback] ${remoteItems} leaf item(s), ${remoteEvents} event(s) survived the round-trip`);

      if (remoteItems < localItems) {
        failures += 1;
        console.error(`  [FAIL] Postman dropped items: local=${localItems} remote=${remoteItems}`);
      }
      if (localEvents > 0 && remoteEvents === 0) {
        failures += 1;
        console.error('  [FAIL] Postman dropped all test events on round-trip');
      }
    }
  } finally {
    console.log('\n[teardown] Removing created assets...');
    for (const uid of createdCollections) {
      try {
        await client.deleteCollection(uid);
        console.log(`  [teardown] Deleted collection ${uid}`);
      } catch (error) {
        console.error(`  [teardown] Failed to delete collection ${uid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const id of createdEcCollections) {
      try {
        await ecClient?.deleteExtensibleCollection(id);
        console.log(`  [teardown] Deleted EC collection ${id}`);
      } catch (error) {
        console.error(`  [teardown] Failed to delete EC collection ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await deleteWorkspace(apiKey, workspace.id);
      console.log(`  [teardown] Deleted workspace ${workspace.id}`);
    } catch (error) {
      console.error(`  [teardown] Failed to delete workspace ${workspace.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[leg:${label}] ${failures} failure(s).`);
  return failures;
}

async function main(): Promise<void> {
  const nonOrgKey =
    process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!nonOrgKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping live validation.');
    return;
  }

  let failures = await runLeg({ label: 'non-org', apiKey: nonOrgKey, orgMode: false });

  // Org-mode leg (S4): opt-in on both the org key and an explicit sub-team id.
  const orgKey = process.env.POSTMAN_E2E_API_KEY_ORG_MODE || '';
  const orgTeamRaw = process.env.ORG_MODE_WORKSPACE_TEAM_ID || '';
  if (orgKey && orgTeamRaw) {
    const orgTeamId = Number.parseInt(orgTeamRaw, 10);
    if (Number.isNaN(orgTeamId)) {
      console.error(`[org] ORG_MODE_WORKSPACE_TEAM_ID must be numeric, got: ${orgTeamRaw}`);
      failures += 1;
    } else {
      failures += await runLeg({
        label: 'org',
        apiKey: orgKey,
        orgMode: true,
        workspaceTeamId: orgTeamId
      });
    }
  } else {
    console.log('\n[skip] org-mode leg (set POSTMAN_E2E_API_KEY_ORG_MODE + ORG_MODE_WORKSPACE_TEAM_ID to run it).');
  }

  if (failures > 0) {
    console.error(`\n[result] ${failures} live validation failure(s).`);
    process.exitCode = 1;
    return;
  }
  console.log('\n[result] All protocols built, accepted by Postman, and round-tripped cleanly.');
}

function asCollection(value: unknown): unknown {
  if (value && typeof value === 'object' && 'collection' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).collection;
  }
  return value;
}

// Mint a service-account access token from a PMAK (POST /service-account-tokens),
// mirroring postman-resolve-service-token-action. Used so the gRPC EC leg can run
// from a sandbox API key alone. Token is read from access_token / session.token.
async function mintAccessToken(apiKey: string): Promise<string> {
  const response = await fetch('https://api.getpostman.com/service-account-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ apiKey })
  });
  if (!response.ok) {
    throw new Error(`service-account-tokens failed (HTTP ${response.status})`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const direct = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  const session = payload.session && typeof payload.session === 'object'
    ? (payload.session as Record<string, unknown>).token
    : undefined;
  const token = direct || (typeof session === 'string' ? session.trim() : '');
  if (!token) throw new Error('Mint succeeded but no access token in response');
  return token;
}

// The production PostmanAssetsClient intentionally exposes no deleteWorkspace
// (the action never deletes a workspace it provisioned). This harness owns the
// throwaway workspace, so it deletes via a raw authenticated call rather than
// widening the client's API surface for a manual script.
async function deleteWorkspace(apiKey: string, workspaceId: string): Promise<void> {
  const response = await fetch(`https://api.getpostman.com/workspaces/${workspaceId}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': apiKey }
  });
  if (!response.ok) {
    throw new Error(`DELETE /workspaces/${workspaceId} -> ${response.status}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
