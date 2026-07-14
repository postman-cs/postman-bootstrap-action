import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const gateScript = readFileSync(join(process.cwd(), '.github/scripts/wait-for-e2e-gate.mjs'), 'utf8');
const liveE2eWorkflow = readFileSync(join(process.cwd(), '.github/workflows/live-e2e.yml'), 'utf8');

describe('e2e gate timeout bounds', () => {
  it('keeps the default gate poll timeout at 30 minutes (smoke runs finish in 3-4)', () => {
    const match = gateScript.match(/const DEFAULT_TIMEOUT_SECONDS = (\d+);/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(1800);
  });

  it('keeps the env override hook for exceptional runs', () => {
    expect(gateScript).toContain("parsePositiveInteger(process.env.E2E_GATE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS, 'E2E_GATE_TIMEOUT_SECONDS')");
  });

  it('caps the live e2e job ceiling at 45 minutes, not the legacy 240', () => {
    expect(liveE2eWorkflow).toMatch(/timeout-minutes: 45\b/);
    expect(liveE2eWorkflow).not.toMatch(/timeout-minutes: 240\b/);
  });
});
