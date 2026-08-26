import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import { runAction, type CoreLike } from '../src/index.js';
import { activateWorkingDirectory } from '../src/lib/working-directory.js';

let originalCwd: string;
let originalWorkspace: string | undefined;
const tempDirs: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bootstrap-working-directory-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'services', 'payments'), { recursive: true });
  return root;
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalWorkspace = process.env.GITHUB_WORKSPACE;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalWorkspace === undefined) {
    delete process.env.GITHUB_WORKSPACE;
  } else {
    process.env.GITHUB_WORKSPACE = originalWorkspace;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('activateWorkingDirectory', () => {
  it('leaves process state untouched when the input is empty', () => {
    const root = makeRoot();
    process.chdir(root);
    process.env.GITHUB_WORKSPACE = root;
    const cwdBefore = process.cwd();

    const result = activateWorkingDirectory('', root);

    expect(result).toEqual({ changed: false, originalRoot: root, effectiveRoot: root });
    expect(process.cwd()).toBe(cwdBefore);
    expect(process.env.GITHUB_WORKSPACE).toBe(root);
  });

  it('runs before action input validation', async () => {
    const root = makeRoot();
    const service = realpathSync(path.join(root, 'services', 'payments'));
    process.env.GITHUB_WORKSPACE = root;
    const actionCore: CoreLike = {
      error: () => undefined,
      getInput: (name) => (name === 'working-directory' ? 'services/payments' : ''),
      group: async (_name, fn) => fn(),
      info: () => undefined,
      setFailed: () => undefined,
      setOutput: () => undefined,
      setSecret: () => undefined,
      warning: () => undefined
    };

    await expect(runAction(actionCore)).rejects.toThrow(/spec-url or spec-path/i);
    expect(process.cwd()).toBe(service);
    expect(process.env.GITHUB_WORKSPACE).toBe(service);
  });

  it('runs before CLI input validation', async () => {
    const root = makeRoot();
    const service = realpathSync(path.join(root, 'services', 'payments'));
    process.chdir(root);

    await expect(
      runCli(['--working-directory', 'services/payments', '--project-name', 'payments'], {
        env: {},
        writeStdout: () => undefined
      })
    ).rejects.toThrow(/spec-url or spec-path/i);
    expect(process.cwd()).toBe(service);
    expect(process.env.GITHUB_WORKSPACE).toBe(service);
  });

  it('activates an inward symlink and makes cwd and GITHUB_WORKSPACE agree', () => {
    const root = makeRoot();
    const service = path.join(root, 'services', 'payments');
    const realRoot = realpathSync(root);
    const realService = realpathSync(service);
    symlinkSync(service, path.join(root, 'payments-link'), process.platform === 'win32' ? 'junction' : 'dir');

    const result = activateWorkingDirectory('payments-link', root);

    expect(result).toEqual({ changed: true, originalRoot: realRoot, effectiveRoot: realService });
    expect(process.cwd()).toBe(realService);
    expect(process.env.GITHUB_WORKSPACE).toBe(realService);
  });

  it('rejects paths that are not confined service directories', () => {
    const root = makeRoot();
    const outside = mkdtempSync(path.join(tmpdir(), 'bootstrap-working-directory-outside-'));
    tempDirs.push(outside);
    writeFileSync(path.join(root, 'service.txt'), 'not a directory');
    symlinkSync(outside, path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');

    const cases = [
      path.join(root, 'services', 'payments'),
      '../outside',
      'services/../services/payments',
      'missing',
      'service.txt',
      'outside-link'
    ];

    for (const input of cases) {
      expect(() => activateWorkingDirectory(input, root), input).toThrow(/working-directory/i);
      expect(process.cwd()).toBe(originalCwd);
    }
  });
});
