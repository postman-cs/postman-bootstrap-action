/**
 * Focused probe: does per-request auth round-trip on the gateway v3 store?
 *
 * Refutes "Per-request auth does NOT round-trip on the gateway v3 store; OAuth must
 * ride collection-level auth." That claim (1) used a WRONG create shape — nesting
 * `auth` under `payload` — and (2) read credentials back via the v3 items GET-by-id,
 * which surfaces `auth.type` but omits `credentials` (a v3 read-shape quirk). The
 * authoritative persistence proof is the v2 EXPORT `request.auth` — the exact payload
 * `postman collection run` executes.
 *
 * Verified LIVE (disposable non-org sandbox team 10490519, 2026-06-30):
 *   [201] POST /v3/collections/<bareModelId>/items/  auth at ROOT
 *          body {$kind:'http-request', name, method, url, auth:{type:'bearer',
 *                credentials:[{key:'token', value:'{{access_token}}'}]},
 *                position:{parent:{id:<bareModelId>,$kind:'collection'}}}
 *        -> v3 GET-by-id auth  = {credentials:[{key:'token',value:'{{access_token}}'}], type:'bearer'}
 *        -> v3 export leaf auth = {credentials:[{key:'token',value:'{{access_token}}'}], type:'bearer'}
 *           BEARER per-request auth FULLY round-trips (type + credentials) in BOTH readbacks.
 *   [201] POST same with oauth2 root auth + 3 credentials -> type lands; credentials read back
 *        EMPTY in both v3 GET-by-id and v3 export (oauth2-specific readback quirk — the
 *        smoke-flow action does NOT apply oauth2 as per-request auth, so this is moot: it
 *        seeds collection `variables` + a pre-request script and applies BEARER per request).
 *   Contrast: nesting `auth` under `payload` (the other agent's shape) -> the auth is NOT
 *        placed on the request; v3 GET-by-id auth = empty; export leaf auth = empty. Wrong
 *        shape, not a platform limit. Correct shape: `auth` at the item ROOT, sibling to
 *        url/body/headers (per createCollectionFromRecords.ts:21-37 + v3-auth-adapter.ts).
 *
 * Drive against the disposable non-org sandbox:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/probe-item-auth-roundtrip.ts
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

function bareModelId(uid: string): string {
  return uid.includes('-') ? uid.slice(uid.indexOf('-') + 1) : uid;
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

  try {
    // --- setup: workspace + spec + spec-generated collection ---
    const wsCreate = await client.requestJson<JsonRecord>({
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: `auth-rt-probe-${stamp}`, visibilityStatus: 'personal' }
    });
    const workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (workspaceId) createdWorkspaces.add(workspaceId);
    if (!workspaceId) { console.log('[abort] no workspace'); return; }
    console.log(`[setup] workspace ${workspaceId}`);

    const specContent = [
      'openapi: 3.0.3', 'info:', '  title: Auth RT Probe', '  version: 1.0.0',
      'paths:', '  /ping:', '    get:', '      summary: Ping', '      operationId: ping',
      '      responses:', "        '200':", '          description: OK'
    ].join('\n');
    const specCreate = await client.requestJson<JsonRecord>({
      service: 'specification', method: 'post',
      path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
      body: { name: 'Auth RT Probe', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }] }
    });
    const specId = String((specCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!specId) { console.log('[abort] no spec'); return; }
    console.log(`[setup] spec ${specId}`);

    const gen = await client.requestJson<JsonRecord>({
      service: 'specification', method: 'post', path: `/specifications/${specId}/collections`,
      body: { name: 'Auth RT Probe Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } }
    });
    const taskId = String((gen?.data as JsonRecord | undefined)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const t = await client.requestJson<JsonRecord>({
        service: 'specification', method: 'get', path: '/tasks',
        query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
      });
      const data = (t?.data as JsonRecord | undefined) ?? {};
      const status = String(data[taskId] ?? '');
      if (status && status !== 'in-progress') break;
    }
    const specCols = await client.requestJson<JsonRecord>({
      service: 'specification', method: 'get', path: `/specifications/${specId}/collections`
    });
    const colData = Array.isArray(specCols?.data) ? (specCols.data as JsonRecord[]) : [];
    const collectionUid = String(colData[0]?.collection ?? colData[0]?.id ?? colData[0]?.collectionId ?? colData[0]?.uid ?? '').trim();
    if (!collectionUid) { console.log('[abort] no collection'); return; }
    const modelId = bareModelId(collectionUid);
    console.log(`[setup] collection uid ${collectionUid} modelId ${modelId}`);

    const createItem = async (label: string, body: JsonRecord): Promise<string> => {
      const r = await client.requestJson<JsonRecord>({
        service: 'collection', method: 'post', path: `/v3/collections/${modelId}/items/`,
        body
      });
      const id = String((r?.data as JsonRecord | undefined)?.id ?? '').trim();
      console.log(`  [create ${label}] -> id=${id || '<none>'} :: ${snippet(r?.data ?? r)}`);
      return id;
    };

    const parent = { id: modelId, $kind: 'collection' };

    // A) CORRECT: auth at the item ROOT (sibling to url/body/headers).
    const idA = await createItem('A root-bearer (correct)', {
      $kind: 'http-request', name: 'Root Bearer Auth', method: 'GET',
      url: 'https://postman-echo.com/get',
      auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{access_token}}' }] },
      position: { parent }
    });

    // B) CORRECT: oauth2 at the item ROOT with full credentials.
    const idB = await createItem('B root-oauth2 (correct)', {
      $kind: 'http-request', name: 'Root OAuth2 Auth', method: 'GET',
      url: 'https://postman-echo.com/get',
      auth: { type: 'oauth2', credentials: [
        { key: 'grantType', value: 'client_credentials' },
        { key: 'tokenUrl', value: 'https://example.com/token' },
        { key: 'clientAuthentication', value: 'body' }
      ] },
      position: { parent }
    });

    // C) WRONG (the other agent's shape): auth nested under `payload`.
    const idC = await createItem('C payload-nested (wrong)', {
      $kind: 'http-request', name: 'Payload Nested Auth', method: 'GET',
      url: 'https://postman-echo.com/get',
      payload: { auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{access_token}}' }] } },
      position: { parent }
    });

    // --- readback 1: v3 GET-by-id (surfaces auth.type, omits credentials — read quirk) ---
    console.log('\n== v3 GET-by-id readback (auth.type only; credentials omitted) ==');
    for (const [label, id] of [['A', idA], ['B', idB], ['C', idC]] as const) {
      if (!id) continue;
      const g = await client.requestJson<JsonRecord>({
        service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/${id}`,
        headers: { 'X-Entity-Type': 'http-request' }
      });
      const d = (g?.data as JsonRecord | undefined) ?? {};
      console.log(`  [v3 GET ${label}] auth=${snippet(d.auth)}`);
    }

    // --- readback 2: v2 EXPORT (the executable shape `postman collection run` reads) ---
    console.log('\n== v2 export readback (executable request.auth) ==');
    const exp = await client.requestJson<JsonRecord>({
      service: 'collection', method: 'get', path: `/v3/collections/${modelId}/export`
    });
    const expData = (exp?.data as JsonRecord | undefined) ?? {};
    const coll = (expData.collection as JsonRecord | undefined) ?? expData;
    console.log(`  [export keys] data.keys=${Object.keys(expData).join(',')} coll.keys=${Object.keys(coll).join(',')}`);
    const rawItems = (coll.item as JsonRecord[] | undefined) ?? (coll.items as JsonRecord[] | undefined) ?? [];
    console.log(`  [export items] count=${Array.isArray(rawItems) ? rawItems.length : 'not-array'}`);
    const walk = (arr: JsonRecord[], depth = 0): void => {
      for (const it of arr) {
        const kind = String(it.$kind ?? '');
        if (kind === 'http-request') {
          console.log(`  [export leaf '${it.name}'] auth=${snippet(it.auth)}`);
        }
        if (Array.isArray(it.items as unknown)) walk(it.items as JsonRecord[], depth + 1);
        if (Array.isArray(it.item as unknown)) walk(it.item as JsonRecord[], depth + 1);
      }
    };
    walk(rawItems);

    console.log('\n[verdict] A + B root-auth items -> export request.auth populated => per-request auth ROUND-TRIPS.');
    console.log('[verdict] C payload-nested -> export request.auth empty => the other agent used the wrong shape.');
  } finally {
    console.log('\n[teardown] deleting created workspaces...');
    for (const id of createdWorkspaces) {
      try {
        const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } });
        console.log(`  [teardown] DELETE /workspaces/${id} -> ${r.status}`);
      } catch (error) {
        console.log(`  [teardown] workspace ${id} delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  console.log('\n[result] probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
