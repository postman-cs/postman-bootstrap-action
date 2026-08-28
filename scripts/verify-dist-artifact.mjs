#!/usr/bin/env node
/**
 * Read-only dist artifact contract (canonical, fleet-identical).
 *
 * This file is byte-identical across every postman-actions onboarding
 * action repository. All repo-specific facts are derived from manifests:
 *
 * - package.json `bin`   -> CLI entrypoint + usage banner name
 * - package.json `main`  -> library entrypoint
 * - action.yml runs.main -> GitHub Action entrypoint
 *
 * Asserts exact dist census (no hidden/extra files, no symlinks, no missing
 * entrypoints), CLI shebang, disk + git-index exec bits, sandboxed direct
 * --help/--version, node --check on every entrypoint, and literal require()
 * builtins only (bare or node:, via builtinModules).
 *
 * The require() scan parses each CommonJS entrypoint and records literal
 * require() calls from the syntax tree, excluding comments and string or
 * template data.
 *
 * Usage: node scripts/verify-dist-artifact.mjs [repoRoot]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parse } from 'acorn';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');
const root = path.resolve(process.argv[2] ?? defaultRoot);
const distDir = path.join(root, 'dist');
const SHEBANG = '#!/usr/bin/env node\n';
// 5s is generous for an uncontended boot of the bundled CLI. Under a full
// vitest run every core is saturated and the same boot can take >5s, so the
// suite may grant explicit headroom; the standalone gate keeps the strict
// default.
const DEFAULT_CLI_PROBE_TIMEOUT_MS = 5_000;
// Explicit suite headroom is capped so environment input cannot turn a
// verifier probe into an arbitrarily long hang.
const MAX_CLI_PROBE_TIMEOUT_MS = 30_000;
function parseCliProbeTimeoutMs(value) {
  if (value === undefined || value.trim() === '') return DEFAULT_CLI_PROBE_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CLI_PROBE_TIMEOUT_MS) {
    fail(`VERIFY_DIST_CLI_PROBE_TIMEOUT_MS must be a finite integer between 1 and ${MAX_CLI_PROBE_TIMEOUT_MS}ms, got ${JSON.stringify(value)}`);
  }
  return timeoutMs;
}
const CLI_PROBE_TIMEOUT_MS = parseCliProbeTimeoutMs(process.env.VERIFY_DIST_CLI_PROBE_TIMEOUT_MS);
const DYNAMIC_VARIABLE_REGISTRY_RUNS = 1_000;

// Optional third-party peers that bundled runtimes (e.g. node-fetch) try to
// require and swallow on failure. These are NOT runtime dependencies of the
// action: the bundle runs correctly whether or not they resolve, and the
// catch swallows any error. Kept narrow, explicit, and documented so any NEW
// third-party require() in code position still fails the gate.
const OPTIONAL_PEER_ALLOWLIST = Object.freeze(['encoding']);
const PROTECTED_BOOT_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'GITHUB_WORKSPACE',
  'GITHUB_OUTPUT',
  'NODE_OPTIONS',
  'VERIFY_DIST_NETWORK_SENTINEL'
]);

function fail(message) {
  console.error(`verify-dist-artifact: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`unable to read ${file}: ${error instanceof Error ? error.message : error}`);
  }
  return undefined;
}

function actionRunsMain(packageRoot) {
  let text;
  try {
    text = readFileSync(path.join(packageRoot, 'action.yml'), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const runsIdx = lines.findIndex((line) => /^runs:\s*$/.test(line));
  if (runsIdx === -1) {
    return null;
  }
  for (let i = runsIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) {
      break;
    }
    const match = line.match(/^\s+main:\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function normalizedActionEntry(entryRel, source) {
  if (typeof entryRel !== 'string' || entryRel.length === 0) fail(`${source} must declare a non-empty entry path`);
  if (path.isAbsolute(entryRel) || path.win32.isAbsolute(entryRel)) fail(`${source} must point to a relative path under dist/, found ${JSON.stringify(entryRel)}`);
  if (entryRel.split(/[\\/]/).some((segment) => segment === '..')) fail(`${source} must not traverse outside dist/, found ${JSON.stringify(entryRel)}`);
  const normalized = path.posix.normalize(entryRel.replaceAll('\\', '/'));
  if (!normalized.startsWith('dist/') || normalized === 'dist/') fail(`${source} must point under dist/, found ${JSON.stringify(entryRel)}`);
  return normalized;
}
function validatedActionEntry(entryRel, source) {
  const normalized = normalizedActionEntry(entryRel, source);
  let segmentPath = root;
  for (const segment of normalized.split('/')) {
    segmentPath = path.join(segmentPath, segment);
    let segmentStat;
    try { segmentStat = lstatSync(segmentPath); } catch (error) { fail(`${source} path segment ${path.relative(root, segmentPath)} is unreadable: ${error instanceof Error ? error.message : error}`); }
    if (segmentStat.isSymbolicLink()) fail(`${source} path segment ${path.relative(root, segmentPath)} must not be a symlink`);
  }
  const entryAbs = path.resolve(root, normalized);
  const relativeToDist = path.relative(distDir, entryAbs);
  if (relativeToDist === '' || relativeToDist.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToDist)) fail(`${source} must resolve under dist/, found ${JSON.stringify(entryRel)}`);
  let entry;
  try { entry = lstatSync(entryAbs); } catch (error) { fail(`${source} entry ${normalized} is unreadable: ${error instanceof Error ? error.message : error}`); }
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${source} entry ${normalized} must be a regular non-symlink file`);
  return { normalized, entryAbs };
}

function deriveManifest() {
  const pkg = readJson(path.join(root, 'package.json'));
  const binField =
    typeof pkg.bin === 'string'
      ? { [String(pkg.name ?? '').split('/').pop() ?? 'cli']: pkg.bin }
      : (pkg.bin ?? {});
  const binNames = Object.keys(binField);
  if (binNames.length !== 1) {
    fail(`package.json bin must declare exactly one CLI entry, found ${binNames.length}`);
  }
  const binName = binNames[0];
  const cliRel = binField[binName];
  if (typeof cliRel !== 'string' || !cliRel.startsWith('dist/')) {
    fail(`package.json bin.${binName} must point under dist/, found ${JSON.stringify(cliRel)}`);
  }
  const census = new Set();
  if (typeof pkg.main === 'string' && pkg.main.startsWith('dist/')) {
    census.add(pkg.main.slice('dist/'.length));
  }
  census.add(cliRel.slice('dist/'.length));
  const runsMain = actionRunsMain(root);
  if (runsMain && runsMain.startsWith('dist/')) {
    census.add(runsMain.slice('dist/'.length));
  }
  if (census.size < 2) {
    fail(
      `manifest-derived dist census has ${census.size} entries; expected at least a CLI and one library/action entrypoint`
    );
  }
  return {
    version: String(pkg.version),
    binName,
    cliRel,
    expectedDist: [...census].sort((left, right) => left.localeCompare(right))
  };
}

const manifest = deriveManifest();
const CLI_REL = manifest.cliRel.split('/').join(path.sep);

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    return false;
  }
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return builtinModules.includes(bare) || builtinModules.includes(specifier);
}

function isAllowedOptionalPeer(specifier) {
  return OPTIONAL_PEER_ALLOWLIST.includes(specifier);
}

function literalRequireSpecifiers(source, sourcePath) {
  let ast;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowHashBang: true
    });
  } catch (error) {
    fail(`${sourcePath} failed JavaScript parsing for require census: ${error instanceof Error ? error.message : error}`);
  }

  const specifiers = [];

  function visit(node) {
    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0]?.type === 'Literal' &&
      typeof node.arguments[0].value === 'string'
    ) {
      specifiers.push(node.arguments[0].value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
        }
      } else if (value && typeof value === 'object' && typeof value.type === 'string') {
        visit(value);
      }
    }
  }

  visit(ast);
  return specifiers;
}

function assertExactCensus() {
  let entries;
  try {
    const dist = lstatSync(distDir);
    if (!dist.isDirectory() || dist.isSymbolicLink()) fail('dist root must be a regular non-symlink directory');
    entries = readdirSync(distDir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
  } catch (error) {
    fail(`unable to read ${distDir}: ${error instanceof Error ? error.message : error}`);
  }
  const expected = manifest.expectedDist;
  const names = entries.map((entry) => entry.name);
  if (names.length !== expected.length || names.some((name, i) => name !== expected[i])) {
    fail(
      `dist census mismatch: got [${names.join(', ')}], expected exact [${expected.join(', ')}] (unexpected file or missing entrypoint)`
    );
  }
  const nonFiles = entries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (nonFiles.length > 0) {
    fail(`dist entrypoint must be a regular file, not a directory or symlink: ${nonFiles.join(', ')}`);
  }
}

function assertShebang() {
  let contents;
  try {
    contents = readFileSync(path.join(root, CLI_REL), 'utf8');
  } catch (error) {
    fail(`unable to read ${CLI_REL}: ${error instanceof Error ? error.message : error}`);
  }
  if (!contents.startsWith(SHEBANG)) {
    fail(`${CLI_REL} missing Node shebang (expected first line ${JSON.stringify(SHEBANG.trim())})`);
  }
}

function assertDiskExecutable() {
  if (process.platform === 'win32') return;
  const cliPath = path.join(root, CLI_REL);
  const mode = statSync(cliPath).mode;
  if ((mode & 0o111) === 0) {
    fail(`${CLI_REL} is not executable on disk (mode 0o${(mode & 0o777).toString(8)}; need 0o111 bits)`);
  }
}

function gitContextOrNull() {
  try {
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return { toplevel, prefix };
  } catch {
    return null;
  }
}

function assertGitIndexExec() {
  const git = gitContextOrNull();
  if (!git) {
    // Temp fixture trees used by edge tests are not a git worktree.
    return;
  }
  const cliPathspec = `${git.prefix}${CLI_REL.split(path.sep).join('/')}`;
  let stage;
  try {
    stage = execFileSync('git', ['ls-files', '--stage', '--', cliPathspec], {
      cwd: git.toplevel,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (error) {
    fail(`unable to read git index for ${CLI_REL}: ${error instanceof Error ? error.message : error}`);
  }
  if (!stage) {
    // Dist-off-main worktrees intentionally keep generated artifacts ignored and untracked.
    try {
      execFileSync('git', ['check-ignore', '--quiet', '--', cliPathspec], {
        cwd: git.toplevel,
        stdio: 'ignore'
      });
      return;
    } catch {
      // Fall through to the existing untracked-file failure.
    }
    fail(`${CLI_REL} is not tracked in the git index`);
  }
  const mode = stage.split(' ', 1)[0];
  if (mode !== '100755') {
    fail(`${CLI_REL} git-index mode is ${mode}, expected 100755 (executable)`);
  }
}

function assertDirectHelpAndVersion() {
  const cliPath = path.join(root, CLI_REL);
  const command = process.platform === 'win32' ? process.execPath : cliPath;
  const cliArgs = process.platform === 'win32' ? [cliPath] : [];
  const sandbox = mkdtempSync(path.join(tmpdir(), 'verify-dist-sandbox-'));
  const homeDir = path.join(sandbox, 'home');
  const tmpDir = path.join(sandbox, 'tmp');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  // Minimal environment: no ambient credentials or CI variables leak into
  // the CLI under test, and #!/usr/bin/env node still resolves.
  const sandboxedEnv = {
    PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
    HOME: homeDir,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state')
  };
  const usagePattern = new RegExp(
    `Usage:\\s+${manifest.binName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'i'
  );
  try {
    const help = spawnSync(command, [...cliArgs, '--help'], {
      cwd: root,
      encoding: 'utf8',
      env: sandboxedEnv,
      timeout: CLI_PROBE_TIMEOUT_MS
    });
    if (help.error?.code === 'ETIMEDOUT') {
      fail(`direct ${CLI_REL} --help timed out after ${CLI_PROBE_TIMEOUT_MS}ms`);
    }
    if (help.status !== 0) {
      fail(`direct ${CLI_REL} --help exited ${help.status}: ${help.stderr || help.stdout}`);
    }
    if (!usagePattern.test(help.stdout)) {
      fail(`direct ${CLI_REL} --help missing usage banner (expected /Usage: ${manifest.binName}/)`);
    }
    if (/permission denied|exec format|syntax error|unexpected token|"use strict"/i.test(help.stderr)) {
      fail(`direct ${CLI_REL} --help produced shell/exec errors`);
    }

    const version = spawnSync(command, [...cliArgs, '--version'], {
      cwd: root,
      encoding: 'utf8',
      env: sandboxedEnv,
      timeout: CLI_PROBE_TIMEOUT_MS
    });
    if (version.error?.code === 'ETIMEDOUT') {
      fail(`direct ${CLI_REL} --version timed out after ${CLI_PROBE_TIMEOUT_MS}ms`);
    }
    if (version.status !== 0) {
      fail(`direct ${CLI_REL} --version exited ${version.status}: ${version.stderr || version.stdout}`);
    }
    if (version.stdout.trim() !== manifest.version) {
      fail(
        `direct ${CLI_REL} --version was ${JSON.stringify(version.stdout.trim())}, expected ${JSON.stringify(manifest.version)}`
      );
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function assertNodeCheck() {
  for (const name of manifest.expectedDist) {
    const target = path.join(distDir, name);
    const result = spawnSync(process.execPath, ['--check', target], {
      cwd: root,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      fail(`node --check ${path.join('dist', name)} failed: ${result.stderr || result.stdout}`);
    }
  }
}

function assertLiteralRequiresAreBuiltins() {
  for (const name of manifest.expectedDist) {
    const contents = readFileSync(path.join(distDir, name), 'utf8');
    const sourcePath = path.join('dist', name);
    for (const specifier of literalRequireSpecifiers(contents, sourcePath)) {
      if (isAllowedOptionalPeer(specifier)) {
        continue;
      }
      if (!isNodeBuiltin(specifier)) {
        fail(
          `${path.join('dist', name)} has non-builtin/third-party require(${JSON.stringify(specifier)}); only Node builtinModules (bare or node:) are allowed`
        );
      }
    }
  }
}

function createSandbox(prefix) {
  const sandbox = mkdtempSync(path.join(tmpdir(), prefix));
  const homeDir = path.join(sandbox, 'home');
  const tmpDir = path.join(sandbox, 'tmp');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  // Minimal environment: no ambient credentials or CI variables leak into
  // the artifact under test, and #!/usr/bin/env node still resolves.
  const env = {
    PATH: [path.dirname(process.execPath), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
    HOME: homeDir,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    XDG_CACHE_HOME: path.join(homeDir, '.cache'),
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(homeDir, '.local', 'state')
  };
  return { sandbox, env };
}

function createNetworkGuard(sandbox) {
  const sentinel = path.join(sandbox, 'network-attempted');
  const preload = path.join(sandbox, 'network-guard.cjs');
  writeFileSync(preload, [
    "const { appendFileSync } = require('node:fs');",
    "const sentinel = process.env.VERIFY_DIST_NETWORK_SENTINEL;",
    "function block(kind) { appendFileSync(sentinel, kind + '\\n'); throw new Error('VERIFY_DIST_NETWORK_FORBIDDEN ' + kind); }",
    "function patch(mod, names) { const target = require(mod); for (const name of names) { if (typeof target[name] === 'function') target[name] = (...args) => block(mod + '.' + name); } }",
    "patch('node:net', ['connect', 'createConnection']);",
    "const net = require('node:net'); if (net.Socket && net.Socket.prototype) net.Socket.prototype.connect = (...args) => block('node:net.Socket.connect');",
    "patch('node:tls', ['connect']);",
    "patch('node:http', ['request', 'get']);",
    "patch('node:https', ['request', 'get']);",
    "globalThis.fetch = (...args) => block('global.fetch');"
  ].join('\n'), 'utf8');
  return { sentinel, preload };
}

function dynamicVariableRegistryConfig() {
  const contractFile = path.join(root, 'scripts', 'dist-boot-contract.json');
  if (!existsSync(contractFile)) return null;
  const contract = readJson(contractFile);
  if (!Object.hasOwn(contract, 'dynamicVariableRegistry')) return null;
  const registry = contract.dynamicVariableRegistry;
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    fail('dist-boot-contract.json dynamicVariableRegistry must be an object');
  }
  if (typeof registry.export !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(registry.export)) {
    fail('dist-boot-contract.json dynamicVariableRegistry.export must be a non-empty safe JavaScript identifier');
  }
  if (!Number.isInteger(registry.expectedGeneratorCount) || registry.expectedGeneratorCount <= 0) {
    fail('dist-boot-contract.json dynamicVariableRegistry.expectedGeneratorCount must be a positive integer');
  }
  return { exportName: registry.export, expectedGeneratorCount: registry.expectedGeneratorCount };
}

function assertNoNetworkAttempt(sentinel, entryRel) {
  if (existsSync(sentinel)) fail(`entrypoint ${entryRel} attempted network I/O during boot: ${readFileSync(sentinel, 'utf8').trim()}`);
}

// Runtime failure classes that must never appear when booting a shipped
// artifact. The getter-only-core bundler bug surfaced exactly as a TypeError
// at load time, invisible to src/-importing tests and to node --check.
const BOOT_FAILURE_PATTERN = /TypeError:|ReferenceError:|is not a function|Cannot read properties of/;

/**
 * Execute-the-bytes gate, leg 1: require() the committed library entrypoint
 * (package.json main) in a sandboxed child process and touch every named
 * export. node --check parses; this actually runs module init and property
 * getters, which is where bundler/minifier artifacts (the getter-only-core
 * class) explode. Skipped when the library entrypoint IS the Action
 * entrypoint (single-entry actions execute on require; leg 2 covers them).
 */
function assertLibraryEntrypointBoots(dynamicVariableRegistry) {
  const pkg = readJson(path.join(root, 'package.json'));
  const mainRel = typeof pkg.main === 'string' ? pkg.main : null;
  if (!mainRel) {
    return;
  }
  const runsMain = actionRunsMain(root);
  if (runsMain && path.normalize(runsMain) === path.normalize(mainRel)) {
    // Requiring the entrypoint would execute the action; leg 2 boots it with
    // an explicit contract instead.
    return;
  }
  const mainAbs = path.join(root, mainRel.split('/').join(path.sep));
  const probe = [
    'const failures = [];',
    'let m;',
    'try {',
    `  m = require(${JSON.stringify(mainAbs)});`,
    '} catch (error) {',
    "  console.error('LIBRARY_REQUIRE_FAILED ' + (error && error.stack ? error.stack : error));",
    '  process.exit(1);',
    '}',
    'for (const key of Object.keys(m)) {',
    '  try { void m[key]; } catch (error) {',
    "    failures.push(key + ': ' + (error && error.message ? error.message : error));",
    '  }',
    '}',
    'if (failures.length > 0) {',
    "  console.error('LIBRARY_EXPORT_ACCESS_FAILED ' + failures.join('; '));",
    '  process.exit(1);',
    '}',
    `const dynamicVariableRegistry = ${JSON.stringify(dynamicVariableRegistry)};`,
    'if (dynamicVariableRegistry) {',
    '  let report;',
    '  const originalConsoleWarn = console.warn;',
    '  if (typeof m[dynamicVariableRegistry.exportName] !== \'function\') {',
    "    console.error('DYNAMIC_VARS_BOOT_FAILED missing export=' + dynamicVariableRegistry.exportName);",
    '    process.exit(1);',
    '  }',
    '  try {',
    '    console.warn = () => {};',
    `    for (let run = 1; run <= ${DYNAMIC_VARIABLE_REGISTRY_RUNS}; run += 1) {`,
    '      report = m[dynamicVariableRegistry.exportName]();',
    '      if (!report || report.generators !== dynamicVariableRegistry.expectedGeneratorCount || !Array.isArray(report.failures) || report.failures.length > 0) {',
    "        console.error('DYNAMIC_VARS_BOOT_FAILED run=' + run + ' result=' + JSON.stringify(report));",
    '        process.exit(1);',
    '      }',
    '    }',
    '  } catch (error) {',
    "    console.error('DYNAMIC_VARS_BOOT_FAILED result=' + JSON.stringify(report) + ' error=' + (error && error.stack ? error.stack : error));",
    '    process.exit(1);',
    '  } finally {',
    '    console.warn = originalConsoleWarn;',
    '  }',
    `  console.log('DYNAMIC_VARS_BOOT_OK ' + dynamicVariableRegistry.exportName + ' ' + report.generators + ' runs=${DYNAMIC_VARIABLE_REGISTRY_RUNS}');`,
    '} else {',
    "  console.log('DYNAMIC_VARS_BOOT_SKIPPED');",
    '}',
    "console.log('LIBRARY_BOOT_OK ' + Object.keys(m).length);",
    'process.exitCode = 0;'
  ].join('\n');
  const { sandbox, env } = createSandbox('verify-dist-libboot-');
  const networkGuard = createNetworkGuard(sandbox);
  try {
    const result = spawnSync(process.execPath, ['-e', probe], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...env, NODE_OPTIONS: `--require=${networkGuard.preload}`, VERIFY_DIST_NETWORK_SENTINEL: networkGuard.sentinel },
      timeout: 120_000
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assertNoNetworkAttempt(networkGuard.sentinel, mainRel);
    if (result.status !== 0) {
      fail(`library entrypoint ${mainRel} failed to boot under require(): ${output.trim()}`);
    }
    if (!/LIBRARY_BOOT_OK \d+/.test(result.stdout ?? '')) {
      fail(`library entrypoint ${mainRel} boot probe produced no receipt: ${output.trim()}`);
    }
    if (!/DYNAMIC_VARS_BOOT_(?:OK [A-Za-z_$][A-Za-z0-9_$]* \d+ runs=1000|SKIPPED)/.test(result.stdout ?? '')) {
      fail(`library entrypoint ${mainRel} dynamic-variable probe produced no receipt: ${output.trim()}`);
    }
    if (dynamicVariableRegistry) {
      console.log(`DYNAMIC_VARS_BOOT_OK ${dynamicVariableRegistry.exportName} ${dynamicVariableRegistry.expectedGeneratorCount} runs=${DYNAMIC_VARIABLE_REGISTRY_RUNS}`);
    }
    if (BOOT_FAILURE_PATTERN.test(output)) {
      fail(`library entrypoint ${mainRel} boot emitted a runtime failure class: ${output.trim()}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * Execute-the-bytes gate, leg 2: boot the committed Action entrypoint
 * (action.yml runs.main) with the gated-tier inputs declared in
 * scripts/dist-boot-contract.json. Gated runs return before any token mint,
 * so the boot is credential-free and network-free by construction. The
 * contract pins expected exit code and output markers; TypeError/
 * ReferenceError anywhere in the output fails regardless of exit code.
 */
function assertActionEntrypointBoots() {
  const contractFile = path.join(root, 'scripts', 'dist-boot-contract.json');
  try {
    statSync(contractFile);
  } catch {
    // Temp fixture trees and repos without a boot contract skip leg 2.
    return;
  }
  const contract = readJson(contractFile);
  const runsMain = actionRunsMain(root);
  if (!runsMain) fail('dist-boot-contract.json present but action.yml runs.main is missing');
  const actionEntry = validatedActionEntry(runsMain, 'action.yml runs.main');
  if (Object.hasOwn(contract, 'entry')) {
    const contractEntry = normalizedActionEntry(contract.entry, 'dist-boot-contract.json entry');
    if (contractEntry !== actionEntry.normalized) fail(`dist-boot-contract.json entry ${JSON.stringify(contract.entry)} does not match action.yml runs.main ${JSON.stringify(runsMain)}`);
  }
  if (!Number.isInteger(contract.exitCode)) {
    fail('dist-boot-contract.json must declare an integer exitCode');
  }
  if (!Array.isArray(contract.outputIncludes) || contract.outputIncludes.some((m) => typeof m !== 'string' || m.length === 0)) {
    fail('dist-boot-contract.json must declare outputIncludes as an array of non-empty strings');
  }
  if (Object.hasOwn(contract, 'githubOutputIncludes') && (!Array.isArray(contract.githubOutputIncludes) || contract.githubOutputIncludes.some((m) => typeof m !== 'string' || m.length === 0))) fail('dist-boot-contract.json githubOutputIncludes must be an array of non-empty strings');
  const contractEnv = contract.env ?? {};
  if (typeof contractEnv !== 'object' || Array.isArray(contractEnv)) {
    fail('dist-boot-contract.json env must be an object of string values');
  }
  for (const [name, value] of Object.entries(contractEnv)) {
    if (PROTECTED_BOOT_ENVIRONMENT_NAMES.has(name)) {
      fail(`dist-boot-contract.json env.${name} is a protected boot environment`);
    }
    if (typeof value !== 'string') {
      fail(`dist-boot-contract.json env.${name} must be a string`);
    }
    if (/(?:^|[-_])(?:key|token|secret|password|passphrase|credential)(?:$|[-_])/i.test(name)) {
      fail(`dist-boot-contract.json env.${name} looks credential-shaped; gated boots are credential-free by contract`);
    }
  }
  const entryRel = actionEntry.normalized;
  const entryAbs = actionEntry.entryAbs;
  const { sandbox, env } = createSandbox('verify-dist-actionboot-');
  const networkGuard = createNetworkGuard(sandbox);
  try {
    const githubOutput = path.join(sandbox, 'github-output');
    writeFileSync(githubOutput, '', 'utf8');
    const result = spawnSync(process.execPath, [entryAbs], {
      cwd: sandbox,
      encoding: 'utf8',
      env: {
        ...env,
        ...contractEnv,
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: githubOutput,
        NODE_OPTIONS: `--require=${networkGuard.preload}`,
        VERIFY_DIST_NETWORK_SENTINEL: networkGuard.sentinel
      },
      timeout: 120_000
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const githubOutputContents = readFileSync(githubOutput, 'utf8');
    assertNoNetworkAttempt(networkGuard.sentinel, entryRel);
    if (result.status !== contract.exitCode) {
      fail(`action entrypoint ${entryRel} boot exited ${result.status}, contract expects ${contract.exitCode}: ${output.trim().slice(0, 2000)}`);
    }
    for (const marker of contract.outputIncludes) {
      if (!output.includes(marker)) {
        fail(`action entrypoint ${entryRel} boot output missing contract marker ${JSON.stringify(marker)}: ${output.trim().slice(0, 2000)}`);
      }
    }
    for (const marker of contract.githubOutputIncludes ?? []) {
      if (!githubOutputContents.includes(marker)) fail(`action entrypoint ${entryRel} GitHub output missing contract marker ${JSON.stringify(marker)}: ${githubOutputContents.trim().slice(0, 2000)}`);
    }
    if (BOOT_FAILURE_PATTERN.test(output)) {
      fail(`action entrypoint ${entryRel} boot emitted a runtime failure class: ${output.trim().slice(0, 2000)}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

assertExactCensus();
assertShebang();
assertDiskExecutable();
assertGitIndexExec();
assertDirectHelpAndVersion();
assertNodeCheck();
assertLiteralRequiresAreBuiltins();
const dynamicVariableRegistry = dynamicVariableRegistryConfig();
assertLibraryEntrypointBoots(dynamicVariableRegistry);
assertActionEntrypointBoots();

console.log('verify-dist-artifact: ok');
