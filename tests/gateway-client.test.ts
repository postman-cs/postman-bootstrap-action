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

  describe('transport-rejection retry (socket hangup / deadline)', () => {
    it('retries a safe request when fetch itself rejects, then succeeds', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce(jsonResponse({ ok: true }));
      const sleep = vi.fn(async () => undefined);
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        retryBaseDelayMs: 10,
        sleepImpl: sleep
      });

      const result = await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' });
      expect(result).toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(10);
    });

    it('does not retry an unsafe mutation on a transport rejection; it surfaces so the caller reconciles', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET'));
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        sleepImpl: async () => undefined
      });

      await expect(
        client.requestJson({ service: 'collection', method: 'post', path: '/v3/collections', body: {} })
      ).rejects.toThrow(/ECONNRESET/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries a safe request within budget on repeated rejections, then re-throws', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ETIMEDOUT'));
      const sleep = vi.fn(async () => undefined);
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        maxRetries: 2,
        retryBaseDelayMs: 5,
        sleepImpl: sleep
      });

      await expect(
        client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' })
      ).rejects.toThrow(/ETIMEDOUT/);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('aborts a request that exceeds the per-request deadline and (for safe requests) retries', async () => {
      const controllerSignals: (AbortSignal | undefined)[] = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        const signal = (init as RequestInit).signal ?? undefined;
        controllerSignals.push(signal);
        if (controllerSignals.length === 1) {
          // Emulate a hung proxy: reject only once the deadline fires.
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
          });
        }
        return jsonResponse({ ok: true });
      });
      const sleep = vi.fn(async () => undefined);
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        requestTimeoutMs: 5,
        retryBaseDelayMs: 1,
        sleepImpl: sleep
      });

      const result = await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' });
      expect(result).toEqual({ ok: true });
      // Each send got a real AbortSignal (the deadline is wired).
      expect(controllerSignals[0]).toBeInstanceOf(AbortSignal);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  it('passes a bodyless 204 delete through without crashing the Response rebuild', async () => {
    // Regression: new Response('', { status: 204 }) throws "Invalid response
    // status code 204" — a drained 204 must be rebuilt with a null body.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const provider = new AccessTokenProvider({ accessToken: 'tok' });
    const client = new AccessTokenGatewayClient({ tokenProvider: provider, fetchImpl });

    await expect(
      client.requestJson({ service: 'collection', method: 'delete', path: '/v3/collections/x' })
    ).resolves.toBeNull();
  });

  describe('inner Bifrost envelope errors on HTTP 200', () => {
    it('treats a 200 wrapping an inner error envelope as a failure and throws', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ error: { name: 'forbidden', message: 'nope' }, status: 403 })
      );
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        sleepImpl: async () => undefined
      });

      await expect(
        client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' })
      ).rejects.toThrow(/403/);
    });

    it('retries a safe request when the inner envelope error is a transient 5xx', async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ error: { message: 'ESOCKETTIMEDOUT' }, status: 503 }))
        .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
      const sleep = vi.fn(async () => undefined);
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        retryBaseDelayMs: 10,
        sleepImpl: sleep
      });

      const result = await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' });
      expect(result).toEqual({ data: { ok: true } });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unsafe mutation whose inner error is a transient 5xx; it surfaces for reconciliation', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ error: { message: 'downstream' }, status: 503 })
      );
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        sleepImpl: async () => undefined
      });

      await expect(
        client.requestJson({ service: 'collection', method: 'post', path: '/v3/collections', body: {} })
      ).rejects.toThrow(/503/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('passes a clean 200 envelope through unchanged (no false inner error)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ data: { id: 'c1' }, status: 200 })
      );
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        sleepImpl: async () => undefined
      });

      const result = await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/c1' });
      expect(result).toEqual({ data: { id: 'c1' }, status: 200 });
    });

    it('treats success:false envelopes as failures (fresh response per attempt)', async () => {
      // success:false has no inner status, so it maps to 502 which is transient;
      // a safe GET retries, so each attempt needs its own unconsumed Response.
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ success: false }));
      const client = new AccessTokenGatewayClient({
        tokenProvider: new AccessTokenProvider({ accessToken: 'tok' }),
        fetchImpl,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        sleepImpl: async () => undefined
      });

      await expect(
        client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' })
      ).rejects.toThrow(/502/);
      // initial attempt + 1 retry, each with a fresh envelope
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
