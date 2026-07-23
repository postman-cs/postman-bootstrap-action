import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetIdentityMemo,
  formatIdentityLine,
  getSessionResolutionFailure,
  resolveSessionIdentity,
  runCredentialPreflight
} from '../src/lib/postman/credential-identity.js';
import { createSecretMasker } from '../src/lib/secrets.js';

const IAPUB_BASE = 'https://iapub.postman.co';

function sessionResponse(status = 200): Response {
  return new Response(
    JSON.stringify({
      session: {
        identity: { team: 10490519, domain: 'jared-demo' },
        data: { user: { id: 42, roles: ['admin'] } },
        consumerType: 'service_account',
        token: 'must-not-leak'
      }
    }),
    { status }
  );
}

describe('access-token session identity', () => {
  beforeEach(() => {
    __resetIdentityMemo();
  });

  it('resolves the whitelisted iapub session fields', async () => {
    const fetchImpl = vi.fn(async () => sessionResponse());

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'PMAT-token',
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(identity).toEqual({
      source: 'iapub/sessions',
      userId: '42',
      teamId: '10490519',
      teamDomain: 'jared-demo',
      roles: ['admin'],
      consumerType: 'service_account'
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${IAPUB_BASE}/api/sessions/current`,
      expect.objectContaining({ headers: { 'x-access-token': 'PMAT-token' } })
    );
  });

  it('memoizes resolution for the same access token', async () => {
    const fetchImpl = vi.fn(async () => sessionResponse());
    const options = {
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'PMAT-token',
      fetchImpl: fetchImpl as unknown as typeof fetch
    };

    await resolveSessionIdentity(options);
    await resolveSessionIdentity(options);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry an authentication rejection', async () => {
    const fetchImpl = vi.fn(async () => sessionResponse(401));

    await expect(
      resolveSessionIdentity({
        iapubBaseUrl: IAPUB_BASE,
        accessToken: 'PMAT-expired',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: vi.fn()
      })
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getSessionResolutionFailure()).toBe('auth');
  });

  it('retries a transient failure and then resolves', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(sessionResponse());
    const sleepImpl = vi.fn(async () => undefined);

    const identity = await resolveSessionIdentity({
      iapubBaseUrl: IAPUB_BASE,
      accessToken: 'PMAT-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
      randomImpl: () => 0
    });

    expect(identity?.teamId).toBe('10490519');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
  });

  it('fails closed under enforce when the access-token session is rejected', async () => {
    await expect(
      runCredentialPreflight({
        iapubBaseUrl: IAPUB_BASE,
        postmanAccessToken: 'PMAT-expired',
        mode: 'enforce',
        mask: createSecretMasker(['PMAT-expired']),
        log: { info: vi.fn(), warning: vi.fn() },
        fetchImpl: vi.fn(async () => sessionResponse(401)) as unknown as typeof fetch
      })
    ).rejects.toThrow(/invalid or expired/);
  });

  it('logs only masked, whitelisted identity fields', () => {
    const line = formatIdentityLine(
      {
        source: 'iapub/sessions',
        teamId: '10490519',
        teamDomain: 'secret-domain'
      },
      createSecretMasker(['secret-domain'])
    );

    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('secret-domain');
  });
});
