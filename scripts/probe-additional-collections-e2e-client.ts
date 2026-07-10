/** Secret-safe Local View loader -> sync -> gateway create/update/export proof. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { stringify } from 'yaml';

import {
  loadAdditionalCollectionFiles,
  syncAdditionalCollections,
  type PostmanResourcesState
} from '../src/lib/postman/additional-collections.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type JsonRecord = Record<string, unknown>;

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PROBE_ASSERTION_FAILED: ${message}`);
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function bareModelId(uid: string): string {
  return uid.includes('-') ? uid.slice(uid.indexOf('-') + 1) : uid;
}

async function writeCreatedTree(root: string): Promise<void> {
  const collectionDir = path.join(root, 'postman/additional/local-view');
  const folderDir = path.join(collectionDir, 'First Folder');
  await mkdir(path.join(collectionDir, '.resources'), { recursive: true });
  await mkdir(path.join(folderDir, '.resources'), { recursive: true });
  await writeFile(
    path.join(collectionDir, '.resources/definition.yaml'),
    stringify({
      $kind: 'collection',
      name: 'Local View E2E Probe',
      description: 'created from Local View',
      auth: { type: 'bearer', credentials: { token: '{{token}}' } },
      variables: [{ key: 'baseUrl', value: 'https://postman-echo.com' }],
      scripts: [{
        type: 'beforeRequest',
        code: 'pm.collectionVariables.set("probe", "created");',
        language: 'text/javascript'
      }]
    })
  );
  await writeFile(
    path.join(folderDir, '.resources/definition.yaml'),
    stringify({ $kind: 'collection', name: 'First Folder', description: 'nested', order: 1000 })
  );
  await writeFile(
    path.join(folderDir, 'Nested.request.yaml'),
    stringify({
      $kind: 'http-request',
      name: 'Nested request',
      method: 'GET',
      url: '{{baseUrl}}/get?nested=true',
      order: 1000,
      scripts: [{
        type: 'afterResponse',
        code: 'pm.test("nested", function () { pm.expect(pm.response.code).to.eql(200); });',
        language: 'text/javascript'
      }]
    })
  );
  await writeFile(
    path.join(collectionDir, 'Root.request.yaml'),
    stringify({
      $kind: 'http-request',
      name: 'Root request',
      method: 'GET',
      url: '{{baseUrl}}/get?root=true',
      order: 2000
    })
  );
}

async function writeUpdatedTree(root: string): Promise<void> {
  const collectionDir = path.join(root, 'postman/additional/local-view');
  await rm(path.join(collectionDir, 'First Folder'), { recursive: true, force: true });
  await writeFile(
    path.join(collectionDir, '.resources/definition.yaml'),
    stringify({ $kind: 'collection', name: 'Local View E2E Probe (updated)' })
  );
  await writeFile(
    path.join(collectionDir, 'Root.request.yaml'),
    stringify({
      $kind: 'http-request',
      name: 'Only request',
      method: 'GET',
      url: 'https://postman-echo.com/get?updated=true',
      order: 1000
    })
  );
}

async function exportCollection(
  gateway: AccessTokenGatewayClient,
  collectionUid: string
): Promise<JsonRecord> {
  const exported = await gateway.requestJson<{ data?: { collection?: unknown } }>({
    service: 'collection',
    method: 'get',
    path: `/v3/collections/${bareModelId(collectionUid)}/export`
  });
  return asRecord(exported?.data?.collection);
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] no POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const gateway = new AccessTokenGatewayClient({ tokenProvider: provider });
  const client = new PostmanGatewayAssetsClient({ gateway });
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'local-view-e2e-'));
  const previousCwd = process.cwd();
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  const resourcesState: PostmanResourcesState = {};
  let workspaceId = '';
  let collectionUid = '';

  try {
    process.chdir(workspaceRoot);
    process.env.GITHUB_WORKSPACE = workspaceRoot;
    await writeCreatedTree(workspaceRoot);

    const workspace = await gateway.requestJson<{ data?: { id?: string } }>({
      service: 'workspaces',
      method: 'post',
      path: '/workspaces',
      body: {
        name: `local-view-e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        visibilityStatus: 'personal'
      }
    });
    workspaceId = String(workspace?.data?.id ?? '').trim();
    requireCondition(workspaceId, 'workspace create returned no id');

    const createdFiles = loadAdditionalCollectionFiles('postman/additional', resourcesState);
    const created = await syncAdditionalCollections({
      collectionFiles: createdFiles,
      core: { info: console.log, warning: console.warn },
      postman: client,
      resourcesState,
      workspaceId
    });
    requireCondition(created.length === 1 && created[0].operation === 'created', 'create sync result');
    collectionUid = created[0].collectionId;

    const firstExport = await exportCollection(gateway, collectionUid);
    const firstItems = Array.isArray(firstExport.items) ? firstExport.items.map(asRecord) : [];
    requireCondition(firstExport.name === 'Local View E2E Probe', 'created root name');
    requireCondition(firstExport.description === 'created from Local View', 'created description');
    requireCondition(firstExport.auth !== undefined, 'created root auth');
    requireCondition(firstExport.variables !== undefined, 'created root variables');
    requireCondition(firstExport.scripts !== undefined, 'created root scripts');
    requireCondition(firstItems.map((item) => item.name).join(',') === 'First Folder,Root request', 'created item order');
    requireCondition(Array.isArray(firstItems[0].items) && firstItems[0].items.length === 1, 'nested folder export');
    console.log('[pass] Local View create/export preserved root fields, order, and nesting');

    await writeUpdatedTree(workspaceRoot);
    const updatedFiles = loadAdditionalCollectionFiles('postman/additional', resourcesState);
    const updated = await syncAdditionalCollections({
      collectionFiles: updatedFiles,
      core: { info: console.log, warning: console.warn },
      postman: client,
      resourcesState,
      workspaceId
    });
    requireCondition(updated.length === 1 && updated[0].operation === 'updated', 'update sync result');

    const secondExport = await exportCollection(gateway, collectionUid);
    const secondItems = Array.isArray(secondExport.items) ? secondExport.items.map(asRecord) : [];
    requireCondition(secondExport.name === 'Local View E2E Probe (updated)', 'updated root name');
    requireCondition(secondExport.description === '', 'updated description cleared');
    requireCondition(secondExport.auth === undefined, 'updated auth cleared');
    requireCondition(secondExport.variables === undefined, 'updated variables cleared');
    requireCondition(secondExport.scripts === undefined, 'updated scripts cleared');
    requireCondition(secondItems.length === 1 && secondItems[0].name === 'Only request', 'updated item tree');
    console.log('[pass] Local View update/export cleared root fields and replaced the item tree');
  } finally {
    process.chdir(previousCwd);
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
    if (collectionUid) await client.deleteCollection(collectionUid).catch(() => {});
    if (workspaceId) {
      await gateway.requestJson({
        service: 'workspaces',
        method: 'delete',
        path: `/workspaces/${workspaceId}`
      }).catch(() => {});
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
