import { describe, expect, it, vi } from 'vitest';

import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

function tokenResponse(token: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ access_token: token }), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const MINT_URL = 'https://api.getpostman.com/service-account-tokens';

describe('AccessTokenProvider', () => {
  it('returns the initial token from current()', () => {
    const provider = new AccessTokenProvider({ accessToken: 'tok-initial' });
    expect(provider.current()).toBe('tok-initial');
  });

  it('mirrors the resolver mint wire shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse('tok-new'));
    const provider = new AccessTokenProvider({
      accessToken: 'tok-old',
      apiKey: 'PMAK-123',
      fetchImpl
    });

    const minted = await provider.refresh();

    expect(minted).toBe('tok-new');
    expect(provider.current()).toBe('tok-new');
    expect(fetchImpl).toHaveBeenCalledWith(
      MINT_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'PMAK-123' },
        body: JSON.stringify({ apiKey: 'PMAK-123' })
      })
    );
  });

  it('reads access_token from the session.token shape', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ session: { token: 'tok-session' } }), {
          headers: { 'Content-Type': 'application/json' }
        })
      );
    const provider = new AccessTokenProvider({ apiKey: 'PMAK', fetchImpl });

    expect(await provider.refresh()).toBe('tok-session');
  });

  it('is single-flight: concurrent refresh calls mint once', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const provider = new AccessTokenProvider({ apiKey: 'PMAK', fetchImpl });

    const a = provider.refresh();
    const b = provider.refresh();
    const c = provider.refresh();
    resolveFetch?.(tokenResponse('tok-shared'));

    expect(await Promise.all([a, b, c])).toEqual(['tok-shared', 'tok-shared', 'tok-shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('clears the inflight promise so a later refresh re-mints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse('tok-1'))
      .mockResolvedValueOnce(tokenResponse('tok-2'));
    const provider = new AccessTokenProvider({ apiKey: 'PMAK', fetchImpl });

    expect(await provider.refresh()).toBe('tok-1');
    expect(await provider.refresh()).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('invokes onToken with each minted token (for setSecret + masking)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse('tok-secret'));
    const onToken = vi.fn();
    const provider = new AccessTokenProvider({ apiKey: 'PMAK', fetchImpl, onToken });

    await provider.refresh();

    expect(onToken).toHaveBeenCalledWith('tok-secret');
  });

  it('throws without minting when no PMAK is present (canRefresh false)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new AccessTokenProvider({ accessToken: 'tok', fetchImpl });

    expect(provider.canRefresh()).toBe(false);
    await expect(provider.refresh()).rejects.toThrow(/no token-mint credential/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not retry when the PMAK is rejected (401)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 401 }));
    const provider = new AccessTokenProvider({
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });

    await expect(provider.refresh()).rejects.toThrow(/postman-api-key was rejected/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces the service-accounts-not-enabled message on 400', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('service accounts not enabled', { status: 400 }));
    const provider = new AccessTokenProvider({
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });

    await expect(provider.refresh()).rejects.toThrow(/service accounts are not enabled/);
  });

  it('retries a transient 500 then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(tokenResponse('tok-ok'));
    const provider = new AccessTokenProvider({
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });

    expect(await provider.refresh()).toBe('tok-ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
