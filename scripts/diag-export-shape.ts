/** Dump the v3 export leaf shape for a spec-generated (v2-HTTP) collection so the
 * smoke-flow v3->v2 read adapter is designed from ground truth, not a guess.
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-export-shape.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created = new Set<string>();
  try {
    const ws = await gw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `exp-shape-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    created.add(workspaceId);
    const specContent = [
      'openapi: 3.0.3',
      'info: { title: Exp API, version: 1.0.0 }',
      'servers: [{ url: https://postman-echo.com }]',
      'paths:',
      '  /post: { post: { operationId: doPost, summary: Do Post, requestBody: { content: { application/json: { schema: { type: object, properties: { name: { type: string } } } } } }, parameters: [{ name: q, in: query, schema: { type: string } }], responses: { "200": { description: OK } } } }'
    ].join('\n');
    const spec = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'Exp API', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: specContent, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();
    const gen = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications/${specId}/collections`, body: { name: 'Exp Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } } });
    const taskId = String((gen?.data as J)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i++) { await new Promise((r) => setTimeout(r, 2000)); const t = await gw.requestJson<J>({ service: 'specification', method: 'get', path: '/tasks', query: { entityId: specId, entityType: 'specification', type: 'collection-generation' } }); if (String((t?.data as J)?.[taskId] ?? '') === 'completed') break; }
    const cols = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/collections` });
    const uid = String((Array.isArray(cols?.data) ? (cols.data as J[]) : [])[0]?.collection ?? '').trim();
    const cid = bare(uid);
    const exp = await gw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/export` });
    console.log(JSON.stringify((exp?.data as J)?.collection ?? exp?.data, null, 2).slice(0, 4000));
  } finally {
    for (const id of created) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
