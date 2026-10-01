/**
 * Live probe for the new externally-exposed Collection V3 API (Christos's team,
 * "Collection V3 Design Space" workspace). Answers the actual ask — does a plain
 * personal API key plug-and-play against this gateway, no Bifrost access-token
 * minting, no service account — before any actions-suite code changes.
 *
 * This gateway is NOT in base-urls.ts: it is a separate host from the standard
 * prod/beta profiles, not live in production yet, and this script intentionally
 * does not wire it into any shared client. Throwaway, run-scoped, no CI wiring.
 *
 * Only 4 routes exist on the public contract:
 *   POST   /collections            (workspace query param required)
 *   GET    /collections/:id
 *   PATCH  /collections/:id        (application/json-patch+json, RFC 6902 only —
 *                                   there is no full-document replace route)
 *   DELETE /collections/:id
 *
 * Related prior art: scripts/probe-collection-v3-crud.ts probed the INTERNAL
 * /v3/collections/ route (Bifrost access-token gateway, same collection service
 * on the backend) and found live quirks that may well carry over here since this
 * public gateway proxies to that same internal service: EC collections return a
 * bare id vs. v2-HTTP collections return a full owner-prefixed uid, DELETE
 * responds 204 (not 200), and DELETE-on-already-deleted is a 500 (not 404).
 * Don't assume this new gateway normalizes those away — confirm against real
 * STAGE responses rather than trusting the OpenAPI examples verbatim.
 *
 * Drive it:
 *   POSTMAN_API_KEY="<your personal PMAK>" \
 *   COLLECTION_V3_WORKSPACE_ID="<a workspace you can edit>" \
 *   node --experimental-strip-types scripts/v3-public-gateway-probe.ts
 *
 * COLLECTION_V3_HOST defaults to the beta public gateway (the Draft environment's host).
 */

// The Draft environment's gateway (public, Cloudflare, x-api-key auth). The
// collection.postman-{stage,beta}.tech hosts are the collection service's internal
// istio ingress behind it: they want a gateway-minted access token and 401
// "Invalid access token" on any PMAK, so probing them directly can never pass.
const DEFAULT_HOST = 'https://api.getpostman-beta.com';
// The "Collection V3 Design Space" workspace itself — already accessible to
// whoever holds the key this script is run with, per x-postman-api-design-workspace.
const DEFAULT_WORKSPACE_ID = '2d3c021f-b574-4f6e-ae5c-8a7806032c34';

function snip(s: string): string {
  return s.slice(0, 300).replace(/\s+/g, ' ');
}

async function call(
  apiKey: string,
  host: string,
  method: string,
  path: string,
  contentType?: string,
  body?: unknown
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  // The gateway picks V3 by this Accept header; without it /collections lands on the legacy
  // Postman API (400 paramMissingError "collection"). Spec claims it's equivalent to
  // application/json, which is not true at the gateway.
  const headers: Record<string, string> = {
    'x-api-key': apiKey,
    Accept: 'application/vnd.collections.v3+json'
  };
  if (contentType) headers['Content-Type'] = contentType;
  const r = await fetch(`${host}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const text = await r.text().catch(() => '');
  let json: Record<string, unknown> | null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: r.status, text, json };
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || '';
  if (!apiKey) {
    console.log('[skip] no POSTMAN_API_KEY (use your own personal key — no service account needed)');
    return;
  }
  const hostRoot = (process.env.COLLECTION_V3_HOST || DEFAULT_HOST).replace(/\/+$/, '');
  // Live routing (2026-09-30): the contract's unprefixed /collections is unregistered on both
  // hosts. /v3/collections answers but only allows HEAD, GET (POST is 405), and
  // /v3/collections/:id allows GET, PATCH, DELETE with 401 "Invalid access token" when unauthed.
  // That looks like the internal collection service, not the public contract, so create won't
  // work under /v3. Set COLLECTION_V3_PATH_PREFIX=/v3 only to exercise the item routes.
  const pathPrefix = (process.env.COLLECTION_V3_PATH_PREFIX ?? '').replace(/\/+$/, '');
  const host = `${hostRoot}${pathPrefix}`;
  // Diagnostic escape hatch: send create with NO workspace query param at all, to tell
  // apart "route isn't deployed here" (still a flat GENERIC_ERROR 404) from "route exists
  // but rejects the missing/invalid workspace" (spec says this should be a proper 400
  // application/problem+json with detail: missing parameter 'workspace' in query string).
  const omitWorkspace = process.env.COLLECTION_V3_OMIT_WORKSPACE === '1';
  const workspaceId = process.env.COLLECTION_V3_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;
  console.log(
    `[setup] host=${host} workspace=${omitWorkspace ? '(omitted)' : workspaceId} key=${apiKey ? 'present' : 'MISSING'}`
  );

  const results: Record<string, boolean> = {};

  // (1) Create — proves plain x-api-key auth is even accepted by this gateway.
  const stamp = new Date().toISOString();
  const createPath = omitWorkspace ? '/collections' : `/collections?workspace=${workspaceId}`;
  const created = await call(apiKey, host, 'POST', createPath, 'application/json', {
    name: `v3-public-gateway-probe ${stamp}`,
    description: 'throwaway — created by v3-public-gateway-probe.ts, safe to delete',
    variables: [{ key: 'probe', value: 'true', secret: false }]
  });
  console.log(`\n[create] status=${created.status} body=${snip(created.text)}`);
  results.authAccepted = created.status !== 401;
  results.create = created.status === 201;
  const collectionId = String(created.json?.data && (created.json.data as Record<string, unknown>).id || '');
  if (!collectionId) {
    console.log('[abort] no collection id returned — cannot continue to read/patch/delete');
    printSummary(results);
    return;
  }
  console.log(`[create] collectionId=${collectionId}`);

  try {
    // (2) Read
    const got = await call(apiKey, host, 'GET', `/collections/${collectionId}`);
    console.log(`\n[read] status=${got.status} body=${snip(got.text)}`);
    results.read = got.status === 200;

    // (3) Patch — the only update mechanism this API offers (RFC 6902).
    const patched = await call(
      apiKey,
      host,
      'PATCH',
      `/collections/${collectionId}`,
      'application/json-patch+json',
      [{ op: 'replace', path: '/description', value: 'patched by v3-public-gateway-probe.ts' }]
    );
    console.log(`\n[patch] status=${patched.status} body=${snip(patched.text)}`);
    results.patch = patched.status === 200;

    // (4) Confirm the patch actually persisted.
    const gotAfterPatch = await call(apiKey, host, 'GET', `/collections/${collectionId}`);
    const persistedDescription =
      gotAfterPatch.json?.data &&
      (gotAfterPatch.json.data as Record<string, unknown>).description === 'patched by v3-public-gateway-probe.ts';
    console.log(`\n[verify-patch] status=${gotAfterPatch.status} persisted=${persistedDescription}`);
    results.patchPersisted = Boolean(persistedDescription);
  } finally {
    // (5) Delete — always attempt teardown even if an earlier step failed.
    const deleted = await call(apiKey, host, 'DELETE', `/collections/${collectionId}`);
    console.log(`\n[delete] status=${deleted.status} body=${snip(deleted.text)}`);
    results.delete = deleted.status === 200 || deleted.status === 204;

    const gotAfterDelete = await call(apiKey, host, 'GET', `/collections/${collectionId}`);
    console.log(`[verify-delete] status=${gotAfterDelete.status} (expect 404)`);
    results.deleteConfirmed = gotAfterDelete.status === 404;
  }

  printSummary(results);
}

function printSummary(results: Record<string, boolean>): void {
  console.log('\n=== SUMMARY ===');
  for (const [key, ok] of Object.entries(results)) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${key}`);
  }
  console.log(
    '\nNote: this API has no full-document replace — only RFC 6902 PATCH. ' +
      'bootstrap-action\'s deepUpdateV2Collection (whole-collection PUT via the internal ' +
      'sync service) has no equivalent here yet. Auth + basic CRUD plug-and-play with a ' +
      'plain personal key is what this script actually answers.'
  );
}

main().catch((error) => {
  console.error('[error]', error);
  process.exitCode = 1;
});
