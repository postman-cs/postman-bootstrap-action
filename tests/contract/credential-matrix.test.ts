/**
 * Tier-2 contract tests: the credential x team x stack matrix, driving the
 * REAL runAction composition root against the in-memory platform fake. This
 * is the layer that would have caught the 7e2ed70 release bug ({PMAK-only,
 * org} skipped org-mode detection and 403'd on the visibility flip) - and
 * guards against its reintroduction: on the fake, exactly as live, an org
 * account 403s the personal->team flip, so a regression FAILS loudly here.
 */
import { describe, expect, it } from 'vitest';

import { createPlatformFake, DEFAULT_SQUAD } from './platform-fake.js';
import { runContractAction, runWithFakeTimers } from './harness.js';

const PMAK_ONLY = { 'postman-api-key': 'pmak-test', 'postman-access-token': '' };
const TOKEN_ONLY = { 'postman-api-key': '', 'postman-access-token': 'access-token-test' };
const BOTH = { 'postman-api-key': 'pmak-test', 'postman-access-token': 'access-token-test' };

function firstIndex(events: string[], predicate: (entry: string) => boolean): number {
  return events.findIndex(predicate);
}

describe('contract: credential x team matrix', () => {
  it('{PMAK-only, org} mints eagerly, probes squads, creates via the squad path, and NEVER attempts the visibility flip (7e2ed70 regression guard)', async () => {
    const fake = createPlatformFake({ org: true });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: PMAK_ONLY, fetchImpl: fake.fetch }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');

    // Eager mint happened, and before any gateway asset traffic.
    expect(fake.state.mintCount).toBeGreaterThanOrEqual(1);
    const mintIndex = firstIndex(fake.state.events, (entry) =>
      entry.includes('POST') && entry.includes('/service-account-tokens')
    );
    const firstProxyIndex = firstIndex(fake.state.events, (entry) => entry.startsWith('proxy:'));
    expect(mintIndex).toBeGreaterThanOrEqual(0);
    expect(firstProxyIndex).toBeGreaterThan(mintIndex);

    // Org-mode squad probe ran over ums.
    expect(fake.state.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);

    // Workspace was created org-style: squad + team visibility in one POST...
    expect(fake.state.workspaceCreateBodies).toHaveLength(1);
    const body = fake.state.workspaceCreateBodies[0];
    expect(body.squad).toBe(DEFAULT_SQUAD.id);
    expect(body.visibilityStatus).toBe('team');
    // ...and the personal->team flip (which 403s on org accounts) never ran.
    expect(fake.state.flipAttempts).toBe(0);
  });

  it('{PMAK-only, non-org} creates personal then flips to team visibility', async () => {
    const fake = createPlatformFake({ org: false });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: PMAK_ONLY, fetchImpl: fake.fetch }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.mintCount).toBeGreaterThanOrEqual(1);
    expect(fake.state.workspaceCreateBodies[0]?.visibilityStatus).toBe('personal');
    expect(fake.state.workspaceCreateBodies[0]?.squad).toBeUndefined();
    expect(fake.state.flipAttempts).toBe(1);
  });

  it('{token-only, org} skips the mint, probes squads with the provided token, and never flips', async () => {
    const fake = createPlatformFake({ org: true });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: TOKEN_ONLY, fetchImpl: fake.fetch }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.mintCount).toBe(0);
    expect(fake.state.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
    expect(fake.state.workspaceCreateBodies[0]?.squad).toBe(DEFAULT_SQUAD.id);
    expect(fake.state.flipAttempts).toBe(0);
  });

  it('{token-only, non-org} creates personal then flips (no mint available, none needed)', async () => {
    const fake = createPlatformFake({ org: false });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: TOKEN_ONLY, fetchImpl: fake.fetch }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.mintCount).toBe(0);
    expect(fake.state.flipAttempts).toBe(1);
  });

  it('{both, org} uses the provided token (no mint) and the squad create path', async () => {
    const fake = createPlatformFake({ org: true });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: BOTH, fetchImpl: fake.fetch }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.mintCount).toBe(0);
    expect(fake.state.workspaceCreateBodies[0]?.squad).toBe(DEFAULT_SQUAD.id);
    expect(fake.state.flipAttempts).toBe(0);
  });

  it('{both, non-org} creates personal then flips', async () => {
    const fake = createPlatformFake({ org: false });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: BOTH, fetchImpl: fake.fetch }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.flipAttempts).toBe(1);
  });

  it('{PMAK-only, org, beta stack} routes every call to beta hosts', async () => {
    const fake = createPlatformFake({ org: true, stack: 'beta' });
    const result = await runWithFakeTimers(() => runContractAction({
      inputs: { ...PMAK_ONLY, 'postman-stack': 'beta' },
      fetchImpl: fake.fetch
    }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    const fetches = fake.state.events.filter((entry) => entry.startsWith('fetch:'));
    expect(fetches.length).toBeGreaterThan(0);
    const prodHits = fetches.filter(
      (entry) =>
        entry.includes('api.getpostman.com') ||
        entry.includes('bifrost-premium-https-v4.gw.postman.com')
    );
    expect(prodHits).toEqual([]);
    expect(fetches.some((entry) => entry.includes('api.getpostman-beta.com'))).toBe(true);
    expect(fetches.some((entry) => entry.includes('gw.postman-beta.com'))).toBe(true);
  });

  it('{org, multiple squads, no workspace-team-id} fails fast with the squad list before any workspace create', async () => {
    const fake = createPlatformFake({
      org: true,
      squads: [
        DEFAULT_SQUAD,
        { id: 132320, name: 'CSE v13', handle: 'cse-v13', organizationId: 13347347 }
      ]
    });
    const result = await runWithFakeTimers(() => runContractAction({ inputs: BOTH, fetchImpl: fake.fetch }));

    expect(result.error).toBeInstanceOf(Error);
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    expect(message).toContain('Org-mode account detected');
    expect(message).toContain('132319');
    expect(message).toContain('132320');
    expect(message).toContain('workspace-team-id');
    expect(fake.state.workspaceCreateBodies).toHaveLength(0);
  });

  it('{org, explicit workspace-team-id} creates in that sub-team without probT-dependent ambiguity and never flips', async () => {
    const fake = createPlatformFake({
      org: true,
      squads: [
        DEFAULT_SQUAD,
        { id: 132320, name: 'CSE v13', handle: 'cse-v13', organizationId: 13347347 }
      ]
    });
    const result = await runWithFakeTimers(() => runContractAction({
      inputs: { ...BOTH, 'workspace-team-id': '132320' },
      fetchImpl: fake.fetch
    }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.workspaceCreateBodies[0]?.squad).toBe(132320);
    expect(fake.state.flipAttempts).toBe(0);
  });
});
