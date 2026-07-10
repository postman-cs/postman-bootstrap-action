/**
 * Secret-safe probe: collection-root JSON Patch reconcile semantics for Local View.
 *
 * Grounds the uncertain ops used by PostmanGatewayAssetsClient.applyCollectionLevelSettings
 * on update (reconcileRemovals):
 *   - add/remove /description
 *   - add/remove /variables
 *   - add/remove /scripts
 *   - remove /auth when present vs already absent (smoke-flow proves remove /auth only)
 *
 * Never prints API keys or access tokens. Logs only status codes + redacted snippets.
 *
 * Drive against the disposable non-org sandbox:
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/probe-collection-root-patch-reconcile.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '')
    .replace(/PMAK-[A-Za-z0-9-]+/g, 'PMAK-[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .slice(0, 500)
    .replace(/\s+/g, ' ');
}

function bareModelId(uid: string): string {
  const u = String(uid ?? '').trim();
  return u.includes('-') ? u.slice(u.indexOf('-') + 1) : u;
}

function assertStatuses(
  actual: Array<{ op: string; status: number }>,
  expected: Record<string, number>
): void {
  for (const [op, status] of Object.entries(expected)) {
    const row = actual.find((entry) => entry.op === op);
    if (!row || row.status !== status) {
      throw new Error(
        `PROBE_ASSERTION_FAILED: ${op} expected ${status}, got ${row?.status ?? '<missing>'}`
      );
    }
  }
}

async function gw(
  client: AccessTokenGatewayClient,
  label: string,
  request: Parameters<AccessTokenGatewayClient['request']>[0]
): Promise<{ status: number; body: JsonRecord | null; raw: string }> {
  try {
    const response = await client.request(request);
    const raw = await response.text().catch(() => '');
    console.log(`  [${response.status}] ${label} :: ${snippet(raw)}`);
    let body: JsonRecord | null = null;
    try {
      body = raw.trim() ? (JSON.parse(raw) as JsonRecord) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body, raw };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  [ERR] ${label} :: ${snippet(msg)}`);
    return { status: -1, body: null, raw: msg };
  }
}

async function patchRoot(
  client: AccessTokenGatewayClient,
  cid: string,
  label: string,
  ops: JsonRecord[]
): Promise<number> {
  const result = await gw(client, label, {
    service: 'collection',
    method: 'patch',
    path: `/v3/collections/${cid}`,
    body: ops
  });
  return result.status;
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] no POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const client = new AccessTokenGatewayClient({ tokenProvider: provider });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let workspaceId = '';
  let cid = '';
  const results: Array<{ op: string; status: number }> = [];

  try {
    const ws = await gw(client, 'create workspace', {
      service: 'workspaces',
      method: 'post',
      path: '/workspaces',
      body: { name: `root-patch-reconcile-${stamp}`, visibilityStatus: 'personal' }
    });
    workspaceId = String((ws.body?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!workspaceId) return;

    console.log('\n== create bare collection (no description/auth/variables/scripts) ==');
    const created = await gw(client, 'POST /v3/collections/', {
      service: 'collection',
      method: 'post',
      path: `/v3/collections/?workspace=${workspaceId}`,
      headers: { 'X-Entity-Target': 'http' },
      body: { name: 'Root Patch Reconcile Probe' }
    });
    const rawId = String((created.body?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (!rawId) return;
    cid = bareModelId(rawId);

    console.log('\n== remove on ABSENT fields (blind reconcile risk) ==');
    for (const path of ['/description', '/auth', '/variables', '/scripts'] as const) {
      const status = await patchRoot(client, cid, `remove absent ${path}`, [
        { op: 'remove', path }
      ]);
      results.push({ op: `remove-absent ${path}`, status });
    }

    console.log('\n== add each root field ==');
    const addOps: Array<{ path: string; value: unknown }> = [
      { path: '/description', value: 'probe description' },
      {
        path: '/auth',
        value: { type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] }
      },
      { path: '/variables', value: [{ key: 'baseUrl', value: 'https://example.test' }] },
      {
        path: '/scripts',
        value: [
          {
            type: 'beforeRequest',
            code: 'pm.variables.set("ready", "1");',
            language: 'text/javascript'
          }
        ]
      }
    ];
    for (const { path, value } of addOps) {
      const status = await patchRoot(client, cid, `add ${path}`, [{ op: 'add', path, value }]);
      results.push({ op: `add ${path}`, status });
    }

    console.log('\n== GET root after adds ==');
    await gw(client, 'GET /v3/collections/:id', {
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}`
    });

    console.log('\n== remove on PRESENT fields ==');
    for (const path of ['/description', '/auth', '/variables', '/scripts'] as const) {
      const status = await patchRoot(client, cid, `remove present ${path}`, [
        { op: 'remove', path }
      ]);
      results.push({ op: `remove-present ${path}`, status });
    }

    console.log('\n== add /scripts with http: root types ==');
    const httpScriptsStatus = await patchRoot(client, cid, 'add /scripts http:beforeRequest', [
      {
        op: 'add',
        path: '/scripts',
        value: [
          {
            type: 'http:beforeRequest',
            code: 'pm.variables.set("ready", "1");',
            language: 'text/javascript'
          }
        ]
      }
    ]);
    results.push({ op: 'add /scripts http:beforeRequest', status: httpScriptsStatus });

    console.log('\n== GET root after http: scripts ==');
    const afterScripts = await gw(client, 'GET after http scripts', {
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}`
    });

    console.log('\n== remove present /scripts after http: add ==');
    const removeScripts = await patchRoot(client, cid, 'remove present /scripts', [
      { op: 'remove', path: '/scripts' }
    ]);
    results.push({ op: 'remove-present /scripts after http add', status: removeScripts });

    console.log('\n== conditional reconcile: GET then remove only present fields ==');
    await patchRoot(client, cid, 're-seed present fields', [
      { op: 'add', path: '/description', value: 'seed' },
      {
        op: 'add',
        path: '/auth',
        value: { type: 'bearer', credentials: [{ key: 'token', value: '{{token}}' }] }
      },
      { op: 'add', path: '/variables', value: [{ key: 'k', value: 'v' }] },
      {
        op: 'add',
        path: '/scripts',
        value: [{ type: 'http:beforeRequest', code: '1;', language: 'text/javascript' }]
      }
    ]);
    const seeded = await gw(client, 'GET seeded root', {
      service: 'collection',
      method: 'get',
      path: `/v3/collections/${cid}`
    });
    const seededData = (seeded.body?.data as JsonRecord | undefined) ?? {};
    const conditionalOps: JsonRecord[] = [];
    if (Object.prototype.hasOwnProperty.call(seededData, 'description')) {
      conditionalOps.push({ op: 'remove', path: '/description' });
    }
    if (seededData.auth !== undefined) conditionalOps.push({ op: 'remove', path: '/auth' });
    if (seededData.variables !== undefined) conditionalOps.push({ op: 'remove', path: '/variables' });
    if (seededData.scripts !== undefined) conditionalOps.push({ op: 'remove', path: '/scripts' });
    const conditional = await patchRoot(
      client,
      cid,
      `conditional remove (${conditionalOps.map((op) => op.path).join(',')})`,
      conditionalOps
    );
    results.push({ op: 'conditional-remove-present-only', status: conditional });

    assertStatuses(results, {
      'remove-absent /description': 200,
      'remove-absent /auth': -1,
      'remove-absent /variables': -1,
      'remove-absent /scripts': -1,
      'add /description': 200,
      'add /auth': 200,
      'add /variables': 200,
      'add /scripts': -1,
      'remove-present /description': 200,
      'remove-present /auth': 200,
      'remove-present /variables': 200,
      'remove-present /scripts': -1,
      'add /scripts http:beforeRequest': 200,
      'remove-present /scripts after http add': 200,
      'conditional-remove-present-only': 200
    });

    console.log('\n== verdict table ==');
    for (const row of results) {
      console.log(`  ${row.status}\t${row.op}`);
    }
    console.log('\n== notes ==');
    console.log('  root scripts require http:beforeRequest / http:afterResponse');
    console.log('  remove absent auth/variables/scripts => 400; description remove always ok');
    console.log('  afterScripts keys:', Object.keys((afterScripts.body?.data as JsonRecord) ?? {}).join(','));
  } finally {
    console.log('\n[teardown]');
    if (cid) {
      await gw(client, 'DELETE collection', {
        service: 'collection',
        method: 'delete',
        path: `/v3/collections/${cid}`
      });
    }
    if (workspaceId) {
      await gw(client, 'DELETE workspace', {
        service: 'workspaces',
        method: 'delete',
        path: `/workspaces/${workspaceId}`
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
