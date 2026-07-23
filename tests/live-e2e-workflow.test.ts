import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and as a post-publish async monitor', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).not.toContain('live-e2e-gate:');
    expect(releaseWorkflow).not.toContain('gate_required');
    expect(releaseWorkflow).not.toContain('wait-for-e2e-gate.mjs');
    expect(releaseWorkflow).toContain('dispatch-live-monitor:');
    expect(releaseWorkflow).toContain('continue-on-error: true');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: smoke');
    expect(releaseWorkflow).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
    expect(releaseWorkflow).toContain("needs.verify-package.outputs.release_kind == 'immutable'");
  });
});
