import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const helper = join(process.cwd(), '.github/scripts/run-windows-gates.ps1');
const pwshAvailable = spawnSync('pwsh', ['--version'], { encoding: 'utf8' }).status === 0;

function runGates(...gates: string[]) {
  return spawnSync('pwsh', ['-NoProfile', '-File', helper, '-GateJson', JSON.stringify(gates)], {
    encoding: 'utf8'
  });
}

describe.skipIf(!pwshAvailable)('Windows gate queue', () => {
  it('continues after native stderr on exit 0 and aggregates a later nonzero status', () => {
    expect(existsSync(helper)).toBe(true);
    const warningOnly = runGates(
      "stderr-ok|||pwsh|||-NoProfile|||-Command|||[Console]::Error.WriteLine('DEP0040'); exit 0",
      "also-ok|||pwsh|||-NoProfile|||-Command|||exit 0"
    );
    expect(warningOnly.status, warningOnly.stderr).toBe(0);
    expect(warningOnly.stdout).toContain('::group::stderr-ok');
    expect(warningOnly.stdout + warningOnly.stderr).toContain('DEP0040');
    expect(warningOnly.stdout).not.toContain('__POSTMAN_GATE_RESULT__');
    expect(warningOnly.stdout).toContain('gate:stderr-ok=pass');
    expect(warningOnly.stdout).toContain('gate:also-ok=pass');

    const mixed = runGates(
      "stderr-ok|||pwsh|||-NoProfile|||-Command|||[Console]::Error.WriteLine('DEP0040'); exit 0",
      'fails|||pwsh|||-NoProfile|||-Command|||exit 7',
      'after-failure|||pwsh|||-NoProfile|||-Command|||exit 0'
    );
    expect(mixed.status).toBe(1);
    expect(mixed.stdout).toContain('gate:stderr-ok=pass');
    expect(mixed.stdout).toContain('gate:fails=fail');
    expect(mixed.stdout).toContain('gate:after-failure=pass');
    expect(mixed.stdout).toContain('::group::fails');
  });

  it(
    'reaches but never exceeds MaxParallelGates=2 while completing all gates',
    () => {
      expect(existsSync(helper)).toBe(true);
      const workDir = mkdtempSync(join(tmpdir(), 'windows-gates-maxparallel-'));
      const probePath = join(workDir, 'probe.ps1');
      const currentPath = join(workDir, 'current.txt');
      const maxPath = join(workDir, 'max.txt');
      const startedPath = join(workDir, 'started.txt');
      const mutexName = `PostmanBootstrapGatesTest-${basename(workDir)}`;
      const gateNames = ['probe-a', 'probe-b', 'probe-c'] as const;

      writeFileSync(currentPath, '0', 'utf8');
      writeFileSync(maxPath, '0', 'utf8');
      writeFileSync(startedPath, '0', 'utf8');
      writeFileSync(
        probePath,
        [
          'param(',
          '  [Parameter(Mandatory = $true)][string]$WorkDir,',
          '  [Parameter(Mandatory = $true)][string]$GateName,',
          '  [Parameter(Mandatory = $true)][string]$MutexName',
          ')',
          '$ErrorActionPreference = "Stop"',
          '$currentPath = Join-Path $WorkDir "current.txt"',
          '$maxPath = Join-Path $WorkDir "max.txt"',
          '$startedPath = Join-Path $WorkDir "started.txt"',
          '$markerPath = Join-Path $WorkDir ("marker-" + $GateName + ".txt")',
          '$mutex = New-Object System.Threading.Mutex($false, $MutexName)',
          'try {',
          '  $null = $mutex.WaitOne()',
          '  try {',
          '    $started = [int]((Get-Content -LiteralPath $startedPath -Raw).Trim())',
          '    $started++',
          '    Set-Content -LiteralPath $startedPath -Value $started -NoNewline',
          '    $current = [int]((Get-Content -LiteralPath $currentPath -Raw).Trim())',
          '    $current++',
          '    Set-Content -LiteralPath $currentPath -Value $current -NoNewline',
          '    $max = [int]((Get-Content -LiteralPath $maxPath -Raw).Trim())',
          '    if ($current -gt $max) {',
          '      Set-Content -LiteralPath $maxPath -Value $current -NoNewline',
          '    }',
          '    $shouldRendezvous = $started -le 2',
          '  } finally {',
          '    $mutex.ReleaseMutex()',
          '  }',
          '  Set-Content -LiteralPath $markerPath -Value "done" -NoNewline',
          '  if ($shouldRendezvous) {',
          '    $deadline = [datetime]::UtcNow.AddSeconds(5)',
          '    while ([datetime]::UtcNow -lt $deadline) {',
          '      $null = $mutex.WaitOne()',
          '      try {',
          '        $observedMax = [int]((Get-Content -LiteralPath $maxPath -Raw).Trim())',
          '        if ($observedMax -ge 2) { break }',
          '      } finally {',
          '        $mutex.ReleaseMutex()',
          '      }',
          '      Start-Sleep -Milliseconds 50',
          '    }',
          '  }',
          '  Start-Sleep -Milliseconds 100',
          '  $null = $mutex.WaitOne()',
          '  try {',
          '    $current = [int]((Get-Content -LiteralPath $currentPath -Raw).Trim())',
          '    $current--',
          '    Set-Content -LiteralPath $currentPath -Value $current -NoNewline',
          '  } finally {',
          '    $mutex.ReleaseMutex()',
          '  }',
          '} finally {',
          '  $mutex.Dispose()',
          '}',
          'exit 0',
          ''
        ].join('\n'),
        'utf8'
      );

      try {
        const gates = gateNames.map(
          (name) =>
            `${name}|||pwsh|||-NoProfile|||-File|||${probePath}|||-WorkDir|||${workDir}|||-GateName|||${name}|||-MutexName|||${mutexName}`
        );
        const result = runGates(...gates);
        expect(result.status, result.stderr).toBe(0);
        for (const name of gateNames) {
          expect(result.stdout).toContain(`gate:${name}=pass`);
          expect(readFileSync(join(workDir, `marker-${name}.txt`), 'utf8')).toBe('done');
        }
        expect(Number.parseInt(readFileSync(maxPath, 'utf8').trim(), 10)).toBe(2);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    30_000
  );
});
