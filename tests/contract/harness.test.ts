import { describe, expect, it } from 'vitest';

import { runWithFakeTimers } from './harness.js';

describe('runWithFakeTimers', () => {
  it('settles a normally delayed promise', async () => {
    await expect(
      runWithFakeTimers(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('settled'), 1_000))
      )
    ).resolves.toBe('settled');
  });

  it(
    'fails deterministically when the action promise never settles',
    async () => {
      await expect(runWithFakeTimers(() => new Promise<never>(() => {}))).rejects.toThrow(
        /Fake timer flush budget exhausted .* action promise did not settle/
      );
    },
    30_000
  );
});
