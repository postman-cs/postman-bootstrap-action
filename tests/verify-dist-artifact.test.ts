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
  cliVersion?: string;
  pkgVersion?: string;
  extraDistFile?: string;
  omitEntry?: string;
  symlinkEntry?: string;
  brokenEntry?: string;
  requireSpecifier?: string;
  requireExampleOnly?: string;
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
  process.stdout.write(${JSON.stringify(helpBody)});
  process.exit(0);
}
if (args.includes('--version') || args.includes('-V')) {
  process.stdout.write(${JSON.stringify(`${cliVersion}\n`)});
  process.exit(0);
}
process.stderr.write('unexpected\\n');
process.exit(1);
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
    const body = name === options.brokenEntry ? 'const = broken;\n' : 'module.exports = {};\n';
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
  }, 30_000);

  it('passes a well-formed temporary dist tree', async () => {
    const root = await makeTempDir('verify-dist-ok-');
    await writeFixture(root);
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }, 30_000);

  it('fails when the CLI shebang is missing', async () => {
    const root = await makeTempDir('verify-dist-shebang-');
    await writeFixture(root, { shebang: false });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing Node shebang/);
  });

  it.skipIf(process.platform === 'win32')('fails when cli.cjs is not executable on disk', async () => {
    const root = await makeTempDir('verify-dist-mode-');
    await writeFixture(root, { mode: 0o644 });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not executable on disk/);
  });

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
  });

  it('fails when dist census has an extra file', async () => {
    const root = await makeTempDir('verify-dist-extra-');
    await writeFixture(root, { extraDistFile: 'extra.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  });

  it('fails when dist census has a hidden extra file', async () => {
    const root = await makeTempDir('verify-dist-hidden-');
    await writeFixture(root, { extraDistFile: '.hidden' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  });

  it('fails when dist census is missing an entrypoint', async () => {
    const root = await makeTempDir('verify-dist-missing-');
    const missing = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { omitEntry: missing });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/dist census mismatch/);
  });

  it.skipIf(process.platform === 'win32')('fails when an expected entrypoint is a symlink', async () => {
    const root = await makeTempDir('verify-dist-symlink-');
    const linked = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { symlinkEntry: linked });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/regular file, not a directory or symlink/);
  });

  it('fails when direct --help does not produce the usage banner', async () => {
    const root = await makeTempDir('verify-dist-help-');
    await writeFixture(root, { helpBody: 'no banner here\n' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/missing usage banner/);
  });

  it('fails when direct --version drifts from package.json', async () => {
    const root = await makeTempDir('verify-dist-version-');
    await writeFixture(root, { cliVersion: '0.0.0-drift' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/--version was/);
  });

  it('fails when node --check rejects a bundled entrypoint', async () => {
    const root = await makeTempDir('verify-dist-syntax-');
    const broken = CONFIG.census.find((name) => name !== 'cli.cjs') as string;
    await writeFixture(root, { brokenEntry: broken });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/node --check/);
  });

  it('fails when a literal require() targets a third-party module', async () => {
    const root = await makeTempDir('verify-dist-thirdparty-');
    await writeFixture(root, { requireSpecifier: 'left-pad' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-builtin\/third-party require\("left-pad"\)/);
  });

  it('fails when a literal require() targets a relative path', async () => {
    const root = await makeTempDir('verify-dist-relative-');
    await writeFixture(root, { requireSpecifier: './side-effect.cjs' });
    const result = await runVerify(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/non-builtin\/third-party require/);
  });

  it('ignores require() examples in comments and string data', async () => {
    const root = await makeTempDir('verify-dist-example-');
    await writeFixture(root, { requireExampleOnly: 'left-pad' });
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });

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
  });

  it('accepts the documented optional peer allowlist', async () => {
    const root = await makeTempDir('verify-dist-peer-');
    await writeFixture(root, { requireSpecifier: 'encoding' });
    const result = await runVerify(root);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });
});
