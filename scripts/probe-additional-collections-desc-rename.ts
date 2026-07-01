/**
 * Probe: description field + multi-level folder nesting (folder>folder>leaf) +
 * collection rename, for the additional-collections v3 port.
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 700).replace(/\s+/g, ' ');
}

function bareModelId(uid: string): string {
  const u = String(uid ?? '').trim();
  return u.includes('-') ? u.slice(u.indexOf('-') + 1) : u;
}

async function gw(
  client: AccessTokenGatewayClient,
  label: string,
  request: Parameters<AccessTokenGatewayClient['request']>[0]
): Promise<JsonRecord | null> {
  try {
    const response = await client.request(request);
    const body = await response.text().catch(() => '');
    console.log(`  [${response.status}] ${label} :: ${snippet(body)}`);
    try {
      return body.trim() ? (JSON.parse(body) as JsonRecord) : null;
    } catch {
      return null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  [ERR] ${label} :: ${snippet(msg)}`);
    return null;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no key'); return; }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const client = new AccessTokenGatewayClient({ tokenProvider: provider });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let workspaceId = '';
  let cid = '';

  try {
    const wsCreate = await gw(client, 'create workspace', {
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: `desc-nest-probe-${stamp}`, visibilityStatus: 'personal' }
    });
    workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!workspaceId) return;

    console.log('\n== create v2-HTTP collection with description ==');
    const created = await gw(client, 'POST /v3/collections/', {
      service: 'collection', method: 'post', path: `/v3/collections/?workspace=${workspaceId}`,
      headers: { 'X-Entity-Target': 'http' },
      body: { name: 'Desc Nest Probe', description: 'top-level description' }
    });
    const rawId = String(((created?.data as JsonRecord | undefined)?.id) ?? '').trim();
    if (!rawId) return;
    cid = bareModelId(rawId);

    console.log('\n== GET collection root, check description persisted ==');
    await gw(client, 'GET /v3/collections/:id', {
      service: 'collection', method: 'get', path: `/v3/collections/${cid}`
    });

    console.log('\n== create folder A (root) with description ==');
    const folderA = await gw(client, 'POST items/ (folder A)', {
      service: 'collection', method: 'post', path: `/v3/collections/${cid}/items/`,
      headers: { 'X-Entity-Type': 'collection' },
      body: { $kind: 'collection', name: 'Folder A', description: 'folder A desc', position: { parent: { id: cid, $kind: 'collection' } } }
    });
    const folderAId = String((folderA?.data as JsonRecord | undefined)?.id ?? '').trim();

    console.log('\n== create folder B (nested under A) ==');
    const folderB = await gw(client, 'POST items/ (folder B under A)', {
      service: 'collection', method: 'post', path: `/v3/collections/${cid}/items/`,
      headers: { 'X-Entity-Type': 'collection' },
      body: { $kind: 'collection', name: 'Folder B', position: { parent: { id: folderAId, $kind: 'collection' } } }
    });
    const folderBId = String((folderB?.data as JsonRecord | undefined)?.id ?? '').trim();

    console.log('\n== create leaf under folder B (2 levels deep) with description ==');
    await gw(client, 'POST items/ (leaf under B)', {
      service: 'collection', method: 'post', path: `/v3/collections/${cid}/items/`,
      headers: { 'X-Entity-Type': 'http-request' },
      body: {
        $kind: 'http-request', name: 'Deep Leaf', description: 'leaf desc',
        method: 'POST', url: 'https://postman-echo.com/post',
        headers: [{ key: 'X-Probe', value: '1' }],
        body: { type: 'json', content: '{"a":1}' },
        position: { parent: { id: folderBId, $kind: 'collection' } }
      }
    });

    console.log('\n== export: verify 2-level nesting + descriptions ==');
    const exported = await gw(client, 'GET export', {
      service: 'collection', method: 'get', path: `/v3/collections/${cid}/export`
    });
    console.log(JSON.stringify(((exported?.data as JsonRecord)?.collection), null, 2).slice(0, 2000));

    console.log('\n== rename collection via PATCH /name ==');
    await gw(client, 'PATCH /v3/collections/:id (rename)', {
      service: 'collection', method: 'patch', path: `/v3/collections/${cid}`,
      body: [{ op: 'replace', path: '/name', value: 'Renamed Desc Nest Probe' }]
    });
    await gw(client, 'GET /v3/collections/:id (verify rename)', {
      service: 'collection', method: 'get', path: `/v3/collections/${cid}`
    });
  } finally {
    console.log('\n[teardown]');
    if (cid) await gw(client, 'DELETE collection', { service: 'collection', method: 'delete', path: `/v3/collections/${cid}` });
    if (workspaceId) await gw(client, 'DELETE workspace', { service: 'workspaces', method: 'delete', path: `/workspaces/${workspaceId}` });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
