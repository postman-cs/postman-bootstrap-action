import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const CHILD_TIMEOUT_MS = 15_000;
const temporaryDirectories: string[] = [];

function fixtureGitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HOME: tmpdir(),
    LANG: 'C'
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: fixtureGitEnv()
  }).trim();
}

function createTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-release-alias-git-'));
  temporaryDirectories.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'alias-fixture']);
  git(root, ['config', 'user.email', 'alias-fixture@example.com']);
  return root;
}

function commitPackage(cwd: string, version: string, message: string): string {
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({ name: '@postman-cse/onboarding-bootstrap', version }, null, 2)}\n`);
  git(cwd, ['add', 'package.json']);
  git(cwd, ['commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function packageVersionAt(cwd: string, rev: string): string {
  const text = git(cwd, ['show', `${rev}:package.json`]);
  return JSON.parse(text).version as string;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe('release alias git dereference fixtures', { timeout: 30_000 }, () => {
  it('peels lightweight and annotated immutable tags to the candidate commit', () => {
    const repo = createTempRepo();
    const candidate = commitPackage(repo, '2.9.8', 'immutable candidate');

    git(repo, ['tag', 'v2.9.8-light', candidate]);
    git(repo, ['tag', '-a', 'v2.9.8-annotated', '-m', 'immutable annotated', candidate]);

    expect(git(repo, ['rev-parse', 'v2.9.8-light^{commit}'])).toBe(candidate);
    expect(git(repo, ['rev-parse', 'v2.9.8-annotated^{commit}'])).toBe(candidate);
    expect(git(repo, ['rev-parse', 'v2.9.8-light'])).toBe(candidate);
    expect(git(repo, ['rev-parse', 'v2.9.8-annotated'])).not.toBe(candidate);
    expect(git(repo, ['cat-file', '-t', 'v2.9.8-annotated'])).toBe('tag');
  });

  it('reads package.json through ^{commit} for lightweight and annotated rolling aliases', () => {
    const repo = createTempRepo();
    const older = commitPackage(repo, '2.9.7', 'older alias target');
    const candidate = commitPackage(repo, '2.9.8', 'candidate release');

    git(repo, ['tag', 'v2-light', older]);
    git(repo, ['tag', '-a', 'v2-annotated', '-m', 'Rolling v2 alias', older]);

    expect(git(repo, ['rev-parse', 'v2-light^{commit}'])).toBe(older);
    expect(git(repo, ['rev-parse', 'v2-annotated^{commit}'])).toBe(older);
    expect(packageVersionAt(repo, 'v2-light^{commit}')).toBe('2.9.7');
    expect(packageVersionAt(repo, 'v2-annotated^{commit}')).toBe('2.9.7');

    const headCommit = git(repo, ['rev-parse', 'HEAD^{commit}']);
    expect(headCommit).toBe(candidate);
    expect(packageVersionAt(repo, 'HEAD^{commit}')).toBe('2.9.8');

    git(repo, ['tag', '-fa', 'v2-light', '-m', 'Rolling v2 alias', headCommit]);
    git(repo, ['tag', '-fa', 'v2-annotated', '-m', 'Rolling v2 alias', headCommit]);
    expect(git(repo, ['rev-parse', 'v2-light^{commit}'])).toBe(candidate);
    expect(git(repo, ['rev-parse', 'v2-annotated^{commit}'])).toBe(candidate);
    expect(packageVersionAt(repo, 'v2-light^{commit}')).toBe('2.9.8');
    expect(packageVersionAt(repo, 'v2-annotated^{commit}')).toBe('2.9.8');
  });

  it('proves annotated tag object SHA differs from the peeled candidate commit', () => {
    const repo = createTempRepo();
    const candidate = commitPackage(repo, '2.9.8', 'annotated checkout candidate');
    git(repo, ['tag', '-a', 'v2.9.8', '-m', 'immutable annotated', candidate]);

    const annotatedObject = git(repo, ['rev-parse', 'v2.9.8']);
    const peeledFromTag = git(repo, ['rev-parse', 'v2.9.8^{commit}']);
    expect(peeledFromTag).toBe(candidate);
    expect(annotatedObject).not.toBe(candidate);
    expect(git(repo, ['cat-file', '-t', annotatedObject])).toBe('tag');

    git(repo, ['checkout', '--detach', 'v2.9.8']);
    expect(git(repo, ['rev-parse', 'HEAD^{commit}'])).toBe(candidate);
    expect(packageVersionAt(repo, 'HEAD^{commit}')).toBe('2.9.8');
  });
});
