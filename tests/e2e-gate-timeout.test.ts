import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const gateScript = readFileSync(join(process.cwd(), '.github/scripts/wait-for-e2e-gate.mjs'), 'utf8');

describe('e2e gate timeout bounds', () => {
  it('keeps the default gate poll timeout at 30 minutes (smoke runs finish in 3-4)', () => {
    const match = gateScript.match(/const DEFAULT_TIMEOUT_SECONDS = (\d+);/);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(1800);
  });

  it('keeps the env override hook for exceptional runs', () => {
    expect(gateScript).toContain("parsePositiveInteger(process.env.E2E_GATE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS, 'E2E_GATE_TIMEOUT_SECONDS')");
  });

});
