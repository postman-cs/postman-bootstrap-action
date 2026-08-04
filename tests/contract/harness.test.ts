import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  FAKE_TIMER_CLEANUP_GRACE_MS,
  FAKE_TIMER_SETTLE_DEADLINE_MS,
  runWithFakeTimers
} from './harness.js';

/** Matches vitest.config.ts CI_TIMEOUT_MS; kept local so drift is caught here. */
const CI_TEST_TIMEOUT_MS = 30_000;

describe('runWithFakeTimers', () => {
  it('keeps default settle + cleanup budgets strictly inside the CI test timeout', () => {
    expect(FAKE_TIMER_SETTLE_DEADLINE_MS + FAKE_TIMER_CLEANUP_GRACE_MS).toBeLessThan(
      CI_TEST_TIMEOUT_MS
    );
  });

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

  it(
    'fails a recursive timer chain by the settle deadline rather than Vitest timer exhaustion',
    async () => {
      const settleDeadlineMs = 25;
      const cleanupGraceMs = 10;
      await expect(
        runWithFakeTimers(() => {
          const reschedule = (): void => {
            setTimeout(reschedule, 0);
          };
          reschedule();
          return new Promise<never>(() => {});
        }, { settleDeadlineMs, cleanupGraceMs })
      ).rejects.toThrow(
        `Fake timer settle deadline exceeded after ${settleDeadlineMs}ms (+${cleanupGraceMs}ms cleanup grace): action promise did not settle`
      );

      expect(vi.isFakeTimers()).toBe(false);
    },
    5_000
  );

  it('restores cwd when a never-settling action leaves it changed', async () => {
    const cwdBefore = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'bootstrap-harness-cwd-'));
    const settleDeadlineMs = 25;
    const cleanupGraceMs = 10;

    await expect(
      runWithFakeTimers(() => {
        process.chdir(tempDir);
        return new Promise<never>(() => {});
      }, { settleDeadlineMs, cleanupGraceMs })
    ).rejects.toThrow(
      `Fake timer settle deadline exceeded after ${settleDeadlineMs}ms (+${cleanupGraceMs}ms cleanup grace): action promise did not settle`
    );

    expect(process.cwd()).toBe(cwdBefore);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an asynchronously resolved undefined value', async () => {
    await expect(
      runWithFakeTimers(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      })
    ).resolves.toBeUndefined();
  });

  it('restores real timers and cwd after a synchronous throw', async () => {
    const cwdBefore = process.cwd();
    const tempDir = mkdtempSync(join(tmpdir(), 'bootstrap-harness-sync-cwd-'));
    const expected = new Error('synchronous action failed');

    await expect(
      runWithFakeTimers((() => {
        process.chdir(tempDir);
        throw expected;
      }) as () => Promise<never>)
    ).rejects.toBe(expected);

    expect(vi.isFakeTimers()).toBe(false);
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

      expect(vi.isFakeTimers()).toBe(false);
    },
    FAKE_TIMER_CLEANUP_GRACE_MS + 5_000
  );
});
