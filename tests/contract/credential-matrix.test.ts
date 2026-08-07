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
    expect(fake.state.flipAttempts).toBe(0);
  });

  // --- squad discovery must fail closed (org account, no workspace-team-id) ---
  //
  // Each cell replaces the ums squads read with a terminal outcome that is NOT
  // the recognized non-org sentinel. Discovery is indeterminate, so the run must
  // fail BEFORE any workspace exists: zero creates, zero visibility flips. The
  // old fail-open contract read every one of these as 'not org-mode' and then
  // 403'd on PUT /workspaces/:id/visibility after creating (and deleting) a
  // workspace, which is the incident this closes.
  function orgFakeWithSquadOutcome(respond: () => Response) {
    return createPlatformFake({
      org: true,
      override: ({ proxy }) => {
        if (proxy?.service === 'ums' && /\/squads/.test(proxy.path)) {
          return respond();
        }
        return undefined;
      }
    });
  }

  async function expectSquadDiscoveryFailsClosed(
    fake: ReturnType<typeof createPlatformFake>
  ): Promise<string> {
    const result = await runWithFakeTimers(() =>
      runContractAction({ inputs: BOTH, fetchImpl: fake.fetch })
    );

    expect(result.error).toBeInstanceOf(Error);
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    expect(message).toContain('workspace-team-id');
    // No workspace may be created, and no flip attempted, when org-mode is unknown.
    expect(fake.state.workspaceCreateBodies).toEqual([]);
    expect(fake.state.flipAttempts).toBe(0);
    return message;
  }

  it('{org, squads 403, no workspace-team-id} fails before any workspace create and names workspace-team-id', async () => {
    const fake = orgFakeWithSquadOutcome(
      () =>
        new Response(JSON.stringify({ message: 'You are not authorized to perform this action' }), {
          status: 403
        })
    );
    const message = await expectSquadDiscoveryFailsClosed(fake);
    expect(message).toContain('403');
    expect(message).toContain('POSTMAN_WORKSPACE_TEAM_ID');
    expect(message).toContain('--workspace-team-id');
  }, 30000);

  // The gateway retries safe GETs three times on 5xx before the classifier ever
  // sees a terminal outcome, so this cell walks the whole retry ladder and needs
  // headroom above vitest's 5s default.
  it('{org, squads terminal 5xx, no workspace-team-id} fails before any workspace create', async () => {
    const fake = orgFakeWithSquadOutcome(
      () => new Response(JSON.stringify({ message: 'internal error' }), { status: 503 })
    );
    const message = await expectSquadDiscoveryFailsClosed(fake);
    expect(message).toContain('503');
  }, 30000);

  it('{org, squads 400 with an unrecognized body, no workspace-team-id} fails instead of degrading', async () => {
    const fake = orgFakeWithSquadOutcome(
      () =>
        new Response(JSON.stringify({ message: 'settings query parameter is invalid' }), {
          status: 400
        })
    );
    const message = await expectSquadDiscoveryFailsClosed(fake);
    expect(message).toContain('400');
  }, 30000);

  it('{org, squads malformed non-array body, no workspace-team-id} fails before any workspace create', async () => {
    const fake = orgFakeWithSquadOutcome(
      () => new Response(JSON.stringify({ data: { id: 132319, name: 'CSE v12' } }), { status: 200 })
    );
    await expectSquadDiscoveryFailsClosed(fake);
  }, 30000);

  it('{org, squads 200 with an empty data array, no workspace-team-id} fails before any workspace create', async () => {
    const fake = orgFakeWithSquadOutcome(
      () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    );
    await expectSquadDiscoveryFailsClosed(fake);
  }, 30000);

  it('{org, squad row missing a usable id or name, no workspace-team-id} fails before any workspace create', async () => {
    const fake = orgFakeWithSquadOutcome(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 132319, name: 'CSE v12', organizationId: 13347347 },
              { name: '', organizationId: 13347347 }
            ]
          }),
          { status: 200 }
        )
    );
    await expectSquadDiscoveryFailsClosed(fake);
  }, 30000);

  it('{org, squad row that is null, no workspace-team-id} fails before any workspace create or flip', async () => {
    const fake = orgFakeWithSquadOutcome(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 132319, name: 'CSE v12', organizationId: 13347347 },
              null
            ]
          }),
          { status: 200 }
        )
    );
    await expectSquadDiscoveryFailsClosed(fake);
  }, 30000);

  it('{non-org, recognized squads 400 sentinel} still degrades to the personal-then-flip path', async () => {
    const fake = createPlatformFake({
      org: false,
      override: ({ proxy }) => {
        if (proxy?.service === 'ums' && /\/squads/.test(proxy.path)) {
          return new Response(
            JSON.stringify({ message: 'Squad feature is not available for your team.' }),
            { status: 400 }
          );
        }
        return undefined;
      }
    });
    const result = await runWithFakeTimers(() =>
      runContractAction({ inputs: BOTH, fetchImpl: fake.fetch })
    );

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.workspaceCreateBodies[0]?.visibilityStatus).toBe('personal');
    expect(fake.state.workspaceCreateBodies[0]?.squad).toBeUndefined();
    expect(fake.state.flipAttempts).toBe(1);
  }, 30000);

  it('{org, squads 403, workspace-id reuse} keeps working because discovery is skipped entirely', async () => {
    const fake = orgFakeWithSquadOutcome(
      () =>
        new Response(JSON.stringify({ message: 'You are not authorized to perform this action' }), {
          status: 403
        })
    );
    const result = await runWithFakeTimers(() =>
      runContractAction({
        inputs: { ...BOTH, 'workspace-id': 'ws-contract' },
        fetchImpl: fake.fetch
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.workspaceCreateBodies).toEqual([]);
    expect(fake.state.flipAttempts).toBe(0);
  }, 30000);

  it('{org, explicit workspace-team-id} creates in that sub-team even when ums squads returns 403 and never flips', async () => {
    const fake = createPlatformFake({
      org: true,
      squads: [
        DEFAULT_SQUAD,
        { id: 132320, name: 'CSE v13', handle: 'cse-v13', organizationId: 13347347 }
      ],
      override: ({ proxy }) => {
        if (proxy?.service === 'ums' && /\/squads/.test(proxy.path)) {
          return new Response(
            JSON.stringify({ message: 'You are not authorized to perform this action' }),
            { status: 403 }
          );
        }
        return undefined;
      }
    });
    const result = await runWithFakeTimers(() => runContractAction({
      inputs: { ...BOTH, 'workspace-team-id': '132320' },
      fetchImpl: fake.fetch
    }));

    expect(result.error).toBeUndefined();
    expect(result.outputs['workspace-id']).toBe('ws-contract');
    expect(fake.state.workspaceCreateBodies[0]?.squad).toBe(132320);
    expect(fake.state.flipAttempts).toBe(0);
    expect(fake.state.events.some((entry) => entry.startsWith('proxy:ums'))).toBe(true);
  });
});