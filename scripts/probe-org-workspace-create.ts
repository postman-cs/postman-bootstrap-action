/**
 * Merge gate: org-mode workspace create via direct squad POST (not personal→flip).
 *
 * Org service accounts 403 on the visibility flip (`addWorkspaceLevelTeamRoles`);
 * bootstrap's org path mirrors WorkspaceService.createDraftWorkspace:
 *
 *   POST /workspaces
 *   body: { name, visibilityStatus: 'team', squad: <subTeamId>,
 *           roles: { group: { <subTeamId>: ['WORKSPACE_VIEWER_V9'] } } }
 *
 * with x-entity-team-id set to the same sub-team id.
 *
 * Run against the org-mode disposable sandbox:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_ORG_MODE" \
 *     POSTMAN_E2E_TEAM_ID="132319" \
 *     POSTMAN_WORKSPACE_TEAM_ID="132319" \
 *     npx tsx scripts/probe-org-workspace-create.ts
 *
 * Merge criterion for access-token-migration: this probe passes AND org-mode e2e
 * passes locally with sibling actions on the migration branch.
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
): Promise<{ status: number; body: JsonRecord | null }> {
  try {
    const response = await client.request(request);
    const text = await response.text().catch(() => '');
    console.log(`  [${response.status}] ${label} (${request.service} ${request.method} ${request.path}) :: ${snippet(text)}`);
    try {
      return { status: response.status, body: text.trim() ? (JSON.parse(text) as JsonRecord) : null };
    } catch {
      return { status: response.status, body: null };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(`  [ERR] ${label} (${request.service} ${request.method} ${request.path}) :: ${snippet(msg)}`);
    return { status: 0, body: null };
  }
}

async function resolveSession(accessToken: string, teamId: string): Promise<{ teamId: string }> {
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
    const resolvedTeam = String(identity.team ?? teamId ?? '').trim();
    console.log(`[session] teamId=${resolvedTeam} consumerType=${root.consumerType ?? ''}`);
    return { teamId: resolvedTeam };
  } catch {
    console.log(`[session] parse failed :: ${snippet(body)}`);
    return { teamId };
  }
}

async function main(): Promise<void> {
  const apiKey =
    process.env.POSTMAN_API_KEY ||
    process.env.POSTMAN_E2E_API_KEY_ORG_MODE ||
    process.env.POSTMAN_E2E_API_KEY ||
    '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_ORG_MODE set; skipping.');
    return;
  }

  const squadId = String(
    process.env.POSTMAN_WORKSPACE_TEAM_ID || process.env.POSTMAN_E2E_TEAM_ID || ''
  ).trim();
  if (!squadId) {
    console.log('[abort] Set POSTMAN_WORKSPACE_TEAM_ID or POSTMAN_E2E_TEAM_ID to the org sub-team (squad) id.');
    process.exitCode = 1;
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const accessToken = provider.current();
  const session = await resolveSession(accessToken, squadId);
  if (!session.teamId) {
    console.log('[abort] could not resolve teamId from session');
    process.exitCode = 1;
    return;
  }

  const client = new AccessTokenGatewayClient({ tokenProvider: provider });
  client.configureTeamContext(squadId, true);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workspaceName = `org-create-probe-${stamp}`;

  console.log(`\n== direct org create (squad ${squadId}, x-entity-team-id ${squadId}) ==`);
  const direct = await gw(client, 'POST /workspaces (team + squad + group roles)', {
    service: 'workspaces',
    method: 'post',
    path: '/workspaces',
    body: {
      name: workspaceName,
      visibilityStatus: 'team',
      squad: squadId,
      roles: { group: { [squadId]: ['WORKSPACE_VIEWER_V9'] } }
    }
  });
  const workspaceId = String((direct.body?.data as JsonRecord | undefined)?.id ?? '').trim();

  if (direct.status !== 200 || !workspaceId) {
    console.log('\n[FAIL] direct org create did not return 200 + workspace id');
    process.exitCode = 1;
    return;
  }

  const read = await gw(client, 'GET /workspaces/:id (verify team visibility)', {
    service: 'workspaces',
    method: 'get',
    path: `/workspaces/${workspaceId}`
  });
  const visibility = String(
    (read.body?.data as JsonRecord | undefined)?.visibility ??
      (read.body?.data as JsonRecord | undefined)?.visibilityStatus ??
      ''
  ).trim();

  if (visibility !== 'team') {
    console.log(`\n[FAIL] workspace ${workspaceId} visibility is '${visibility || 'unknown'}', expected team`);
    await gw(client, 'DELETE /workspaces/:id (cleanup)', {
      service: 'workspaces',
      method: 'delete',
      path: `/workspaces/${workspaceId}`
    });
    process.exitCode = 1;
    return;
  }

  console.log(`\n[PASS] direct org create: workspace ${workspaceId} visibility=team`);

  // Contrast: flip-only path (documents why bootstrap must not use this in org-mode).
  console.log('\n== contrast: personal create + team flip (expected 403 in org-mode) ==');
  const flipName = `org-flip-probe-${stamp}`;
  const personal = await gw(client, 'POST /workspaces (personal)', {
    service: 'workspaces',
    method: 'post',
    path: '/workspaces',
    body: { name: flipName, visibilityStatus: 'personal' }
  });
  const flipWsId = String((personal.body?.data as JsonRecord | undefined)?.id ?? '').trim();
  if (flipWsId) {
    const flip = await gw(client, 'PUT /workspaces/:id/visibility (team)', {
      service: 'workspaces',
      method: 'put',
      path: `/workspaces/${flipWsId}/visibility`,
      body: { visibilityStatus: 'team' }
    });
    if (flip.status === 403) {
      console.log('[expected] org-mode flip 403 — direct squad create is the correct path');
    }
    await gw(client, 'DELETE /workspaces/:id (flip contrast cleanup)', {
      service: 'workspaces',
      method: 'delete',
      path: `/workspaces/${flipWsId}`
    });
  }

  await gw(client, 'DELETE /workspaces/:id (direct create cleanup)', {
    service: 'workspaces',
    method: 'delete',
    path: `/workspaces/${workspaceId}`
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
