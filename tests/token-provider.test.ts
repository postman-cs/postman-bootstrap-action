import { describe, expect, it, vi } from 'vitest';

import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

function tokenResponse(token: string, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ access_token: token }), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const MINT_URL = 'https://api.getpostman.com/service-account-tokens';
const ME_URL = 'https://api.getpostman.com/me';

function meResponse(init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ user: { id: 123, teamId: 456 } }), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

describe('AccessTokenProvider', () => {
  it('returns the initial token from current()', () => {
    const provider = new AccessTokenProvider({ accessToken: 'tok-initial' });
    expect(provider.current()).toBe('tok-initial');
  });

  it('mirrors the resolver mint wire shape', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(tokenResponse('tok-new'));
    const provider = new AccessTokenProvider({
      accessToken: 'tok-old',
      apiKey: 'PMAK-123',
      fetchImpl
    });

    const minted = await provider.refresh();

    expect(minted).toBe('tok-new');
    expect(provider.current()).toBe('tok-new');
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      ME_URL,
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-api-key': 'PMAK-123' }
      })
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
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
      .mockResolvedValueOnce(meResponse())
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
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input) === ME_URL) return Promise.resolve(meResponse());
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    const provider = new AccessTokenProvider({ apiKey: 'PMAK', fetchImpl });

    const a = provider.refresh();
    const b = provider.refresh();
    const c = provider.refresh();
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf('function'));
    resolveFetch!(tokenResponse('tok-shared'));

    expect(await Promise.all([a, b, c])).toEqual(['tok-shared', 'tok-shared', 'tok-shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('clears the inflight promise so a later refresh re-mints', async () => {
    const minted = [tokenResponse('tok-1'), tokenResponse('tok-2')];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(String(input) === ME_URL ? meResponse() : minted.shift()!)
    );
    const provider = new AccessTokenProvider({ apiKey: 'PMAK', fetchImpl });

    expect(await provider.refresh()).toBe('tok-1');
    expect(await provider.refresh()).toBe('tok-2');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('invokes onToken with each minted token (for setSecret + masking)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(tokenResponse('tok-secret'));
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

  it('does not mint or retry when the PMAK preflight is rejected (401)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 401 }));
    const provider = new AccessTokenProvider({
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });

    await expect(provider.refresh()).rejects.toThrow(/preflight.*rejected/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(ME_URL, expect.objectContaining({ method: 'GET' }));
  });

  it('surfaces the service-accounts-not-enabled message on 400', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(meResponse())
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
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(tokenResponse('tok-ok'));
    const provider = new AccessTokenProvider({
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });

    expect(await provider.refresh()).toBe('tok-ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === ME_URL)).toHaveLength(1);
  });

  it('retries a transient PMAK preflight failure before minting', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporary', { status: 500 }))
      .mockResolvedValueOnce(meResponse())
      .mockResolvedValueOnce(tokenResponse('tok-ok'));
    const provider = new AccessTokenProvider({
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });

    expect(await provider.refresh()).toBe('tok-ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      ME_URL,
      ME_URL,
      MINT_URL
    ]);
  });
});
