import { execFile } from 'node:child_process';
import { access, constants, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('CLI packaging contract', () => {
  it('commits a Node shebang and git-index executable mode on dist/cli.cjs', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const contents = await readFile(cliPath, 'utf8');
    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true);

    const mode = (await stat(cliPath)).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
    await access(cliPath, constants.X_OK);

    const staged = await execFileAsync('git', ['ls-files', '--stage', 'dist/cli.cjs'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(staged.stdout).toMatch(/^100755 /);
  });

  it('runs ./dist/cli.cjs --help and --version without credentials, network, or writes', async () => {
    const cliPath = path.join(repoRoot, 'dist', 'cli.cjs');
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const sandbox = await makeTempDir('postman-bootstrap-cli-sandbox-');
    const env = {
      PATH: process.env.PATH ?? '',
      INPUT_POSTMAN_API_KEY: '',
      POSTMAN_API_KEY: '',
      POSTMAN_ACCESS_TOKEN: '',
      INPUT_POSTMAN_ACCESS_TOKEN: '',
      HOME: sandbox,
      TMPDIR: sandbox
    };

    const help = await execFileAsync(cliPath, ['--help'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(help.stdout).toMatch(/Usage:\s+postman-bootstrap/i);
    expect(help.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token|"use strict"/i);

    const version = await execFileAsync(cliPath, ['--version'], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024
    });
    expect(version.stdout.trim()).toBe(packageJson.version);

    const written = await execFileAsync('find', [sandbox, '-type', 'f'], {
      encoding: 'utf8'
    });
    expect(written.stdout.trim()).toBe('');
  }, 20_000);

  it('keeps an exact dist census of action/cli/index entrypoints', async () => {
    const distDir = path.join(repoRoot, 'dist');
    const entries = (await execFileAsync('git', ['ls-files', '--', 'dist'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })).stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((filePath) => path.basename(filePath))
      .sort();
    expect(entries).toEqual(['action.cjs', 'cli.cjs', 'index.cjs']);

    const onDisk = (await import('node:fs/promises')).readdir(distDir);
    expect((await onDisk).slice().sort()).toEqual(['action.cjs', 'cli.cjs', 'index.cjs']);
  });

  it('does not rebuild dist from packaging tests', async () => {
    const packageJson = await readFile(path.join(repoRoot, 'package.json'), 'utf8');
    const packagingSource = await readFile(path.join(repoRoot, 'tests', 'cli-packaging.test.ts'), 'utf8');
    const executableLines = packagingSource
      .split(/\r?\n/)
      .filter((line) => !/^\s*(?:\/\/|expect\(|it\(|describe\()/.test(line))
      .join('\n');
    expect(packageJson).toMatch(/"verify:dist:assert"/);
    expect(executableLines).not.toMatch(/\bnpm run (?:build|bundle)\b/);
    expect(executableLines).not.toMatch(/\besbuild\b/);
    expect(executableLines).not.toMatch(/rm -rf dist/);
  });
});
