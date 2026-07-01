/** Feasibility probe: can injectTests + tagCollection run on the GATEWAY (no PMAK)?
 * Creates spec+generated collection, then probes the routes the OAS path needs. */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { HttpError } from '../src/lib/http-error.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;
async function raw(gw: AccessTokenGatewayClient, service: string, method: 'get'|'post'|'put'|'patch'|'delete', path: string, body?: unknown) {
  try { const r = await gw.request({ service, method, path, ...(body!==undefined?{body}:{}) }); return { status: r.status, text: (await r.text().catch(()=>'')).slice(0,260) }; }
  catch (e) { return { status: e instanceof HttpError ? e.status : 0, text: (e instanceof Error ? e.message : String(e)).slice(0,260) }; }
}
async function main() {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip]'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const wsr = await raw(gw, 'workspaces', 'post', '/workspaces', { name: `oas-${stamp}`, visibilityStatus: 'personal' });
  const ws = String((JSON.parse(wsr.text||'{}').data ?? JSON.parse(wsr.text||'{}'))?.id ?? '').trim();
  await raw(gw, 'workspaces', 'put', `/workspaces/${ws}/visibility`, { visibilityStatus: 'team' });
  try {
    const sc = await raw(gw, 'specification', 'post', `/specifications?containerType=workspace&containerId=${ws}`, { name: 'O', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: 'openapi: 3.0.3\ninfo: { title: O, version: 1.0.0 }\npaths: { /p: { get: { operationId: p, responses: { "200": { description: OK } } } } }', type: 'ROOT' }] });
    const specId = String(JSON.parse(sc.text||'{}').data?.id ?? '').trim();
    const gen = await raw(gw, 'specification', 'post', `/specifications/${specId}/collections`, { name: 'OC', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } });
    const taskId = String(JSON.parse(gen.text||'{}').data?.taskId ?? '').trim();
    for (let i=0;i<30&&taskId;i++){ await new Promise(r=>setTimeout(r,2000)); const t=await gw.requestJson<J>({service:'specification',method:'get',path:'/tasks',query:{entityId:specId,entityType:'specification',type:'collection-generation'}}); const st=String((t?.data as J)?.[taskId]??'').toLowerCase(); if(st&&!['in-progress','pending','queued'].includes(st))break; }
    const cols = await gw.requestJson<J>({ service:'specification', method:'get', path:`/specifications/${specId}/collections` });
    const entries = Array.isArray(cols?.data)?(cols.data as J[]):[];
    const pub = String(entries[entries.length-1]?.collection ?? entries[entries.length-1]?.id ?? '').trim();
    const model = pub.split('-').slice(1).join('-');
    console.log(`[col] pub=${pub} model=${model}`);

    console.log('\n=== injectTests candidate: v3 collection-items ===');
    console.log('  GET /v3/collections/:model/items ::', (await raw(gw,'collection','get',`/v3/collections/${model}/items`)).status);
    const items = await gw.requestJson<J>({service:'collection',method:'get',path:`/v3/collections/${model}/items`}).catch(()=>null);
    const firstItem = Array.isArray((items as J)?.data)?((items as J).data as J[])[0]:Array.isArray((items as J)?.items)?((items as J).items as J[])[0]:null;
    const itemId = String((firstItem as J)?.id ?? '').trim();
    console.log(`  first itemId=${itemId}`);
    if (itemId) console.log('  PATCH /v3/collections/:model/items/:itemId ::', (await raw(gw,'collection','patch',`/v3/collections/${model}/items/${itemId}`,{ })).status);

    console.log('\n=== tagCollection candidates ===');
    for (const [label, svc, m, p] of [
      ['PUT collection /collections/:pub/tags','collection','put',`/collections/${pub}/tags`],
      ['PUT collection /v3/collections/:model/tags','collection','put',`/v3/collections/${model}/tags`],
      ['PUT tags service /collections/:pub/tags','tags','put',`/collections/${pub}/tags`],
    ] as const) {
      const r = await raw(gw, svc, m as 'put', p, { tags: [{ slug: 'generated-baseline' }] });
      console.log(`  [${r.status}] ${label} :: ${r.text}`);
    }
  } finally {
    if (ws) { const d = await fetch(`${API}/workspaces/${ws}`, { method:'DELETE', headers:{'X-Api-Key':apiKey} }); console.log(`\n[teardown] ${d.status}`); }
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
