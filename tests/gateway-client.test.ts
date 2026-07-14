import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';
import { createMutableSecretMasker } from '../src/lib/secrets.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const GATEWAY = 'https://bifrost-premium-https-v4.gw.postman.com/ws/proxy';

describe('AccessTokenGatewayClient', () => {
  it('sends the proxy envelope with the live access token', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const provider = new AccessTokenProvider({ accessToken: 'tok-1' });
    const client = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl });

    await client.requestJson({
      service: 'specification',
      method: 'post',
      path: '/specifications/abc/collections',
      body: { collectionId: 'c1' }
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      GATEWAY,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-access-token': 'tok-1'
        }),
        body: JSON.stringify({
          service: 'specification',
          method: 'post',
          path: '/specifications/abc/collections',
          body: { collectionId: 'c1' }
        })
      })
    );
  });

  it('adds x-entity-team-id only in org-mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const orgClient = new AccessTokenGatewayClient({
      tokenProvider: provider,
      teamId: '777',
      orgMode: true,
      fetchImpl
    });

    await orgClient.requestJson({ service: 'workspaces', method: 'get', path: '/workspaces' });
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      'x-entity-team-id': '777'
    });

    fetchImpl.mockClear();
    const personalClient = new AccessTokenGatewayClient({
      tokenProvider: provider,
      teamId: '777',
      orgMode: false,
      fetchImpl
    });
    await personalClient.requestJson({ service: 'workspaces', method: 'get', path: '/workspaces' });
    const headers = (fetchImpl.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-entity-team-id']).toBeUndefined();
  });

  it('refreshes the token on UNAUTHENTICATED and retries once with the new token', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // first proxy call: token expired
      .mockResolvedValueOnce(new Response('{"error":"UNAUTHENTICATED"}', { status: 401 }))
      // re-mint call
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-fresh' }))
      // retried proxy call: success
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const provider = new AccessTokenProvider({
      accessToken: 'tok-stale',
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined
    });
    const client = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl });

    const result = await client.requestJson({
      service: 'workspaces',
      method: 'get',
      path: '/workspaces'
    });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The retried proxy call carries the refreshed token.
    const retried = fetchImpl.mock.calls[2]?.[1] as RequestInit;
    expect((retried.headers as Record<string, string>)['x-access-token']).toBe('tok-fresh');
  });

  it('does not refresh when no PMAK is present and raises a redacted error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('UNAUTHENTICATED secret-tok', { status: 401 }));
    const provider = new AccessTokenProvider({ accessToken: 'secret-tok', fetchImpl });
    const masker = createMutableSecretMasker(['secret-tok']);
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      secretMasker: masker.mask
    });

    let captured: unknown;
    try {
      await client.requestJson({ service: 'workspaces', method: 'get', path: '/workspaces' });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const message = captured instanceof Error ? captured.message : String(captured);
    expect(message).toContain('401');
    expect(message).not.toContain('secret-tok');
    // one proxy call, no mint
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('redacts a re-minted token registered with a mutable masker', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('UNAUTHENTICATED', { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'tok-fresh-secret' }))
      .mockResolvedValueOnce(new Response('failure leaking tok-fresh-secret', { status: 500 }));
    const masker = createMutableSecretMasker([]);
    const provider = new AccessTokenProvider({
      accessToken: 'tok-stale',
      apiKey: 'PMAK',
      fetchImpl,
      sleep: async () => undefined,
      onToken: (token) => masker.add(token)
    });
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      secretMasker: masker.mask
    });

    let captured: unknown;
    try {
      await client.requestJson({ service: 'workspaces', method: 'get', path: '/workspaces' });
    } catch (error) {
      captured = error;
    }

    const message = captured instanceof Error ? captured.message : String(captured);
    expect(message).toContain('500');
    expect(message).not.toContain('tok-fresh-secret');
  });

  it('retries a transient downstream timeout with backoff, then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT","source":"downstream"}}', { status: 500 })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const sleep = vi.fn(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      retryBaseDelayMs: 10,
      sleepImpl: sleep
    });

    const result = await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x/items/' });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('retries an explicitly safe PATCH after a transient downstream timeout', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT","source":"downstream"}}', { status: 500 })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const sleep = vi.fn(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      retryBaseDelayMs: 10,
      sleepImpl: sleep
    });

    const result = await client.requestJson({
      service: 'collection',
      method: 'patch',
      path: '/v3/collections/x/items/y',
      retry: 'safe',
      body: [{ op: 'add', path: '/scripts', value: [] }]
    });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('does not retry a PATCH unless the caller marks it safe', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"name":"serverError","details":"ESOCKETTIMEDOUT","source":"downstream"}}', { status: 500 })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
      fetchImpl,
      sleepImpl: async () => undefined
    });

    await expect(client.requestJson({
      service: 'collection',
      method: 'patch',
      path: '/v3/collections/x',
      body: [{ op: 'replace', path: '/name', value: 'X' }]
    })).rejects.toThrow(/500/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exhausts the transient retry budget and raises a redacted error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"error":{"message":"ESOCKETTIMEDOUT"}}', { status: 504 }));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const sleep = vi.fn(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      fetchImpl,
      maxRetries: 2,
      retryBaseDelayMs: 5,
      sleepImpl: sleep
    });

    let captured: unknown;
    try {
      await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x/items/' });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    // initial attempt + 2 retries
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 10);
  });
});
