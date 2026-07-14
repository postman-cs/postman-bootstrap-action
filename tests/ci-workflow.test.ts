import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = ciWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

describe('CI workflow dist/pack race contract', () => {
  it('bundles dist once before fan-out, typechecks once, and keeps the parallel dist gate read-only', () => {
    // Regression for the parallel race where `npm run verify:dist` deleted
    // dist/ while tests/cli.test.ts ran `npm pack`.
    expect(ciWorkflow).toMatch(/run: npm run bundle[\s\S]*?- name: Run gates/);
    expect(ciWorkflow).not.toMatch(/run: npm run build/);
    expect(ciWorkflow.match(/npm run typecheck/g) ?? []).toHaveLength(1);

    const runGates = namedStep('Run gates');
    expect(runGates).toContain('run test');
    expect(runGates).toContain('run dist');
    expect(runGates).toContain('npm run verify:dist:assert');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toContain('rm -rf dist');
    expect(runGates).not.toMatch(/run dist\s+git diff --ignore-space-at-eol --text --exit-code -- dist/);

    // Preserve aggregate gate reporting and expected-dist upload.
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('::group::$n');
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('wait -n -p finished_pid');

    const upload = namedStep('Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
  });
});
