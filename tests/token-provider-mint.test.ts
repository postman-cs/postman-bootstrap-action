import { describe, expect, it, vi } from 'vitest';

import { mintAccessTokenIfNeeded } from '../src/lib/postman/token-provider.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function makeLog() {
  return { info: vi.fn(), warning: vi.fn() };
}

describe('mintAccessTokenIfNeeded (PMAK-only eager mint)', () => {
  it('mints an access token from the PMAK when no postman-access-token is supplied', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'PMAT-minted' }));
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-key',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();
    const setSecret = vi.fn();

    await mintAccessTokenIfNeeded(inputs, log, setSecret, fetchImpl as unknown as typeof fetch);

    expect(inputs.postmanAccessToken).toBe('PMAT-minted');
    expect(setSecret).toHaveBeenCalledWith('PMAT-minted');
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('minted a short-lived service-account access token')
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.getpostman.com/service-account-tokens',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('is a no-op when postman-access-token is already supplied', async () => {
    const fetchImpl = vi.fn();
    const inputs = {
      postmanAccessToken: 'PMAT-existing',
      postmanApiKey: 'PMAK-key',
      postmanApiBase: 'https://api.getpostman.com'
    };
    await mintAccessTokenIfNeeded(inputs, makeLog(), undefined, fetchImpl as unknown as typeof fetch);
    expect(inputs.postmanAccessToken).toBe('PMAT-existing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is a no-op when no PMAK is present', async () => {
    const fetchImpl = vi.fn();
    const inputs = { postmanAccessToken: '', postmanApiKey: '', postmanApiBase: '' };
    await mintAccessTokenIfNeeded(inputs, makeLog(), undefined, fetchImpl as unknown as typeof fetch);
    expect(inputs.postmanAccessToken).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('warns and leaves the token empty when the mint fails (PMAK rejected)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, { status: 401 }));
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-bad',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    expect(inputs.postmanAccessToken).toBe('');
    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining('could not mint an access token from the postman-api-key')
    );
    // The raw PMAK must never leak into the warning text.
    const warned = String(log.warning.mock.calls[0]?.[0] ?? '');
    expect(warned).not.toContain('PMAK-bad');
  });
});

  it('names a personal API key when the mint 401s but /me shows a user identity', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/service-account-tokens')) {
        return jsonResponse({ detail: 'Invalid or inactive API key' }, { status: 401 });
      }
      return jsonResponse({
        user: { username: 'jane-doe', email: 'jane@example.com', teamId: 13347347 }
      });
    });
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-personal',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    expect(inputs.postmanAccessToken).toBe('');
    const warned = String(log.warning.mock.calls[0]?.[0] ?? '');
    expect(warned).toContain('Personal API key detected, cannot mint a service-account access token');
    expect(warned).toContain('team 13347347');
    expect(warned).not.toContain('PMAK-personal');
  });

  it('names a permission gap when the mint 401s but /me shows a service-account identity', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/service-account-tokens')) {
        return jsonResponse({ detail: 'Invalid or inactive API key' }, { status: 403 });
      }
      // Service accounts carry null username/email (live-verified shape).
      return jsonResponse({ user: { username: null, email: null, teamId: 10490519 } });
    });
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-svc-limited',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    const warned = String(log.warning.mock.calls[0]?.[0] ?? '');
    expect(warned).toContain('lacks permission to mint access tokens');
    expect(warned).toContain('team 10490519');
  });

  it('names an invalid key when both the mint and /me reject it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/service-account-tokens')) {
        return jsonResponse({ detail: 'Invalid or inactive API key' }, { status: 401 });
      }
      return jsonResponse({ error: { name: 'AuthenticationError' } }, { status: 401 });
    });
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-dead',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    const warned = String(log.warning.mock.calls[0]?.[0] ?? '');
    expect(warned).toContain('invalid, disabled, or expired');
  });

  it('surfaces the team feature gap when service accounts are not enabled', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/service-account-tokens')) {
        return new Response('service accounts not enabled', { status: 400 });
      }
      return jsonResponse({ user: { username: null, email: null } });
    });
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-no-feature',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    const warned = String(log.warning.mock.calls[0]?.[0] ?? '');
    expect(warned).toContain('service accounts are not enabled for this team');
  });

  it('falls back to the raw mint error when the /me probe itself fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/service-account-tokens')) {
        return jsonResponse({}, { status: 401 });
      }
      throw new Error('network down');
    });
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-x',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = makeLog();

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    const warned = String(log.warning.mock.calls[0]?.[0] ?? '');
    expect(warned).toContain('PMAK rejected, HTTP 401');
  });