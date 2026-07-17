import { describe, expect, it, vi } from 'vitest';

import { AccessTokenGatewayClient } from '../src/lib/postman/gateway-client.js';
import { AccessTokenProvider } from '../src/lib/postman/token-provider.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

const PRIMARY = 'https://bifrost-premium-https-v4.gw.postman.com';
const FALLBACK = 'https://go.postman.co/_api';

function makeClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const provider = new AccessTokenProvider({ accessToken: 'tok-1' });
  return new AccessTokenGatewayClient({
    tokenProvider: provider,
    fallbackBaseUrl: FALLBACK,
    sleepImpl: async () => undefined,
    fetchImpl,
    ...extra
  });
}

describe('AccessTokenGatewayClient cold /_api fallback', () => {
  it('safe request: one serial fallback attempt after primary budget is exhausted', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      // primary: 3 transient 502s (default maxRetries=3 -> 4 total primary sends)
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      // fallback: success
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl);

    const result = await client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/c1/items/' });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.slice(0, 4)).toEqual(Array(4).fill(`${PRIMARY}/ws/proxy`));
    expect(urls[4]).toBe(`${FALLBACK}/ws/proxy`);
  });

  it('safe request: transient fallback failure surfaces the original primary error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ESOCKETTIMEDOUT', { status: 502 }));
    const client = makeClient(fetchImpl, { maxRetries: 1 });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).rejects.toMatchObject({ status: 502 });
    // 2 primary sends (initial + 1 retry) + 1 fallback send
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls[2]).toBe(`${FALLBACK}/ws/proxy`);
  });

  it('unsafe request without fallback:auto never falls back', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ESOCKETTIMEDOUT', { status: 502 }));
    const client = makeClient(fetchImpl);

    await expect(
      client.requestJson({ service: 'collection', method: 'post', path: '/v3/collections/c1/items/', retry: 'none' })
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('unsafe request with fallback:auto falls back after the primary failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'item-1' } }));
    const client = makeClient(fetchImpl);

    const result = await client.requestJson({
      service: 'collection',
      method: 'post',
      path: '/v3/collections/c1/items/',
      retry: 'none',
      fallback: 'auto'
    });

    expect(result).toEqual({ data: { id: 'item-1' } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(`${FALLBACK}/ws/proxy`);
  });

  it('transport rejection on primary exhausts budget then falls back', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl, { maxRetries: 1 });

    const result = await client.requestJson({ service: 'collection', method: 'get', path: '/x' });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toBe(`${FALLBACK}/ws/proxy`);
  });

  it('kill switch POSTMAN_ITEM_CREATE_FALLBACK=off disables the fallback', async () => {
    process.env.POSTMAN_ITEM_CREATE_FALLBACK = 'off';
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('ESOCKETTIMEDOUT', { status: 502 }));
      const client = makeClient(fetchImpl, { maxRetries: 1 });

      await expect(
        client.requestJson({ service: 'collection', method: 'get', path: '/x' })
      ).rejects.toMatchObject({ status: 502 });
      const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
      expect(urls.every((u) => u === `${PRIMARY}/ws/proxy`)).toBe(true);
    } finally {
      delete process.env.POSTMAN_ITEM_CREATE_FALLBACK;
    }
  });

  it('no fallbackBaseUrl configured: primary error surfaces without extra sends', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ESOCKETTIMEDOUT', { status: 502 }));
    const provider = new AccessTokenProvider({ accessToken: 'tok-1' });
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      maxRetries: 1,
      sleepImpl: async () => undefined,
      fetchImpl
    });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fallback 4xx surfaces as the freshest authoritative error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      .mockResolvedValueOnce(new Response('ESOCKETTIMEDOUT', { status: 502 }))
      .mockResolvedValueOnce(new Response('bad request', { status: 400 }));
    const client = makeClient(fetchImpl, { maxRetries: 1 });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).rejects.toMatchObject({ status: 400 });
  });
});
