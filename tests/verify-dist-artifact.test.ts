import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

interface RepoConfig {
  pkgName: string;
  binName: string;
  pkgMain: string;
  actionMain: string | null;
  census: string[];
}

const CONFIG: RepoConfig = {"pkgName":"@postman-cse/onboarding-bootstrap","binName":"postman-bootstrap","pkgMain":"dist/index.cjs","actionMain":"dist/action.cjs","census":["action.cjs","cli.cjs","index.cjs"]};

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-dist-artifact.mjs');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface FixtureOptions {
  shebang?: boolean;
  mode?: number;
  helpBody?: string;
  hangHelp?: boolean;
  hangVersion?: boolean;
  cliVersion?: string;
  pkgVersion?: string;
  extraDistFile?: string;
  omitEntry?: string;
  symlinkEntry?: string;
  brokenEntry?: string;
  requireSpecifier?: string;
  requireExampleOnly?: string;
  contractEntry?: string;
  contractEnv?: Record<string, string>;
  libraryGetterThrows?: boolean;
  actionBootThrows?: boolean;
  dynamicVariableRegistry?: unknown;
  dynamicVariablesExport?: string;
  dynamicVariablesReport?: { generators: number; failures: string[] };
}

async function writeFixture(root: string, options: FixtureOptions = {}): Promise<void> {
  const distDir = path.join(root, 'dist');
  await mkdir(distDir, { recursive: true });
  const realPkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
    version: string;
  };
  const pkgVersion = options.pkgVersion ?? realPkg.version;
  const cliVersion = options.cliVersion ?? pkgVersion;
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: CONFIG.pkgName,
      version: pkgVersion,
      main: CONFIG.pkgMain,
      bin: { [CONFIG.binName]: 'dist/cli.cjs' }
    }),
    'utf8'
  );
  if (CONFIG.actionMain) {
    await writeFile(
      path.join(root, 'action.yml'),
      `name: fixture\nruns:\n  using: node24\n  main: ${CONFIG.actionMain}\n`,
      'utf8'
    );
  }
  if (options.contractEntry !== undefined || options.contractEnv !== undefined || options.actionBootThrows || options.dynamicVariableRegistry !== undefined) {
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await writeFile(path.join(root, 'scripts', 'dist-boot-contract.json'), JSON.stringify({ entry: options.contractEntry ?? CONFIG.actionMain, exitCode: 0, outputIncludes: [], ...(options.contractEnv === undefined ? {} : { env: options.contractEnv }), ...(options.dynamicVariableRegistry === undefined ? {} : { dynamicVariableRegistry: options.dynamicVariableRegistry }) }), 'utf8');
  }

  const shebang = options.shebang === false ? '' : '#!/usr/bin/env node\n';
  const helpBody = options.helpBody ?? `Usage: ${CONFIG.binName} [options]\n`;
  const requireLine = options.requireSpecifier
    ? `let peer;\ntry {\n  peer = require(${JSON.stringify(options.requireSpecifier)});\n} catch {\n  peer = undefined;\n}\nvoid peer;\n`
    : '';
  const requireExample = options.requireExampleOnly
    ? `// Example only: require(${JSON.stringify(options.requireExampleOnly)})\nconst example = ${JSON.stringify(`require(${JSON.stringify(options.requireExampleOnly)})`)};\nvoid example;\n`
    : '';
  const cliSource = `${shebang}${requireLine}${requireExample}const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  if (${Boolean(options.hangHelp)}) {
    setInterval(() => {}, 1_000);
  } else {
    process.stdout.write(${JSON.stringify(helpBody)});
    process.exit(0);
  }
}
else if (args.includes('--version') || args.includes('-V')) {
  if (${Boolean(options.hangVersion)}) {
    setInterval(() => {}, 1_000);
  } else {
    process.stdout.write(${JSON.stringify(`${cliVersion}\n`)});
    process.exit(0);
  }
}
else {
  process.stderr.write('unexpected\\n');
  process.exit(1);
}
`;
  const cliPath = path.join(distDir, 'cli.cjs');
  await writeFile(cliPath, cliSource, { encoding: 'utf8', mode: options.mode ?? 0o755 });
  if (options.mode !== undefined) {
    await chmod(cliPath, options.mode);
  }
  for (const name of CONFIG.census) {
    if (name === 'cli.cjs' || name === options.omitEntry) {
      continue;
    }
    if (name === options.symlinkEntry) {
      await symlink(cliPath, path.join(distDir, name));
      continue;
    }
    const body = name === options.brokenEntry ? 'const = broken;\n' : options.libraryGetterThrows && name === path.posix.basename(CONFIG.pkgMain) ? "Object.defineProperty(module.exports, 'broken', { enumerable: true, get() { throw new TypeError('getter-only library export'); } });\n" : options.actionBootThrows && name === path.posix.basename(CONFIG.actionMain ?? '') ? "throw new TypeError('action boot failure');\n" : options.dynamicVariablesReport && name === path.posix.basename(CONFIG.pkgMain) ? `module.exports[${JSON.stringify(options.dynamicVariablesExport ?? 'observeBundledDynamicVariables')}] = () => { process.stdout.write('DYNAMIC_FIXTURE_INVOKED\\n'); return ${JSON.stringify(options.dynamicVariablesReport)}; };\n` : 'module.exports = {};\n';
    await writeFile(path.join(distDir, name), body, 'utf8');
  }
  if (options.extraDistFile) {
    await writeFile(path.join(distDir, options.extraDistFile), 'module.exports = {};\n', 'utf8');
  }
}

async function runVerify(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [verifyScript, root], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? ''
      },
      maxBuffer: 1024 * 1024
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof execError.code === 'number' ? execError.code : 1,
      stdout: String(execError.stdout ?? ''),
      stderr: String(execError.stderr ?? '')
    };
  }
}

describe('verify-dist-artifact canonical contract', { timeout: 30_000 }, () => {
  it('passes against the committed dist artifact', async () => {
    const result = await runVerify(repoRoot);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('verify-dist-artifact: ok');
  }, 15_000);

  it('passes a well-formed temporary dist tree', async () => {
    const root = await makeTempDir('verify-dist-ok-');
    await writeFixture(root);
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }, 15_000);

  it('fails the real verifier on the historical getter-only library export boot failure', async () => {
    const root = await makeTempDir('verify-dist-libboot-');
    await writeFixture(root, { libraryGetterThrows: true });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/LIBRARY_EXPORT_ACCESS_FAILED|library entrypoint.*failed to boot/);
  }, 15_000);

  it('uses dynamicVariableRegistry as the sole registry trigger and expectation source', async () => {
    const absent = await makeTempDir('verify-dist-dynamic-absent-');
    await writeFixture(absent, { dynamicVariablesReport: { generators: 118, failures: ['must not be observed'] } });
    const skipped = await runVerify(absent);
    expect(skipped.code).toBe(0);
    expect(skipped.stdout).not.toContain('DYNAMIC_FIXTURE_INVOKED');

    const success = await makeTempDir('verify-dist-dynamic-success-');
    await writeFixture(success, { dynamicVariableRegistry: { export: 'fixtureRegistry', expectedGeneratorCount: 3 }, dynamicVariablesExport: 'fixtureRegistry', dynamicVariablesReport: { generators: 3, failures: [] } });
    const result = await runVerify(success);
    expect(result.code).toBe(0);
  }, 15_000);

  it('rejects missing, malformed, and mismatched dynamic-variable registries', async () => {
    const missing = await makeTempDir('verify-dist-dynamic-missing-');
    await writeFixture(missing, { dynamicVariableRegistry: { export: 'missingRegistry', expectedGeneratorCount: 1 } });
    expect((await runVerify(missing)).stderr).toContain('DYNAMIC_VARS_BOOT_FAILED missing export=missingRegistry');
    for (const registry of [null, { export: 'not-valid', expectedGeneratorCount: 1 }, { export: 'fixtureRegistry', expectedGeneratorCount: 0 }]) {
      const root = await makeTempDir('verify-dist-dynamic-malformed-');
      await writeFixture(root, { dynamicVariableRegistry: registry });
      expect((await runVerify(root)).stderr).toMatch(/dynamicVariableRegistry/);
    }
    const mismatch = await makeTempDir('verify-dist-dynamic-count-');
    await writeFixture(mismatch, { dynamicVariableRegistry: { export: 'fixtureRegistry', expectedGeneratorCount: 3 }, dynamicVariablesExport: 'fixtureRegistry', dynamicVariablesReport: { generators: 2, failures: [] } });
    expect((await runVerify(mismatch)).stderr).toContain('DYNAMIC_VARS_BOOT_FAILED');
  }, 15_000);

  it('fails when the configured dynamic-variable registry reports generator failures', async () => {
    const root = await makeTempDir('verify-dist-dynamic-failures-');
    await writeFixture(root, { dynamicVariableRegistry: { export: 'fixtureRegistry', expectedGeneratorCount: 3 }, dynamicVariablesExport: 'fixtureRegistry', dynamicVariablesReport: { generators: 3, failures: ['x: boom'] } });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('DYNAMIC_VARS_BOOT_FAILED');
    expect(result.stderr).toContain('x: boom');
  }, 15_000);


  it('rejects a boot contract entry that differs from action.yml runs.main', async () => {
    const root = await makeTempDir('verify-dist-contract-mismatch-');
    await writeFixture(root, { contractEntry: 'dist/cli.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/does not match action.yml runs\.main/);
  }, 15_000);

  it('rejects a traversing boot contract entry', async () => {
    const root = await makeTempDir('verify-dist-contract-traversal-');
    await writeFixture(root, { contractEntry: '../outside.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/must not traverse outside dist/);
  }, 15_000);

  it('rejects a boot contract entry outside dist', async () => {
    const root = await makeTempDir('verify-dist-contract-nondist-');
    await writeFixture(root, { contractEntry: 'outside.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/must point under dist/);
  }, 15_000);

  it('rejects boot contracts that override protected boot environment', async () => {
    for (const env of [{ NODE_OPTIONS: '--require=fixture' }, { GITHUB_OUTPUT: '/tmp/fixture-output' }] as Record<string, string>[]) {
      const root = await makeTempDir('verify-dist-protected-env-');
      await writeFixture(root, { contractEnv: env });
      const result = await runVerify(root);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/protected boot environment/);
    }
  }, 15_000);

  it('fails when the CLI shebang is missing', async () => {
    const root = await makeTempDir('verify-dist-shebang-');
    await writeFixture(root, { shebang: false });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing Node shebang/);
  }, 15_000);

  it.skipIf(process.platform === 'win32')('fails when cli.cjs is not executable on disk', async () => {
    const root = await makeTempDir('verify-dist-mode-');
    await writeFixture(root, { mode: 0o644 });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not executable on disk/);
  }, 15_000);

  it('fails when the git index does not mark cli.cjs executable', async () => {
    const gitRoot = await makeTempDir('verify-dist-gitmode-');
    const pkgRoot = path.join(gitRoot, 'packages', 'pkg');
    await mkdir(pkgRoot, { recursive: true });
    await writeFixture(pkgRoot);
    await execFileAsync('git', ['init', '--quiet'], { cwd: gitRoot });
    await execFileAsync('git', ['add', '--', '.'], { cwd: gitRoot });
    await execFileAsync('git', ['update-index', '--chmod=-x', 'packages/pkg/dist/cli.cjs'], {
      cwd: gitRoot
    });
    const result = await runVerify(pkgRoot);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/git-index mode is 100644/);
  }, 15_000);

  it('fails when dist census has an extra file', async () => {
    const root = await makeTempDir('verify-dist-extra-');
    await writeFixture(root, { extraDistFile: 'extra.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  }, 15_000);

  it('fails when dist census has a hidden extra file', async () => {
    const root = await makeTempDir('verify-dist-hidden-');
    await writeFixture(root, { extraDistFile: '.hidden' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  }, 15_000);

  it('fails when dist census is missing an entrypoint', async () => {
    const root = await makeTempDir('verify-dist-missing-');
    const missing = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { omitEntry: missing });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  }, 15_000);

  it.skipIf(process.platform === 'win32')('fails when an expected entrypoint is a symlink', async () => {
    const root = await makeTempDir('verify-dist-symlink-');
    const linked = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { symlinkEntry: linked });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/regular file, not a directory or symlink/);
  }, 15_000);

  it('fails when direct --help does not produce the usage banner', async () => {
    const root = await makeTempDir('verify-dist-help-');
    await writeFixture(root, { helpBody: 'no banner here\n' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing usage banner/);
  }, 15_000);

  it('fails within the test budget when direct --help hangs', async () => {
    const root = await makeTempDir('verify-dist-help-timeout-');
    await writeFixture(root, { hangHelp: true });
    const startedAt = Date.now();
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/direct dist[\\/]cli\.cjs --help timed out after 5000ms/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it('fails within the test budget when direct --version hangs', async () => {
    const root = await makeTempDir('verify-dist-version-timeout-');
    await writeFixture(root, { hangVersion: true });
    const startedAt = Date.now();
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/direct dist[\\/]cli\.cjs --version timed out after 5000ms/);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  it('fails when direct --version drifts from package.json', async () => {
    const root = await makeTempDir('verify-dist-version-');
    await writeFixture(root, { cliVersion: '0.0.0-drift' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--version was/);
  }, 15_000);

  it('fails when node --check rejects a bundled entrypoint', async () => {
    const root = await makeTempDir('verify-dist-syntax-');
    const broken = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { brokenEntry: broken });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/node --check/);
  }, 15_000);

  it('fails when a literal require() targets a third-party module', async () => {
    const root = await makeTempDir('verify-dist-thirdparty-');
    await writeFixture(root, { requireSpecifier: 'left-pad' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-builtin\/third-party require\("left-pad"\)/);
  }, 15_000);

  it('fails when a literal require() targets a relative path', async () => {
    const root = await makeTempDir('verify-dist-relative-');
    await writeFixture(root, { requireSpecifier: './side-effect.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-builtin\/third-party require/);
  }, 15_000);

  it('ignores require() examples in comments and string data', async () => {
    const root = await makeTempDir('verify-dist-example-');
    await writeFixture(root, { requireExampleOnly: 'left-pad' });
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }, 15_000);

  it('accepts bare and node: builtin require() specifiers', async () => {
    const rootBare = await makeTempDir('verify-dist-bare-');
    await writeFixture(rootBare, { requireSpecifier: 'fs' });
    const bare = await runVerify(rootBare);
    expect(bare.stderr).toBe('');
    expect(bare.code).toBe(0);

    const rootPrefixed = await makeTempDir('verify-dist-prefixed-');
    await writeFixture(rootPrefixed, { requireSpecifier: 'node:fs' });
    const prefixed = await runVerify(rootPrefixed);
    expect(prefixed.stderr).toBe('');
    expect(prefixed.code).toBe(0);
  }, 15_000);

  it.skipIf(process.platform === 'win32')('rejects symlinked dist roots, caught network calls, and unconsumed GitHub output markers', async () => {
    const actionMain = CONFIG.actionMain as string;
    const symlinkRoot = await makeTempDir('verify-dist-parent-symlink-');
    await writeFixture(symlinkRoot);
    await rm(path.join(symlinkRoot, 'dist'), { recursive: true });
    await symlink(symlinkRoot, path.join(symlinkRoot, 'dist'));
    expect((await runVerify(symlinkRoot)).stderr).toMatch(/dist root must be a regular non-symlink directory/);

    const networkRoot = await makeTempDir('verify-dist-network-');
    await writeFixture(networkRoot, { contractEntry: actionMain });
    await writeFile(path.join(networkRoot, actionMain), "try { require('node:https').get('https://example.invalid'); } catch {}\nmodule.exports = {};\n", 'utf8');
    expect((await runVerify(networkRoot)).stderr).toMatch(/attempted network I\/O/);

    const outputRoot = await makeTempDir('verify-dist-github-output-');
    await writeFixture(outputRoot, { contractEntry: actionMain });
    await writeFile(path.join(outputRoot, 'scripts', 'dist-boot-contract.json'), JSON.stringify({ entry: actionMain, exitCode: 0, outputIncludes: [], githubOutputIncludes: ['fixture-output=ok'] }), 'utf8');
    await writeFile(path.join(outputRoot, actionMain), "require('node:fs').appendFileSync(process.env.GITHUB_OUTPUT, 'fixture-output=ok\\n');\nmodule.exports = {};\n", 'utf8');
    expect((await runVerify(outputRoot)).code).toBe(0);
    await writeFile(path.join(outputRoot, 'scripts', 'dist-boot-contract.json'), JSON.stringify({ entry: actionMain, exitCode: 0, outputIncludes: [], githubOutputIncludes: ['missing-output'] }), 'utf8');
    expect((await runVerify(outputRoot)).stderr).toMatch(/GitHub output missing contract marker/);

    const throwRoot = await makeTempDir('verify-dist-direct-action-throw-');
    await writeFixture(throwRoot, { contractEntry: actionMain });
    await writeFile(path.join(throwRoot, actionMain), "throw new TypeError('direct action boot failure');\n", 'utf8');
    expect((await runVerify(throwRoot)).stderr).toMatch(/action entrypoint.*boot exited|direct action boot failure/);
  });

  it('accepts the documented optional peer allowlist', async () => {
    const root = await makeTempDir('verify-dist-peer-');
    await writeFixture(root, { requireSpecifier: 'encoding' });
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }, 15_000);
});
