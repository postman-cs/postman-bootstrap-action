/**
 * Central disposable workspace isolation for unit/contract runs.
 *
 * Every Vitest worker gets a unique GITHUB_WORKSPACE so local OpenAPI artifact
 * writes never pollute the package root. Production still resolves
 * GITHUB_WORKSPACE / cwd with no NODE_ENV/VITEST product bypass.
 *
 * Package cwd is left unchanged. Tests that write relative `.postman/` fixtures
 * must either withCwd into GITHUB_WORKSPACE or chdir there for the test body.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll } from 'vitest';

const previousWorkspace = process.env.GITHUB_WORKSPACE;
const packageRoot = join(import.meta.dirname, '..');
const disposableRoot = mkdtempSync(
  join(tmpdir(), `bootstrap-vitest-w${process.env.VITEST_POOL_ID || '0'}-`)
);

beforeAll(() => {
  process.env.GITHUB_WORKSPACE = disposableRoot;
});

afterAll(() => {
  if (previousWorkspace === undefined) {
    delete process.env.GITHUB_WORKSPACE;
  } else {
    process.env.GITHUB_WORKSPACE = previousWorkspace;
  }
  rmSync(disposableRoot, { recursive: true, force: true });
  for (const name of ['.postman', 'postman'] as const) {
    const abs = join(packageRoot, name);
    if (existsSync(abs)) {
      try {
        rmSync(abs, { recursive: true, force: true });
      } catch {
        // Parallel workers may race on leftover cleanup; the gate python check
        // is the authoritative package-root cleanliness proof.
      }
    }
  }
});
