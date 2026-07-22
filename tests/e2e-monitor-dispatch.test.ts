import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const monitorScript = readFileSync(join(process.cwd(), '.github/scripts/dispatch-e2e-monitor.mjs'), 'utf8');

describe('e2e monitor dispatch contract', () => {
  it('is post-publish, continue-on-error, and unused by the major alias job', () => {
    expect(releaseWorkflow).toMatch(
      /dispatch-live-monitor:[\s\S]*?needs:\n\s+- validate\n\s+- publish/
    );
    expect(releaseWorkflow).toMatch(
      /dispatch-live-monitor:[\s\S]*?continue-on-error: true/
    );
    expect(releaseWorkflow).toMatch(
      /dispatch-live-monitor:[\s\S]*?needs\.validate\.outputs\.npm_publish == 'true'/
    );
    expect(releaseWorkflow).toMatch(
      /advance-major-alias:[\s\S]*?needs:\n\s+- validate\n\s+- publish\n/
    );
    expect(releaseWorkflow).not.toMatch(/advance-major-alias:[\s\S]*dispatch-live-monitor/);
  });

  it('keeps publish dependent only on successful validate', () => {
    expect(releaseWorkflow).toMatch(/publish:\n\s+needs:\n\s+- validate\n/);
    expect(releaseWorkflow).toContain("if: ${{ needs.validate.result == 'success' }}");
    expect(releaseWorkflow).not.toContain('live-e2e-gate');
    expect(releaseWorkflow).not.toContain('gate_required');
  });

  it('dispatches a single POST with no polling or timeout loops', () => {
    expect(monitorScript).toContain("method: 'POST'");
    expect(monitorScript).toContain('gate_correlation_id');
    expect(monitorScript).toContain("suite");
    expect(monitorScript).not.toContain('setTimeout');
    expect(monitorScript).not.toContain('DEFAULT_TIMEOUT_SECONDS');
    expect(monitorScript).not.toContain('DEFAULT_POLL_SECONDS');
    expect(monitorScript).not.toContain('waitForMatchingRun');
    expect(monitorScript).not.toContain('waitForTerminalRun');
  });
});
