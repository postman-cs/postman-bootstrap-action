/** Probe the gateway spec-file update: PATCH /specifications/:id/files/:fileId.
 * The PMAK path is PATCH /specs/:id/files/index.yaml body {content}. Find the
 * gateway shape (fileId discovery + body) and confirm the new content persists.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/diag-specfile-update.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { HttpError } from '../src/lib/http-error.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type J = Record<string, unknown>;

async function tryPatch(gw: AccessTokenGatewayClient, specId: string, fileId: string, label: string, body: unknown): Promise<void> {
  try {
    const r = await gw.request({ service: 'specification', method: 'patch', path: `/specifications/${specId}/files/${fileId}`, body });
    console.log(`  [${r.status}] PATCH (${label})`);
  } catch (e) {
    console.log(`  [${e instanceof HttpError ? e.status : 0}] PATCH (${label}) :: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip]'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const created = new Set<string>();
  try {
    const ws = await gw.requestJson<J>({ service: 'workspaces', method: 'post', path: '/workspaces', body: { name: `specfile-${stamp}`, visibilityStatus: 'personal' } });
    const workspaceId = String((ws?.data as J)?.id ?? '').trim();
    created.add(workspaceId);
    const v1 = ['openapi: 3.0.3', 'info: { title: SpecFile V1, version: 1.0.0 }', 'paths:', '  /a: { get: { operationId: a, summary: A, responses: { "200": { description: OK } } } }'].join('\n');
    const spec = await gw.requestJson<J>({ service: 'specification', method: 'post', path: `/specifications?containerType=workspace&containerId=${workspaceId}`, body: { name: 'SpecFile', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: v1, type: 'ROOT' }] } });
    const specId = String((spec?.data as J)?.id ?? '').trim();
    console.log(`[setup] specId=${specId}`);
    console.log(`[setup] create echo files=${JSON.stringify((spec?.data as J)?.files)}`);

    // Discover the file id via the files list.
    const files = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/files` }).catch((e) => { console.log(`  [files-list err] ${(e as Error).message.slice(0,120)}`); return null; });
    console.log(`[files] list=${JSON.stringify(files?.data ?? files).slice(0, 400)}`);
    const fileArr = Array.isArray(files?.data) ? (files!.data as J[]) : Array.isArray((files?.data as J)?.files) ? ((files!.data as J).files as J[]) : [];
    const root = fileArr.find((f) => String(f.type ?? '') === 'ROOT') ?? fileArr[0] ?? {};
    const fileId = String(root.id ?? root.fileId ?? root.path ?? 'index.yaml').trim();
    console.log(`[files] rootFileId=${fileId}`);

    const v2 = v1.replace('SpecFile V1', 'SpecFile V2_UPDATED');
    console.log('\n== PATCH jsonpatch /content (uuid fileId) ==');
    await tryPatch(gw, specId, fileId, 'jsonpatch /content', [{ op: 'replace', path: '/content', value: v2 }]);

    // Authoritative persistence checks (200 != persisted): dump the GET-by-id
    // body, and confirm via the PMAK public files read.
    const byId = await gw.requestJson<J>({ service: 'specification', method: 'get', path: `/specifications/${specId}/files/${fileId}` }).catch(() => null);
    console.log(`  [gw GET-by-id keys] ${Object.keys((byId?.data as J) ?? byId ?? {}).join(',')}`);
    console.log(`  [gw GET-by-id raw] ${JSON.stringify(byId?.data ?? byId).slice(0, 220)}`);
    const pub = await (await fetch(`${API}/specs/${specId}/files/index.yaml`, { headers: { 'X-Api-Key': apiKey } })).json().catch(() => ({})) as J;
    console.log(`  [public files GET] content includes V2_UPDATED? ${String(pub.content ?? '').includes('V2_UPDATED')}`);

    // Probe gateway CONTENT-read routes (needed for getSpecContent on no-PMAK runs).
    console.log('\n== gateway content-read probes ==');
    const probes: Array<[string, J]> = [
      ['GET /files/:fileId?fields=content', { service: 'specification', method: 'get', path: `/specifications/${specId}/files/${fileId}`, query: { fields: 'content' } }],
      ['GET /files/:fileId?fields=id,name,content', { service: 'specification', method: 'get', path: `/specifications/${specId}/files/${fileId}`, query: { fields: 'id,name,content' } }]
    ];
    for (const [label, req] of probes) {
      try {
        const r = await gw.requestJson<J>(req as never);
        const s = JSON.stringify(r?.data ?? r);
        console.log(`  [ok] ${label} :: hasV2=${s.includes('V2_UPDATED')} len=${s.length} keys=${Object.keys((r?.data as J) ?? r ?? {}).join(',').slice(0,80)}`);
      } catch (e) {
        console.log(`  [${e instanceof HttpError ? e.status : 0}] ${label}`);
      }
    }
  } finally {
    for (const id of created) { const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } }); console.log(`[teardown] ${id} -> ${r.status}`); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
