/** Probe: which fields does the v3 item CREATE accept, and which JSON-patch paths
 * land on an existing item? Grounds how to build the resolve-secrets item (auth +
 * body + headers + events) over the gateway. Source: cloud-service.ts createItem
 * sends `input` verbatim; real UI caller creates method/url/headers then edits.
 * Run-scoped teardown. */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { HttpError } from '../src/lib/http-error.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;

async function attempt(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`  [200] ${label}`);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 0;
    const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  [${status}] ${label} :: ${msg}`);
  }
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
    const ws = await gw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `cf-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    createdWorkspaces.add(workspaceId);
    const spec = await gw.requestJson<J>({
      service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
      body: { name: 'CF', type: 'OPENAPI:3.0', files: [{ path: 'i.yaml', content: 'openapi: 3.0.3\ninfo: { title: CF, version: 1.0.0 }\npaths: { /p: { get: { operationId: p, responses: { "200": { description: OK } } } } }', type: 'ROOT' }] }
    });
    const specId = String((spec?.data as J)?.id ?? '').trim();
    const gen = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications/${specId}/collections`, body: { name: 'CFC', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } } });
    const taskId = String((gen?.data as J)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i++) { await new Promise((r) => setTimeout(r, 2000)); const t = await gw.requestJson<J>({ service: 'specification', method: 'get', path: '/tasks', query: { entityId: specId, entityType: 'specification', type: 'collection-generation' } }); if (String((t?.data as J)?.[taskId] ?? '') === 'completed') break; }
    const cols = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/collections` });
    const uid = String((Array.isArray(cols?.data) ? (cols.data as J[]) : [])[0]?.collection ?? '').trim();
    const cid = uid.includes('-') ? uid.slice(uid.indexOf('-') + 1) : uid;
    console.log(`[setup] cid=${cid}`);

    const mk = (extra: J) => ({ service: 'collection', method: 'post' as const, path: `/v3/collections/${cid}/items/`, headers: { 'X-Entity-Type': 'http-request' }, body: { $kind: 'http-request', name: 'probe', method: 'POST', url: 'https://example.com', position: { parent: { id: cid, $kind: 'collection' } }, ...extra } });

    console.log('\n== CREATE field acceptance ==');
    await attempt('create minimal (method/url)', () => gw.requestJson(mk({})));
    await attempt('create + headers', () => gw.requestJson(mk({ headers: [{ key: 'X-A', value: '1' }] })));
    await attempt('create + body(raw)', () => gw.requestJson(mk({ body: { mode: 'raw', raw: '{}' } })));
    await attempt('create + auth(awsv4)', () => gw.requestJson(mk({ auth: { type: 'awsv4', awsv4: [{ key: 'region', value: 'us-east-1' }] } })));
    await attempt('create + payload{headers,body,auth}', () => gw.requestJson(mk({ payload: { headers: [{ key: 'X-A', value: '1' }], body: { mode: 'raw', raw: '{}' }, auth: { type: 'awsv4', awsv4: [{ key: 'region', value: 'us-east-1' }] } } })));

    console.log('\n== PATCH path acceptance (on a freshly created minimal item) ==');
    const base = await gw.requestJson<J>(mk({}));
    const itemId = String((base?.data as J)?.id ?? '').trim();
    console.log(`  [item] ${itemId}`);
    const patch = (path: string, value: unknown) => ({ service: 'collection', method: 'patch' as const, path: `/v3/collections/${cid}/items/${itemId}`, headers: { 'X-Entity-Type': 'http-request' }, body: [{ op: 'add', path, value }] });
    await attempt('PATCH /headers', () => gw.requestJson(patch('/headers', [{ key: 'X-A', value: '1' }])));
    await attempt('PATCH /body', () => gw.requestJson(patch('/body', { mode: 'raw', raw: '{}' })));
    await attempt('PATCH /auth', () => gw.requestJson(patch('/auth', { type: 'awsv4', awsv4: [{ key: 'region', value: 'us-east-1' }] })));
    await attempt('PATCH /payload (replace)', () => gw.requestJson({ service: 'collection', method: 'patch', path: `/v3/collections/${cid}/items/${itemId}`, headers: { 'X-Entity-Type': 'http-request' }, body: [{ op: 'replace', path: '/payload', value: { headers: [{ key: 'X-A', value: '1' }], body: { mode: 'raw', raw: '{}' }, auth: { type: 'awsv4', awsv4: [{ key: 'region', value: 'us-east-1' }] } } }] }));
    await attempt('PATCH /events', () => gw.requestJson(patch('/events', [{ listen: 'test', script: { exec: ['pm.test("x",()=>{})'], type: 'text/javascript' } }])));
  } finally {
    for (const id of createdWorkspaces) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
