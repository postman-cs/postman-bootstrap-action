/**
 * Focused probe: workspace role assignment via the access-token gateway.
 *
 * Retires bootstrap's last PMAK `PATCH /workspaces/:id/roles` route
 * (`addAdminsToWorkspace`, `inviteRequesterToWorkspace`). The reference app
 * assigns workspace roles through the `workspaces` service gateway envelope:
 *
 *   workspaces PATCH /workspaces/:id/roles
 *   body: [{ op: 'add', value: { user: { <userId>: ['WORKSPACE_EDITOR'] } } }]
 *
 * Two differences from the PMAK public-REST shape bootstrap sends today:
 *   1. The body is a BARE array (no `{ roles: [...] }` wrapper, no `path` field).
 *   2. The role value is a STRING enum name ('WORKSPACE_EDITOR', 'WORKSPACE_VIEWER_V9',
 *      'WORKSPACE_EDITOR_V9', ...), NOT a numeric id (3/2/4). See
 *      postman-reference/postman-workspaces/constants/WorkspaceRoles.js:307-309.
 *
 * Critical unknown: the gateway route's preHandler chain includes
 * `POLICIES.isOrgsEnabled` (postman-reference/postman-workspaces/config/routes.js:154),
 * which may reject non-org teams. The PMAK public-REST route
 * (`/workspaces-cloud/:id/roles`, allowRequestsExclusivelyFromPostmanAPI) is the
 * non-org path today. This probe determines whether the gateway route serves a
 * service-account token on BOTH the non-org (10490519) and org-mode (13347347)
 * disposable sandboxes, or only org-mode.
 *
 * Drive against the disposable sandboxes:
 *   set -a && source ../.env && set +a
 *   # non-org (team 10490519, jared-demo):
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/probe-workspace-roles-gateway.ts
 *   # org-mode (team 13347347, field-services-v12-demo):
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_ORG_MODE" POSTMAN_E2E_TEAM_ID="13347347" \
 *     npx tsx scripts/probe-workspace-roles-gateway.ts
 *
 * Verified LIVE (disposable sandboxes, 2026-06-30):
 *   NON-ORG (10490519, team workspace via personal->team flip):
 *   [200] workspaces PATCH /workspaces/:id/roles
 *        body [{op:'add', value:{user:{<userId>:['WORKSPACE_EDITOR']}}}]  (string role name)
 *   [400] numeric role [3] -> "invalid roles passed in payload / some roles are not configured"
 *        => the gateway REQUIRES string enum names, NOT numeric ids.
 *   [400] {roles:[{op,path,value}]} wrapper -> "body must be array"
 *        => bare array body, no wrapper, no `path` field.
 *   [400] op:'remove' of the last admin -> "noAdminError: A workspace needs to have at least one Admin"
 *        => op:'add' SETS the user's role list (not append); adminless outcomes are rejected.
 *   isOrgsEnabled policy did NOT block the non-org service-account token.
 *
 *   ORG-MODE (13347347): the personal->team visibility flip 403s for the SA
 *   ("forbiddenError / addWorkspaceLevelTeamRoles"), so the probe could not
 *   materialize a team workspace to test roles against. The roles route itself
 *   returned a STATE guard ("Roles are not supported for personal workspaces"),
 *   proving it is reachable in org-mode (the policy passed). The roles PATCH
 *   route is mode-agnostic; the non-org 200 above is the canonical proof. The
 *   org-mode visibility-flip 403 is a pre-existing workspace-creation concern,
 *   not introduced by this roles cutover.
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const IAPUB = POSTMAN_ENDPOINT_PROFILES.prod.iapubBaseUrl;
const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 600).replace(/\s+/g, ' ');
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

async function resolveSession(accessToken: string, teamId: string): Promise<{ userId: string; teamId: string }> {
  const r = await fetch(`${IAPUB}/api/sessions/current`, {
    method: 'GET',
    headers: { 'x-access-token': accessToken, ...(teamId ? { 'x-entity-team-id': teamId } : {}) }
  });
  const body = await r.text().catch(() => '');
  console.log(`[session] GET /api/sessions/current -> ${r.status}`);
  try {
    const j = JSON.parse(body) as JsonRecord;
    const root = (j.session as JsonRecord) ?? j;
    const identity = (root.identity as JsonRecord) ?? {};
    const data = (root.data as JsonRecord) ?? {};
    const user = (data.user as JsonRecord) ?? {};
    const userId = String(identity.user ?? user.id ?? '').trim();
    const resolvedTeam = String(identity.team ?? teamId ?? '').trim();
    console.log(`[session] userId=${userId} teamId=${resolvedTeam} consumerType=${root.consumerType ?? ''}`);
    return { userId, teamId: resolvedTeam };
  } catch {
    console.log(`[session] parse failed :: ${snippet(body)}`);
    return { userId: '', teamId };
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping.');
    return;
  }
  const explicitTeamId = String(process.env.POSTMAN_E2E_TEAM_ID || '').trim();
  const orgMode = Boolean(explicitTeamId);

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const accessToken = provider.current();
  const session = await resolveSession(accessToken, explicitTeamId);
  if (!session.userId || !session.teamId) {
    console.log('[abort] could not resolve userId/teamId from session');
    return;
  }

  const client = new AccessTokenGatewayClient({ tokenProvider: provider });
  if (orgMode) client.configureTeamContext(session.teamId, true);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceName = `roles-probe-${stamp}`;
  const createdWorkspaces = new Set<string>();

  try {
    // --- setup: personal workspace, then flip to team visibility ---
    const wsCreate = await gw(client, 'create workspace (personal)', {
      service: 'workspaces', method: 'post', path: '/workspaces',
      body: { name: workspaceName, visibilityStatus: 'personal' }
    });
    const workspaceId = String((wsCreate?.data as JsonRecord | undefined)?.id ?? '').trim();
    if (workspaceId) createdWorkspaces.add(workspaceId);
    if (!workspaceId) { console.log('[abort] no workspace id'); return; }
    console.log(`[setup] workspace ${workspaceId} (orgMode=${orgMode} team=${session.teamId})`);

    await gw(client, 'flip visibility to team', {
      service: 'workspaces', method: 'put', path: `/workspaces/${workspaceId}/visibility`,
      body: { visibilityStatus: 'team' }
    });

    // Baseline: who has roles on the workspace right now (creator = admin)?
    const before = await client.requestJson<JsonRecord>({
      service: 'workspaces', method: 'get', path: `/workspaces/${workspaceId}/roles`,
      query: { include: 'guest' }
    }).catch(() => null);
    console.log(`[baseline roles] ${snippet(before)}`);

    // --- THE PROBE: gateway PATCH /workspaces/:id/roles with string role name ---
    console.log('\n== route 1: workspaces PATCH /roles (string role name WORKSPACE_EDITOR) ==');
    const addOp = await gw(client, 'PATCH /roles add WORKSPACE_EDITOR (self, string name)', {
      service: 'workspaces', method: 'patch', path: `/workspaces/${workspaceId}/roles`,
      body: [{ op: 'add', value: { user: { [session.userId]: ['WORKSPACE_EDITOR'] } } }]
    });

    // Verify: GET /roles should list the actor with the assigned role.
    if (addOp) {
      const after = await client.requestJson<JsonRecord>({
        service: 'workspaces', method: 'get', path: `/workspaces/${workspaceId}/roles`,
        query: { include: 'guest' }
      }).catch(() => null);
      const listing = (after?.listing as JsonRecord | undefined) ?? (after?.data as JsonRecord | undefined) ?? {};
      const userRoles = (listing.user as JsonRecord | undefined) ?? {};
      const selfRole = userRoles[session.userId];
      console.log(`[verify] self roles after add: ${snippet(selfRole)}`);
    }

    // --- contrast: numeric role id (the PMAK shape bootstrap sends today) ---
    console.log('\n== contrast: numeric role id (PMAK shape) ==');
    await gw(client, 'PATCH /roles add numeric 3 (PMAK shape) [contrast]', {
      service: 'workspaces', method: 'patch', path: `/workspaces/${workspaceId}/roles`,
      body: [{ op: 'add', value: { user: { [session.userId]: [3] } } }]
    });

    // --- contrast: the PMAK wrapper shape ({roles:[{op,path,value}]}) ---
    console.log('\n== contrast: PMAK wrapper shape ({roles:[{op,path,value}]}) ==');
    await gw(client, 'PATCH /roles PMAK wrapper [contrast]', {
      service: 'workspaces', method: 'patch', path: `/workspaces/${workspaceId}/roles`,
      body: { roles: [{ op: 'add', path: '/user', value: [{ id: Number(session.userId), role: 3 }] }] }
    });

    // --- route 2: REMOVE op (string role name) ---
    console.log('\n== route 2: workspaces PATCH /roles (REMOVE, string role name) ==');
    await gw(client, 'PATCH /roles remove WORKSPACE_EDITOR (self)', {
      service: 'workspaces', method: 'patch', path: `/workspaces/${workspaceId}/roles`,
      body: [{ op: 'remove', value: { user: { [session.userId]: ['WORKSPACE_EDITOR'] } } }]
    });

    // --- route 3: a second role on the same call (editor) ---
    console.log('\n== route 3: add WORKSPACE_EDITOR_V9 (editor role, string name) ==');
    await gw(client, 'PATCH /roles add WORKSPACE_EDITOR_V9 (self)', {
      service: 'workspaces', method: 'patch', path: `/workspaces/${workspaceId}/roles`,
      body: [{ op: 'add', value: { user: { [session.userId]: ['WORKSPACE_EDITOR_V9'] } } }]
    });

    console.log(`\n[verdict] gateway roles PATCH on ${orgMode ? 'ORG-MODE' : 'NON-ORG'} team ${session.teamId}: see status codes above.`);
  } finally {
    console.log('\n[teardown] deleting created workspaces (gateway DELETE)...');
    for (const id of createdWorkspaces) {
      await gw(client, `DELETE /workspaces/${id}`, {
        service: 'workspaces', method: 'delete', path: `/workspaces/${id}`
      });
    }
  }
  console.log('\n[result] probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
