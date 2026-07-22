import { describe, expect, it, vi } from 'vitest';

import { mintAccessTokenIfNeeded } from '../src/lib/postman/token-provider.js';

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

describe('mintAccessTokenIfNeeded', () => {
  it('preflights the PMAK before minting a missing access token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/me')
        ? response({ user: { id: 123, teamId: 456 } })
        : response({ access_token: 'PMAT-minted' })
    );
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-key',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = { info: vi.fn(), warning: vi.fn() };
    const setSecret = vi.fn();

    await mintAccessTokenIfNeeded(inputs, log, setSecret, fetchImpl as unknown as typeof fetch);

    expect(inputs.postmanAccessToken).toBe('PMAT-minted');
    expect(setSecret).toHaveBeenCalledWith('PMAT-minted');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.getpostman.com/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-api-key': 'PMAK-key' })
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.getpostman.com/service-account-tokens',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'PMAK-key' })
      })
    );
  });

  it('does not use PMAK when an access token already exists', async () => {
    const fetchImpl = vi.fn();
    const inputs = {
      postmanAccessToken: 'PMAT-existing',
      postmanApiKey: 'PMAK-key',
      postmanApiBase: 'https://api.getpostman.com'
    };

    await mintAccessTokenIfNeeded(
      inputs,
      { info: vi.fn(), warning: vi.fn() },
      undefined,
      fetchImpl as unknown as typeof fetch
    );

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a disabled service-account feature after a successful preflight', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/me')
        ? response({ user: { id: 123, teamId: 456 } })
        : response('service accounts not enabled', 400)
    );
    const inputs = {
      postmanAccessToken: '',
      postmanApiKey: 'PMAK-key',
      postmanApiBase: 'https://api.getpostman.com'
    };
    const log = { info: vi.fn(), warning: vi.fn() };

    await mintAccessTokenIfNeeded(inputs, log, undefined, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('service accounts are not enabled'));
  });
});
