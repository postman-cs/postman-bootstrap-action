/**
 * Focused probe: enumerate org sub-teams (squads) via the access-token gateway.
 *
 * Refutes "NO access-token route enumerates org sub-teams; iapub /api/users/teams 500s,
 * every /squads|/groups|/teams candidate 400s." That claim probed the WRONG service/path:
 *   - iapub GET /api/users/teams  -> 500 (wrong service for squad enumeration)
 *   - bare /squads, /groups, /teams -> 400 (missing the /api/teams/<teamId> prefix)
 *
 * The reference app (desktop SquadsBrowsing) enumerates squads via the `ums` service
 * through the /ws/proxy envelope: GET /api/teams/<orgTeamId>/squads?settings=true&userRoles=true
 * -> {data:[{id, name, handle, organizationId, memberCount, roles, settings}, ...]}.
 * `<orgTeamId>` is the parent org team id from iapub `/api/sessions/current`
 * (`session.identity.team`). This is the access-token equivalent of PMAK `GET /teams`.
 *
 * Drive against the disposable sandbox:
 *   # org-mode (team 13347347, field-services-v12-demo — has sub-teams):
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_ORG_MODE" POSTMAN_E2E_TEAM_ID="13347347" \
 *     npx tsx scripts/probe-teams-ums.ts
 *   # non-org (team 10490519, jared-demo — no sub-teams; expect empty/400):
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/probe-teams-ums.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const IAPUB = POSTMAN_ENDPOINT_PROFILES.prod.iapubBaseUrl;
const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 800).replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY set; skipping.');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const accessToken = provider.current();
  const teamId = String(process.env.POSTMAN_E2E_TEAM_ID || '').trim();
  const orgMode = Boolean(teamId);
  console.log(`[setup] orgMode=${orgMode} teamId=${teamId || '(inferred)'}`);

  // 1. Resolve the org/team id from the iapub session identity.
  let sessionTeamId = teamId;
  {
    const r = await fetch(`${IAPUB}/api/sessions/current`, {
      method: 'GET',
      headers: { 'x-access-token': accessToken, ...(teamId ? { 'x-entity-team-id': teamId } : {}) }
    });
    const body = await r.text().catch(() => '');
    console.log(`[session] GET /api/sessions/current -> ${r.status}`);
    try {
      const j = JSON.parse(body) as JsonRecord;
      const identity = ((j.session as JsonRecord)?.identity as JsonRecord) ?? {};
      sessionTeamId = String(identity.team ?? teamId ?? '').trim();
      console.log(`[session] identity.team=${sessionTeamId} domain=${identity.domain ?? ''} consumerType=${(j.session as JsonRecord)?.consumerType ?? ''}`);
    } catch {
      console.log(`[session] parse failed :: ${snippet(body)}`);
    }
  }
  if (!sessionTeamId) { console.log('[abort] no team id'); return; }

  const client = new AccessTokenGatewayClient({ tokenProvider: provider });
  if (orgMode) client.configureTeamContext(sessionTeamId, true);

  // 2. The squad-enumeration route the reference app uses: ums GET /api/teams/<teamId>/squads.
  const tryRoute = async (label: string, path: string): Promise<void> => {
    try {
      const r = await client.request({
        service: 'ums', method: 'get', path
      });
      const text = await r.text().catch(() => '');
      console.log(`\n[ums ${label}] GET ${path} -> ${r.status} :: ${snippet(text)}`);
      try {
        const j = JSON.parse(text) as JsonRecord;
        const data = j.data;
        if (Array.isArray(data)) {
          console.log(`  squads count=${data.length}`);
          for (const s of (data as JsonRecord[]).slice(0, 12)) {
            console.log(`    - id=${s.id} name=${JSON.stringify(s.name)} handle=${JSON.stringify(s.handle)} organizationId=${s.organizationId} memberCount=${s.memberCount}`);
          }
          const orgIds = new Set((data as JsonRecord[]).map((s) => s.organizationId));
          console.log(`  distinct organizationIds: ${[...orgIds].join(',')}`);
        }
      } catch { /* not json */ }
    } catch (error) {
      console.log(`\n[ums ${label}] GET ${path} -> ERR ${snippet(error instanceof Error ? error.message : String(error))}`);
    }
  };

  await tryRoute('/api/teams/<id>/squads', `/api/teams/${sessionTeamId}/squads?settings=true&userRoles=true`);
  await tryRoute('/api/teams/<id>/squads (bare)', `/api/teams/${sessionTeamId}/squads`);

  // 3. Contrast: the wrong routes the other agent tried.
  const tryWrong = async (service: string, path: string): Promise<void> => {
    try {
      const r = await client.request({ service, method: 'get', path });
      const text = await r.text().catch(() => '');
      console.log(`\n[contrast] ${service} GET ${path} -> ${r.status} :: ${snippet(text)}`);
    } catch (error) {
      console.log(`\n[contrast] ${service} GET ${path} -> ERR ${snippet(error instanceof Error ? error.message : String(error))}`);
    }
  };
  await tryWrong('iapub', '/api/users/teams');
  await tryWrong('ums', '/squads');
  await tryWrong('ums', '/teams');

  console.log('\n[result] probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
