/**
 * Phase 0 probe for the "everything -> EC v3.0" conversion. Read-mostly against a
 * throwaway sandbox workspace; creates and tears down its own assets (run-scoped).
 * Answers four gating questions before any code flips:
 *   (a) Do extensions.events persist on EC item create, readable via the per-item
 *       GET /collections/:id/items/:itemId (the list route omits extensions)?
 *   (b) Is there an EC tags route (PUT /collections/:id/tags via the gateway)?
 *   (c) Does an http-request EC item create accept the documented payload keys?
 *   (d) Will the specification service link + sync a NATIVE EC collection id to an
 *       OpenAPI spec (OAS hardcodes the legacy 'collection' type in the app)?
 *
 * Drive it:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" node <bundled>.cjs
 */
import { PostmanAssetsClient } from '../src/lib/postman/postman-assets-client.js';
import { PostmanExtensibleCollectionClient } from '../src/lib/postman/postman-ec-client.js';
import { createInternalIntegrationAdapter } from '../src/lib/postman/internal-integration-adapter.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const BIFROST = POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl;

const MINIMAL_OAS = `openapi: 3.0.3
info:
  title: EC v3 Phase0 Probe API
  version: 1.0.0
paths:
  /ping:
    get:
      summary: Ping
      operationId: ping
      responses:
        '200':
          description: ok
`;

async function mint(apiKey: string): Promise<string> {
  const r = await fetch('https://api.getpostman.com/service-account-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ apiKey })
  });
  const p = (await r.json()) as Record<string, unknown>;
  const direct = typeof p.access_token === 'string' ? p.access_token : '';
  const sess =
    p.session && typeof p.session === 'object'
      ? (p.session as Record<string, unknown>).token
      : '';
  return (direct || (typeof sess === 'string' ? sess : '')).trim();
}

/** Raw EC gateway envelope (mirrors PostmanExtensibleCollectionClient.proxyRequest). */
async function gw(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; text: string }> {
  const r = await fetch(`${BIFROST}/ws/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-access-token': accessToken },
    body: JSON.stringify({
      service: 'collection',
      method: method.toLowerCase(),
      path,
      ...(body !== undefined ? { body } : {})
    })
  });
  return { status: r.status, text: await r.text().catch(() => '') };
}

function snip(s: string): string {
  return s.slice(0, 300).replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] no POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE');
    return;
  }
  const client = new PostmanAssetsClient({ apiKey });
  const teamId = await client.getAutoDerivedTeamId();
  const accessToken = await mint(apiKey);
  console.log(`[setup] team=${teamId ?? '(none)'} token=${accessToken ? 'minted' : 'MISSING'}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ws = await client.createWorkspace(`ec-v3-phase0-${stamp}`, 'disposable phase0 probe', undefined);
  console.log(`[setup] workspace ${ws.id}`);

  const ec = new PostmanExtensibleCollectionClient({ accessToken, teamId: teamId ?? '', orgMode: false });
  let ecId = '';
  try {
    // (c) http-request EC item create + (a) events persistence.
    ecId = await ec.createExtensibleCollection(ws.id, { name: 'Phase0 EC' });
    console.log(`\n[c] created EC collection ${ecId}`);
    const httpItemId = await ec.createItem(ecId, {
      type: 'http-request',
      title: 'GET ping',
      payload: {
        url: '{{baseUrl}}/ping',
        method: 'GET',
        headers: [{ key: 'Accept', value: 'application/json' }]
      },
      event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }]
    });
    console.log(`[c] http-request item create: OK id=${httpItemId}`);

    // (a) per-item GET should carry extensions.events; the list route omits them.
    const perItem = await gw(accessToken, 'get', `/collections/${ecId}/items/${httpItemId}`);
    const list = await gw(accessToken, 'get', `/collections/${ecId}/items/`);
    const perItemHasEvents = /"events"\s*:/.test(perItem.text);
    const listHasEvents = /"events"\s*:/.test(list.text);
    console.log(`[a] per-item GET [${perItem.status}] events=${perItemHasEvents} :: ${snip(perItem.text)}`);
    console.log(`[a] list GET     [${list.status}] events=${listHasEvents}`);

    // (b) EC tags route probe.
    const tag = await gw(accessToken, 'put', `/collections/${ecId}/tags`, { tags: [{ slug: 'generated-smoke' }] });
    console.log(`\n[b] PUT /collections/:id/tags [${tag.status}] :: ${snip(tag.text)}`);

    // (d) link + sync a NATIVE EC collection id to an OpenAPI spec.
    const specId = await client.uploadSpec(ws.id, 'Phase0 Probe API', MINIMAL_OAS, '3.0');
    console.log(`\n[d] uploaded OAS spec ${specId}`);
    const adapter = createInternalIntegrationAdapter({
      accessToken,
      teamId: teamId ?? '',
      orgMode: false,
      backend: 'bifrost'
    });
    try {
      await adapter.linkCollectionsToSpecification(specId, [{ collectionId: ecId }]);
      console.log('[d] linkCollectionsToSpecification(EC id): OK');
      try {
        await adapter.syncCollection(specId, ecId);
        console.log('[d] syncCollection(EC id): OK -> OAS<->EC link+sync ACCEPTED');
      } catch (e) {
        console.log(`[d] syncCollection(EC id): REJECTED :: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      console.log(`[d] linkCollectionsToSpecification(EC id): REJECTED :: ${e instanceof Error ? e.message : String(e)}`);
    }

    // (d-control) Same token, same spec, but link a NATIVE v2 spec-generated
    // collection. Isolates whether the (d) 403 is EC-type-specific or a general
    // token/permission failure on the linking endpoint.
    try {
      const v2Uid = await client.generateCollection(specId, 'Phase0 Probe API', '[Baseline]', 'Paths', false, 'Fallback');
      console.log(`\n[d-control] generated v2 collection ${v2Uid}`);
      try {
        await adapter.linkCollectionsToSpecification(specId, [{ collectionId: v2Uid }]);
        console.log('[d-control] link(v2 uid): OK -> token CAN link; (d) 403 is EC-specific');
      } catch (e) {
        console.log(`[d-control] link(v2 uid): REJECTED -> token cannot link at all :: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      console.log(`[d-control] generateCollection failed :: ${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    console.log('\n[teardown]');
    if (ecId) await ec.deleteExtensibleCollection(ecId).catch((e) => console.log(`  ec del fail: ${e}`));
    await fetch(`https://api.getpostman.com/workspaces/${ws.id}`, {
      method: 'DELETE',
      headers: { 'X-Api-Key': apiKey }
    }).catch(() => {});
    console.log('  done');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exitCode = 1;
});
