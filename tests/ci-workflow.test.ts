import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ciWorkflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const seaWorkflow = readFileSync(join(process.cwd(), '.github/workflows/sea-binary.yml'), 'utf8');
const windowsGateHelper = readFileSync(join(process.cwd(), '.github/scripts/run-windows-gates.ps1'), 'utf8');
const cliTest = readFileSync(join(process.cwd(), 'tests/cli.test.ts'), 'utf8');

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
const receiptNormalizer = jobText(ciWorkflow, 'normalize-receipt');

describe('CI workflow dist/pack race contract', () => {
  it('supersedes only older pull-request runs and queues Windows read-only gates', () => {
    expect(ciWorkflow).toContain('group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}');
    expect(ciWorkflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ciWorkflow).toMatch(/windows:[\s\S]*?Run gates/);
    expect(ciWorkflow).toMatch(/windows:[\s\S]*?run-windows-gates\.ps1/);
    expect(ciWorkflow).toMatch(/windows:[\s\S]*?'integ\|\|\|node\|\|\|--run\|\|\|test:integration'/);
    expect(windows).not.toContain('npm run bundle');
  });

  it('normalizes stale receipts only on same-repository PRs without force-pushing', () => {
    expect(receiptNormalizer).toContain(
      "if: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository }}",
    );
    expect(receiptNormalizer).toContain('actions: write');
    expect(receiptNormalizer).toContain('contents: write');
    expect(receiptNormalizer).toContain('ref: ${{ github.event.pull_request.head.sha }}');
    expect(receiptNormalizer).toContain('node .github/scripts/rebind-multifile-receipt.mjs --write');
    expect(receiptNormalizer).toContain("if: steps.rebind.outputs.updated == 'true'");
    expect(receiptNormalizer).toContain(
      'git add validation/evidence/multifile-spec-sync.json dist/action.cjs dist/cli.cjs dist/index.cjs',
    );
    expect(receiptNormalizer).toContain('chore: rebind multifile receipt to source');
    expect(receiptNormalizer).toContain('git push origin "HEAD:${GITHUB_HEAD_REF}"');
    expect(receiptNormalizer).not.toMatch(/git push[^\n]*(?:--force|-f\b)/);
    expect(receiptNormalizer).toContain('gh workflow run ci.yml --ref "$GITHUB_HEAD_REF"');
    expect(receiptNormalizer).toContain('gh workflow run sea-binary.yml --ref "$GITHUB_HEAD_REF"');

    for (const job of [linux, windows]) {
      expect(job).toContain('needs: normalize-receipt');
      expect(job).toContain("needs.normalize-receipt.outputs.updated != 'true'");
    }
  });

  it('uses the pinned actionlint binary without Go setup', () => {
    expect(ciWorkflow).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).toContain('run actionlint "$ACTIONLINT_BIN"');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
  });

  it('gates immutable dist on Linux and keeps Windows as a runtime-only lane', () => {
    // Regression for the parallel race where `npm run verify:dist` deleted
    // dist/ while tests/cli.test.ts ran `npm pack`.
    expect(ciWorkflow).toMatch(/run: npm run bundle[\s\S]*?- name: Run gates/);
    expect(ciWorkflow).not.toMatch(/run: npm run build/);
    expect(linux).toContain('npm run typecheck');
    expect(windows).not.toContain("'typecheck|||npm|||run|||typecheck'");

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
    expect(windows).not.toContain('install/win64.ps1');
  });

  it('confines the locked-registry token to npm ci install steps', () => {
    expect(linux).toMatch(/- run: npm ci\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect(windows).toMatch(
      /if: steps\.windows-node-modules\.outputs\.cache-hit != 'true'\n {8}run: npm ci --prefer-offline --no-audit --no-fund\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/,
    );
    expect(seaWorkflow).toMatch(/- run: npm ci\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    expect((ciWorkflow.match(/secrets\.NPM_TOKEN/g) ?? [])).toHaveLength(3);
    expect((seaWorkflow.match(/secrets\.NPM_TOKEN/g) ?? [])).toHaveLength(1);
    expect(namedStep(linux, 'Run gates')).not.toContain('NPM_TOKEN');
    expect(namedStep(windows, 'Run gates')).not.toContain('NPM_TOKEN');
    expect(namedStep(windows, 'Install Postman CLI')).not.toContain('NPM_TOKEN');
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
    expect(install).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(install).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(install.match(/393031adb9afb225ee52ae2ccd7a5af5525e03e8/)?.[0]).toHaveLength(40);
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(ciWorkflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(ciWorkflow).not.toContain('actions/setup-go');
    expect(ciWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflow).not.toMatch(/\bgo install\b/);
  });

  it('retains Windows with exact caches, versioned CLI, and test+integ max-two gates', () => {
    expect(windows).toContain('name: Windows gate');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).toContain('fetch-depth: 0');
    expect(windows).toContain('filter: blob:none');
    expect(windows).not.toContain('cache: npm');

    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain('id: windows-postman-cli');
    expect(windows).toContain('id: postman-cli-version');
    expect(
      (windows.match(/actions\/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57 # v4\.2\.0/g) ?? []).length,
    ).toBe(2);
    const repositoryIdentity = '${{ github.event.pull_request.head.repo.full_name || github.repository }}';
    const nodeModulesKey =
      'node-modules-Windows-Node-24-' + repositoryIdentity + "-${{ hashFiles('package-lock.json') }}";
    const postmanCliKey =
      'postman-cli-${{ steps.postman-cli-version.outputs.version }}-Windows-${{ runner.arch }}-' +
      repositoryIdentity;
    expect(windows).toContain(`key: ${nodeModulesKey}`);
    expect(windows).toContain(
      `key: ${postmanCliKey}`,
    );
    for (const key of [nodeModulesKey, postmanCliKey]) {
      const baseRepositoryKey = key.replace(repositoryIdentity, 'postman-cs/postman-bootstrap-action');
      const forkRepositoryKey = key.replace(repositoryIdentity, 'untrusted-fork/postman-bootstrap-action');
      expect(baseRepositoryKey).not.toBe(forkRepositoryKey);
    }
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain('path: ${{ runner.temp }}\\postman-cli');
    expect(windows).not.toContain('restore-keys');

    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('npm ci --prefer-offline --no-audit --no-fund');
    expect(windows).toContain("if: steps.windows-postman-cli.outputs.cache-hit != 'true'");

    const resolveCli = namedStep(windows, 'Resolve Postman CLI version');
    expect(resolveCli).toContain('npm view postman-cli version --json');
    expect(resolveCli).toContain('^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$');
    expect(resolveCli).toContain('GITHUB_OUTPUT');
    expect(resolveCli).toContain('version=$version');

    const installCli = namedStep(windows, 'Install Postman CLI');
    expect(installCli).toContain(
      'npm install "postman-cli@${{ steps.postman-cli-version.outputs.version }}" --prefix "${{ runner.temp }}\\postman-cli" --no-save --no-audit --no-fund',
    );
    expect(installCli).not.toContain('win64.ps1');
    expect(installCli).not.toContain('postman.exe');
    expect(installCli).not.toContain('--no-optional');
    expect(installCli).not.toContain('postman.cmd');

    const addCliPath = namedStep(windows, 'Add Postman CLI to PATH');
    expect(addCliPath).toContain('GITHUB_PATH');
    expect(addCliPath).toContain(
      'node_modules\\@postman\\pm-bin-windows-x64\\bin\\postman.exe',
    );
    expect(addCliPath).toContain('Test-Path -LiteralPath $exe -PathType Leaf');
    expect(addCliPath).toContain('Split-Path -Parent $exe');
    expect(addCliPath).toContain('& $exe --version');
    expect(addCliPath).toContain('--version');
    expect(addCliPath).not.toContain('postman.cmd');
    expect(addCliPath).not.toContain('node_modules\\.bin');
    expect(addCliPath).not.toContain('win64.ps1');
    expect(addCliPath).not.toContain('dl-cli.pstmn.io');
    expect(addCliPath).not.toMatch(/\bif:/);

    const runGates = namedStep(windows, 'Run gates');
    expect(runGates).toContain('.github/scripts/run-windows-gates.ps1');
    expect(runGates).toContain('-GateJson $gates');
    expect(runGates).toContain("'test|||node|||--run|||test'");
    expect(runGates).toContain("'integ|||node|||--run|||test:integration'");
    expect(runGates.match(/'[^']+\|\|\|[^']+'/g) ?? []).toEqual([
      "'test|||node|||--run|||test'",
      "'integ|||node|||--run|||test:integration'",
    ]);
    expect(runGates).not.toMatch(/\bif:/);
    expect(windowsGateHelper).toContain('[int]$MaxParallelGates = 2');
    expect(windowsGateHelper).toContain('Start-ThreadJob');
    expect(windowsGateHelper).toContain('ValidateRange(1, 2)');
    expect(windowsGateHelper).toContain("$ErrorActionPreference = 'Continue'");
    expect(windowsGateHelper).toContain('Receive-Job -Job $completed -ErrorAction Continue 2>&1');
    expect(windowsGateHelper).toContain('::group::$name');
    expect(windowsGateHelper).toContain('gate:$name=pass');
    expect(windowsGateHelper).toContain('gate:$name=fail');

    expect(cliTest).toContain(
      "process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')",
    );
    expect(cliTest).not.toContain("process.env.npm_execpath ?? ''");

    expect(windows).not.toContain('npm run bundle');
    expect(windows).not.toContain('npm run build');
    expect(windows).not.toContain("'lint|||npm|||run|||lint'");
    expect(windows).not.toContain("'typecheck|||npm|||run|||typecheck'");
    expect(windows).not.toContain("'dist|||npm|||run|||verify:dist:assert'");
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
    expect(windows).not.toContain('install/win64.ps1');
    expect(windows).not.toContain('postman.cmd');
    expect(windows).toContain(
      'node_modules\\@postman\\pm-bin-windows-x64\\bin\\postman.exe',
    );
    expect(runGates).not.toContain('continue-on-error');
    expect(runGates).not.toMatch(/npm run verify:dist(?:\s|$|"|')/);
  });
});

describe('SEA binary workflow contract', () => {
  it('builds once, keeps empty-env/version/execArgv smokes, and runs the exact proxy command with canonical sidecar', () => {
    expect(seaWorkflow.match(/bash scripts\/build-sea\.sh/g) ?? []).toHaveLength(1);
    expect(seaWorkflow).toContain('env -i PATH=/nonexistent');
    expect(seaWorkflow).toContain('--version');
    expect(seaWorkflow).toContain('NODE_OPTIONS=--invalid-node-option');
    expect(seaWorkflow).toContain(
      'hardened="$(NODE_OPTIONS=--invalid-node-option "$BIN" --version 2>/dev/null || true)"',
    );

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
