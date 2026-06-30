/** DECISIVE probe: which test-injection shape actually EXECUTES on a v2-HTTP
 * (OpenAPI-spec-gen) collection — the v2 `/events` shape or the v3 `/scripts`
 * (afterResponse) shape?
 *
 * Readback alone is ambiguous: the v3 per-item GET projects `data.scripts`
 * (EC view) while the public v2 GET projects `item.event` (run view). The only
 * ground truth is RUNNING the collection (Postman CLI) and seeing which named
 * test the runner executes.
 *
 * Flow (access-token gateway for mutation; PMAK only to mint + to drive the CLI run):
 *   1. workspace + spec (servers -> postman-echo.com, two GET paths) + generate.
 *   2. leaf A: PATCH /events  [{listen:test, script:{exec,type}}]   test name "EVENTS_MARKER"
 *      leaf B: PATCH /scripts [{type:afterResponse, code, language}] test name "SCRIPTS_MARKER"
 *   3. readback each via v3 per-item GET (data.events/data.scripts) + public v2 GET (item.event).
 *   4. `postman collection run <uid>` (PMAK login) -> capture which marker assertions ran.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-test-injection-exec.ts
 */
import { execFileSync } from 'node:child_process';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;

function bare(uid: string): string {
  return uid.includes('-') ? uid.slice(uid.indexOf('-') + 1) : uid;
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no api key'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const createdWorkspaces = new Set<string>();

  try {
    const ws = await gw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `inj-exec-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    createdWorkspaces.add(workspaceId);

    // Spec points the generated requests at postman-echo (a real 200 endpoint).
    const specContent = [
      'openapi: 3.0.3',
      'info: { title: Inj Exec API, version: 1.0.0 }',
      'servers: [{ url: https://postman-echo.com }]',
      'paths:',
      '  /get:  { get: { operationId: echoGet,  summary: Echo Get,  responses: { "200": { description: OK } } } }',
      '  /headers: { get: { operationId: echoHdr, summary: Echo Headers, responses: { "200": { description: OK } } } }'
    ].join('\n');
    const spec = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'Inj Exec API', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();
    const gen = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications/${specId}/collections`, body: { name: 'Inj Exec Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } } });
    const taskId = String((gen?.data as J)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i++) { await new Promise((r) => setTimeout(r, 2000)); const t = await gw.requestJson<J>({ service: 'specification', method: 'get', path: '/tasks', query: { entityId: specId, entityType: 'specification', type: 'collection-generation' } }); if (String((t?.data as J)?.[taskId] ?? '') === 'completed') break; }
    const cols = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/collections` });
    const uid = String((Array.isArray(cols?.data) ? (cols.data as J[]) : [])[0]?.collection ?? '').trim();
    const cid = bare(uid);
    console.log(`[setup] collection uid=${uid} cid=${cid}`);

    const items = (await gw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/items/` }))?.data as J[] ?? [];
    const leaves = items.filter((i) => String(i.$kind ?? '') === 'http-request');
    console.log(`[setup] leaves=${leaves.map((l) => `${l.name}:${l.id}`).join(', ')}`);
    if (leaves.length < 2) { console.log('[abort] need 2 leaves'); return; }

    const leafA = String(leaves[0].id); // /events shape
    const leafB = String(leaves[1].id); // /scripts shape
    const eventsScript = ['pm.test("EVENTS_MARKER status ok", function () { pm.response.to.have.status(200); });'];
    const scriptsScript = ['pm.test("SCRIPTS_MARKER status ok", function () { pm.response.to.have.status(200); });'];

    console.log('\n== inject leaf A via /events (v2 shape) ==');
    const ra = await gw.request({ service: 'collection', method: 'patch', path: `/v3/collections/${cid}/items/${leafA}`, headers: { 'X-Entity-Type': 'http-request' }, body: [{ op: 'add', path: '/events', value: [{ listen: 'test', script: { exec: eventsScript, type: 'text/javascript' } }] }] }).catch((e) => e);
    console.log(`  /events PATCH -> ${ra?.status ?? ra?.message ?? ra}`);

    console.log('== inject leaf B via /scripts (v3 afterResponse shape) ==');
    const rb = await gw.request({ service: 'collection', method: 'patch', path: `/v3/collections/${cid}/items/${leafB}`, headers: { 'X-Entity-Type': 'http-request' }, body: [{ op: 'add', path: '/scripts', value: [{ type: 'afterResponse', code: scriptsScript.join('\n'), language: 'text/javascript' }] }] }).catch((e) => e);
    console.log(`  /scripts PATCH -> ${rb?.status ?? rb?.message ?? rb}`);

    // Readback: v3 per-item GET
    for (const [label, id] of [['A(/events)', leafA], ['B(/scripts)', leafB]] as const) {
      const full = (await gw.requestJson<J>({ service: 'collection', method: 'get', path: `/v3/collections/${cid}/items/${id}`, headers: { 'X-Entity-Type': 'http-request' } }))?.data as J ?? {};
      console.log(`  [v3 GET ${label}] events=${JSON.stringify(full.events ?? null)} scripts=${JSON.stringify(full.scripts ?? null)}`);
    }
    // Readback: public v2 GET (the run representation)
    const pub = await (await fetch(`${API}/collections/${uid}`, { headers: { 'X-Api-Key': apiKey } })).json().catch(() => ({})) as J;
    const walk = (nodes: unknown, out: J[] = []): J[] => { if (Array.isArray(nodes)) for (const n of nodes as J[]) { if (Array.isArray(n.item)) walk(n.item, out); else out.push(n); } return out; };
    const v2leaves = walk((pub.collection as J)?.item);
    for (const l of v2leaves) {
      const ev = Array.isArray(l.event) ? (l.event as J[]) : [];
      const testExec = ev.filter((e) => e.listen === 'test').map((e) => JSON.stringify((e.script as J)?.exec ?? '')).join('|');
      console.log(`  [v2 GET leaf '${l.name}'] event.test=${testExec || '<none>'}`);
    }

    // EXECUTE: run the collection via Postman CLI (PMAK login) and capture which markers ran.
    console.log('\n== EXECUTE: postman collection run ==');
    let runOut = '';
    try {
      runOut = execFileSync('postman', ['collection', 'run', uid, '--postman-api-key', apiKey, '-x'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      runOut = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`;
    }
    const ranEvents = /EVENTS_MARKER/.test(runOut);
    const ranScripts = /SCRIPTS_MARKER/.test(runOut);
    // Print the run summary lines for evidence (mask any token echoes).
    const lines = runOut.split('\n').filter((l) => /MARKER|assertion|test|✓|✗|passed|failed|GET |200|executed/i.test(l)).map((l) => l.replace(/PMAK-[A-Za-z0-9-]+/g, 'PMAK-***')).slice(0, 40);
    console.log(lines.join('\n'));
    console.log(`\n[VERDICT] EVENTS_MARKER executed=${ranEvents} | SCRIPTS_MARKER executed=${ranScripts}`);
  } finally {
    for (const id of createdWorkspaces) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
