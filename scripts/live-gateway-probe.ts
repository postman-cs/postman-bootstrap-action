/**
 * Live gateway route probe (access-token migration Phase 1).
 *
 * Drives every migratable asset route through AccessTokenGatewayClient against a
 * throwaway sandbox workspace and prints the request + response shape for each,
 * so the gateway-assets client (Phase 2) can be written against verified wire
 * contracts. Any route that fails here stays PMAK-fallback-only and is flagged,
 * not forced (per the migration plan and the facade no-regression contract).
 *
 * Read/write against a disposable team: it creates one workspace + spec +
 * collection and deletes them in a finally block (run-scoped teardown). Drive it
 * with the non-org sandbox key (mints its own access token from the PMAK):
 *
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     node --experimental-strip-types scripts/live-gateway-probe.ts
 *
 * Without a key it exits 0 with a skip notice so it is safe to invoke
 * unconditionally.
 *
 * Verified findings (sandbox team 10490519) — drive the Phase 2 client + facade:
 *   MIGRATE (gateway, observed 200/201/202):
 *     workspaces GET /workspaces/:id, GET /workspaces, GET /workspaces/:id/filesystem
 *     specification POST /specifications?containerType=workspace&containerId=:ws
 *       body { name, type:'OPENAPI:3.0', files:[{ path, content, type:'ROOT' }] }  (file type:'ROOT' required)
 *     specification GET /specifications/:id, GET /specifications/:id/files,
 *       POST /specifications/:id/collections -> 202 {data:{taskId}},
 *       GET /tasks?entityId=&entityType=specification&type=collection-generation -> {data:{<taskId>:status}},
 *       GET /specifications/:id/collections -> {data:[{collection:<uid>,state}]}
 *   STAY PMAK (gateway rejected; facade falls back, flagged):
 *     workspaces POST /workspaces (roles), PUT /workspaces/:id (path not allowed),
 *     specification PATCH /specifications/:id/files/:fileId (payload shape),
 *     collection /v3/collections/:uid/items + /collections/:uid + /collections/:uid/tags
 *       (404/invalidPath — spec-generated uids are not served by the gateway collection svc),
 *     so injectTests / tagCollection / collection CRUD remain PMAK.
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 240).replace(/\s+/g, ' ');
}

/** Run one gateway route through the client; print status + response snippet. */
async function gw(
  client: AccessTokenGatewayClient,
  label: string,
  request: Parameters<AccessTokenGatewayClient['request']>[0]
): Promise<JsonRecord | null> {
  const query = request.query ? `?${new URLSearchParams(request.query as Record<string, string>).toString()}` : '';
  try {
    const response = await client.request(request);
    const body = await response.text().catch(() => '');
    console.log(`  [${response.status}] ${label} (${request.service} ${request.method} ${request.path}${query}) :: ${snippet(body)}`);
    try {
      return body.trim() ? (JSON.parse(body) as JsonRecord) : null;
    } catch {
      return null;
    }
  } catch (error) {
    console.log(`  [ERR] ${label} (${request.service} ${request.method} ${request.path}) :: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping gateway probe.');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  console.log('[setup] minted access token');

  // Non-org sandbox: bifrost infers the team from the token (no x-entity-team-id).
  const client = new AccessTokenGatewayClient({ tokenProvider: provider });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceName = `gateway-probe-${stamp}`;

  let workspaceId = '';
  let specId = '';
  let collectionId = '';
  const createdWorkspaces = new Set<string>();

  try {
    console.log('\n== workspaces service: create-shape discovery ==');
    // PMAK create uses {workspace:{name,about,type}}; the gateway rejected that
    // ("must have name + visibilityStatus, no additional properties"). Probe the
    // flat app-internal shape candidates.
    for (const [label, body] of [
      ['flat {name,visibilityStatus:team}', { name: `${workspaceName}-a`, visibilityStatus: 'team' }],
      ['flat {name,about,visibilityStatus:team}', { name: `${workspaceName}-b`, about: 'probe', visibilityStatus: 'team' }],
      ['flat {name,type:team,visibilityStatus:team}', { name: `${workspaceName}-c`, type: 'team', visibilityStatus: 'team' }]
    ] as Array<[string, JsonRecord]>) {
      const r = await gw(client, `create workspace ${label}`, {
        service: 'workspaces', method: 'post', path: '/workspaces', body
      });
      const id = String((r?.workspace as JsonRecord | undefined)?.id ?? r?.id ?? '').trim();
      if (id) {
        createdWorkspaces.add(id);
        if (!workspaceId) {
          workspaceId = id;
          console.log(`[setup] gateway-created workspace ${workspaceId} via ${label}`);
        }
      }
    }

    // Fall back to PMAK create so downstream spec/collection probes have a workspace.
    if (!workspaceId) {
      const r = await fetch(`${API}/workspaces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ workspace: { name: workspaceName, about: 'gateway probe (disposable)', type: 'team' } })
      });
      const j = (await r.json()) as JsonRecord;
      workspaceId = String((j.workspace as JsonRecord | undefined)?.id ?? '').trim();
      if (workspaceId) createdWorkspaces.add(workspaceId);
      console.log(`[setup] PMAK-created workspace ${workspaceId || '<none>'} (status ${r.status})`);
    }
    if (!workspaceId) {
      console.log('[abort] no workspace id; downstream probes skipped.');
      return;
    }

    console.log('\n== workspaces service: read/update ==');
    await gw(client, 'get workspace', { service: 'workspaces', method: 'get', path: `/workspaces/${workspaceId}` });
    await gw(client, 'list workspaces', { service: 'workspaces', method: 'get', path: '/workspaces' });
    await gw(client, 'workspace visibility PUT (flat)', {
      service: 'workspaces',
      method: 'put',
      path: `/workspaces/${workspaceId}`,
      body: { name: workspaceName, visibilityStatus: 'team' }
    });
    await gw(client, 'workspace filesystem (git repo url)', {
      service: 'workspaces',
      method: 'get',
      path: `/workspaces/${workspaceId}/filesystem`
    });

    console.log('\n== specification service ==');
    const specContent = [
      'openapi: 3.0.3',
      'info:',
      '  title: Gateway Probe API',
      '  version: 1.0.0',
      'paths:',
      '  /ping:',
      '    get:',
      '      summary: Ping',
      '      operationId: ping',
      '      responses:',
      "        '200':",
      '          description: OK'
    ].join('\n');
    // Probe spec-list (proven route from repo-sync) then spec-create candidates.
    await gw(client, 'spec list (containerType)', {
      service: 'specification',
      method: 'get',
      path: `/specifications?containerType=workspace&containerId=${workspaceId}`
    });
    // Verified: spec-level type 'OPENAPI:3.0' valid; each file needs type:'ROOT'.
    const specCreate = await gw(client, 'spec create (file type ROOT)', {
      service: 'specification',
      method: 'post',
      path: `/specifications?containerType=workspace&containerId=${workspaceId}`,
      body: { name: 'Gateway Probe API', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: specContent, type: 'ROOT' }] }
    });
    specId = String(
      (specCreate?.data as JsonRecord | undefined)?.id ?? specCreate?.id ?? ''
    ).trim();
    if (specId) console.log(`[setup] gateway-created spec ${specId}`);
    // PMAK fallback so downstream spec/collection routes still get probed.
    if (!specId) {
      const r = await fetch(`${API}/specs?workspaceId=${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ name: 'Gateway Probe API', type: 'OPENAPI:3.0', files: [{ path: 'index.yaml', content: specContent }] })
      });
      const j = (await r.json()) as JsonRecord;
      specId = String(j.id ?? '').trim();
      console.log(`[setup] PMAK-created spec ${specId || '<none>'} (status ${r.status})`);
    }
    if (specId) {
      await gw(client, 'spec get', { service: 'specification', method: 'get', path: `/specifications/${specId}` });
      // File PATCH needs the file id, not the filename. List files to learn the shape.
      const files = await gw(client, 'spec files list', {
        service: 'specification', method: 'get', path: `/specifications/${specId}/files`
      });
      const fileList = Array.isArray((files as JsonRecord | null)?.data) ? ((files as JsonRecord).data as JsonRecord[]) : [];
      const fileId = String(fileList[0]?.id ?? fileList[0]?.path ?? 'index.yaml').trim();
      console.log(`  [spec file id] ${fileId}`);
      await gw(client, 'spec file PATCH {content}', {
        service: 'specification', method: 'patch', path: `/specifications/${specId}/files/${fileId}`,
        body: { content: specContent }
      });
      await gw(client, 'spec file PATCH {payload}', {
        service: 'specification', method: 'patch', path: `/specifications/${specId}/files/${fileId}`,
        body: { payload: specContent }
      });
      await gw(client, 'spec file GET content', {
        service: 'specification', method: 'get', path: `/specifications/${specId}/files/${fileId}`
      });
      const gen = await gw(client, 'generate collection', {
        service: 'specification', method: 'post', path: `/specifications/${specId}/collections`,
        body: { name: 'Gateway Probe Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } }
      });
      const taskId = String((gen?.data as JsonRecord | undefined)?.taskId ?? '').trim();
      console.log(`  [generate taskId] ${taskId}`);
      // Poll the task to completion and recover the generated collection id.
      for (let i = 0; i < 30 && taskId; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const t = await client.requestJson<JsonRecord>({
          service: 'specification', method: 'get', path: '/tasks',
          query: { entityId: specId, entityType: 'specification', type: 'collection-generation' }
        });
        const data = (t?.data as JsonRecord | undefined) ?? {};
        const status = String(data[taskId] ?? '');
        if (i === 0 || status !== 'in-progress') console.log(`  [task ${taskId}] ${snippet(data)}`);
        if (status && status !== 'in-progress') break;
      }
      // Recover the generated collection id from the spec's collections list.
      const specCols = await client.requestJson<JsonRecord>({
        service: 'specification', method: 'get', path: `/specifications/${specId}/collections`
      });
      const colData = Array.isArray(specCols?.data) ? (specCols.data as JsonRecord[]) : [];
      console.log(`  [spec collections] ${snippet(specCols)}`);
      collectionId = String(colData[0]?.id ?? colData[0]?.collectionId ?? colData[0]?.uid ?? '').trim();
    }

    console.log('\n== collection v3 service (injectTests target) ==');
    // PMAK-generate a real collection from the spec so the v3-items + tag routes
    // can be probed against a concrete uid.
    if (!collectionId && specId) {
      const r = await fetch(`${API}/specs/${specId}/generations/collection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
        body: JSON.stringify({ name: 'Gateway Probe Collection', options: { requestNameSource: 'Fallback', folderStrategy: 'Tags' } })
      });
      const j = (await r.json().catch(() => ({}))) as JsonRecord;
      console.log(`  [PMAK generate] status ${r.status} :: ${snippet(j)}`);
      collectionId = String(
        ((j.details as JsonRecord | undefined)?.resources as JsonRecord[] | undefined)?.[0]?.id ??
        (j.collection as JsonRecord | undefined)?.id ?? (j.collection as JsonRecord | undefined)?.uid ?? ''
      ).trim();
      if (!collectionId) {
        const cl = await fetch(`${API}/collections?workspace=${workspaceId}`, { headers: { 'X-Api-Key': apiKey } });
        const cj = (await cl.json().catch(() => ({}))) as JsonRecord;
        const cols = Array.isArray(cj.collections) ? cj.collections : [];
        collectionId = String((cols[0] as JsonRecord | undefined)?.uid ?? '').trim();
      }
    }
    console.log(`[setup] collection ${collectionId || '<none>'}`);
    if (collectionId) {
      await gw(client, 'v3 collection items GET', {
        service: 'collection', method: 'get', path: `/v3/collections/${collectionId}/items`
      });
      await gw(client, 'collection get by uid', {
        service: 'collection', method: 'get', path: `/collections/${collectionId}`
      });
      await gw(client, 'collection items GET (no v3)', {
        service: 'collection', method: 'get', path: `/collections/${collectionId}/items`
      });
      await gw(client, 'collection tag PUT (collection svc)', {
        service: 'collection', method: 'put', path: `/collections/${collectionId}/tags`,
        body: { tags: [{ slug: 'gateway-probe' }] }
      });
    }
  } finally {
    console.log('\n[teardown] deleting created assets...');
    for (const id of createdWorkspaces) {
      try {
        const r = await fetch(`${API}/workspaces/${id}`, { method: 'DELETE', headers: { 'X-Api-Key': apiKey } });
        console.log(`  [teardown] DELETE /workspaces/${id} -> ${r.status}`);
      } catch (error) {
        console.log(`  [teardown] workspace ${id} delete failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log('\n[result] gateway probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
