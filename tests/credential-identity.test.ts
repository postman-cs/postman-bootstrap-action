import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../src/lib/http-error.js';
import { createSecretMasker, REDACTED } from '../src/lib/secrets.js';
import {
  __resetIdentityMemo,
  crossCheckIdentities,
  formatIdentityLine,
  getMemoizedSessionIdentity,
  getSessionResolutionFailure,
  resolvePmakIdentity,
  resolveSessionIdentity,
  runCredentialPreflight,
  type CredentialIdentity
} from '../src/lib/postman/credential-identity.js';
import { adviseFromHttpError } from '../src/lib/postman/error-advice.js';

const API_BASE = 'https://api.getpostman.com';
const IAPUB_BASE = 'https://iapub.postman.co';
const passthroughMask = (value: string) => value;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function meFetch(user: Record<string, unknown> | undefined, status = 200) {
  return vi.fn<typeof fetch>(async () =>
    jsonResponse(status === 200 ? { user } : { error: { name: 'AuthenticationError' } }, status)
  );
}

function sessionFetch(payload: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => jsonResponse(payload, status));
}

function sessionPayload(team: unknown = 13347347): Record<string, unknown> {
  return {
    identity: { team, domain: 'field-services-v12-demo' },
    data: {
      user: {
        id: 999,
        fullName: 'Svc Account',
        roles: ['collection-editor'],
        role: 'member'
      }
    },
    consumerType: 'service_account',
    token: 'session-token-must-never-copy'
  };
}

function pmakIdentity(overrides: Partial<CredentialIdentity> = {}): CredentialIdentity {
  return {
    source: 'pmak/me',
    userId: '12345678',
    fullName: 'Ada Lovelace',
    teamId: '10490519',
    teamName: 'jared-demo',
    teamDomain: 'jared-demo',
    ...overrides
  };
}

function sessionIdentity(overrides: Partial<CredentialIdentity> = {}): CredentialIdentity {
  return {
    source: 'iapub/sessions',
    teamId: '13347347',
    teamDomain: 'field-services-v12-demo',
    roles: ['collection-editor'],
    consumerType: 'service_account',
    ...overrides
  };
}

function createLogCapture() {
  const infos: string[] = [];
  const warnings: string[] = [];
  return {
    infos,
    warnings,
    log: {
      info: (message: string) => {
        infos.push(message);
      },
      warning: (message: string) => {
        warnings.push(message);
      }
    }
  };
}

describe('credential identity', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  it('resolvePmakIdentity returns {userId, teamId, teamName} from /me payload', async () => {
    const fetchImpl = meFetch({
      id: 12345678,
      fullName: 'Ada Lovelace',
      teamId: '10490519',
      teamName: 'jared-demo',
      teamDomain: 'jared-demo'
    });

    const identity = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-case-1',
      fetchImpl
    });

    expect(identity).toMatchObject({
      source: 'pmak/me',
      userId: '12345678',
      fullName: 'Ada Lovelace',
      teamId: '10490519',
      teamName: 'jared-demo',
      teamDomain: 'jared-demo'
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${API_BASE}/me`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-Api-Key': 'pmak-case-1' })
      })
    );
    expect(formatIdentityLine(identity!, passthroughMask)).toBe(
      'postman: PMAK identity - user 12345678 (Ada Lovelace), team 10490519 (jared-demo), domain jared-demo'
    );
  });

  it('resolvePmakIdentity tolerates missing user.teamId (returns identity without teamId)', async () => {
    const identity = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-case-2',
      fetchImpl: meFetch({ id: 42, fullName: 'No Team' })
    });

    expect(identity).toBeDefined();
    expect(identity?.teamId).toBeUndefined();
    expect(identity?.userId).toBe('42');
  });

  it('resolvePmakIdentity coerces a numeric /me user.teamId to a string and leaves a zero/empty teamId undefined', async () => {
    const numeric = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-case-3a',
      fetchImpl: meFetch({ id: 1, teamId: 13347347 })
    });
    expect(numeric?.teamId).toBe('13347347');
    expect(typeof numeric?.teamId).toBe('string');

    const zero = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-case-3b',
      fetchImpl: meFetch({ id: 1, teamId: 0 })
    });
    expect(zero?.teamId).toBeUndefined();

    const empty = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-case-3c',
      fetchImpl: meFetch({ id: 1, teamId: '' })
    });
    expect(empty?.teamId).toBeUndefined();
  });

  it('resolveSessionIdentity reads identity.team, identity.domain, data.user.roles, data.user.role, consumerType from iapub /api/sessions/current', async () => {
    const fetchImpl = sessionFetch(sessionPayload());

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-4',
      fetchImpl
    });

    expect(identity).toMatchObject({
      source: 'iapub/sessions',
      teamId: '13347347',
      teamDomain: 'field-services-v12-demo',
      roles: ['collection-editor'],
      consumerType: 'service_account'
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${IAPUB_BASE}/api/sessions/current`);
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-access-token']).toBe('access-token-case-4');
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(getMemoizedSessionIdentity()?.teamId).toBe('13347347');
    expect(formatIdentityLine(identity!, passthroughMask)).toBe(
      'postman: access-token session identity - team 13347347 (field-services-v12-demo), domain field-services-v12-demo [source: iapub/sessions]'
    );
  });

  it('resolveSessionIdentity unwraps the live iapub shape (session.identity.team, session.data.user)', async () => {
    const fetchImpl = sessionFetch({
      session: {
        status: 'active',
        consumerType: 'service_account',
        identity: { user: 55363555, team: 10490519, domain: 'jared-demo' },
        data: {
          user: {
            name: 'actions-integration-tests',
            teamName: "Jared's Demo",
            roles: ['admin', 'user'],
            role: 'admin'
          }
        },
        token: 'session-token-must-never-copy'
      }
    });

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-wrapped',
      fetchImpl
    });

    expect(identity).toMatchObject({
      source: 'iapub/sessions',
      userId: '55363555',
      teamId: '10490519',
      teamName: "Jared's Demo",
      teamDomain: 'jared-demo',
      roles: ['admin', 'user'],
      consumerType: 'service_account'
    });
    expect(JSON.stringify(identity)).not.toContain('session-token-must-never-copy');
    expect(formatIdentityLine(identity!, passthroughMask)).toBe(
      "postman: access-token session identity - team 10490519 (Jared's Demo), domain jared-demo [source: iapub/sessions]"
    );
  });

  it('resolveSessionIdentity coerces a numeric identity.team to a string (raw ? String(raw) : undefined)', async () => {
    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-5',
      fetchImpl: sessionFetch(sessionPayload(13347347))
    });
    expect(identity?.teamId).toBe('13347347');
    expect(typeof identity?.teamId).toBe('string');

    const zero = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-5b',
      fetchImpl: sessionFetch(sessionPayload(0))
    });
    expect(zero?.teamId).toBeUndefined();
  });

  it('resolveSessionIdentity never exposes session.token in the returned struct', async () => {
    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-6',
      fetchImpl: sessionFetch({
        ...sessionPayload(),
        token: 'session-token-must-never-copy',
        data: {
          user: {
            id: 999,
            roles: ['collection-editor'],
            token: 'session-token-must-never-copy'
          }
        }
      })
    });

    expect(identity).toBeDefined();
    expect('token' in identity!).toBe(false);
    expect(JSON.stringify(identity)).not.toContain('session-token-must-never-copy');
    expect(formatIdentityLine(identity!, passthroughMask)).not.toContain(
      'session-token-must-never-copy'
    );
  });

  it('resolveSessionIdentity returns undefined and does not throw on non-2xx', async () => {
    const rejected = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-7',
      fetchImpl: sessionFetch({ error: 'denied' }, 404)
    });
    expect(rejected).toBeUndefined();

    const network = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-7b',
      fetchImpl: vi.fn<typeof fetch>(async () => {
        throw new Error('network down');
      }),
      sleepImpl: async () => undefined,
      randomImpl: () => 0
    });
    expect(network).toBeUndefined();
  });

  it('crossCheckIdentities passes when pmak.teamId === session.teamId (incl. org-mode parent==parent, no getTeams needed)', () => {
    const result = crossCheckIdentities({
      pmak: pmakIdentity({ teamId: '13347347', teamName: 'field-services-v12-demo' }),
      session: sessionIdentity({ teamId: '13347347' }),
      mode: 'enforce',
      mask: passthroughMask
    });

    expect(result.ok).toBe(true);
    expect(result.level).toBe('ok');
    expect(result.message).toBe(
      'postman: credential preflight OK - PMAK and access token both resolve to team 13347347 (field-services-v12-demo)'
    );

    const orgScoped = crossCheckIdentities({
      pmak: pmakIdentity({ teamId: '13347347', teamName: 'field-services-v12-demo' }),
      session: sessionIdentity({ teamId: '13347347' }),
      workspaceTeamId: '132319',
      mode: 'enforce',
      mask: passthroughMask
    });
    expect(orgScoped.level).toBe('ok');
    expect(orgScoped.message).toBe(
      'postman: credential preflight OK - PMAK and access token both resolve to parent org team 13347347 (field-services-v12-demo)'
    );
  });

  it('crossCheckIdentities treats a numeric session.identity.team and a string pmak.teamId of the same value as EQUAL (no NOTE under warn, no FAIL under enforce) - regression for iapub returning identity.team as a JSON number', async () => {
    const session = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'access-token-case-9',
      fetchImpl: sessionFetch(sessionPayload(13347347))
    });

    const underWarn = crossCheckIdentities({
      pmak: pmakIdentity({ teamId: '13347347' }),
      session,
      mode: 'warn',
      mask: passthroughMask
    });
    expect(underWarn.level).toBe('ok');
    expect(underWarn.ok).toBe(true);

    const underEnforce = crossCheckIdentities({
      pmak: pmakIdentity({ teamId: '13347347' }),
      session,
      mode: 'enforce',
      mask: passthroughMask
    });
    expect(underEnforce.level).toBe('ok');
    expect(underEnforce.ok).toBe(true);
  });

  it('crossCheckIdentities FAILS under enforce with both identities named when both teamIds present and parent orgs differ', () => {
    const result = crossCheckIdentities({
      pmak: pmakIdentity(),
      session: sessionIdentity(),
      mode: 'enforce',
      mask: passthroughMask
    });

    expect(result.ok).toBe(false);
    expect(result.level).toBe('fail');
    expect(result.message).toContain('credential preflight FAILED');
    expect(result.message).toContain('10490519');
    expect(result.message).toContain('jared-demo');
    expect(result.message).toContain('13347347');
    expect(result.message).toContain('field-services-v12-demo');
    expect(result.message).toContain('re-mint the access token');
  });

  it('FAIL never fires when either teamId is undefined or empty', () => {
    const combos: Array<[CredentialIdentity | undefined, CredentialIdentity | undefined]> = [
      [pmakIdentity({ teamId: undefined }), sessionIdentity()],
      [pmakIdentity(), sessionIdentity({ teamId: undefined })],
      [pmakIdentity({ teamId: '' }), sessionIdentity()],
      [pmakIdentity(), sessionIdentity({ teamId: '' })],
      [pmakIdentity({ teamId: undefined }), sessionIdentity({ teamId: undefined })],
      [undefined, sessionIdentity()],
      [pmakIdentity(), undefined]
    ];

    for (const [pmak, session] of combos) {
      const result = crossCheckIdentities({
        pmak,
        session,
        mode: 'enforce',
        mask: passthroughMask
      });
      expect(result.level).toBe('note');
      expect(result.level).not.toBe('fail');
    }
  });

  it('crossCheckIdentities does NOT FAIL when both sides report the same parent org id even if workspace-team-id names a different sub-team (documented limitation; reactive layer covers it)', () => {
    const result = crossCheckIdentities({
      pmak: pmakIdentity({ teamId: '13347347' }),
      session: sessionIdentity({ teamId: '13347347' }),
      workspaceTeamId: '132109',
      mode: 'enforce',
      mask: passthroughMask
    });

    expect(result.level).toBe('ok');
    expect(result.ok).toBe(true);
  });

  it('default mode warn: a parent-org mismatch logs a NOTE and returns ok=false level=note, never throws', async () => {
    const result = crossCheckIdentities({
      pmak: pmakIdentity(),
      session: sessionIdentity(),
      mode: 'warn',
      mask: passthroughMask
    });
    expect(result.ok).toBe(false);
    expect(result.level).toBe('note');
    expect(result.message).toContain('credential preflight note');
    expect(result.message).toContain('Set credential-preflight: enforce');

    const capture = createLogCapture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({
          user: { id: 1, fullName: 'Ada Lovelace', teamId: 10490519, teamName: 'jared-demo' }
        });
      }
      return jsonResponse(sessionPayload(13347347));
    });
    await expect(
      runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-case-13',
        postmanAccessToken: 'access-token-case-13',
        mode: 'warn',
        mask: passthroughMask,
        log: capture.log,
        fetchImpl
      })
    ).resolves.toBeUndefined();
    expect(
      capture.warnings.some((entry) => entry.includes('credential preflight note'))
    ).toBe(true);
  });

  it('crossCheckIdentities respects mode=enforce (throws on parent-org mismatch) and mode=warn (downgrades to note)', async () => {
    expect(
      crossCheckIdentities({
        pmak: pmakIdentity(),
        session: sessionIdentity(),
        mode: 'enforce',
        mask: passthroughMask
      }).level
    ).toBe('fail');
    expect(
      crossCheckIdentities({
        pmak: pmakIdentity(),
        session: sessionIdentity(),
        mode: 'warn',
        mask: passthroughMask
      }).level
    ).toBe('note');
    const mismatchFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({ user: { id: 1, teamId: 10490519, teamName: 'jared-demo' } });
      }
      return jsonResponse(sessionPayload(13347347));
    });
    const enforceCapture = createLogCapture();
    await expect(
      runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-case-14',
        postmanAccessToken: 'access-token-case-14',
        mode: 'enforce',
        mask: passthroughMask,
        log: enforceCapture.log,
        fetchImpl: mismatchFetch
      })
    ).rejects.toThrow(/credential preflight FAILED.*10490519.*13347347/s);

  });

  it('warns when postman-access-token is a user/session token instead of a service-account token', async () => {
    const capture = createLogCapture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({ user: { id: 1, teamId: 10490519, teamName: 'jared-demo' } });
      }
      return jsonResponse({
        identity: { team: 10490519, domain: 'jared-demo' },
        data: { user: { id: 999, fullName: 'Ada Lovelace' } },
        consumerType: 'user'
      });
    });

    await runCredentialPreflight({
      apiBaseUrl: API_BASE,
      iapubBaseUrl: IAPUB_BASE,
      postmanApiKey: 'pmak-user-token',
      postmanAccessToken: 'access-token-user-token',
      mode: 'warn',
      mask: passthroughMask,
      log: capture.log,
      fetchImpl
    });

    expect(
      capture.warnings.some((entry) =>
        entry.includes('deprecation warning') &&
        entry.includes('consumerType user') &&
        entry.includes('postman-cs/postman-resolve-service-token-action')
      )
    ).toBe(true);
  });

  it('formatIdentityLine masks token-shaped secret values', () => {
    const mask = createSecretMasker(['fake-token-abc123']);
    const line = formatIdentityLine(
      pmakIdentity({ teamName: 'fake-token-abc123' }),
      mask
    );

    expect(line).toContain(REDACTED);
    expect(line).not.toContain('fake-token-abc123');
  });

  it('formatIdentityLine and adviseFromHttpError mask internally: a fed fake-token secret returns [REDACTED] in the emitted/returned string even when the caller does NOT pre-wrap it', () => {
    const mask = createSecretMasker(['fake-token-abc123']);

    const line = formatIdentityLine(
      sessionIdentity({ teamDomain: 'fake-token-abc123' }),
      mask
    );
    expect(line).toContain(REDACTED);
    expect(line).not.toContain('fake-token-abc123');

    const httpErr = new HttpError({
      method: 'POST',
      url: 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy',
      status: 403,
      statusText: 'Forbidden',
      responseBody: 'You are not authorized to perform this action'
    });
    const advised = adviseFromHttpError(httpErr, {
      operation: 'governance assignment',
      hasAccessToken: true,
      workspaceTeamId: 'fake-token-abc123',
      mask
    });
    expect(advised).toBeDefined();
    expect(advised?.message).toContain(REDACTED);
    expect(advised?.message).not.toContain('fake-token-abc123');
  });

  it("__resetIdentityMemo lets a second case inject a DIFFERENT /me teamId: after case 1 resolves teamId A, reset, then case 2 injects teamId B and sees B (case 1's memo did not leak)", async () => {
    const first = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-memo-case',
      fetchImpl: meFetch({ id: 1, teamId: '11111111' })
    });
    expect(first?.teamId).toBe('11111111');

    const secondFetch = meFetch({ id: 1, teamId: '22222222' });
    const memoized = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-memo-case',
      fetchImpl: secondFetch
    });
    expect(memoized?.teamId).toBe('11111111');
    expect(secondFetch).not.toHaveBeenCalled();

    __resetIdentityMemo();
    const second = await resolvePmakIdentity({
      apiBaseUrl: API_BASE,
      apiKey: 'pmak-memo-case',
      fetchImpl: secondFetch
    });
    expect(second?.teamId).toBe('22222222');
    expect(secondFetch).toHaveBeenCalledTimes(1);
  });
});

describe('event-based session retry', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  function sessionSequence(steps: Array<() => Response>) {
    let n = 0;
    return vi.fn<typeof fetch>(async () => {
      const step = steps[Math.min(n, steps.length - 1)];
      n += 1;
      return step();
    });
  }

  it('retries a transient 5xx and resolves on a later attempt, waiting the full-jitter delay via the injected clock', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([
      () => new Response('server error', { status: 503 }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-5xx',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0.5
    });

    expect(identity?.teamId).toBe('13347347');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // No server signal on the 503, so full jitter: round(0.5 * min(8000, 500*2^0)) = 250.
    expect(sleeps).toEqual([250]);
    expect(getSessionResolutionFailure()).toBeUndefined();
  });

  it('honors a Retry-After (delta-seconds) header on 429 instead of jitter', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after-secs',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      // A high rng would dominate if jitter were used; proves the header wins.
      randomImpl: () => 0.99
    });

    expect(identity?.teamId).toBe('13347347');
    expect(sleeps).toEqual([2000]);
  });

  it('honors a Retry-After HTTP-date header (converted to a positive delta)', async () => {
    const sleeps: number[] = [];
    const future = new Date(Date.now() + 5000).toUTCString();
    const fetchImpl = sessionSequence([
      () => new Response('slow', { status: 503, headers: { 'retry-after': future } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after-date',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0
    });

    expect(identity?.teamId).toBe('13347347');
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(5000);
  });

  it('falls back to RateLimit-Reset (seconds) when no Retry-After is present', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([
      () => new Response('limited', { status: 503, headers: { 'ratelimit-reset': '3' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'ratelimit-reset',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0.99
    });

    expect(identity?.teamId).toBe('13347347');
    expect(sleeps).toEqual([3000]);
  });

  it('clamps a rogue large Retry-After to the max delay so CI cannot stall', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([
      () => new Response('slow', { status: 503, headers: { 'retry-after': '9999' } }),
      () => jsonResponse(sessionPayload(13347347))
    ]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'retry-after-huge',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 0
    });

    expect(identity?.teamId).toBe('13347347');
    expect(sleeps).toEqual([8000]);
  });

  it('does NOT retry or sleep on 401 and classifies the failure as auth', async () => {
    const sleeps: number[] = [];
    const fetchImpl = sessionSequence([() => new Response('nope', { status: 401 })]);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'auth-401',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      }
    });

    expect(identity).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleeps).toHaveLength(0);
    expect(getSessionResolutionFailure()).toBe('auth');
  });

  it('retries network failures up to maxAttempts then classifies unavailable', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('network down');
    });

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'net-fail',
      fetchImpl,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      randomImpl: () => 1
    });

    expect(identity).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Two waits between three attempts; full jitter ceilings 500 then 1000 at rng=1.
    expect(sleeps).toEqual([500, 1000]);
    expect(getSessionResolutionFailure()).toBe('unavailable');
  });

  it('runCredentialPreflight enforce FAILS closed when the session stays unresolved (auth), naming the re-mint fix', async () => {
    const capture = createLogCapture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({ user: { id: 1, teamId: 10490519, teamName: 'jared-demo' } });
      }
      return new Response('expired', { status: 401 });
    });

    await expect(
      runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-enforce-unresolved',
        postmanAccessToken: 'access-token-expired',
        mode: 'enforce',
        mask: passthroughMask,
        log: capture.log,
        fetchImpl,
        sleepImpl: async () => undefined
      })
    ).rejects.toThrow(/enforce requires a resolvable session identity/);
  });

  it('runCredentialPreflight warn continues when the session stays unresolved (unavailable), naming the transient cause', async () => {
    const capture = createLogCapture();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return jsonResponse({ user: { id: 1, teamId: 10490519, teamName: 'jared-demo' } });
      }
      return new Response('unavailable', { status: 503 });
    });

    await expect(
      runCredentialPreflight({
        apiBaseUrl: API_BASE,
        iapubBaseUrl: IAPUB_BASE,
        postmanApiKey: 'pmak-warn-unresolved',
        postmanAccessToken: 'access-token-transient',
        mode: 'warn',
        mask: passthroughMask,
        log: capture.log,
        fetchImpl,
        sleepImpl: async () => undefined,
        randomImpl: () => 0
      })
    ).resolves.toBeUndefined();

    expect(
      capture.warnings.some((entry) => entry.includes('iapub was unreachable after retries'))
    ).toBe(true);
  });
});
