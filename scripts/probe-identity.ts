/**
 * Focused probe: access-token team + identity resolution via iapub.
 *
 * Confirms getMe/getTeams can move off PMAK:
 *   - GET https://iapub.postman.co/api/sessions/current  (direct REST, x-access-token)
 *     -> the actions' credential-identity.ts already extracts identity.team + consumerType here.
 *   - gateway service `iapub` GET /api/users/teams  (POST /ws/proxy envelope, x-access-token)
 *     -> the reference-app getTeams equivalent (IAMservice.fetchTeamsOfUser).
 *
 * Drive against the disposable non-org sandbox:
 *   set -a && source ../.env && set +a
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" npx tsx scripts/probe-identity.ts
 *   # org-mode:
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_ORG_MODE" POSTMAN_E2E_TEAM_ID="13347347" npx tsx scripts/probe-identity.ts
 *
 * Verified LIVE (2026-06-30, both non-org team 10490519 AND org-mode team 13347347 SA tokens):
 *   [200] GET https://iapub.postman.co/api/sessions/current  (direct REST, x-access-token)
 *        -> session.identity.{user,team,domain}, session.consumerType='service_account',
 *           session.data.user.{name,roles}.  getMe / team-scope / identity FULLY access-token-resolvable
 *           (already implemented in src/lib/postman/credential-identity.ts:152-219).
 *   [500] GET /api/users/teams  (direct REST AND gateway envelope iapub)  -> UnexpectedError for SA token.
 *        PMAK GET /teams -> 200 in org-mode (returns squad list), 400 "Team feature not available" non-org.
 *        => getTeams (org-mode sub-team/squad enumeration) stays PMAK; iapub /api/users/teams 500s for SA.
 *   [400] gateway envelope iapub GET /api/sessions/current -> invalidPathError (iapub routes are direct
 *        REST to iapub.postman.co, NOT the /ws/proxy envelope).
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const API = POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl;
const IAPUB = POSTMAN_ENDPOINT_PROFILES.prod.iapubBaseUrl;

type JsonRecord = Record<string, unknown>;

function snippet(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, 600).replace(/\s+/g, ' ');
}

function redact(obj: unknown): string {
  // Drop session.token / accessToken before printing.
  const text = JSON.stringify(obj ?? {});
  return text
    .replace(/"(token|accessToken|access_token)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
    .slice(0, 1200);
}

async function main(): Promise<void> {
  const apiKey = process.env.POSTMAN_API_KEY || process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE || '';
  if (!apiKey) {
    console.log('[skip] No POSTMAN_API_KEY / POSTMAN_E2E_API_KEY_NON_ORG_MODE set; skipping.');
    return;
  }

  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: API });
  await provider.refresh();
  const accessToken = provider.current();
  console.log(`[setup] minted access token (len=${accessToken.length})`);

  // Org-mode: pass POSTMAN_E2E_TEAM_ID so iapub/Bifrost get x-entity-team-id.
  const teamId = String(process.env.POSTMAN_E2E_TEAM_ID || '').trim();
  const iapubHeaders: Record<string, string> = { 'x-access-token': accessToken };
  if (teamId) {
    iapubHeaders['x-entity-team-id'] = teamId;
    console.log(`[setup] org-mode: x-entity-team-id=${teamId}`);
  }

  // 1. Direct iapub REST: GET /api/sessions/current  (the actions' existing path).
  console.log('\n== direct iapub REST: GET /api/sessions/current ==');
  try {
    const r = await fetch(`${IAPUB}/api/sessions/current`, {
      method: 'GET',
      headers: iapubHeaders
    });
    const body = await r.text().catch(() => '');
    console.log(`  [${r.status}] direct GET /api/sessions/current :: ${snippet(redact(body))}`);
    try {
      const j = JSON.parse(body) as JsonRecord;
      const root = (j.session as JsonRecord | undefined) ?? j;
      const identity = root.identity as JsonRecord | undefined;
      console.log(`  [extract] identity.team=${identity?.team ?? '?'} consumerType=${root.consumerType ?? '?'} domain=${identity?.domain ?? '?'} user=${identity?.user ?? '?'}`);
    } catch {
      console.log('  [extract] non-JSON body');
    }
  } catch (error) {
    console.log(`  [ERR] direct /api/sessions/current :: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Direct iapub REST: GET /api/users/teams  (getTeams replacement — iapub routes are
  //    direct REST, not the /ws/proxy envelope; /api/sessions/current is direct too).
  console.log('\n== direct iapub REST: GET /api/users/teams ==');
  try {
    const r = await fetch(`${IAPUB}/api/users/teams`, {
      method: 'GET',
      headers: iapubHeaders
    });
    const body = await r.text().catch(() => '');
    console.log(`  [${r.status}] direct GET /api/users/teams :: ${snippet(body)}`);
    try {
      const j = JSON.parse(body) as JsonRecord;
      const arr = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.teams) ? j.teams : [];
      console.log(`  [extract] teams count=${arr.length} :: ${snippet(arr.map((t: unknown) => { const x = t as JsonRecord; return { id: x.id, name: x.name, domain: x.domain }; }))}`);
    } catch {
      console.log('  [extract] non-JSON body');
    }
  } catch (error) {
    console.log(`  [ERR] direct GET /api/users/teams :: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 2b. Gateway envelope: iapub GET /api/users/teams  (reference-app IAMservice path, for contrast).
  const client = new AccessTokenGatewayClient({ tokenProvider: provider });
  if (teamId) {
    client.configureTeamContext(teamId, true);
  }
  console.log('\n== gateway envelope (contrast): iapub GET /api/users/teams ==');
  try {
    const r = await client.request({ service: 'iapub', method: 'get', path: '/api/users/teams' });
    const body = await r.text().catch(() => '');
    console.log(`  [${r.status}] iapub GET /api/users/teams :: ${snippet(body)}`);
    try {
      const j = JSON.parse(body) as JsonRecord;
      const arr = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray((j as JsonRecord).teams) ? (j as JsonRecord).teams : [];
      console.log(`  [extract] teams count=${arr.length} :: ${snippet(arr.map((t: unknown) => { const x = t as JsonRecord; return { id: x.id, name: x.name, domain: x.domain }; }))}`);
    } catch {
      console.log('  [extract] non-JSON body');
    }
  } catch (error) {
    console.log(`  [ERR] iapub GET /api/users/teams :: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 3. Contrast: gateway envelope iapub GET /api/sessions/current (does it also work via envelope?).
  console.log('\n== gateway envelope: iapub GET /api/sessions/current (contrast) ==');
  try {
    const r = await client.request({ service: 'iapub', method: 'get', path: '/api/sessions/current' });
    const body = await r.text().catch(() => '');
    console.log(`  [${r.status}] iapub GET /api/sessions/current :: ${snippet(redact(body))}`);
  } catch (error) {
    console.log(`  [ERR] iapub GET /api/sessions/current :: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 4. PMAK GET /teams contrast (what the actions use today for org-mode sub-team enum).
  console.log('\n== PMAK contrast: GET /teams (api.getpostman.com, X-Api-Key) ==');
  try {
    const r = await fetch(`${API}/teams`, { method: 'GET', headers: { 'X-Api-Key': apiKey } });
    const body = await r.text().catch(() => '');
    console.log(`  [${r.status}] PMAK GET /teams :: ${snippet(body)}`);
  } catch (error) {
    console.log(`  [ERR] PMAK GET /teams :: ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('\n[result] identity probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
