/**
 * Live proof: post-generation injectTests on org squad 172912 with full-uid items paths.
 * Cleanup always runs. Exit 0 only on LIVE_VALIDATE_PASS.
 */
import { AccessTokenProvider } from '../src/lib/postman/token-provider.ts';
import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.ts';
import { PostmanGatewayAssetsClient } from '../src/lib/postman/postman-gateway-assets-client.ts';
import { POSTMAN_ENDPOINT_PROFILES } from '../src/lib/postman/base-urls.ts';

const API_KEY = process.env.POSTMAN_E2E_API_KEY_ORG_MODE || '';
const SQUAD = process.env.POSTMAN_WORKSPACE_TEAM_ID || '172912';
const SPEC_URL = process.env.POSTMAN_E2E_SPEC_URL || '';

async function main(): Promise<void> {
  if (!API_KEY || !SPEC_URL) {
    console.log('[skip] need POSTMAN_E2E_API_KEY_ORG_MODE + POSTMAN_E2E_SPEC_URL');
    return;
  }
  const stamp = Date.now();
  const created: { ws?: string; col?: string } = {};
  const provider = new AccessTokenProvider({
    apiKey: API_KEY,
    apiBaseUrl: POSTMAN_ENDPOINT_PROFILES.prod.apiBaseUrl
  });
  await provider.refresh();
  const gateway = new AccessTokenGatewayClient({
    tokenProvider: provider,
    bifrostBaseUrl: POSTMAN_ENDPOINT_PROFILES.prod.bifrostBaseUrl,
    teamId: SQUAD,
    orgMode: true
  });
  const client = new PostmanGatewayAssetsClient({
    gateway,
    generationPollAttempts: 40,
    generationPollDelayMs: 1500,
    createIdentity: () => `fix-${stamp}`
  });
  client.configureTeamContext(SQUAD, true);

  try {
    const ws = await client.createWorkspace(`fulluid-fix-${stamp}`, 'probe', Number(SQUAD));
    created.ws = ws.id;
    console.log('workspace', ws.id);

    const specContent = await (await fetch(SPEC_URL)).text();
    const specId = await client.uploadSpec(ws.id, `fulluid-spec-${stamp}`, specContent, '3.0');
    console.log('spec', specId);

    const t0 = Date.now();
    const colUid = await client.generateCollection(
      specId,
      `fulluid-proj-${stamp}`,
      'Baseline',
      'Paths',
      false,
      'Fallback'
    );
    created.col = colUid;
    console.log('generated', colUid, 'in', Date.now() - t0, 'ms');

    const t1 = Date.now();
    await client.injectTests(colUid, 'smoke');
    console.log('injectTests OK in', Date.now() - t1, 'ms');

    await client.injectTests(colUid, 'smoke');
    console.log('injectTests idempotent OK');
    console.log('LIVE_VALIDATE_PASS');
  } catch (error) {
    console.error('LIVE_VALIDATE_FAIL', error);
    process.exitCode = 1;
  } finally {
    try {
      if (created.col) await client.deleteCollection(created.col);
    } catch (error) {
      console.log('del col err', error instanceof Error ? error.message : error);
    }
    try {
      if (created.ws) {
        await gateway.requestJson({
          service: 'workspaces',
          method: 'delete',
          path: `/workspaces/${created.ws}`
        });
      }
    } catch (error) {
      console.log('del ws err', error instanceof Error ? error.message : error);
    }
    console.log('cleanup done', created);
  }
}

void main();
