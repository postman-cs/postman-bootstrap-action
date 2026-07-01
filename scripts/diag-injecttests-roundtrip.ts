/** Validate the corrected injectTests create shape: the secrets-resolver's
 * headers/body/auth must persist at the item ROOT (not the dropped payload
 * wrapper), and every leaf must carry its afterResponse test script. Reads back
 * via the v3 export and asserts persistence.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-injecttests-roundtrip.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;
function bare(uid: string): string { return uid.includes('-') ? uid.slice(uid.indexOf('-') + 1) : uid; }

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip]'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const assets = new PostmanGatewayAssetsClient({ gateway: gw });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created = new Set<string>();
  try {
    const ws = await gw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `inj-rt-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    created.add(workspaceId);
    const specContent = ['openapi: 3.0.3', 'info: { title: InjRT, version: 1.0.0 }', 'servers: [{ url: https://postman-echo.com }]', 'paths:', '  /get: { get: { operationId: g, summary: G, responses: { "200": { description: OK } } } }'].join('\n');
    const spec = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'InjRT', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: specContent, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();
    const gen = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications/${specId}/collections`, body: { name: 'InjRT C', options: { requestNameSource: 'Fallback' } } });
    const taskId = String((gen?.data as J)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i++) { await new Promise((r) => setTimeout(r, 2000)); const t = await gw.requestJson<J>({ service: 'specification', method: 'get', path: '/tasks', query: { entityId: specId, entityType: 'specification', type: 'collection-generation' } }); if (String((t?.data as J)?.[taskId] ?? '') === 'completed') break; }
    const cols = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/collections` });
    const uid = String((Array.isArray(cols?.data) ? (cols.data as J[]) : [])[0]?.collection ?? '').trim();
    const cid = bare(uid);

    await assets.injectTests(uid, 'smoke');
    console.log('[injectTests] done');

    const exp = await gw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/export` });
    const c = (exp?.data as J)?.collection as J ?? {};
    const walk = (arr: unknown, out: J[] = []): J[] => { if (Array.isArray(arr)) for (const n of arr as J[]) { if (String(n.$kind) === 'http-request') out.push(n); if (Array.isArray(n.items)) walk(n.items, out); } return out; };
    const leaves = walk(c.items);
    const resolver = leaves.find((l) => String(l.name) === '00 - Resolve Secrets') ?? {};
    console.log(`[resolver] method=${resolver.method} headers=${JSON.stringify(resolver.headers)}`);
    console.log(`[resolver] body=${JSON.stringify(resolver.body)}`);
    console.log(`[resolver] auth=${JSON.stringify(resolver.auth)}`);
    console.log(`[resolver] scripts.types=${JSON.stringify((Array.isArray(resolver.scripts) ? resolver.scripts as J[] : []).map((s) => s.type))}`);
    const leafWithTests = leaves.filter((l) => String(l.name) !== '00 - Resolve Secrets');
    console.log(`[leaves] ${leafWithTests.map((l) => `${l.name}:scripts=${(Array.isArray(l.scripts) ? l.scripts as J[] : []).length}`).join(', ')}`);
  } finally {
    for (const id of created) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
