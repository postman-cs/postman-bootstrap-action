/**
 * Pins the CI timeout contract in vitest.config.ts.
 *
 * The Windows gate starves ordinary tests under runner contention: the suite's
 * genuinely slow cases already carry explicit 20-30s timeouts and pass, while
 * unannotated tests left on vitest's 5000ms default fail, with different
 * victims each run. The config grants headroom only when CI is set, so local
 * runs keep the strict default and a real slowdown still fails fast.
 *
 * That branch never executes in a local run, so without this test the contract
 * stays unverified until it breaks on a hosted runner. The config is read and
 * evaluated here rather than imported, because a plain import would resolve to
 * whichever env the current process happens to carry.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { transform } from 'esbuild';

const CONFIG_PATH = fileURLToPath(new URL('../vitest.config.ts', import.meta.url));

/** Evaluate vitest.config.ts under an explicit CI value and return `test`. */
async function loadTestConfig(ci: string | undefined): Promise<Record<string, unknown>> {
  const source = readFileSync(CONFIG_PATH, 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'cjs' });
  const previous = process.env.CI;
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  try {
    const module_ = { exports: {} as Record<string, unknown> };
    const require_ = (specifier: string): unknown => {
      if (specifier === 'vitest/config') return { defineConfig: (value: unknown) => value };
      throw new Error(`unexpected require in vitest.config.ts: ${specifier}`);
    };
    new Function('module', 'exports', 'require', 'process', code)(
      module_,
      module_.exports,
      require_,
      process
    );
    const config = (module_.exports.default ?? module_.exports) as {
      test?: Record<string, unknown>;
    };
    return config.test ?? {};
  } finally {
    if (previous === undefined) delete process.env.CI;
    else process.env.CI = previous;
  }
}

describe('vitest config: CI timeout contract', () => {
  it('grants 30s test and hook timeouts when CI is set', async () => {
    const test = await loadTestConfig('true');
    expect(test.testTimeout).toBe(30_000);
    expect(test.hookTimeout).toBe(30_000);
  });

  it('keeps vitest defaults locally so a real slowdown still fails fast', async () => {
    const test = await loadTestConfig(undefined);
    expect(test.testTimeout).toBeUndefined();
    expect(test.hookTimeout).toBeUndefined();
  });

  it('keeps the shared settings identical in both modes', async () => {
    const [ci, local] = await Promise.all([loadTestConfig('true'), loadTestConfig(undefined)]);
    for (const config of [ci, local]) {
      expect(config.environment).toBe('node');
      expect(config.execArgv).toEqual(['--no-experimental-webstorage']);
      expect(config.include).toEqual(['tests/**/*.test.ts']);
      expect(config.setupFiles).toEqual(['tests/setup.ts']);
      expect(config.env).toEqual({ POSTMAN_ACTIONS_TELEMETRY: 'off' });
    }
  });
});
