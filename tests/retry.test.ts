import { describe, expect, it, vi, afterEach } from 'vitest';

import { retry } from '../src/lib/retry.js';

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
});
