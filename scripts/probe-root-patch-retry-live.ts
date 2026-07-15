
/** Secret-safe live probe: retried root PATCH via createCollection/updateCollection. Cleans up after itself. */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no api key'); return; }
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gateway = new AccessTokenGatewayClient({ tokenProvider: provider });
  const client = new PostmanGatewayAssetsClient({ gateway });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let workspaceId = '';
  let uid = '';
  try {
    const ws = await gateway.requestJson<{ data?: { id?: string } }>({
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: 'root-patch-retry-probe-' + stamp, visibilityStatus: 'personal' }
    });
    workspaceId = String(ws?.data?.id ?? '');
    if (!workspaceId) throw new Error('no workspace id');
    console.log('[ok] workspace ' + workspaceId);

    const v21 = {
      info: { name: 'Retry Probe', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
      variable: [{ key: 'baseUrl', value: 'https://example.test' }],
      item: [{ name: 'Ping', request: { method: 'GET', url: { raw: 'https://example.test/ping', host: ['example','test'], path: ['ping'] } } }]
    };
    uid = await client.createCollection(workspaceId, v21);
    console.log('[ok] createCollection (root PATCH with retry:safe path) ' + uid);

    // update with removals: exercises reconcileRemovals root PATCH (add + remove ops)
    const v21b = {
      info: { name: 'Retry Probe Updated', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Ping2', request: { method: 'GET', url: { raw: 'https://example.test/ping2', host: ['example','test'], path: ['ping2'] } } }]
    };
    await client.updateCollection(uid, v21b);
    console.log('[ok] updateCollection (reconcileRemovals root PATCH) done');
    console.log('PROBE_PASS');
  } finally {
    try { if (uid) await client.deleteCollection(uid); } catch (e) { console.log('[warn] collection cleanup: ' + (e as Error).message.slice(0,120)); }
    try { if (workspaceId) await gateway.requestJson({ service: 'workspaces', method: 'delete', path: '/workspaces/' + workspaceId }); console.log('[ok] cleaned up'); } catch (e) { console.log('[warn] ws cleanup: ' + (e as Error).message.slice(0,120)); }
  }
}
main().catch((e) => { console.error('PROBE_FAIL: ' + String(e?.message ?? e).slice(0, 300)); process.exit(1); });
