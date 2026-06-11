import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../src/lib/http-error.js';
import { createSecretMasker, REDACTED } from '../src/lib/secrets.js';
import {
  __resetIdentityMemo,
  crossCheckIdentities,
  formatIdentityLine,
  getMemoizedSessionIdentity,
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
      })
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

  it('crossCheckIdentities respects mode=enforce (throws on parent-org mismatch), mode=warn (downgrades to note), mode=off (no-op, no probe)', async () => {
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
    const off = crossCheckIdentities({
      pmak: pmakIdentity(),
      session: sessionIdentity(),
      mode: 'off',
      mask: passthroughMask
    });
    expect(off.level).toBe('ok');
    expect(off.message).toBe('');

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

    __resetIdentityMemo();
    const offFetch = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const offCapture = createLogCapture();
    await runCredentialPreflight({
      apiBaseUrl: API_BASE,
      iapubBaseUrl: IAPUB_BASE,
      postmanApiKey: 'pmak-case-14-off',
      postmanAccessToken: 'access-token-case-14-off',
      mode: 'off',
      mask: passthroughMask,
      log: offCapture.log,
      fetchImpl: offFetch
    });
    expect(offFetch).not.toHaveBeenCalled();
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
