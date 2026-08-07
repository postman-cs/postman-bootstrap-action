import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

describe('live e2e tiering contract', () => {
  it('keeps live sandbox work off PRs and gates only the rolling alias after publish', () => {
    expect(existsSync(join(process.cwd(), '.github/workflows/live-e2e.yml'))).toBe(false);
    expect(releaseWorkflow).toContain('verify-release-e2e:');
    // The E2E gate and the alias advance stay fail-closed. Scoped per job because
    // the sibling-release notifier deliberately tolerates a failed App-token mint
    // and falls back to the composite's daily cron.
    expect(job('verify-release-e2e')).not.toContain('continue-on-error: true');
    expect(job('advance-major-alias')).not.toContain('continue-on-error: true');
    expect(releaseWorkflow).toContain('E2E_GATE_SUITE: full');
    expect(releaseWorkflow).toContain('node .github/scripts/verify-e2e-release.mjs');
    expect(releaseWorkflow).toContain('needs.verify-release-e2e.result == \'success\'');
    expect(releaseWorkflow).toContain('publish:\n    needs: [classify, verify-package]');
    expect(releaseWorkflow).toContain('default: enforce');
  });
});
