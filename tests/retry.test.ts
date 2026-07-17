import { describe, expect, it, vi, afterEach } from 'vitest';

import { fullJitterDelayMs, parseRetryAfterMs, retry } from '../src/lib/retry.js';

describe('retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries failed operations and resolves on a later success', async () => {
    vi.useFakeTimers();

    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce('ok');

    const onRetry = vi.fn();
    const promise = retry(operation, {
      maxAttempts: 3,
      delayMs: 250,
      onRetry
    });

    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        delayMs: 250
      })
    );
  });

  it('stops retrying when shouldRetry rejects the error', async () => {
    vi.useFakeTimers();

    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('fatal'));

    const promise = retry(operation, {
      maxAttempts: 4,
      delayMs: 500,
      shouldRetry: () => false
    });

    await expect(promise).rejects.toThrow('fatal');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('applies deterministic backoff, caps delays, reports retry context, and preserves the terminal error', async () => {
    const delays: number[] = [];
    const retryContexts: Array<{ attempt: number; delayMs: number; message: string }> = [];
    const terminal = new Error('still failing');
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(terminal);

    await expect(
      retry(operation, {
        maxAttempts: 3,
        delayMs: 100,
        backoffMultiplier: 3,
        maxDelayMs: 250,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        onRetry: ({ attempt, delayMs, error }) => {
          retryContexts.push({
            attempt,
            delayMs,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      })
    ).rejects.toBe(terminal);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 250]);
    expect(retryContexts).toEqual([
      { attempt: 1, delayMs: 100, message: 'first' },
      { attempt: 2, delayMs: 250, message: 'second' }
    ]);
  });

  describe('fullJitterDelayMs', () => {
    it('returns a value inside [0, min(cap, base*2^attempt))', () => {
      // attempt 0 -> ceiling 400; attempt 2 -> ceiling 1600; capped at 2000
      expect(fullJitterDelayMs(0, 400, 2000, () => 0)).toBe(0);
      expect(fullJitterDelayMs(0, 400, 2000, () => 0.999999)).toBe(399);
      expect(fullJitterDelayMs(2, 400, 2000, () => 0.5)).toBe(800);
      // ceiling clamps at the cap once base*2^attempt exceeds it
      expect(fullJitterDelayMs(10, 400, 2000, () => 0.5)).toBe(1000);
    });

    it('never returns a negative delay for a negative attempt', () => {
      expect(fullJitterDelayMs(-3, 400, 2000, () => 0.5)).toBe(200);
    });
  });

  describe('parseRetryAfterMs', () => {
    it('parses delta-seconds into milliseconds', () => {
      expect(parseRetryAfterMs('2')).toBe(2000);
      expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('parses an HTTP-date into a positive delay', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const ms = parseRetryAfterMs(future);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(5000);
    });

    it('returns undefined for absent or unparseable values', () => {
      expect(parseRetryAfterMs(undefined)).toBeUndefined();
      expect(parseRetryAfterMs(null)).toBeUndefined();
      expect(parseRetryAfterMs('soon')).toBeUndefined();
    });
  });
});
