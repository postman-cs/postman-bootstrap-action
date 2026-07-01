/** Probe the two v3 item primitives the smoke-flow reshape needs but that were
 * not yet live-proven: reorder (POST /v3/items/move) and delete
 * (DELETE /v3/collections/:cid/items/:itemId). Reference:
 * cloud-service.ts:760-799 (move, body {items:[{id,$kind}], toPosition}),
 * types.ts:344-351 (V3MoveItemsInput); cloud-service.ts:435-450 (delete, X-Entity-Type).
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-move-delete.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { HttpError } from '../src/lib/http-error.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;

function bare(uid: string): string { return uid.includes('-') ? uid.slice(uid.indexOf('-') + 1) : uid; }

async function listNames(gw: AccessTokenGatewayClient, cid: string): Promise<Array<{ id: string; name: string }>> {
  const r = await gw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/items/` });
  const items = Array.isArray(r?.data) ? (r!.data as J[]) : [];
  return items.filter((i) => String(i.$kind ?? '') === 'http-request').map((i) => ({ id: String(i.id), name: String(i.name) }));
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip]'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const createdWorkspaces = new Set<string>();

  try {
    const ws = await gw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `mv-del-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    createdWorkspaces.add(workspaceId);
    const specContent = [
      'openapi: 3.0.3',
      'info: { title: MvDel API, version: 1.0.0 }',
      'paths:',
      '  /a: { get: { operationId: a, summary: A, responses: { "200": { description: OK } } } }',
      '  /b: { get: { operationId: b, summary: B, responses: { "200": { description: OK } } } }',
      '  /c: { get: { operationId: c, summary: C, responses: { "200": { description: OK } } } }'
    ].join('\n');
    const spec = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'MvDel API', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: specContent, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();
    const gen = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications/${specId}/collections`, body: { name: 'MvDel Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } } });
    const taskId = String((gen?.data as J)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i++) { await new Promise((r) => setTimeout(r, 2000)); const t = await gw.requestJson<J>({ service: 'specification', method: 'get', path: '/tasks', query: { entityId: specId, entityType: 'specification', type: 'collection-generation' } }); if (String((t?.data as J)?.[taskId] ?? '') === 'completed') break; }
    const cols = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/collections` });
    const uid = String((Array.isArray(cols?.data) ? (cols.data as J[]) : [])[0]?.collection ?? '').trim();
    const cid = bare(uid);

    let leaves = await listNames(gw, cid);
    console.log(`[setup] cid=${cid} order=${leaves.map((l) => l.name).join(',')}`);
    if (leaves.length < 3) { console.log('[abort] need 3 leaves'); return; }

    // --- MOVE: reorder so the last leaf becomes first (toPosition.parent=cid, nextSibling=first) ---
    const last = leaves[leaves.length - 1];
    const first = leaves[0];
    try {
      const r = await gw.request({ service: 'collection', method: 'post', path: '/v3/items/move', body: { items: [{ id: last.id, $kind: 'http-request' }], toPosition: { parent: { id: cid, $kind: 'collection' }, collectionId: cid, nextSibling: { id: first.id, $kind: 'http-request' } } } });
      console.log(`  [${r.status}] MOVE ${last.name} before ${first.name}`);
    } catch (e) { console.log(`  [${e instanceof HttpError ? e.status : 0}] MOVE failed :: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`); }
    leaves = await listNames(gw, cid);
    console.log(`  items-list order after move=${leaves.map((l) => l.name).join(',')}`);
    // Ordered representations: v3 export tree + public v2 item[].
    const exp = await gw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/export` }).catch(() => null);
    const expItems = (((exp?.data as J)?.collection as J) ?? exp?.data as J ?? {})?.item ?? ((exp?.data as J)?.collection as J)?.items;
    console.log(`  v3 export order=${JSON.stringify((Array.isArray(expItems) ? expItems : []).map((i: J) => i.name ?? i.title)).slice(0, 200)}`);
    const pubResp = await fetch(`${API}/collections/${uid}`, { headers: { 'X-Api-Key': apiKey } });
    const pub = await pubResp.json().catch(() => ({})) as J;
    const pubItems = Array.isArray((pub.collection as J)?.item) ? ((pub.collection as J).item as J[]) : [];
    console.log(`  public v2 order=${JSON.stringify(pubItems.map((i) => i.name))}`);

    // --- DELETE: remove one leaf ---
    const victim = leaves[leaves.length - 1];
    try {
      const r = await gw.request({ service: 'collection', method: 'delete', path: `/v3/collections/${cid}/items/${victim.id}`, headers: { 'X-Entity-Type': 'http-request' } });
      console.log(`  [${r.status}] DELETE ${victim.name}`);
    } catch (e) { console.log(`  [${e instanceof HttpError ? e.status : 0}] DELETE failed :: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`); }
    leaves = await listNames(gw, cid);
    console.log(`  order after delete=${leaves.map((l) => l.name).join(',')} (count=${leaves.length})`);
  } finally {
    for (const id of createdWorkspaces) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
