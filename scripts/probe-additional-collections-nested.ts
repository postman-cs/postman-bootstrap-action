/**
 * Probe: v3 collection create (v2-HTTP) + nested-folder item population + full-replace
 * update reconcile, for porting bootstrap's additional-collections feature off PMAK.
 *
 * Builds on the LIVE-PROVEN routes in probe-collection-v3-crud.ts (create empty
 * v2-HTTP collection via X-Entity-Target: http) and probe-collection-mutation.ts
 * (flat item create/patch). This probe adds the untested piece: creating a FOLDER
 * item (a container with position.parent = the collection root) and a nested
 * leaf under that folder (position.parent = the folder's own item id), then
 * verifying via GET /v3/collections/:cid/items/ and GET .../export that the
 * nesting round-trips, then a full delete-all-items + recreate reconcile.
 *
 * Drive against the disposable non-org sandbox:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/probe-additional-collections-nested.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 700).replace(/\s+/g, ' ');
}

function bareModelId(uid: string): string {
  const u = String(uid ?? '').trim();
  return u.includes('-') ? u.slice(u.indexOf('-') + 1) : u;
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
  let workspaceId = '';
  let cid = '';

  try {
    const wsCreate = await gw(client, 'create workspace (personal)', {
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: `nested-probe-${stamp}`, visibilityStatus: 'personal' }
    });
    workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!workspaceId) { console.log('[abort] no workspace'); return; }
    console.log(`[setup] workspace ${workspaceId}`);

    console.log('\n== step 1: create v2-HTTP collection (X-Entity-Target: http) ==');
    const created = await gw(client, 'POST /v3/collections/ (v2-HTTP)', {
      service: 'collection', method: 'post', path: `/v3/collections/?workspace=${workspaceId}`,
      headers: { 'X-Entity-Target': 'http' },
      body: { name: 'Additional Collection Nested Probe' }
    });
    const rawId = String(((created?.data as JsonRecord | undefined)?.id) ?? '').trim();
    if (!rawId) { console.log('[abort] no collection id'); return; }
    cid = bareModelId(rawId);
    console.log(`  [raw id] ${rawId}  [bare id] ${cid}`);

    console.log('\n== step 2: create a FOLDER item at root ==');
    const folderCreate = await gw(client, 'POST items/ (folder)', {
      service: 'collection', method: 'post', path: `/v3/collections/${cid}/items/`,
      headers: { 'X-Entity-Type': 'collection' },
      body: {
        $kind: 'collection',
        name: 'Nested Folder',
        position: { parent: { id: cid, $kind: 'collection' } }
      }
    });
    const folderId = String((folderCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    console.log(`  [folder id] ${folderId}`);

    console.log('\n== step 3: create a LEAF item under the folder ==');
    if (folderId) {
      const leafCreate = await gw(client, 'POST items/ (leaf under folder)', {
        service: 'collection', method: 'post', path: `/v3/collections/${cid}/items/`,
        headers: { 'X-Entity-Type': 'http-request' },
        body: {
          $kind: 'http-request',
          name: 'Nested Leaf',
          method: 'GET',
          url: 'https://postman-echo.com/get',
          headers: [],
          position: { parent: { id: folderId, $kind: 'collection' } }
        }
      });
      console.log(`  [leaf id] ${String((leafCreate?.data as JsonRecord | undefined)?.id ?? '')}`);
    }

    console.log('\n== step 4: create a ROOT-level leaf (sibling of folder) ==');
    await gw(client, 'POST items/ (root leaf)', {
      service: 'collection', method: 'post', path: `/v3/collections/${cid}/items/`,
      headers: { 'X-Entity-Type': 'http-request' },
      body: {
        $kind: 'http-request',
        name: 'Root Leaf',
        method: 'GET',
        url: 'https://postman-echo.com/get',
        headers: [],
        position: { parent: { id: cid, $kind: 'collection' } }
      }
    });

    console.log('\n== step 5: list items (flat), verify nesting via $kind + parent ==');
    const listed = await gw(client, 'GET items/', {
      service: 'collection', method: 'get', path: `/v3/collections/${cid}/items/`
    });
    const items = Array.isArray((listed?.data)) ? (listed!.data as JsonRecord[]) : [];
    console.log(`  [item count] ${items.length}`);
    for (const it of items) {
      console.log(`    - id=${it.id} kind=${it.$kind} name=${JSON.stringify(it.name)}`);
    }

    console.log('\n== step 6: export, verify folder nesting shows up ==');
    const exported = await gw(client, 'GET export', {
      service: 'collection', method: 'get', path: `/v3/collections/${cid}/export`
    });
    const exportedCollection = (exported?.data as JsonRecord | undefined)?.collection as JsonRecord | undefined;
    console.log(`  [export items] ${JSON.stringify((exportedCollection?.items as JsonRecord[] | undefined)?.map((n) => ({ kind: n.$kind, name: n.name, childCount: Array.isArray(n.items) ? (n.items as unknown[]).length : 0 })))}`);

    console.log('\n== step 7: delete-all-items reconcile (mirrors smoke-flow deleteAllItems) ==');
    for (const it of items) {
      const itemId = String(it.id ?? '').trim();
      if (!itemId) continue;
      await gw(client, `DELETE items/${itemId}`, {
        service: 'collection', method: 'delete', path: `/v3/collections/${cid}/items/${itemId}`,
        headers: { 'X-Entity-Type': String(it.$kind ?? 'http-request') }
      });
    }
    const relisted = await gw(client, 'GET items/ (after delete-all)', {
      service: 'collection', method: 'get', path: `/v3/collections/${cid}/items/`
    });
    const remaining = Array.isArray(relisted?.data) ? (relisted!.data as JsonRecord[]) : [];
    console.log(`  [remaining after delete] ${remaining.length}`);

    console.log('\n[verdict] nested-folder create/list/export/delete probe complete; see status codes above.');
  } finally {
    console.log('\n[teardown] deleting collection + workspace...');
    if (cid) {
      await gw(client, `DELETE /v3/collections/${cid}`, {
        service: 'collection', method: 'delete', path: `/v3/collections/${cid}`
      });
    }
    if (workspaceId) {
      await gw(client, `DELETE /workspaces/${workspaceId}`, {
        service: 'workspaces', method: 'delete', path: `/workspaces/${workspaceId}`
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
