import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  runOpenApiBreakingChangeCheck,
  validatePinnedOpenApiChangesChecksums,
  type OpenApiChangesDependencies
} from '../src/lib/openapi-changes.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function platformName(): string {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  if (process.platform === 'win32') return 'windows';
  throw new Error(`Unsupported test platform: ${process.platform}`);
}

function archName(): string {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'i386';
  if (process.arch === 'x64') return 'x86_64';
  throw new Error(`Unsupported test architecture: ${process.arch}`);
}

async function createInstalledBinary(tempRoot: string): Promise<string> {
  const realTempRoot = await realpath(tempRoot);
  const binaryName = process.platform === 'win32' ? 'openapi-changes.exe' : 'openapi-changes';
  const binaryPath = path.join(
    realTempRoot,
    'postman-bootstrap-tools',
    'openapi-changes',
    '0.2.7',
    `${platformName()}-${archName()}`,
    'bin',
    binaryName
  );
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await writeFile(binaryPath, '', 'utf8');
  return binaryPath;
}

function createDependencies(
  binaryPath?: string,
  options: { onReportArgs?: (args: string[]) => Promise<void> | void } = {}
): OpenApiChangesDependencies {
  const getExecOutput = vi.fn(async (commandLine: string, args: string[] = []) => {
    if (binaryPath && commandLine === binaryPath && args[0] === 'version') {
      return { exitCode: 0, stdout: '0.2.7\n', stderr: '' };
    }
    if (binaryPath && commandLine === binaryPath && args[0] === 'report') {
      await options.onReportArgs?.(args);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ changes: [{ breaking: true }] }),
        stderr: ''
      };
    }
    if (binaryPath && commandLine === binaryPath && args[0] === 'summary') {
      return {
        exitCode: 0,
        stdout: [
          '## Removed operation',
          '**Date**: 05/21/26 | **Commit**: Original: /home/runner/work/_temp/postman-bootstrap/openapi-changes-123/previous-openapi.json, Modified: /home/runner/work/_temp/postman-bootstrap/openapi-changes-123/current-openapi.json',
          '',
          'BREAKING Changes: 1 out of 1'
        ].join('\n'),
        stderr: ''
      };
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected command' };
  });

  return {
    core: {
      info: vi.fn(),
      warning: vi.fn()
    },
    exec: {
      exec: vi.fn().mockResolvedValue(0),
      getExecOutput
    }
  };
}

describe('openapi-changes breaking-change check', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('validates every pinned release checksum shape', () => {
    expect(() => validatePinnedOpenApiChangesChecksums()).not.toThrow();
  });

  it('keeps default reports in runner temp and fails when the JSON report marks breaking changes', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const runnerTemp = await makeTempDir('postman-bootstrap-runner-');
    const realRunnerTemp = await realpath(runnerTemp);
    const binaryPath = await createInstalledBinary(runnerTemp);
    await writeFile(path.join(workspace, 'baseline.yaml'), 'openapi: 3.1.0\ninfo:\n  title: API\n  version: 1\npaths: {}\n');
    let commandCurrentContent = '';
    let commandConfigContent = '';
    let commandConfigPath = '';
    const dependencies = createDependencies(binaryPath, {
      onReportArgs: async (args) => {
        const configIndex = args.indexOf('--config');
        commandConfigPath = args[configIndex + 1] ?? '';
        commandConfigContent = await readFile(commandConfigPath, 'utf8');
        commandCurrentContent = await readFile(args.at(-1) ?? '', 'utf8');
      }
    });
    dependencies.env = {
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp
    };

    const result = await runOpenApiBreakingChangeCheck(
      {
        baselineSpecPath: 'baseline.yaml',
        currentSourceContent: 'openapi: 3.1.0\ninfo:\n  title: API\n  version: 2\npaths:\n  /from-source:\n    $ref: ./paths.yaml\n',
        currentUploadContent: '{"openapi":"3.1.0","paths":{"/bundled":{}}}',
        mode: 'baseline-only',
        rulesPath: 'changes-rules.yaml'
      },
      dependencies
    );

    expect(result.status).toBe('failed');
    expect(result.breakingChanges).toBe(1);
    expect(result.summaryPath.startsWith(realRunnerTemp)).toBe(true);
    expect(result.logPath.startsWith(realRunnerTemp)).toBe(true);
    const summary = await readFile(result.summaryPath, 'utf8');
    expect(summary).toContain('Status: failed');
    expect(summary).toContain('## Removed operation');
    expect(summary).toContain('BREAKING Changes: 1 out of 1');
    expect(summary).not.toContain('Date:');
    expect(summary).not.toContain('/home/runner/work/_temp');
    expect(commandCurrentContent).toBe('{"openapi":"3.1.0","paths":{"/bundled":{}}}');
    expect(commandConfigPath.startsWith(realRunnerTemp)).toBe(true);
    expect(commandConfigContent).toBe('{}\n');
    expect(dependencies.exec.getExecOutput).toHaveBeenCalledWith(
      binaryPath,
      expect.arrayContaining(['report']),
      expect.objectContaining({ silent: true })
    );
    expect(dependencies.exec.getExecOutput).toHaveBeenCalledWith(
      binaryPath,
      expect.arrayContaining(['summary']),
      expect.objectContaining({ silent: true })
    );
  });

  it('skips without installing openapi-changes when the enabled mode has no comparison source', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const runnerTemp = await makeTempDir('postman-bootstrap-runner-');
    const dependencies = createDependencies();
    dependencies.env = {
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp
    };

    const result = await runOpenApiBreakingChangeCheck(
      {
        baselineSpecPath: 'missing.yaml',
        currentSourceContent: 'openapi: 3.1.0\ninfo:\n  title: API\n  version: 2\npaths: {}\n',
        currentUploadContent: '{}',
        mode: 'baseline-only'
      },
      dependencies
    );

    expect(result.status).toBe('skipped');
    expect(dependencies.exec.getExecOutput).not.toHaveBeenCalled();
    expect(await readFile(result.summaryPath, 'utf8')).toContain('No baseline spec found');
  });

  it('rejects configured report paths that escape the workspace', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const runnerTemp = await makeTempDir('postman-bootstrap-runner-');
    const dependencies = createDependencies();
    dependencies.env = {
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp
    };

    await expect(
      runOpenApiBreakingChangeCheck(
        {
          currentSourceContent: '{}',
          currentUploadContent: '{}',
          mode: 'baseline-only',
          summaryPath: '../outside.md'
        },
        dependencies
      )
    ).rejects.toThrow(/output path must stay/i);
  });
});
