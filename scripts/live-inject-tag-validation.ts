/**
 * Live validation: bootstrap injectTests + tagCollection over the GATEWAY only
 * (access token; PMAK used solely to mint that token). Drives the real
 * PostmanGatewayAssetsClient methods (not raw routes) against a spec-generated
 * collection, then reads back events via per-item GET (the list route omits
 * them) and tags via the tagging service.
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/live-inject-tag-validation.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type JsonRecord = Record<string, unknown>;

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
  const gw = new AccessTokenGatewayClient({ tokenProvider: provider });
  const assets = new PostmanGatewayAssetsClient({ gateway: gw });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const createdWorkspaces = new Set<string>();
  let pass = true;

  try {
    const wsCreate = await gw.requestJson<JsonRecord>({
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: `inject-tag-${stamp}`, visibilityStatus: 'personal' }
    });
    const workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!workspaceId) { console.log('[abort] no workspace'); return; }
    createdWorkspaces.add(workspaceId);
    console.log(`[setup] workspace ${workspaceId}`);

    const specContent = [
      'openapi: 3.0.3',
      'info:', '  title: Inject Tag API', '  version: 1.0.0',
      'paths:',
      '  /ping:', '    get:', '      summary: Ping', '      operationId: ping',
      '      responses:', "        '200':", '          description: OK',
      '  /pong:', '    get:', '      summary: Pong', '      operationId: pong',
      '      responses:', "        '200':", '          description: OK'
    ].join('\n');
    const specCreate = await gw.requestJson<JsonRecord>({
      service: 'specification', method: 'post',
      path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
      body: { name: 'Inject Tag API', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }] }
    });
    const specId = String((specCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!specId) { console.log('[abort] no spec'); return; }
    console.log(`[setup] spec ${specId}`);

    const gen = await gw.requestJson<JsonRecord>({
      service: 'specification', method: 'post', path: `/specifications/${specId}/collections`,
      body: { name: 'Inject Tag Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } }
    });
    const taskId = String((gen?.data as JsonRecord | undefined)?.taskId ?? '').trim();
    for (let i = 0; i < 30 && taskId; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const t = await gw.requestJson<JsonRecord>({
        service: 'specification', method: 'get', path: '/tasks',
        query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
      });
      const status = String(((t?.data as JsonRecord | undefined) ?? {})[taskId] ?? '');
      if (status && status !== 'in-progress') break;
    }
    const specCols = await gw.requestJson<JsonRecord>({
      service: 'specification', method: 'get', path: `/specifications/${specId}/collections`
    });
    const colData = Array.isArray(specCols?.data) ? (specCols.data as JsonRecord[]) : [];
    const collectionUid = String(colData[0]?.collection ?? colData[0]?.id ?? '').trim();
    if (!collectionUid) { console.log('[abort] no collection'); return; }
    const modelId = bareModelId(collectionUid);
    console.log(`[setup] collection uid=${collectionUid} model=${modelId}`);

    // --- exercise the real client methods (gateway only) ---
    console.log('\n== injectTests(smoke) ==');
    await assets.injectTests(collectionUid, 'smoke');
    console.log('== tagCollection([generated-smoke]) ==');
    await assets.tagCollection(collectionUid, ['generated-smoke']);

    // --- readback: the v3 surface persists item test scripts under `scripts`
    // (afterResponse), surfaced by the per-item GET (`data.scripts`). ---
    const listed = await gw.requestJson<JsonRecord>({
      service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/`
    });
    const items = Array.isArray(listed?.data) ? (listed!.data as JsonRecord[]) : [];
    console.log(`\n[readback] item count=${items.length} :: ${JSON.stringify(items.map((x) => ({ name: x.name, kind: x.$kind }))).slice(0, 300)}`);

    let leavesWithTest = 0;
    let leaves = 0;
    let resolveSecretsPresent = false;
    let resolveSecretsHasEvent = false;
    for (const item of items) {
      if (String(item.$kind ?? '') !== 'http-request') continue;
      const itemId = String(item.id ?? '').trim();
      const full = await gw.requestJson<JsonRecord>({
        service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/${itemId}`,
        headers: { 'X-Entity-Type': 'http-request' }
      });
      const data = (full?.data as JsonRecord | undefined) ?? {};
      const scripts = Array.isArray(data.scripts) ? (data.scripts as JsonRecord[]) : [];
      const hasTest = scripts.some((s) => String(s.type ?? '') === 'afterResponse' && String(s.code ?? '').length > 0);
      if (String(item.name ?? '') === '00 - Resolve Secrets') {
        resolveSecretsPresent = true;
        resolveSecretsHasEvent = hasTest;
        console.log(`  [resolve-secrets] scripts=${scripts.length} hasTest=${hasTest}`);
        continue;
      }
      leaves += 1;
      if (hasTest) leavesWithTest += 1;
      console.log(`  [leaf '${String(item.name)}'] scripts=${scripts.length} hasTest=${hasTest}`);
    }

    const tags = await gw.requestJson<JsonRecord>({
      service: 'tagging', method: 'get', path: `/v1/tags/collections/${collectionUid}`
    }).catch(() => null);
    const tagSlugs = Array.isArray(tags?.data)
      ? (tags!.data as JsonRecord[]).map((t) => String(t.slug ?? ''))
      : Array.isArray((tags as JsonRecord | null)?.tags)
        ? ((tags as JsonRecord).tags as JsonRecord[]).map((t) => String(t.slug ?? ''))
        : [];
    console.log(`\n[readback] tags=${JSON.stringify(tagSlugs)}`);

    // --- assertions ---
    console.log('\n== ASSERTIONS ==');
    const check = (label: string, ok: boolean): void => {
      console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`);
      if (!ok) pass = false;
    };
    check(`all ${leaves} leaf requests carry a test event`, leaves > 0 && leavesWithTest === leaves);
    check('resolve-secrets item created', resolveSecretsPresent);
    check('resolve-secrets carries its test event', resolveSecretsHasEvent);
    check('generated-smoke tag applied', tagSlugs.includes('generated-smoke'));

    // idempotency: a second injectTests must not duplicate the resolve-secrets item
    await assets.injectTests(collectionUid, 'smoke');
    const relisted = await gw.requestJson<JsonRecord>({
      service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/`
    });
    const relistedItems = Array.isArray(relisted?.data) ? (relisted!.data as JsonRecord[]) : [];
    const resolveCount = relistedItems.filter((x) => String(x.name ?? '') === '00 - Resolve Secrets').length;
    check('injectTests is idempotent (single resolve-secrets item)', resolveCount === 1);
  } finally {
    for (const id of createdWorkspaces) {
      const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } });
      console.log(`\n[teardown] DELETE /workspaces/${id} -> ${r.status}`);
    }
  }

  console.log(`\n[result] ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
