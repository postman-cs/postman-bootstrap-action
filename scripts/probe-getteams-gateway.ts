/** Live-prove bootstrap's access-token getTeams: sub-team (squad) enumeration over
 * the gateway `ums` service, replacing the PMAK `GET /teams`. Drives the real
 * PostmanGatewayAssetsClient.getTeams() (token provider -> gateway -> ums ->
 * mapping) for both sandbox teams. Org-mode returns squads (organizationId set);
 * non-org returns [] (ums 400 "Squad feature is not available").
 *
 *   set -a && source ../.env && set +a
 *   npx tsx scripts/probe-getteams-gateway.ts
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.js';
import { resolveSessionIdentity, __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.js';

const P = POSTMAN_ENDPOINT_PROFILES.prod;

async function run(label: string, apiKey: string): Promise<void> {
  if (!apiKey) { console.log(`[${label}] no key`); return; }
  __resetIdentityMemo();
  const provider = new AccessTokenProvider({ apiKey, apiBaseUrl: P.apiBaseUrl });
  await provider.refresh();
  // The credential preflight memoizes the session identity in production; do the
  // same so getTeams can resolve the org id from it.
  const session = await resolveSessionIdentity({ iapubBaseUrl: P.iapubBaseUrl, accessToken: provider.current() });
  const client = new PostmanGatewayAssetsClient({
    gateway: new AccessTokenGatewayClient({ tokenProvider: provider, bifrostBaseUrl: P.bifrostBaseUrl, teamId: '', orgMode: false })
  });
  const teams = await client.getTeams();
  console.log(`\n[${label}] sessionTeam=${session?.teamId} orgMode=${teams.some((t) => t.organizationId != null)} count=${teams.length}`);
  console.log(`  ${JSON.stringify(teams.slice(0, 3))}`);
}

async function main(): Promise<void> {
  await run('ORG_MODE 13347347', process.env.POSTMAN_E2E_API_KEY_ORG_MODE ?? '');
  await run('NON_ORG 10490519', process.env.POSTMAN_E2E_API_KEY_NON_ORG_MODE ?? '');
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
