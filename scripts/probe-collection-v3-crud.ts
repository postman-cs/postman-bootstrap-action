/**
 * Focused probe: v3 collection create / read / delete over the access-token gateway.
 *
 * Retires bootstrap's last PMAK v2.1.0 collection CRUD routes:
 *   - createCollection  (PMAK POST /collections?workspace=)
 *   - getCollection     (PMAK GET /collections/:uid)   -- repo-sync already uses v3 export for reads
 *   - deleteCollection  (PMAK DELETE /collections/:uid)
 *
 * The reference app's v3 cloud-service (postman-reference/postman-app/data/collection-data/
 * src/v3/services/cloud-service.ts) routes these through the `collection` service:
 *
 *   collection POST   /v3/collections/?workspace=<ws>            body: v3 IR collection
 *     -> {data:{id, createdAt}}; header X-Entity-Target: http creates a v2-HTTP collection
 *        (the v3 default is Extensible Collection). (cloud-service.ts:461-527)
 *   collection GET    /v3/collections/:id                       -> {data:{id, name, $kind, ...}}
 *   collection DELETE /v3/collections/:id                       -> 200; bulk: DELETE /v3/collections/
 *     with a body. (cloud-service.ts:271-305)
 *
 * `:id` is the BARE model id (public uid tail, no `<owner>-` prefix), consistent with the
 * v3 items/export routes already live-proven in probe-collection-mutation.ts.
 *
 * Verified LIVE (disposable non-org sandbox 10490519, 2026-06-30):
 *   [201] collection POST /v3/collections/?workspace=<ws> body {name}
 *         EC default -> data.id = BARE model id (24-char hex, e.g. 6a443c3e42dc6fdf46a59d8e),
 *         data.type='extensibleCollection'. Use this bare id verbatim for GET/DELETE.
 *   [201] same POST with header X-Entity-Target: http -> data.id = FULL uid
 *         (owner-prefixed, e.g. 55363555-5a498854-...), data.type='collection' (v2-HTTP).
 *         Use the full uid verbatim for GET/DELETE.
 *         => RULE: callers use the id POST returned AS-IS; do not strip/add an owner prefix.
 *   [200] collection GET /v3/collections/:id -> {data:{id, $kind:'collection', name, type, scripts, items}}
 *         (EC: type='extensibleCollection', scripts+items arrays; v2-HTTP: type='collection', references+items).
 *   [204] collection DELETE /v3/collections/:id -> empty (both EC bare id and v2-HTTP full uid accepted).
 *   [500] DELETE on an ALREADY-DELETED collection -> GENERIC_ERROR (NOT 404).
 *         => deleteV3Collection must tolerate BOTH 404 AND 500-on-already-gone for idempotent teardown.
 *   [404] GET on a deleted collection -> RESOURCE_NOT_FOUND (clean).
 *   [400] GET /v3/collections/0-<bareId> [contrast] -> "invalid format of parameter 'collectionId'"
 *         => never synthesize a uid; use the POST-returned id verbatim.
 *
 * Drive against the disposable non-org sandbox:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/probe-collection-v3-crud.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 600).replace(/\s+/g, ' ');
}

async function gw(
  client: AccessTokenGatewayClient,
  label: string,
  request: Parameters<AccessTokenGatewayClient['request']>[0]
): Promise<JsonRecord | null> {
  try {
    const response = await client.request(request);
    const body = await response.text().catch(() => '');
    console.log(`  [${response.status}] ${label} (${request.service} ${request.method} ${request.path}) :: ${snippet(body)}`);
    try {
      return body.trim() ? (JSON.parse(body) as JsonRecord) : null;
    } catch {
      return null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  [ERR] ${label} (${request.service} ${request.method} ${request.path}) :: ${snippet(msg)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping.');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const client = new AccessTokenGatewayClient({ tokenProvider: provider });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const createdWorkspaces = new Set<string>();
  const createdCollections = new Set<string>();

  try {
    // --- setup: a workspace to hold the collections ---
    const wsCreate = await gw(client, 'create workspace (personal)', {
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: `v3crud-probe-${stamp}`, visibilityStatus: 'personal' }
    });
    const workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (workspaceId) createdWorkspaces.add(workspaceId);
    if (!workspaceId) { console.log('[abort] no workspace'); return; }
    console.log(`[setup] workspace ${workspaceId}`);

    // --- route 1: POST /v3/collections/?workspace= (EC default) ---
    console.log('\n== route 1: collection POST /v3/collections/?workspace= (EC default) ==');
    const ecCreate = await gw(client, 'POST /v3/collections/ (EC default)', {
      service: 'collection', method: 'post', path: `/v3/collections/?workspace=${workspaceId}`,
      body: { name: 'V3 Crud Probe EC' }
    });
    const ecId = String(((ecCreate?.data as JsonRecord | undefined)?.id) ?? '').trim();
    console.log(`  [EC id] ${ecId}`);
    if (ecId) createdCollections.add(ecId);

    // --- route 2: GET /v3/collections/:id ---
    console.log('\n== route 2: collection GET /v3/collections/:id (EC) ==');
    if (ecId) {
      const got = await gw(client, 'GET /v3/collections/:id (EC)', {
        service: 'collection', method: 'get', path: `/v3/collections/${ecId}`
      });
      const data = (got?.data as JsonRecord | undefined) ?? {};
      console.log(`  [EC read] id=${data.id} name=${JSON.stringify(data.name)} $kind=${JSON.stringify(data.$kind)} type=${JSON.stringify(data.type)} keys=${Object.keys(data).join(',')}`);
    }

    // --- route 3: POST /v3/collections/?workspace= with X-Entity-Target: http (v2-HTTP) ---
    console.log('\n== route 3: collection POST /v3/collections/ (X-Entity-Target: http -> v2-HTTP) ==');
    const v2Create = await gw(client, 'POST /v3/collections/ (X-Entity-Target: http)', {
      service: 'collection', method: 'post', path: `/v3/collections/?workspace=${workspaceId}`,
      headers: { 'X-Entity-Target': 'http' },
      body: { name: 'V3 Crud Probe V2-HTTP' }
    });
    const v2Id = String(((v2Create?.data as JsonRecord | undefined)?.id) ?? '').trim();
    console.log(`  [v2-HTTP id] ${v2Id}`);
    if (v2Id) createdCollections.add(v2Id);

    if (v2Id) {
      const got2 = await gw(client, 'GET /v3/collections/:id (v2-HTTP)', {
        service: 'collection', method: 'get', path: `/v3/collections/${v2Id}`
      });
      const data2 = (got2?.data as JsonRecord | undefined) ?? {};
      console.log(`  [v2-HTTP read] id=${data2.id} name=${JSON.stringify(data2.name)} $kind=${JSON.stringify(data2.$kind)} type=${JSON.stringify(data2.type)} keys=${Object.keys(data2).join(',')}`);
    }

    // --- route 4: DELETE /v3/collections/:id ---
    console.log('\n== route 4: collection DELETE /v3/collections/:id ==');
    if (ecId) {
      await gw(client, 'DELETE /v3/collections/:id (EC)', {
        service: 'collection', method: 'delete', path: `/v3/collections/${ecId}`
      });
      createdCollections.delete(ecId);
      // 404 tolerance: delete again, expect 404 (not a throw).
      await gw(client, 'DELETE /v3/collections/:id (again, expect 404)', {
        service: 'collection', method: 'delete', path: `/v3/collections/${ecId}`
      });
    }
    if (v2Id) {
      await gw(client, 'DELETE /v3/collections/:id (v2-HTTP)', {
        service: 'collection', method: 'delete', path: `/v3/collections/${v2Id}`
      });
      createdCollections.delete(v2Id);
    }

    // --- route 5: GET on a deleted collection (expect 404, not a throw) ---
    console.log('\n== route 5: GET on a deleted collection (expect 404) ==');
    if (ecId) {
      await gw(client, 'GET /v3/collections/:id (deleted, expect 404)', {
        service: 'collection', method: 'get', path: `/v3/collections/${ecId}`
      });
    }

    // --- contrast: full-uid form (should fail / not match) ---
    console.log('\n== contrast: full-uid form (do not use) ==');
    if (ecId) {
      await gw(client, 'GET /v3/collections/<owner>-<id> [contrast]', {
        service: 'collection', method: 'get', path: `/v3/collections/0-${ecId}`
      });
    }

    console.log(`\n[verdict] v3 collection CRUD probe complete; see status codes above.`);
  } finally {
    console.log('\n[teardown] deleting leftover collections + workspace...');
    for (const id of createdCollections) {
      await gw(client, `DELETE /v3/collections/${id}`, {
        service: 'collection', method: 'delete', path: `/v3/collections/${id}`
      });
    }
    for (const id of createdWorkspaces) {
      await gw(client, `DELETE /workspaces/${id}`, {
        service: 'workspaces', method: 'delete', path: `/workspaces/${id}`
      });
    }
  }
  console.log('\n[result] probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
