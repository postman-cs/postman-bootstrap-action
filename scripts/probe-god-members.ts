/**
 * Focused probe: email -> user-id resolution via the access-token gateway.
 *
 * Retires bootstrap's last PMAK `GET /users` (email->id) lookup in
 * `inviteRequesterToWorkspace`. The reference app resolves email->userId
 * client-side against an in-memory `team_users` roster hydrated at session
 * bootstrap (it never calls a backend `?email=` search). The roster itself is
 * fetched over the gateway via the `god` service:
 *
 *   god GET /api/organizations/:teamId/members?populate=membership
 *   -> [{ id, email, name, username, roles, membership }, ...]
 *
 * See postman-reference/postman-app/src/renderer/iam/src/TeamSettings/services/
 * TeamAPIService.js:712 (`fetchUserRolesForListing`). Bootstrap filters the
 * roster by email (case-insensitive) to recover the numeric user id, then feeds
 * it to `workspaces PATCH /roles` (see probe-workspace-roles-gateway.ts).
 *
 * No `?email=` / `?q=` user-search gateway route exists in the reference app;
 * the roster-fetch + client filter IS the access-token equivalent of PMAK
 * `GET /users` + email match.
 *
 * Verified LIVE (disposable sandboxes, 2026-06-30):
 *   [200] god GET /api/organizations/:teamId/members -> {result:'success', data:[{id, name, username, email, roles, profile_pic_url, joined_at, membership}, ...]}
 *   NON-ORG (10490519): 7 members, all carry an email.
 *   ORG-MODE (13347347): 140 members, all carry an email. Full roster in one call (no pagination observed at this size).
 *   The service-account actor itself is NOT in the roster (SAs have no Postman User) -- expected;
 *   bootstrap resolves the REQUESTER's email (a human team member), not the SA's own email.
 *   `populate=membership` is optional (membership is present either way); both shapes return the same member fields.
 *   Contrast (wrong, do not use): `ums`/`identity` /api/organizations/:id/members -> 400 invalidPathError;
 *   `god /api/teams/:id/members` -> 400 invalidPathError (must be /api/organizations/:id/members).
 *
 * Drive against the disposable sandboxes:
 *   set -a && source ../.env && set +a
 *   # non-org (team 10490519):
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_NON_ORG_MODE" \
 *     npx tsx scripts/probe-god-members.ts
 *   # org-mode (team 13347347):
 *   POSTMAN_API_KEY="$POSTMAN_E2E_API_KEY_ORG_MODE" POSTMAN_E2E_TEAM_ID="13347347" \
 *     npx tsx scripts/probe-god-members.ts
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
  if (!session.teamId) { console.log('[abort] no team id'); return; }

  const client = new AccessTokenGatewayClient({ tokenProvider: provider });
  if (orgMode) client.configureTeamContext(session.teamId, true);

  // --- THE PROBE: god GET /api/organizations/:teamId/members ---
  console.log(`\n== god GET /api/organizations/${session.teamId}/members?populate=membership ==`);
  const tryRoute = async (label: string, path: string, query?: Record<string, unknown>): Promise<void> => {
    try {
      const r = await client.request({ service: 'god', method: 'get', path, query });
      const text = await r.text().catch(() => '');
      console.log(`\n[god ${label}] GET ${path} -> ${r.status} :: ${snippet(text)}`);
      try {
        const j = JSON.parse(text) as JsonRecord;
        // Response may be a bare array, or {data:[...]}, or {data:{members:[...]}}.
        const arr: JsonRecord[] = Array.isArray(j)
          ? (j as JsonRecord[])
          : Array.isArray(j?.data)
            ? (j.data as JsonRecord[])
            : Array.isArray((j?.data as JsonRecord)?.members)
              ? ((j.data as JsonRecord).members as JsonRecord[])
              : [];
        console.log(`  members count=${arr.length}`);
        for (const m of arr.slice(0, 8)) {
          console.log(
            `    - id=${m.id} email=${JSON.stringify(m.email)} name=${JSON.stringify(m.name ?? m.username)} roles=${JSON.stringify(m.roles)} membership=${JSON.stringify(m.membership)}`
          );
        }
        // The resolution bootstrap will do: find the actor's own id, then read its email.
        const self = arr.find((m) => String(m.id) === session.userId);
        if (self) {
          console.log(`  [self-resolve] actor id=${session.userId} -> email=${JSON.stringify(self.email)} (roster contains the actor)`);
        } else {
          console.log(`  [self-resolve] actor id=${session.userId} NOT in roster`);
        }
        // Sanity: every member has an id + email?
        const withEmail = arr.filter((m) => typeof m.email === 'string' && m.email).length;
        console.log(`  [shape] ${withEmail}/${arr.length} members carry an email; sample keys=${Object.keys(arr[0] ?? {}).join(',')}`);
      } catch { /* not json */ }
    } catch (error) {
      console.log(`\n[god ${label}] GET ${path} -> ERR ${snippet(error instanceof Error ? error.message : String(error))}`);
    }
  };

  await tryRoute('/api/organizations/:id/members?populate=membership', `/api/organizations/${session.teamId}/members`, { populate: 'membership' });
  await tryRoute('/api/organizations/:id/members (no populate)', `/api/organizations/${session.teamId}/members`);

  // --- contrast: the wrong services the prior "no route" claim might try ---
  console.log('\n== contrast: wrong services/paths (do not use) ==');
  const tryWrong = async (service: string, path: string): Promise<void> => {
    try {
      const r = await client.request({ service, method: 'get', path });
      const text = await r.text().catch(() => '');
      console.log(`  [contrast] ${service} GET ${path} -> ${r.status} :: ${snippet(text)}`);
    } catch (error) {
      console.log(`  [contrast] ${service} GET ${path} -> ERR ${snippet(error instanceof Error ? error.message : String(error))}`);
    }
  };
  await tryWrong('ums', `/api/organizations/${session.teamId}/members`);
  await tryWrong('identity', `/api/organizations/${session.teamId}/members`);
  await tryWrong('god', `/api/teams/${session.teamId}/members`);

  console.log('\n[result] probe complete.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
