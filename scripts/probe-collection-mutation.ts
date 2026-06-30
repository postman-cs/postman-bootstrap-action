/**
 * Focused probe: collection mutation routes the reference app actually uses.
 *
 * Refutes the claim "gateway has NO route for injectTests or tagCollection"
 * (v3 items GET -> 404, all tag PUTs -> 400). That claim probed the WRONG
 * routes: `collection GET /v3/collections/:uid/items` (full uid, no trailing
 * slash) and `collection PUT /collections/:uid/tags` (wrong service). The
 * reference-app routes are:
 *
 *   - collection GET   /v3/collections/:cid/items/          (bare model id, trailing slash)
 *   - collection PATCH /v3/collections/:cid/items/:itemId   (JSON-patch; injectTests)
 *   - tagging   PUT    /v1/tags/collections/:id             (dedicated tagging service)
 *
 * Verified LIVE (disposable non-org sandbox team 10490519, 2026-06-30):
 *   [200] GET  /v3/collections/<bareModelId>/items/                    -> {data:[{$kind:'http-request',...}]}
 *   [200] PUT  tagging /v1/tags/collections/<fullUid>  body {tags:[{slug}]}  -> {tags:[{slug,label,type:'default',...}]}
 *   [200] PATCH collection /v3/collections/<bareModelId>/items/<itemId>
 *          body [{op:'add', path:'/events', value:[{listen:'test',script:{exec:[...],type:'text/javascript'}}]}]
 *          -> {data:{...,events:[{listen:'test',script:{exec:[...]}}]}}   (test script injected)
 *   [201] POST collection /v3/collections/<bareModelId>/items/
 *          body {$kind:'http-request', name, method, url, position:{parent:{id:<bareModelId>,$kind:'collection'}}}
 *          -> {data:{id, createdAt, createdBy}}   (server assigns id; re-list + GET-by-id confirm)
 *   [200] PUT  specification /specifications/<specId>/collections  body [{collectionId:<fullUid>}]
 *          -> {data:{updated:[{collectionId, state:'out-of-sync'}]}}   (link relationship recorded)
 *   [202] POST specification /specifications/<specId>/collections/<fullUid>/sync  -> {data:{taskId}}
 *          poll tasks?entityType=collection&type=collection-sync -> completed;
 *          GET /specifications/<specId>/collections -> state flips to 'in-sync'  (regenerate lives for OAS)
 *
 *   Contrast (the shapes the "no route" claim probed):
 *   [404] GET  /v3/collections/<fullUid>/items        (no trailing slash + full uid)
 *   [400] PUT  collection /collections/<fullUid>/tags (wrong service -> invalidPathError)
 *
 * injectTests gotcha: OpenAPI-spec-gen collections are v2-HTTP exposed through
 * the v3 cloud surface, so they keep the v2 `events` test-event shape
 * (`[{listen:'test',script:{exec:[...],type:'text/javascript'}}]`), NOT the EC
 * `scripts.test` shape. Patching `/scripts/test` -> REJECTED_PATCH; `/scripts`
 * replace -> SCHEMA_ENFORCED; `/events` add -> 200.
 *
 * Drive against the disposable non-org sandbox:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/probe-collection-mutation.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 320).replace(/\s+/g, ' ');
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
  const workspaceName = `mut-probe-${stamp}`;
  const createdWorkspaces = new Set<string>();

  try {
    // --- setup: workspace + spec + spec-generated collection ---
    const wsCreate = await gw(client, 'create workspace (personal)', {
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: workspaceName, visibilityStatus: 'personal' }
    });
    const workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (workspaceId) createdWorkspaces.add(workspaceId);
    if (!workspaceId) { console.log('[abort] no workspace'); return; }
    console.log(`[setup] workspace ${workspaceId}`);

    const specContent = [
      'openapi: 3.0.3',
      'info:', '  title: Mut Probe API', '  version: 1.0.0',
      'paths:', '  /ping:', '    get:',
      '      summary: Ping', '      operationId: ping',
      '      responses:', "        '200':", '          description: OK'
    ].join('\n');
    const specCreate = await gw(client, 'create spec', {
      service: 'specification', method: 'post',
      path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
      body: { name: 'Mut Probe API', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }] }
    });
    const specId = String((specCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!specId) { console.log('[abort] no spec'); return; }
    console.log(`[setup] spec ${specId}`);

    const gen = await gw(client, 'generate collection', {
      service: 'specification', method: 'post', path: `/specifications/${specId}/collections`,
      body: { name: 'Mut Probe Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } }
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
      if (status && status !== 'in-progress') { console.log(`  [task] ${snippet(data)}`); break; }
    }
    const specCols = await client.requestJson<JsonRecord>({
      service: 'specification', method: 'get', path: `/specifications/${specId}/collections`
    });
    const colData = Array.isArray(specCols?.data) ? (specCols.data as JsonRecord[]) : [];
    const collectionUid = String(
      colData[0]?.collection ?? colData[0]?.id ?? colData[0]?.collectionId ?? colData[0]?.uid ?? ''
    ).trim();
    console.log(`[setup] collection uid ${collectionUid || '<none>'}`);
    if (!collectionUid) { console.log('[abort] no collection'); return; }

    const modelId = bareModelId(collectionUid);
    console.log(`[setup] bare model id ${modelId}`);

    // --- THE PROBE: corrected routes ---
    console.log('\n== corrected route 1: v3 items GET (bare model id, trailing slash) ==');
    const items = await gw(client, 'v3 items GET (trailing slash, bare id)', {
      service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/`
    });
    // Contrast: the failing shape the other agent used (full uid, no trailing slash).
    await gw(client, 'v3 items GET (WRONG: full uid, no slash) [contrast]', {
      service: 'collection', method: 'get', path: `/v3/collections/${collectionUid}/items`
    });

    // Recover an item id + $kind for the injectTests PATCH.
    const itemsArr = Array.isArray((items as JsonRecord | null)?.data)
      ? ((items as JsonRecord).data as JsonRecord[])
      : [];
    const firstItem = itemsArr[0] ?? {};
    const itemId = String(firstItem.id ?? '').trim();
    const itemKind = String(firstItem.$kind ?? firstItem.type ?? 'http-request').trim();
    console.log(`  [first item] id=${itemId} kind=${itemKind} (count=${itemsArr.length})`);

    console.log('\n== corrected route 2: tagging PUT (tagging service) ==');
    // Reference test (UniversalTaggingService.test.js:79) asserts body { tags:[{slug}] } — NO type field.
    await gw(client, 'tagging PUT /v1/tags/collections/:uid (full uid, {tags:[{slug}]})', {
      service: 'tagging', method: 'put', path: `/v1/tags/collections/${collectionUid}`,
      body: { tags: [{ slug: 'generated-mut-probe' }] }
    });
    // Contrast: the failing shape the other agent used (collection service).
    await gw(client, 'tag PUT (WRONG: collection svc) [contrast]', {
      service: 'collection', method: 'put', path: `/collections/${collectionUid}/tags`,
      body: { tags: [{ slug: 'generated-mut-probe' }] }
    });

    console.log('\n== corrected route 3: v3 item PATCH (injectTests, JSON-patch) ==');
    if (itemId) {
      // Print the FULL item shape so the patch path is grounded in the real wire body.
      const fullItem = await client.requestJson<JsonRecord>({
        service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/${itemId}`,
        headers: { 'X-Entity-Type': itemKind }
      });
      console.log(`  [full item] ${JSON.stringify(fullItem?.data ?? fullItem).slice(0, 1200)}`);
      const itemData = (fullItem?.data as JsonRecord | undefined) ?? {};
      const hasScripts = Object.prototype.hasOwnProperty.call(itemData, 'scripts');
      const hasEvents = Object.prototype.hasOwnProperty.call(itemData, 'events');
      console.log(`  [item fields] hasScripts=${hasScripts} hasEvents=${hasEvents} keys=${Object.keys(itemData).join(',')}`);

      const testExec = ['pm.test("200 OK", function () { pm.response.to.have.status(200); });'];
      // Variant A: add /scripts/test (v3 IR scripts shape).
      await gw(client, 'v3 item PATCH /scripts/test (add)', {
        service: 'collection', method: 'patch', path: `/v3/collections/${modelId}/items/${itemId}`,
        headers: { 'X-Entity-Type': itemKind },
        body: [{ op: 'add', path: '/scripts/test', value: { exec: testExec } }]
      });
      // Variant B: replace whole /scripts.
      await gw(client, 'v3 item PATCH /scripts (replace)', {
        service: 'collection', method: 'patch', path: `/v3/collections/${modelId}/items/${itemId}`,
        headers: { 'X-Entity-Type': itemKind },
        body: [{ op: 'replace', path: '/scripts', value: { test: { exec: testExec } } }]
      });
      // Variant C: v2-style events array.
      await gw(client, 'v3 item PATCH /events (add, v2-style)', {
        service: 'collection', method: 'patch', path: `/v3/collections/${modelId}/items/${itemId}`,
        headers: { 'X-Entity-Type': itemKind },
        body: [{ op: 'add', path: '/events', value: [{ listen: 'test', script: { exec: testExec, type: 'text/javascript' } }] }]
      });
      // Re-read the item to see which (if any) landed.
      const after = await client.requestJson<JsonRecord>({
        service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/${itemId}`,
        headers: { 'X-Entity-Type': itemKind }
      });
      console.log(`  [item after patches] ${JSON.stringify(after?.data ?? after).slice(0, 1200)}`);
    } else {
      console.log('  [skip] no item id recovered; cannot probe injectTests PATCH');
    }

    console.log('\n== corrected route 4: v3 item CREATE (POST /v3/collections/:cid/items/) ==');
    // Reference: cloud-service.ts:529-554 (createItem); V3ItemCreateInput = Item +
    // position.parent{id,$kind} (types.ts:402-404). Real caller createCollectionFromRecords.ts:21-39
    // sends {$kind:'http-request', name, method, url, headers?, position.parent.id=collectionId,
    // $kind:'collection'}. The service strips the client `id` (server assigns); parent id is the
    // BARE model id (same as the path :cid). Trailing slash required on the path.
    const created = await gw(client, 'v3 item CREATE (http-request at root)', {
      service: 'collection', method: 'post', path: `/v3/collections/${modelId}/items/`,
      body: {
        $kind: 'http-request',
        name: 'Probe Created Request',
        method: 'GET',
        url: '{{baseUrl}}/probe-created',
        position: { parent: { id: modelId, $kind: 'collection' } }
      }
    });
    const newItemId = String(((created?.data as JsonRecord | undefined)?.id) ?? '').trim();
    console.log(`  [created item id] ${newItemId}`);
    if (newItemId) {
      // Re-list items to confirm the new item is present server-side.
      const relist = await client.requestJson<JsonRecord>({
        service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/`
      });
      const arr = Array.isArray(relist?.data) ? (relist.data as JsonRecord[]) : [];
      console.log(`  [items after create] count=${arr.length} :: ${JSON.stringify(arr.map((x) => ({ id: x.id, name: x.name, $kind: x.$kind }))).slice(0, 400)}`);
      // And confirm we can GET the new item by id (X-Entity-Type header).
      await gw(client, 'v3 created item GET (confirm)', {
        service: 'collection', method: 'get', path: `/v3/collections/${modelId}/items/${newItemId}`,
        headers: { 'X-Entity-Type': 'http-request' }
      });
    }

    console.log('\n== corrected route 5: spec->collection SYNC / regenerate (linked-spec relationship) ==');
    // Refutes "the cloud Spec Hub 'linked spec / regenerate' relationship dies for the OAS path."
    // OAS-generated collections are v2 HTTP (isV2HttpInV3Workbench), canSyncCollection:true, and the
    // linked-spec relationship is alive. The spec service link + sync routes (SpecificationService.ts:284,306)
    // take ids as-is (no bare/uid transform). Probe the regenerate (sync) route on the generated collection.
    if (specId && collectionUid) {
      const linkPut = await gw(client, 'spec PUT link collections (idempotent)', {
        service: 'specification', method: 'put', path: `/specifications/${specId}/collections`,
        body: [{ collectionId: collectionUid }]
      });
      console.log(`  [link PUT] ${snippet(linkPut)}`);
      const sync = await gw(client, 'spec->collection sync (regenerate)', {
        service: 'specification', method: 'post', path: `/specifications/${specId}/collections/${collectionUid}/sync`
      });
      const syncTaskId = String(((sync?.data as JsonRecord | undefined)?.taskId) ?? '').trim();
      console.log(`  [sync taskId] ${syncTaskId}`);
      for (let i = 0; i < 20 && syncTaskId; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const t = await client.requestJson<JsonRecord>({
          service: 'specification', method: 'get', path: '/tasks',
          query: { entityId: collectionUid, entityType: 'collection', type: 'collection-sync' }
        });
        const data = (t?.data as JsonRecord | undefined) ?? {};
        const status = String(data[syncTaskId] ?? '');
        if (i === 0 || (status && status !== 'in-progress')) console.log(`  [sync task] ${snippet(data)}`);
        if (status && status !== 'in-progress') break;
      }
      // Re-list the spec's linked collections to confirm the relationship is recorded.
      await gw(client, 'spec linked collections list', {
        service: 'specification', method: 'get', path: `/specifications/${specId}/collections`
      });
    }
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
