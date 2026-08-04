import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FAKE_TIMER_CLEANUP_GRACE_MS,
  runWithFakeTimers
} from './harness.js';

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

  it('settles work that needs several fake-timer flushes before a real I/O turn', async () => {
    await expect(
      runWithFakeTimers(async () => {
        for (let step = 0; step < 5; step += 1) {
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
        }
        return readFile(new URL(import.meta.url), 'utf8');
      })
    ).resolves.toContain('runWithFakeTimers');
  });

  it('restores cwd after the wrapped action rejects', async () => {
    const cwdBefore = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'bootstrap-harness-cwd-'));

    await expect(
      runWithFakeTimers(async () => {
        const previousCwd = process.cwd();
        process.chdir(tempDir);
        try {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
          throw new Error('action failed');
        } finally {
          process.chdir(previousCwd);
        }
      })
    ).rejects.toThrow('action failed');

    expect(process.cwd()).toBe(cwdBefore);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'fails deterministically when the action promise never settles',
    async () => {
      const settleDeadlineMs = 50;
      const cleanupGraceMs = 25;
      await expect(
        runWithFakeTimers(() => new Promise<never>(() => {}), {
          settleDeadlineMs,
          cleanupGraceMs
        })
      ).rejects.toThrow(
        `Fake timer settle deadline exceeded after ${settleDeadlineMs}ms (+${cleanupGraceMs}ms cleanup grace): action promise did not settle`
      );
    },
    FAKE_TIMER_CLEANUP_GRACE_MS + 5_000
  );
});
