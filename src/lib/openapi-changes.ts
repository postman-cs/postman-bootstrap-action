import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import os from 'node:os';
import path from 'node:path';

export type BreakingChangeMode = 'off' | 'pr-native' | 'baseline-only' | 'previous-spec';
export type BreakingChangeStatus = 'passed' | 'failed' | 'skipped';

interface ExecLike {
  exec(
    commandLine: string,
    args?: string[],
    options?: Record<string, unknown>
  ): Promise<number> | number;
  getExecOutput(
    commandLine: string,
    args?: string[],
    options?: Record<string, unknown>
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface LoggerLike {
  info(message: string): void;
  warning(message: string): void;
}

export interface OpenApiBreakingChangeCheckInputs {
  baselineSpecPath?: string;
  currentSourceContent: string;
  currentUploadContent: string;
  logPath?: string;
  mode: BreakingChangeMode;
  previousSpecContent?: string;
  rulesPath?: string;
  specPath?: string;
  summaryPath?: string;
  targetRef?: string;
}

export interface OpenApiBreakingChangeCheckResult {
  breakingChanges: number;
  comparison: string;
  exitCode: number;
  logPath: string;
  message?: string;
  mode: BreakingChangeMode;
  status: BreakingChangeStatus;
  summaryPath: string;
}

export type OpenApiBreakingChangeCheckRunner = (
  inputs: OpenApiBreakingChangeCheckInputs,
  dependencies: OpenApiChangesDependencies
) => Promise<OpenApiBreakingChangeCheckResult>;

export interface OpenApiChangesDependencies {
  core: LoggerLike;
  env?: NodeJS.ProcessEnv;
  exec: ExecLike;
}

const TOOL_NAME = 'openapi-changes';
const OPENAPI_CHANGES_VERSION = '0.2.7';
const RELEASE_BASE_URL = `https://github.com/pb33f/openapi-changes/releases/download/v${OPENAPI_CHANGES_VERSION}`;

const CHECKSUMS: Record<string, Record<string, string>> = {
  '0.2.7': {
    'openapi-changes_0.2.7_darwin_arm64.tar.gz': '03e65e0d16c51fb8d43a93318409027bd9cd7c7c3355061d23c084c1ac9c0f7b',
    'openapi-changes_0.2.7_darwin_x86_64.tar.gz': 'c064dab16fac342926126d060efd157ff283e18548ccf6081a7a71a8d3c5bc04',
    'openapi-changes_0.2.7_linux_arm64.tar.gz': '698b29336699fd4ec61e52585f140a6450d112c1eb1c637bbe34c13b4203fecc',
    'openapi-changes_0.2.7_linux_i386.tar.gz': 'bb95699989ef67d0fd9d8644e56b1e183dea4dc439e59d051fe6964b87636f8c',
    'openapi-changes_0.2.7_linux_x86_64.tar.gz': '333742ea369c90437fbda47a814cf2393cb65eaa3867268a4c86281e74f614bf',
    'openapi-changes_0.2.7_windows_arm64.tar.gz': '3dfc29f88fb4332a3bf2d6d45fb9ab02ef907e7bc45fb8e8630ad943c4b9d814',
    'openapi-changes_0.2.7_windows_i386.tar.gz': '78e868e15d0e15f358f7f350af3c9532f6720a140bbb9241dbb947d49c6ec20c',
    'openapi-changes_0.2.7_windows_x86_64.tar.gz': 'fff5a68713b9093ad8ab547d214b5a3b9139ad71e90ee9e1347b3f9bd6e1e191'
  }
};

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => String(value ?? '').trim())?.trim();
}

function getWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return realpathSync(path.resolve(env.GITHUB_WORKSPACE || process.cwd()));
}

function getTempRoot(env: NodeJS.ProcessEnv = process.env): string {
  return realpathSync(path.resolve(env.RUNNER_TEMP || os.tmpdir()));
}

function ensureInsideRoot(root: string, candidate: string, message: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

function nearestExistingPath(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

function isInsideAnyRoot(roots: string[], candidate: string): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function assertOutputFileAllowed(
  filePath: string,
  workspaceRoot: string,
  tempRoot: string
): string {
  const workspaceRealPath = realpathSync(workspaceRoot);
  const tempRealPath = realpathSync(tempRoot);
  const resolved = path.resolve(filePath);
  const existingPath = nearestExistingPath(resolved);
  const existingRealPath = realpathSync(existingPath);
  if (!isInsideAnyRoot([workspaceRealPath, tempRealPath], existingRealPath)) {
    throw new Error('Breaking-change output path must stay within the workspace or runner temp directory');
  }
  return resolved;
}

function resolveConfiguredOutputPath(
  configuredPath: string | undefined,
  defaultFileName: string,
  workspaceRoot: string,
  tempRoot: string
): string {
  const defaultPath = path.join(tempRoot, 'postman-bootstrap', defaultFileName);
  if (!configuredPath) {
    return defaultPath;
  }
  const resolved = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(workspaceRoot, configuredPath);
  return assertOutputFileAllowed(resolved, workspaceRoot, tempRoot);
}

function resolveWorkspaceFilePath(
  configuredPath: string | undefined,
  workspaceRoot: string
): string | undefined {
  if (!configuredPath) {
    return undefined;
  }
  const workspaceRealPath = realpathSync(workspaceRoot);
  const resolved = path.isAbsolute(configuredPath)
    ? path.resolve(configuredPath)
    : path.resolve(workspaceRoot, configuredPath);
  ensureInsideRoot(workspaceRealPath, resolved, 'Breaking-change input path must stay within the workspace');
  if (!existsSync(resolved)) {
    return undefined;
  }
  const realResolved = realpathSync(resolved);
  ensureInsideRoot(
    workspaceRealPath,
    realResolved,
    'Breaking-change input path must stay within the workspace'
  );
  return realResolved;
}

function workspaceRelativePath(filePath: string, workspaceRoot: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceRoot, filePath);
  const realResolved = existsSync(resolved) ? realpathSync(resolved) : resolved;
  ensureInsideRoot(workspaceRoot, realResolved, 'spec-path must stay within the workspace');
  const relative = path.relative(workspaceRoot, realResolved);
  return relative.split(path.sep).join('/');
}

function normalizeBranch(value: string | undefined): string {
  let branchName = String(value || 'main').trim();
  branchName = branchName
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');
  if (!branchName) {
    branchName = 'main';
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(branchName)) {
    throw new Error(`Unsupported target branch name: ${branchName}`);
  }
  return branchName;
}

async function gitObjectExists(
  dependencies: OpenApiChangesDependencies,
  refSpec: string,
  cwd: string
): Promise<boolean> {
  const result = await dependencies.exec.getExecOutput('git', ['cat-file', '-e', refSpec], {
    cwd,
    ignoreReturnCode: true
  });
  return result.exitCode === 0;
}

function targetBranchCandidates(
  configuredTargetRef: string | undefined,
  env: NodeJS.ProcessEnv
): string[] {
  const targetBranch = normalizeBranch(firstValue(
    configuredTargetRef,
    env.GITHUB_BASE_REF,
    env.CHANGE_TARGET,
    env.BITBUCKET_TARGET_BRANCH,
    env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME,
    env.SYSTEM_PULLREQUEST_TARGETBRANCH,
    'main'
  ));
  return Array.from(new Set([`origin/${targetBranch}`, targetBranch]));
}

async function writeTempSpecFile(
  tempRoot: string,
  name: string,
  content: string
): Promise<string> {
  const tempDir = path.join(tempRoot, 'postman-bootstrap', `openapi-changes-${process.pid}-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  const filePath = path.join(tempDir, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function removeTempSpecFile(filePath: string): Promise<void> {
  const parent = path.dirname(filePath);
  if (parent.includes(`${path.sep}openapi-changes-`)) {
    await rm(parent, { recursive: true, force: true });
  }
}

type ComparisonSource =
  | {
      current: string;
      label: string;
      previous: string;
      tempFiles: string[];
    }
  | {
      reason: string;
      skipped: true;
    };

async function resolveComparisonSource(
  inputs: OpenApiBreakingChangeCheckInputs,
  dependencies: OpenApiChangesDependencies,
  workspaceRoot: string,
  tempRoot: string
): Promise<ComparisonSource> {
  if (inputs.mode === 'previous-spec') {
    if (!inputs.previousSpecContent) {
      return {
        skipped: true,
        reason: 'No existing Spec Hub content was available for comparison.'
      };
    }
    const previous = await writeTempSpecFile(tempRoot, 'previous-openapi.json', inputs.previousSpecContent);
    const current = await writeTempSpecFile(tempRoot, 'current-openapi.json', inputs.currentUploadContent);
    return {
      current,
      label: 'Spec Hub previous version -> incoming spec',
      previous,
      tempFiles: [previous, current]
    };
  }

  const currentPath = inputs.specPath
    ? resolveWorkspaceFilePath(inputs.specPath, workspaceRoot)
    : undefined;

  if (inputs.mode === 'pr-native' && inputs.specPath && currentPath) {
    const gitSpecPath = workspaceRelativePath(inputs.specPath, workspaceRoot);
    for (const targetRef of targetBranchCandidates(inputs.targetRef, dependencies.env ?? process.env)) {
      const targetRefSpec = `${targetRef}:${gitSpecPath}`;
      if (await gitObjectExists(dependencies, targetRefSpec, workspaceRoot)) {
        return {
          current: gitSpecPath,
          label: `${targetRefSpec} -> ${gitSpecPath}`,
          previous: targetRefSpec,
          tempFiles: []
        };
      }
    }
  }

  const baselinePath = resolveWorkspaceFilePath(inputs.baselineSpecPath, workspaceRoot);
  if (baselinePath) {
    const current = currentPath ?? await writeTempSpecFile(
      tempRoot,
      'current-openapi.json',
      inputs.currentUploadContent
    );
    return {
      current,
      label: `${inputs.baselineSpecPath} -> ${inputs.specPath || 'incoming spec'}`,
      previous: baselinePath,
      tempFiles: currentPath ? [] : [current]
    };
  }

  return {
    skipped: true,
    reason: inputs.mode === 'baseline-only'
      ? `No baseline spec found at ${inputs.baselineSpecPath || '(empty)'}.`
      : 'No target-branch spec or baseline spec was available for comparison.'
  };
}

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g');

function stripAnsi(value: string): string {
  return String(value || '').replace(ANSI_ESCAPE_PATTERN, '');
}

function sanitizeOpenApiChangesSummary(value: string): string {
  return String(value || '')
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.trim().replace(/\*\*/g, '');
      return !/^Date:\s.*\|\s*Commit:\s*Original:\s.*,\s*Modified:\s.*$/.test(normalized);
    })
    .join('\n')
    .trim();
}

function breakingChangeCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, entry) => total + breakingChangeCount(entry), 0);
  }
  if (!value || typeof value !== 'object') {
    return 0;
  }
  let total = 0;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (
      entry === true &&
      ['breaking', 'breakingchange', 'isbreaking', 'isbreakingchange'].includes(normalizedKey)
    ) {
      total += 1;
      continue;
    }
    total += breakingChangeCount(entry);
  }
  return total;
}

function formatReport(options: {
  body?: string;
  comparison?: string;
  message?: string;
  status: BreakingChangeStatus;
}): string {
  const lines = [
    '# OpenAPI Breaking Change Check',
    '',
    `Status: ${options.status}`
  ];
  if (options.comparison) {
    lines.push(`Comparison: ${options.comparison}`);
  }
  if (options.message) {
    lines.push('', options.message);
  }
  if (options.body?.trim()) {
    lines.push('', options.body.trim());
  }
  return `${lines.join('\n')}\n`;
}

async function writeReportFiles(
  summaryPath: string,
  logPath: string,
  report: string,
  log: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(summaryPath, report, 'utf8');
  await writeFile(logPath, log, 'utf8');
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `\n${report}\n`, 'utf8');
  }
}

function buildResultJson(result: OpenApiBreakingChangeCheckResult): string {
  return JSON.stringify({
    breakingChanges: result.breakingChanges,
    comparison: result.comparison,
    exitCode: result.exitCode,
    logPath: result.logPath,
    message: result.message,
    mode: result.mode,
    status: result.status,
    summaryPath: result.summaryPath
  });
}

export function createBreakingChangeSummaryJson(result: OpenApiBreakingChangeCheckResult): string {
  return buildResultJson(result);
}

function mapPlatform(): string {
  const platforms: Record<NodeJS.Platform, string | undefined> = {
    aix: undefined,
    android: undefined,
    darwin: 'darwin',
    freebsd: undefined,
    haiku: undefined,
    linux: 'linux',
    openbsd: undefined,
    sunos: undefined,
    win32: 'windows',
    cygwin: undefined,
    netbsd: undefined
  };
  const platform = platforms[process.platform];
  if (!platform) {
    throw new Error(`Unsupported openapi-changes platform: ${process.platform}`);
  }
  return platform;
}

function mapArch(): string {
  const architectures: Record<string, string | undefined> = {
    arm: undefined,
    arm64: 'arm64',
    ia32: 'i386',
    loong64: undefined,
    mips: undefined,
    mipsel: undefined,
    ppc: undefined,
    ppc64: undefined,
    riscv64: undefined,
    s390: undefined,
    s390x: undefined,
    x64: 'x86_64'
  };
  const arch = architectures[process.arch];
  if (!arch) {
    throw new Error(`Unsupported openapi-changes architecture: ${process.arch}`);
  }
  return arch;
}

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function validatePinnedOpenApiChangesChecksums(): void {
  for (const [version, checksums] of Object.entries(CHECKSUMS)) {
    for (const [assetName, checksum] of Object.entries(checksums)) {
      if (!/^[a-f0-9]{64}$/.test(checksum)) {
        throw new Error(
          `Pinned checksum for ${assetName} in openapi-changes ${version} must be a 64-character lowercase SHA-256 hex digest`
        );
      }
    }
  }
}

function downloadFile(url: string, destination: string, redirectsRemaining = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;

      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        if (redirectsRemaining <= 0) {
          reject(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        const redirectedUrl = new URL(location, url);
        if (redirectedUrl.protocol !== 'https:') {
          reject(new Error(`Refusing non-HTTPS redirect for ${url}`));
          return;
        }
        downloadFile(redirectedUrl.toString(), destination, redirectsRemaining - 1)
          .then(resolve, reject);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`Download failed for ${url}: HTTP ${statusCode}`));
        return;
      }

      const output = createWriteStream(destination, { flags: 'w' });
      response.pipe(output);
      output.on('finish', () => output.close(() => resolve()));
      output.on('error', reject);
    }).on('error', reject);
  });
}

async function assertBinaryWorks(
  binaryPath: string,
  dependencies: OpenApiChangesDependencies
): Promise<void> {
  const result = await dependencies.exec.getExecOutput(binaryPath, ['version'], {
    ignoreReturnCode: true,
    silent: true
  });
  const installedVersion = result.stdout.trim();
  if (result.exitCode !== 0 || installedVersion !== OPENAPI_CHANGES_VERSION) {
    throw new Error(
      `Expected ${TOOL_NAME} ${OPENAPI_CHANGES_VERSION}, found ${installedVersion || '(unknown)'}.`
    );
  }
}

async function assertSafeTarEntries(
  archivePath: string,
  dependencies: OpenApiChangesDependencies
): Promise<void> {
  const listing = await dependencies.exec.getExecOutput('tar', ['-tzf', archivePath], {
    ignoreReturnCode: true,
    silent: true
  });
  if (listing.exitCode !== 0) {
    throw new Error(`Could not inspect ${TOOL_NAME} archive: ${listing.stderr}`);
  }
  for (const rawEntry of listing.stdout.split(/\r?\n/)) {
    const entry = rawEntry.trim();
    if (!entry) {
      continue;
    }
    if (entry.startsWith('/') || entry.startsWith('\\') || entry.includes('..')) {
      throw new Error(`Refusing unsafe archive entry: ${entry}`);
    }
  }
}

function findBinary(searchRoot: string, binaryName: string): string {
  const entries = readdirSync(searchRoot, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(searchRoot, entry.name);
    if (entry.isDirectory()) {
      const nested = findBinary(entryPath, binaryName);
      if (nested) {
        return nested;
      }
    } else if (entry.name === binaryName || entry.name === TOOL_NAME) {
      return entryPath;
    }
  }
  return '';
}

export async function installOpenApiChanges(
  dependencies: OpenApiChangesDependencies
): Promise<string> {
  validatePinnedOpenApiChangesChecksums();
  const env = dependencies.env ?? process.env;
  const tempRoot = getTempRoot(env);
  const platform = mapPlatform();
  const arch = mapArch();
  const binaryName = process.platform === 'win32' ? `${TOOL_NAME}.exe` : TOOL_NAME;
  const toolRoot = path.join(tempRoot, 'postman-bootstrap-tools', TOOL_NAME, OPENAPI_CHANGES_VERSION, `${platform}-${arch}`);
  const binDir = path.join(toolRoot, 'bin');
  const downloadsDir = path.join(toolRoot, 'downloads');
  const extractDir = path.join(toolRoot, `extract-${Date.now()}`);
  const binaryPath = path.join(binDir, binaryName);

  if (existsSync(binaryPath)) {
    try {
      await assertBinaryWorks(binaryPath, dependencies);
      dependencies.core.info(`${TOOL_NAME} ${OPENAPI_CHANGES_VERSION} already installed at ${binaryPath}`);
      return binaryPath;
    } catch (error) {
      dependencies.core.warning(
        `Reinstalling ${TOOL_NAME}: ${error instanceof Error ? error.message : String(error)}`
      );
      rmSync(binaryPath, { force: true });
    }
  }

  const assetName = `${TOOL_NAME}_${OPENAPI_CHANGES_VERSION}_${platform}_${arch}.tar.gz`;
  const expectedChecksum = CHECKSUMS[OPENAPI_CHANGES_VERSION]?.[assetName];
  if (!expectedChecksum) {
    throw new Error(`No pinned checksum is configured for ${assetName}.`);
  }

  mkdirSync(binDir, { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });

  const archivePath = path.join(downloadsDir, assetName);
  await downloadFile(`${RELEASE_BASE_URL}/${assetName}`, archivePath);

  const actualChecksum = sha256(archivePath);
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`Checksum mismatch for ${assetName}: expected ${expectedChecksum}, got ${actualChecksum}`);
  }

  await assertSafeTarEntries(archivePath, dependencies);
  await dependencies.exec.exec('tar', ['-xzf', archivePath, '-C', extractDir], {
    silent: true
  });

  const extractedBinary = findBinary(extractDir, binaryName);
  if (!extractedBinary) {
    throw new Error(`Could not find ${binaryName} in ${assetName}.`);
  }

  rmSync(binaryPath, { force: true });
  copyFileSync(extractedBinary, binaryPath);
  if (process.platform !== 'win32') {
    chmodSync(binaryPath, 0o755);
  }
  rmSync(extractDir, { recursive: true, force: true });

  await assertBinaryWorks(binaryPath, dependencies);
  dependencies.core.info(`Installed ${TOOL_NAME} ${OPENAPI_CHANGES_VERSION} at ${binaryPath}`);
  return binaryPath;
}

function rulesArgs(rulesPath: string | undefined, workspaceRoot: string, tempRoot: string): string[] {
  const resolved = resolveWorkspaceFilePath(rulesPath, workspaceRoot);
  if (resolved) {
    return ['--config', resolved];
  }
  const defaultRulesPath = path.join(tempRoot, 'postman-bootstrap', 'openapi-changes-default-rules.yaml');
  mkdirSync(path.dirname(defaultRulesPath), { recursive: true });
  writeFileSync(defaultRulesPath, '{}\n', 'utf8');
  return ['--config', defaultRulesPath];
}

export const runOpenApiBreakingChangeCheck: OpenApiBreakingChangeCheckRunner = async (
  inputs,
  dependencies
) => {
  const env = dependencies.env ?? process.env;
  const workspaceRoot = getWorkspaceRoot(env);
  const tempRoot = getTempRoot(env);
  if (inputs.mode === 'off') {
    return {
      breakingChanges: 0,
      comparison: '',
      exitCode: 0,
      logPath: '',
      message: 'Breaking-change check is disabled.',
      mode: inputs.mode,
      status: 'skipped',
      summaryPath: ''
    };
  }

  const summaryPath = resolveConfiguredOutputPath(
    inputs.summaryPath,
    'openapi-changes-summary.md',
    workspaceRoot,
    tempRoot
  );
  const logPath = resolveConfiguredOutputPath(
    inputs.logPath,
    'openapi-changes.log',
    workspaceRoot,
    tempRoot
  );

  const source = await resolveComparisonSource(inputs, dependencies, workspaceRoot, tempRoot);
  if ('skipped' in source) {
    const report = formatReport({
      message: source.reason,
      status: 'skipped'
    });
    await writeReportFiles(summaryPath, logPath, report, source.reason, env);
    return {
      breakingChanges: 0,
      comparison: '',
      exitCode: 0,
      logPath,
      message: source.reason,
      mode: inputs.mode,
      status: 'skipped',
      summaryPath
    };
  }

  try {
    const binaryPath = await installOpenApiChanges(dependencies);
    const configArgs = rulesArgs(inputs.rulesPath, workspaceRoot, tempRoot);
    const reportArgs = [
      'report',
      '--reproducible',
      '--no-color',
      ...configArgs,
      source.previous,
      source.current
    ];
    const reportResult = await dependencies.exec.getExecOutput(binaryPath, reportArgs, {
      cwd: workspaceRoot,
      ignoreReturnCode: true,
      silent: true
    });
    const reportStdout = stripAnsi(reportResult.stdout);
    const reportStderr = stripAnsi(reportResult.stderr);
    let breakingChanges = 0;
    let parsedReport = false;
    if (reportStdout.trim()) {
      try {
        breakingChanges = breakingChangeCount(JSON.parse(reportStdout) as unknown);
        parsedReport = true;
      } catch (error) {
        dependencies.core.warning(
          `Could not parse openapi-changes JSON report: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const summaryArgs = [
      'summary',
      '--markdown',
      '--no-logo',
      '--no-color',
      '--with-lines',
      ...configArgs,
      source.previous,
      source.current
    ];
    const summaryResult = await dependencies.exec.getExecOutput(binaryPath, summaryArgs, {
      cwd: workspaceRoot,
      ignoreReturnCode: true,
      silent: true
    });
    const summaryStdout = sanitizeOpenApiChangesSummary(stripAnsi(summaryResult.stdout));
    const summaryStderr = stripAnsi(summaryResult.stderr);

    const commandFailed =
      (reportResult.exitCode !== 0 && !parsedReport) ||
      (summaryResult.exitCode !== 0 && !summaryStdout.trim() && breakingChanges === 0);
    const status: BreakingChangeStatus = commandFailed || breakingChanges > 0 ? 'failed' : 'passed';
    const message = commandFailed
      ? 'openapi-changes failed while comparing specifications.'
      : breakingChanges > 0
        ? `${breakingChanges} breaking change marker${breakingChanges === 1 ? '' : 's'} detected.`
        : 'No breaking changes detected.';
    const report = formatReport({
      body: summaryStdout || message,
      comparison: source.label,
      message,
      status
    });
    const log = [
      `report exit code: ${reportResult.exitCode}`,
      reportStderr.trim(),
      `summary exit code: ${summaryResult.exitCode}`,
      summaryStderr.trim()
    ].filter(Boolean).join('\n\n');
    await writeReportFiles(summaryPath, logPath, report, log, env);

    return {
      breakingChanges,
      comparison: source.label,
      exitCode: status === 'failed' ? 1 : 0,
      logPath,
      message,
      mode: inputs.mode,
      status,
      summaryPath
    };
  } finally {
    for (const tempFile of source.tempFiles) {
      await removeTempSpecFile(tempFile);
    }
  }
};
