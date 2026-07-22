import { describe, expect, it, vi } from 'vitest';

import { PostmanAppVersionProvider } from '../src/lib/postman/app-version.js';

describe('PostmanAppVersionProvider', () => {
  it('shares one valid lookup across concurrent callers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: '12.21.1-rc1' }), { status: 200 })
    );
    const provider = new PostmanAppVersionProvider({ fetchImpl });

    await expect(Promise.all([provider.resolve(), provider.resolve()])).resolves.toEqual([
      '12.21.1-rc1',
      '12.21.1-rc1'
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses the floor and never looks up in rollback mode', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    vi.stubEnv('POSTMAN_GATEWAY_APP_VERSION', 'off');
    try {
      await expect(new PostmanAppVersionProvider({ fetchImpl }).resolve()).resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['HTTP failure', vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }))],
    ['invalid version', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: 'not-semver' }), { status: 200 })
    )],
    ['invalid JSON', vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{', { status: 200 })
    )],
    ['network failure', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('network down'))]
  ])('falls back to the floor on %s', async (_label, fetchImpl) => {
    await expect(new PostmanAppVersionProvider({ fetchImpl }).resolve()).resolves.toBe('12.0.0');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to the floor when the lookup times out', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    );

    await expect(
      new PostmanAppVersionProvider({ fetchImpl, requestTimeoutMs: 1 }).resolve()
    ).resolves.toBe('12.0.0');
  });
});
