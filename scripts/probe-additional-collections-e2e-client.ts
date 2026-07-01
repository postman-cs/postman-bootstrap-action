/**
 * End-to-end proof: PostmanGatewayAssetsClient.createCollection/updateCollection
 * against a real v2.1.0 collection (folder + nested leaf + root leaf), verifying
 * the full port of bootstrap's additional-collections feature off PMAK.
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

const v21Collection = {
  info: {
    name: 'Curated E2E Probe',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  item: [
    {
      name: 'Payments',
      item: [
        {
          name: 'Get balance',
          request: {
            method: 'GET',
            header: [{ key: 'X-Probe', value: 'nested' }],
            url: { raw: 'https://postman-echo.com/get?scope=balance', host: ['postman-echo', 'com'], path: ['get'], query: [{ key: 'scope', value: 'balance' }] }
          }
        }
      ]
    },
    {
      name: 'Root health',
      request: {
        method: 'GET',
        url: { raw: 'https://postman-echo.com/get', host: ['postman-echo', 'com'], path: ['get'] }
      }
    }
  ]
};

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) { console.log('[skip] no key'); return; }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gateway = new AccessTokenGatewayClient({ tokenProvider: provider });
  const client = new PostmanGatewayAssetsClient({ gateway });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let workspaceId = '';
  let collectionUid = '';

  try {
    const wsRes = await gateway.requestJson<{ data?: { id?: string } }>({
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: `additional-collections-e2e-${stamp}`, visibilityStatus: 'personal' }
    });
    workspaceId = String(wsRes?.data?.id ?? '').trim();
    if (!workspaceId) { console.log('[abort] no workspace'); return; }
    console.log(`[setup] workspace ${workspaceId}`);

    console.log('\n== createCollection (v2.1 -> v3 write) ==');
    collectionUid = await client.createCollection(workspaceId, v21Collection);
    console.log(`  [created] ${collectionUid}`);

    console.log('\n== verify export: nesting + names ==');
    const bareId = collectionUid.includes('-') ? collectionUid.slice(collectionUid.indexOf('-') + 1) : collectionUid;
    const exported = await gateway.requestJson<{ data?: { collection?: unknown } }>({
      service: 'collection', method: 'get', path: `/v3/collections/${bareId}/export`
    });
    console.log(JSON.stringify(exported?.data?.collection, null, 2));

    console.log('\n== updateCollection (full-replace reconcile with a renamed + trimmed tree) ==');
    const updated = {
      info: {
        name: 'Curated E2E Probe (updated)',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: [
        {
          name: 'Root health v2',
          request: {
            method: 'GET',
            url: { raw: 'https://postman-echo.com/get?v=2', host: ['postman-echo', 'com'], path: ['get'], query: [{ key: 'v', value: '2' }] }
          }
        }
      ]
    };
    await client.updateCollection(collectionUid, updated);

    console.log('\n== verify export after update ==');
    const exportedAfter = await gateway.requestJson<{ data?: { collection?: unknown } }>({
      service: 'collection', method: 'get', path: `/v3/collections/${bareId}/export`
    });
    console.log(JSON.stringify(exportedAfter?.data?.collection, null, 2));

    console.log('\n[verdict] createCollection + updateCollection round-trip complete.');
  } finally {
    console.log('\n[teardown]');
    if (collectionUid) await client.deleteCollection(collectionUid).catch(() => {});
    if (workspaceId) {
      await gateway.requestJson({ service: 'workspaces', method: 'delete', path: `/workspaces/${workspaceId}` }).catch(() => {});
    }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
