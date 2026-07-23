import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');
const windowsGateHelper = readFileSync(join(process.cwd(), '.github/scripts/run-windows-gates.ps1'), 'utf8');

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(workflow: string, jobId: string): string {
  const jobsBody = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

const linux = jobText(ciWorkflow, 'gate');
const windows = jobText(ciWorkflow, 'windows');

describe('CI workflow dist/pack race contract', () => {
  it('supersedes only older pull-request runs and queues Windows read-only gates', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ciWorkflow).toMatch(/windows:[\s\S]*?npm run bundle[\s\S]*?Run gates/);
    expect(ciWorkflow).toMatch(/windows:[\s\S]*?run-windows-gates\.ps1/);
    expect(ciWorkflow).toMatch(/windows:[\s\S]*?'integ\|\|\|npm\|\|\|run\|\|\|test:integration'/);
  });

  it('uses the pinned actionlint binary without Go setup', () => {
    expect(ciWorkflow).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('gates immutable dist on Linux and Windows', () => {
    // Regression for the parallel race where `npm run verify:dist` deleted
    // dist/ while tests/cli.test.ts ran `npm pack`.
    expect(ciWorkflow).toMatch(/run: npm run bundle[\s\S]*?- name: Run gates/);
    expect(ciWorkflow).not.toMatch(/run: npm run build/);
    expect(linux).toContain('npm run typecheck');
    expect(windows).toContain("'typecheck|||npm|||run|||typecheck'");

    const runGates = namedStep(linux, 'Run gates');
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

    const upload = namedStep(linux, 'Upload expected dist on mismatch');
    expect(upload).toContain('if: failure()');
    expect(upload).toContain('name: expected-dist');
    expect(upload).toContain('path: dist/');
    expect(ciWorkflow).toContain('name: Windows gate');
    expect(ciWorkflow).toContain('runs-on: windows-latest');
    expect(ciWorkflow).toContain('install/win64.ps1');
  });

  it('confines the locked-registry token to npm ci install steps', () => {
    expect(linux).toMatch(/- run: npm ci\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect(windows).toMatch(/- run: npm ci\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect(seaWorkflow).toMatch(/- run: npm ci\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect((ciWorkflow.match(/secrets\.NPM_TOKEN/g) ?? [])).toHaveLength(2);
    expect((seaWorkflow.match(/secrets\.NPM_TOKEN/g) ?? [])).toHaveLength(1);
    expect(namedStep(linux, 'Run gates')).not.toContain('NPM_TOKEN');
    expect(namedStep(windows, 'Run gates')).not.toContain('NPM_TOKEN');
    expect(namedStep(seaWorkflow, 'Upload SEA binary artifact')).not.toContain('NPM_TOKEN');
  });

  it('keeps locked @postman runtime deps restricted so NPM_TOKEN remains justified', () => {
    // Step-local NPM_TOKEN on npm ci is an exception for private @postman packages.
    // If these stop being restricted (or leave the lock), remove workflow tokens.
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { name?: string; resolved?: string; dependencies?: Record<string, string> }>;
    };
    const modelsKey = 'node_modules/@postman/runtime.models';
    const stdKey = 'node_modules/@postman/runtime.std';
    const modelsLock = lock.packages[modelsKey];
    const stdLock = lock.packages[stdKey];
    expect(modelsLock).toBeDefined();
    expect(stdLock).toBeDefined();
    expect(modelsLock!.dependencies?.['@postman/runtime.std']).toBeDefined();
    expect(modelsLock!.resolved).toMatch(/\/@postman\/runtime\.models\/-/);
    expect(stdLock!.resolved).toMatch(/\/@postman\/runtime\.std\/-/);

    const modelsPkg = JSON.parse(
      readFileSync(join(process.cwd(), modelsKey, 'package.json'), 'utf8'),
    ) as { name: string; publishConfig?: { access?: string }; dependencies?: Record<string, string> };
    const stdPkg = JSON.parse(readFileSync(join(process.cwd(), stdKey, 'package.json'), 'utf8')) as {
      name: string;
      publishConfig?: { access?: string };
    };
    expect(modelsPkg.name).toBe('@postman/runtime.models');
    expect(stdPkg.name).toBe('@postman/runtime.std');
    expect(modelsPkg.dependencies?.['@postman/runtime.std']).toBeDefined();
    expect(modelsPkg.publishConfig?.access).toBe('restricted');
    expect(stdPkg.publishConfig?.access).toBe('restricted');
  });

  it('keeps exact PR-only concurrency on CI and SEA', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(seaWorkflow).toContain(
      'group: sea-binary-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(seaWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('retains Linux full history, one pre-queue bundle, and the exact bounded gate set', () => {
    expect(linux).toContain('fetch-depth: 0');
    expect(linux.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(linux.indexOf('- run: npm run bundle')).toBeLessThan(linux.indexOf('- name: Run gates'));

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'test',
      'typecheck',
      'dist',
      'integ',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint       npm run lint');
    expect(runGates).toContain('run test       npm test');
    expect(runGates).toContain('run typecheck  npm run typecheck');
    expect(runGates).toContain('run dist       npm run verify:dist:assert');
    expect(runGates).toContain('run integ      npm run test:integration');
    expect(runGates).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');

    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('rm -rf dist');
  });

  it('installs pinned actionlint 1.7.11 into $RUNNER_TEMP without Go', () => {
    const install = namedStep(linux, 'Install actionlint');
    expect(install.length).toBeGreaterThan(0);
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('retains Windows with Postman CLI, one pre-queue bundle, and exact lint/test/typecheck/dist/integ set', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).toContain('install/win64.ps1');
    expect(windows).toContain('postman.exe');
    expect(windows.match(/^\s*- run: npm run bundle\s*$/gm) ?? []).toHaveLength(1);
    expect(windows.indexOf('- run: npm run bundle')).toBeLessThan(windows.indexOf('- name: Run gates'));

    const runGates = namedStep(windows, 'Run gates');
    expect(runGates).toContain('.github/scripts/run-windows-gates.ps1');
    expect(runGates).toContain('-GateJson $gates');
    expect(runGates).toContain("'lint|||npm|||run|||lint'");
    expect(runGates).toContain("'test|||npm|||test'");
    expect(runGates).toContain("'typecheck|||npm|||run|||typecheck'");
    expect(runGates).toContain("'dist|||npm|||run|||verify:dist:assert'");
    expect(runGates).toContain("'integ|||npm|||run|||test:integration'");
    expect(windowsGateHelper).toContain('[int]$MaxParallelGates = 2');
    expect(windowsGateHelper).toContain('Start-ThreadJob');
    expect(windowsGateHelper).toContain("$ErrorActionPreference = 'Continue'");
    expect(windowsGateHelper).toContain('Receive-Job -Job $completed -ErrorAction SilentlyContinue');
    expect(windowsGateHelper).toContain('gate:$name=pass');
    expect(windowsGateHelper).toContain('gate:$name=fail');
    expect(runGates).not.toContain('continue-on-error');
    expect(runGates).not.toContain('npm run build');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
    expect(runGates).not.toContain('actionlint');
    expect(runGates).not.toContain('commitlint');
  });
});

describe('SEA binary workflow contract', () => {
  it('builds once, keeps empty-env/version/execArgv smokes, and runs the exact proxy command with canonical sidecar', () => {
    expect(seaWorkflow.match(/bash scripts\/build-sea\.sh/g) ?? []).toHaveLength(1);
    expect(seaWorkflow).toContain('env -i PATH=/nonexistent');
    expect(seaWorkflow).toContain('--version');
    expect(seaWorkflow).toContain('NODE_OPTIONS=--invalid-node-option');
    expect(seaWorkflow).toContain('grep -q "is required" /tmp/sea-node-options.out');

    expect(seaWorkflow).toContain(
      'node scripts/assert-sea-proxy.mjs "$BIN" bifrost-premium-https-v4.gw.postman.com:443 --project-name sea-proxy-smoke --spec-path tests/fixtures/e2e-spec.yaml --postman-access-token sea-proxy-smoke-token --credential-preflight warn --result-json "$PWD/sea-proxy-result.json"',
    );
    expect(seaWorkflow).toContain('bifrost-premium-https-v4.gw.postman.com:443');
    expect(seaWorkflow).toContain('--project-name sea-proxy-smoke');
    expect(seaWorkflow).toContain('--spec-path tests/fixtures/e2e-spec.yaml');
    expect(seaWorkflow).toContain('--postman-access-token sea-proxy-smoke-token');
    expect(seaWorkflow).toContain('--credential-preflight warn');
    expect(seaWorkflow).toContain('--result-json "$PWD/sea-proxy-result.json"');
    expect(seaWorkflow).not.toContain('--result-json "$RUNNER_TEMP/sea-proxy-result.json"');

    expect(seaWorkflow).toContain('cd "$(dirname "$BIN")"');
    expect(seaWorkflow).toContain('shasum -a 256 "$(basename "$BIN")" > "$(basename "$BIN").sha256"');
    expect(seaWorkflow).not.toMatch(/shasum -a 256 "\$BIN" > "\$BIN\.sha256"/);

    const upload = namedStep(seaWorkflow, 'Upload SEA binary artifact');
    expect(upload).toContain('build/sea/postman-bootstrap-*-linux-x64');
    expect(upload).toContain('build/sea/postman-bootstrap-*-linux-x64.sha256');
    expect(upload).toContain('if-no-files-found: error');
  });
});
