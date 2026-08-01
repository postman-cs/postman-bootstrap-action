import { readFile } from 'node:fs/promises';

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

  it('settles asynchronous filesystem work on a real event-loop turn', async () => {
    await expect(
      runWithFakeTimers(() => readFile(new URL(import.meta.url), 'utf8'))
    ).resolves.toContain('runWithFakeTimers');
  });

  it(
    'fails deterministically when the action promise never settles',
    async () => {
      await expect(runWithFakeTimers(() => new Promise<never>(() => {}))).rejects.toThrow(
        'Fake timer flush budget exhausted after 100000 passes: action promise did not settle'
      );
    },
    30_000
  );
});
