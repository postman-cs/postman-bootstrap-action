import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const verifierScript = readFileSync(join(process.cwd(), '.github/scripts/verify-e2e-release.mjs'), 'utf8');

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

describe('correlated release verification contract', () => {
  it('is post-publish, fail-closed, and required by the major alias job', () => {
    expect(releaseWorkflow).toMatch(
      /verify-release-e2e:[\s\S]*?needs: \[classify, verify-package, publish\]/
    );
    // Scoped to the gate job: an unscoped scan now reaches the sibling-release
    // notifier, whose App-token mint is intentionally tolerant.
    expect(job('verify-release-e2e')).not.toContain('continue-on-error');
    expect(releaseWorkflow).toMatch(
      /advance-major-alias:[\s\S]*?needs: \[classify, verify-package, publish, verify-release-e2e\]/
    );
    expect(releaseWorkflow).toMatch(
      /advance-major-alias:[\s\S]*?needs\.verify-release-e2e\.result == 'success'/
    );
    expect(releaseWorkflow).toMatch(
      /advance-major-alias:[\s\S]*?needs\.verify-release-e2e\.outputs\.outcome == 'success'/
    );
    expect(releaseWorkflow).toContain('E2E_GATE_MODE: enforce');
    expect(releaseWorkflow).not.toContain('e2e_verification_mode');
  });

  it('keeps publication dependent on immutable artifact verification', () => {
    expect(releaseWorkflow).toContain('publish:\n    needs: [classify, verify-package]');
    expect(releaseWorkflow).toContain("needs.classify.outputs.release_kind == 'immutable'");
  });

  it('requests run details, has exact-correlation fallback, and polls exact run with bounds', () => {
    expect(verifierScript).toContain('return_run_details: true');
    expect(verifierScript).toContain('gate_correlation_id');
    expect(verifierScript).toContain('electCorrelatedRun');
    expect(verifierScript).toContain('waitForTerminalRun');
    expect(verifierScript).toContain('DEFAULT_LOOKUP_TIMEOUT_MS');
    expect(verifierScript).toContain('DEFAULT_VERIFICATION_TIMEOUT_MS');
    expect(verifierScript).toContain('correlation_mismatch');
    expect(verifierScript).toContain('dispatch_auth_error');
    expect(verifierScript).toContain('verification_timeout');
  });
});
