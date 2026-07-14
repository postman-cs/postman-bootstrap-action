import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and on immutable releases', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).toContain('live-e2e-gate:');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(releaseWorkflow).toContain('node .github/scripts/wait-for-e2e-gate.mjs');
  });
});
