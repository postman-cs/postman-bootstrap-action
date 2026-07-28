import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const helper = join(process.cwd(), '.github/scripts/run-windows-gates.mjs');

function runGatesWithTimeout(gateTimeoutSeconds: number, ...gates: string[]) {
  return spawnSync(
    process.execPath,
    [
      helper,
      '--gate-json',
      JSON.stringify(gates),
      '--gate-timeout-seconds',
      String(gateTimeoutSeconds)
    ],
    {
      encoding: 'utf8',
      timeout: 120_000
    }
  );
}

// Generous default so slow CI runners cannot trip the per-gate deadline;
// the timeout test passes its own short deadline explicitly.
function runGates(...gates: string[]) {
  return runGatesWithTimeout(60, ...gates);
}

function gateDiagnostics(result: ReturnType<typeof runGates>) {
  return [result.stderr, result.error ? `${result.error.name}: ${result.error.message}` : '']
    .filter(Boolean)
    .join('\n');
}

describe('Windows gate queue', () => {
  it('continues after native stderr on exit 0 and aggregates a later nonzero status', () => {
    expect(existsSync(helper)).toBe(true);
    const warningOnly = runGates(
      `stderr-ok|||${process.execPath}|||-e|||process.stderr.write('DEP0040\\n')`,
      `also-ok|||${process.execPath}|||-e|||process.exit(0)`
    );
    expect(warningOnly.status, gateDiagnostics(warningOnly)).toBe(0);
    expect(warningOnly.stdout).toContain('::group::stderr-ok');
    expect(warningOnly.stdout + warningOnly.stderr).toContain('DEP0040');
    expect(warningOnly.stdout).not.toContain('__POSTMAN_GATE_RESULT__');
    expect(warningOnly.stdout).toContain('gate:stderr-ok=pass');
    expect(warningOnly.stdout).toContain('gate:also-ok=pass');

    const mixed = runGates(
      `stderr-ok|||${process.execPath}|||-e|||process.stderr.write('DEP0040\\n')`,
      `fails|||${process.execPath}|||-e|||process.exit(7)`,
      `after-failure|||${process.execPath}|||-e|||process.exit(0)`
    );
    expect(mixed.status, gateDiagnostics(mixed)).toBe(1);
    expect(mixed.stdout).toContain('gate:stderr-ok=pass');
    expect(mixed.stdout).toContain('gate:fails=fail');
    expect(mixed.stdout).toContain('gate:after-failure=pass');
    expect(mixed.stdout).toContain('::group::fails');
  }, 120_000);

  it(
    'times out a sleeping gate and continues to the following gate',
    () => {
      const timedOut = runGatesWithTimeout(
        1,
        `sleeps|||${process.execPath}|||-e|||setTimeout(() => {}, 2_000)`,
        `after-timeout|||${process.execPath}|||-e|||process.exit(0)`
      );

      expect(timedOut.status, gateDiagnostics(timedOut)).toBe(1);
      expect(timedOut.stdout + timedOut.stderr).toMatch(/sleeps.*timed out|timed out.*sleeps/i);
      expect(timedOut.stdout).toContain('gate:sleeps=fail');
      expect(timedOut.stdout).toContain('gate:after-timeout=pass');
    },
    120_000
  );

  it(
    'reaches but never exceeds MaxParallelGates=2 while completing all gates',
    () => {
      expect(existsSync(helper)).toBe(true);
      const workDir = mkdtempSync(join(tmpdir(), 'windows-gates-maxparallel-'));
      const probePath = join(workDir, 'probe.mjs');
      const currentPath = join(workDir, 'current.txt');
      const maxPath = join(workDir, 'max.txt');
      const startedPath = join(workDir, 'started.txt');
      const gateNames = ['probe-a', 'probe-b', 'probe-c'] as const;

      writeFileSync(currentPath, '0', 'utf8');
      writeFileSync(maxPath, '0', 'utf8');
      writeFileSync(startedPath, '0', 'utf8');
      writeFileSync(
        probePath,
        [
          "import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          'const [workDir, gateName] = process.argv.slice(2);',
          "const lockPath = join(workDir, 'lock');",
          "const currentPath = join(workDir, 'current.txt');",
          "const maxPath = join(workDir, 'max.txt');",
          "const startedPath = join(workDir, 'started.txt');",
          'const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
          'const withLock = (fn) => {',
          '  for (;;) {',
          "    try { mkdirSync(lockPath); break; } catch (error) { if (error.code !== 'EEXIST') throw error; sleep(10); }",
          '  }',
          '  try { return fn(); } finally { rmSync(lockPath, { recursive: true }); }',
          '};',
          'const shouldRendezvous = withLock(() => {',
          "  const started = Number(readFileSync(startedPath, 'utf8')) + 1;",
          "  writeFileSync(startedPath, String(started));",
          "  const current = Number(readFileSync(currentPath, 'utf8')) + 1;",
          "  writeFileSync(currentPath, String(current));",
          "  const max = Number(readFileSync(maxPath, 'utf8'));",
          "  if (current > max) writeFileSync(maxPath, String(current));",
          '  return started <= 2;',
          '});',
          "writeFileSync(join(workDir, `marker-${gateName}.txt`), 'done');",
          'if (shouldRendezvous) {',
          '  const deadline = Date.now() + 5_000;',
          "  while (Date.now() < deadline && withLock(() => Number(readFileSync(maxPath, 'utf8'))) < 2) sleep(50);",
          '}',
          'sleep(100);',
          'withLock(() => {',
          "  const current = Number(readFileSync(currentPath, 'utf8')) - 1;",
          "  writeFileSync(currentPath, String(current));",
          '});',
          ''
        ].join('\n'),
        'utf8'
      );

      try {
        const gates = gateNames.map(
          (name) => `${name}|||${process.execPath}|||${probePath}|||${workDir}|||${name}`
        );
        const result = runGates(...gates);
        expect(result.status, gateDiagnostics(result)).toBe(0);
        for (const name of gateNames) {
          expect(result.stdout).toContain(`gate:${name}=pass`);
          expect(readFileSync(join(workDir, `marker-${name}.txt`), 'utf8')).toBe('done');
        }
        expect(Number.parseInt(readFileSync(maxPath, 'utf8').trim(), 10)).toBe(2);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
