#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';

const API = 'https://api.getpostman.com';
const BIFROST = 'https://bifrost-premium-https-v4.gw.postman.com';
const WEB = 'https://go.postman.co';
const GATEWAY = 'https://gateway.postman.com';
const WORKERS = Number(process.env.PROBE_WORKERS || 4);
const ITEMS = Number(process.env.PROBE_ITEMS || 40);
const ROUNDS = Number(process.env.PROBE_ROUNDS || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 30_000);
const requestedOrder = String(process.env.PROBE_ORDER || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const apiKey = String(
  process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || ''
).trim();

if (!apiKey) {
  console.error('Set POSTMAN_API_KEY or POSTMAN_E2E_API_KEY_NON_ORG_MODE.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const receiptPath = `/tmp/gateway-item-create-benchmark-${stamp}.json`;
const createdCollections = new Set();
let workspaceId = '';
let accessToken = '';

function snippet(value) {
  return String(value ?? '').replace(/\s+/g, ' ').slice(0, 240);
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function classify(status, body, error) {
  if (error) return error;
  if (/ESOCKETTIMEDOUT/i.test(body)) return 'ESOCKETTIMEDOUT';
  if (/ETIMEDOUT/i.test(body)) return 'ETIMEDOUT';
  if (/ECONNRESET/i.test(body)) return 'ECONNRESET';
  if (/RESOURCE_NOT_FOUND/i.test(body)) return 'RESOURCE_NOT_FOUND';
  if (/invalidPathError/i.test(body)) return 'invalidPathError';
  if (/authenticationError/i.test(body)) return 'authenticationError';
  return `HTTP_${status}`;
}

async function timedFetch(url, init = {}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual'
    });
    const body = await response.text().catch(() => '');
    return {
      status: response.status,
      ms: Math.round(performance.now() - startedAt),
      body,
      signature: classify(response.status, body)
    };
  } catch (error) {
    const message = String(error?.cause?.code || error?.name || error?.message || error);
    return {
      status: 0,
      ms: Math.round(performance.now() - startedAt),
      body: '',
      error: message,
      signature: classify(0, '', message)
    };
  }
}

function authHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-access-token': accessToken,
    ...extra
  };
}

async function envelope(host, service, method, path, body, headers = {}) {
  return timedFetch(`${host}/ws/proxy`, {
    method: 'POST',
    headers: authHeaders(headers),
    body: JSON.stringify({
      service,
      method,
      path,
      ...(body === undefined ? {} : { body })
    })
  });
}

async function direct(host, service, method, path, body, headers = {}) {
  return timedFetch(`${host}${path}`, {
    method: method.toUpperCase(),
    headers: authHeaders({ 'x-pstmn-req-service': service, ...headers }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function mintToken() {
  const response = await timedFetch(`${API}/service-account-tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ apiKey })
  });
  const parsed = JSON.parse(response.body || '{}');
  accessToken = String(parsed.access_token || '').trim();
  if (response.status !== 200 || !accessToken) {
    throw new Error(`Token mint failed (${response.status}): ${snippet(response.body)}`);
  }
}

async function createWorkspace() {
  const result = await envelope(BIFROST, 'workspaces', 'post', '/workspaces', {
    name: `gateway-item-path-benchmark-${stamp}`,
    visibilityStatus: 'personal'
  });
  const parsed = JSON.parse(result.body || '{}');
  workspaceId = String(parsed?.data?.id || '').trim();
  if (result.status !== 200 || !workspaceId) {
    throw new Error(`Workspace create failed (${result.status}): ${snippet(result.body)}`);
  }
}

async function createCollection(label) {
  const result = await envelope(
    BIFROST,
    'collection',
    'post',
    `/v3/collections/?workspace=${encodeURIComponent(workspaceId)}`,
    { name: `${label}-${crypto.randomUUID()}` },
    { 'X-Entity-Target': 'http' }
  );
  const parsed = JSON.parse(result.body || '{}');
  const id = String(parsed?.data?.id || '').trim();
  if (result.status !== 201 || !id) {
    throw new Error(`Collection create failed (${result.status}): ${snippet(result.body)}`);
  }
  createdCollections.add(id);
  return id;
}

function itemBody(collectionId, name) {
  return {
    $kind: 'http-request',
    name,
    method: 'GET',
    url: `https://postman-echo.com/get?probe=${encodeURIComponent(name)}`,
    headers: [{ key: 'x-gateway-path-probe', value: name }],
    position: { parent: { id: collectionId, $kind: 'collection' } }
  };
}

const transports = {
  envelope: (collectionId, body) =>
    envelope(
      BIFROST,
      'collection',
      'post',
      `/v3/collections/${collectionId}/items/`,
      body,
      { 'X-Entity-Type': 'http-request' }
    ),
  header: (collectionId, body) =>
    direct(
      BIFROST,
      'collection',
      'post',
      `/v3/collections/${collectionId}/items/`,
      body,
      { 'X-Entity-Type': 'http-request' }
    ),
  webAlias: (collectionId, body) =>
    envelope(
      `${WEB}/_api`,
      'collection',
      'post',
      `/v3/collections/${collectionId}/items/`,
      body,
      { 'X-Entity-Type': 'http-request' }
    )
};

async function listItemCount(collectionId) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await envelope(
      BIFROST,
      'collection',
      'get',
      `/v3/collections/${collectionId}/items/`
    );
    if (result.status === 200) {
      const parsed = JSON.parse(result.body || '{}');
      return Array.isArray(parsed.data) ? parsed.data.length : null;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return null;
}

async function deleteCollection(id) {
  const bare = id.includes('-') ? id.slice(id.indexOf('-') + 1) : id;
  const result = await envelope(BIFROST, 'collection', 'delete', `/v3/collections/${bare}`);
  if (result.status === 200 || result.status === 204 || result.status === 404 || result.status === 500) {
    createdCollections.delete(id);
  }
}

async function runWorker(transportName, round, worker) {
  const collectionId = await createCollection(`${transportName}-r${round}-w${worker}`);
  const writes = [];
  try {
    for (let item = 0; item < ITEMS; item += 1) {
      const name = `${transportName}-r${round}-w${worker}-i${item}-${crypto.randomUUID()}`;
      const result = await transports[transportName](collectionId, itemBody(collectionId, name));
      writes.push({
        status: result.status,
        ms: result.ms,
        signature: result.signature,
        body: result.status >= 400 || result.error ? snippet(result.body || result.error) : undefined
      });
    }
    const finalItemCount = await listItemCount(collectionId);
    return { worker, collectionId, writes, finalItemCount };
  } finally {
    await deleteCollection(collectionId);
  }
}

function summarizeTransport(name, workers) {
  const writes = workers.flatMap((worker) => worker.writes);
  const latencies = writes.map((write) => write.ms);
  const statuses = {};
  const signatures = {};
  for (const write of writes) {
    statuses[write.status] = (statuses[write.status] || 0) + 1;
    signatures[write.signature] = (signatures[write.signature] || 0) + 1;
  }
  const serverCount = workers.reduce(
    (sum, worker) => sum + (typeof worker.finalItemCount === 'number' ? worker.finalItemCount : 0),
    0
  );
  return {
    name,
    attempted: writes.length,
    accepted: writes.filter((write) => write.status >= 200 && write.status < 300).length,
    serverCount,
    statuses,
    signatures,
    latencyMs: {
      min: Math.min(...latencies),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: Math.max(...latencies)
    }
  };
}

async function routeCapabilityProbes() {
  const id = await createCollection('capability');
  const body = itemBody(id, `capability-${crypto.randomUUID()}`);
  const path = `/v3/collections/${id}/items/`;
  const ecBody = {
    type: 'http-request',
    title: `legacy-ec-${crypto.randomUUID()}`,
    position: { parent: id },
    payload: { method: 'GET', url: 'https://postman-echo.com/get' },
    extensions: {}
  };
  try {
    const probes = [
      ['gateway.collection', () => direct(GATEWAY, 'collection', 'post', path, body, { 'X-Entity-Type': 'http-request' })],
      ['gateway.collection-api', () => direct(GATEWAY, 'collection-api', 'post', path, body, { 'X-Entity-Type': 'http-request' })],
      ['webGw.collection', () => direct(`${WEB}/_gw`, 'collection', 'post', path, body, { 'X-Entity-Type': 'http-request' })],
      ['webGw.collection-api', () => direct(`${WEB}/_gw`, 'collection-api', 'post', path, body, { 'X-Entity-Type': 'http-request' })],
      ['legacyEcOnHttpCollection.envelope', () => envelope(BIFROST, 'collection', 'post', `/collections/${id}/items/`, ecBody)],
      ['legacyEcOnHttpCollection.header', () => direct(BIFROST, 'collection', 'post', `/collections/${id}/items/`, ecBody)],
      ['artemisDirect.collection', () => direct(WEB, 'collection', 'post', path, body, { 'X-Entity-Type': 'http-request' })],
      ['artemisHost.collection', () => direct('https://artemis.postman.co', 'collection', 'post', path, body, { 'X-Entity-Type': 'http-request' })],
      ['bifrostSocketAction.envelope', () => envelope(BIFROST, 'collection', 'post', '/x/v0/subscribe', { collectionId: id, request: { path, body } })],
      ['bifrostSocketAction.direct', () => direct('https://bifrost-v10.getpostman.com', 'collection', 'post', '/x/v0/subscribe', { collectionId: id, request: { path, body } })]
    ];
    const results = [];
    for (const [name, run] of probes) {
      const result = await run();
      results.push({
        name,
        status: result.status,
        ms: result.ms,
        signature: result.signature,
        body: snippet(result.body || result.error)
      });
    }
    return results;
  } finally {
    await deleteCollection(id);
  }
}

async function main() {
  const receipt = {
    startedAt: new Date().toISOString(),
    config: { workers: WORKERS, itemsPerWorker: ITEMS, rounds: ROUNDS, requestTimeoutMs: REQUEST_TIMEOUT_MS },
    benchmark: [],
    capabilityProbes: []
  };

  try {
    await mintToken();
    await createWorkspace();
    console.log(`[setup] workspace=${workspaceId} workers=${WORKERS} items=${ITEMS} rounds=${ROUNDS}`);

    const orders = requestedOrder.length > 0 ? [requestedOrder] : [
      ['envelope', 'header', 'webAlias'],
      ['header', 'webAlias', 'envelope'],
      ['webAlias', 'envelope', 'header']
    ];

    for (let round = 1; round <= ROUNDS; round += 1) {
      for (const transportName of orders[(round - 1) % orders.length]) {
        console.log(`[run] round=${round} transport=${transportName}`);
        const workers = await Promise.all(
          Array.from({ length: WORKERS }, (_, worker) => runWorker(transportName, round, worker + 1))
        );
        const summary = summarizeTransport(transportName, workers);
        receipt.benchmark.push({ round, transport: transportName, summary, workers });
        console.log(`[result] round=${round} transport=${transportName} ${JSON.stringify(summary)}`);
      }
    }

    if (process.env.PROBE_CAPABILITIES !== 'off') {
      receipt.capabilityProbes = await routeCapabilityProbes();
      for (const result of receipt.capabilityProbes) {
        console.log(`[capability] ${result.name} status=${result.status} signature=${result.signature} body=${result.body}`);
      }
    }
  } finally {
    for (const id of [...createdCollections]) {
      await deleteCollection(id).catch(() => undefined);
    }
    if (workspaceId) {
      await envelope(BIFROST, 'workspaces', 'delete', `/workspaces/${workspaceId}`).catch(() => undefined);
    }
    receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(`[receipt] ${receiptPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
