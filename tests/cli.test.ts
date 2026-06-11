import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, createCliDependencies, parseCliArgs, runCli, toDotenv } from '../src/cli.js';
import { contractInputNames } from '../src/contracts.js';
import { resolveInputs } from '../src/index.js';
import { __resetIdentityMemo } from '../src/lib/postman/credential-identity.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDirs: string[] = [];

type CliOutputs = {
  'workspace-id': string;
  'workspace-url': string;
  'workspace-name': string;
  'spec-id': string;
  'baseline-collection-id': string;
  'smoke-collection-id': string;
  'contract-collection-id': string;
  'collections-json': string;
  'lint-summary-json': string;
  'breaking-change-status': string;
  'breaking-change-summary-json': string;
};

function createCliOutputs(overrides: Partial<CliOutputs> = {}): CliOutputs {
  return {
    'workspace-id': 'ws-123',
    'workspace-url': 'https://go.postman.co/workspace/ws-123',
    'workspace-name': '[AF] core-payments',
    'spec-id': 'spec-123',
    'baseline-collection-id': 'col-baseline',
    'smoke-collection-id': 'col-smoke',
    'contract-collection-id': 'col-contract',
    'collections-json': '{}',
    'lint-summary-json': '{"errors":0}',
    'breaking-change-status': 'skipped',
    'breaking-change-summary-json': '{"status":"skipped"}',
    ...overrides
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(command, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: options.env,
        maxBuffer: 20 * 1024 * 1024
      }, (error, stdout, stderr) => {
        const exitError = error as { code?: number | string; message?: string } | null;
        resolve({
          code: typeof exitError?.code === 'number' ? exitError.code : (exitError ? 1 : 0),
          stdout: String(stdout ?? ''),
          stderr: String(stderr || exitError?.message || '')
        });
      });
    } catch (error) {
      const spawnError = error as Error;
      resolve({
        code: 1,
        stdout: '',
        stderr: spawnError.message
      });
      return;
    }
    child.on('error', (error) => {
      resolve({
        code: 1,
        stdout: '',
        stderr: error.message
      });
    });
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseCliArgs', () => {
  it('maps CLI flags into INPUT_* environment variables', () => {
    const config = parseCliArgs(
      [
        '--project-name',
        'core-payments',
        '--spec-url=https://example.test/openapi.yaml',
        '--postman-api-key',
        'pmak-test',
        '--workspace-admin-user-ids',
        '101,102',
        '--sync-examples',
        'false',
        '--collection-sync-mode',
        'version',
        '--spec-sync-mode',
        'version',
        '--release-label',
        'v1.2.3',
        '--workspace-team-id',
        '12345',
        '--repo-url',
        'https://github.com/postman-cs/postman-bootstrap-action',
        '--postman-stack',
        'beta',
        '--result-json',
        'tmp/result.json',
        '--dotenv-path',
        'tmp/result.env'
      ],
      {}
    );

    expect(config.inputEnv.INPUT_PROJECT_NAME).toBe('core-payments');
    expect(config.inputEnv.INPUT_SPEC_URL).toBe('https://example.test/openapi.yaml');
    expect(config.inputEnv.INPUT_POSTMAN_API_KEY).toBe('pmak-test');
    expect(config.inputEnv.INPUT_WORKSPACE_ADMIN_USER_IDS).toBe('101,102');
    expect(config.inputEnv.INPUT_SYNC_EXAMPLES).toBe('false');
    expect(config.inputEnv.INPUT_COLLECTION_SYNC_MODE).toBe('version');
    expect(config.inputEnv.INPUT_SPEC_SYNC_MODE).toBe('version');
    expect(config.inputEnv.INPUT_RELEASE_LABEL).toBe('v1.2.3');
    expect(config.inputEnv.INPUT_WORKSPACE_TEAM_ID).toBe('12345');
    expect(config.inputEnv.INPUT_REPO_URL).toBe('https://github.com/postman-cs/postman-bootstrap-action');
    expect(config.inputEnv.INPUT_POSTMAN_STACK).toBe('beta');
    expect(config.resultJsonPath).toBe('tmp/result.json');
    expect(config.dotenvPath).toBe('tmp/result.env');
  });

  it('maps every public action input and ignores legacy aliases', () => {
    const values: Record<string, string> = {
      'collection-sync-mode': 'refresh',
      'folder-strategy': 'Paths',
      'integration-backend': 'bifrost',
      'nested-folder-hierarchy': 'false',
      'openapi-version': '3.1',
      'postman-stack': 'prod',
      'request-name-source': 'Fallback',
      'spec-sync-mode': 'update',
      'sync-examples': 'true'
    };
    const argv = contractInputNames.flatMap((name, index) =>
      index % 2 === 0 ? [`--${name}`, values[name] ?? `value-${name}`] : [`--${name}=${values[name] ?? `value-${name}`}`]
    );
    const config = parseCliArgs([
      ...argv,
      '--team-id',
      'legacy-team',
      '--postman_team_id',
      'snake-team'
    ], {});

    for (const name of contractInputNames) {
      const envName = `INPUT_${name.replace(/-/g, '_').toUpperCase()}`;
      expect(config.inputEnv[envName]).toBe(values[name] ?? `value-${name}`);
    }
    expect(config.inputEnv.INPUT_TEAM_ID).toBeUndefined();
    expect(config.inputEnv.INPUT_POSTMAN_TEAM_ID).toBeUndefined();
  });
});

describe('toDotenv', () => {
  it('formats planned outputs as POSTMAN_BOOTSTRAP_* dotenv pairs', () => {
    const dotenv = toDotenv(createCliOutputs({
      'collections-json': '{"baseline":"col-baseline"}',
      'lint-summary-json': '{"errors":0}'
    }));

    expect(dotenv).toContain("POSTMAN_BOOTSTRAP_WORKSPACE_ID='ws-123'");
    expect(dotenv).toContain("POSTMAN_BOOTSTRAP_SPEC_ID='spec-123'");
    expect(dotenv).toContain("POSTMAN_BOOTSTRAP_LINT_SUMMARY_JSON='{\"errors\":0}'");
  });

  it('round-trips hostile values without executing shell substitutions', async () => {
    const dir = await makeTempDir('postman-bootstrap-dotenv-');
    const markerPath = path.join(dir, 'marker');
    const dotenvPath = path.join(dir, 'bootstrap.env');
    const hostileValue = `name $(touch ${markerPath}) \`touch ${markerPath}\` $HOME "quote" 'single' \\slash\nnext`;
    await writeFile(dotenvPath, toDotenv(createCliOutputs({
      'workspace-name': hostileValue,
    })), 'utf8');

    const sourced = await execFileAsync('/bin/sh', [
      '-c',
      '. "$1"; printf "%s" "$POSTMAN_BOOTSTRAP_WORKSPACE_NAME"',
      'sh',
      dotenvPath
    ], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? ''
      }
    });

    expect(sourced.stdout).toBe(hostileValue);
    await expect(readFile(markerPath, 'utf8')).rejects.toThrow();
  });
});

describe('ConsoleReporter', () => {
  it('writes info, warning, and group logs to stderr', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reporter = new ConsoleReporter();

    reporter.info('hello');
    reporter.warning('careful');
    await reporter.group('work', async () => undefined);

    expect(stderrSpy).toHaveBeenNthCalledWith(1, 'hello');
    expect(stderrSpy).toHaveBeenNthCalledWith(2, 'warning: careful');
    expect(stderrSpy).toHaveBeenNthCalledWith(3, '[group] work');

    stderrSpy.mockRestore();
  });
});

describe('runCli', () => {
  it('writes only JSON payload to stdout while routing exec output to stderr', async () => {
    const stdoutChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await runCli(
      [
        '--project-name',
        'core-payments',
        '--spec-url',
        'https://example.test/openapi.yaml',
        '--postman-api-key',
        'test-api-key',
        '--result-json',
        'tmp/cli-run-result.json'
      ],
      {
        env: {},
        executeBootstrap: async (inputs, dependencies) => {
          await dependencies.exec.exec('node', ['-e', `process.stdout.write(${JSON.stringify(inputs.postmanApiKey)})`]);
          return createCliOutputs({
            'collections-json': '{"baseline":"col-baseline","smoke":"col-smoke","contract":"col-contract"}',
            'lint-summary-json': '{"errors":0,"total":0,"violations":[],"warnings":0}'
          });
        },
        writeStdout: (chunk) => {
          stdoutChunks.push(chunk);
        }
      }
    );

    expect(stdoutChunks).toHaveLength(1);
    const parsed = JSON.parse(stdoutChunks[0]);
    expect(parsed['workspace-id']).toBe('ws-123');
    const stderrCombined = stderrSpy.mock.calls.map(([entry]) => String(entry)).join('');
    expect(stderrCombined).toContain('[REDACTED]');
    expect(stderrCombined).not.toContain('test-api-key');

    stderrSpy.mockRestore();
  });

  it('fails missing required CLI inputs before bootstrap side effects or output artifacts', async () => {
    const dir = await makeTempDir('postman-bootstrap-required-');
    const executeBootstrap = vi.fn();

    await withCwd(dir, async () => {
      await expect(
        runCli([
          '--spec-url',
          'https://example.test/openapi.yaml',
          '--postman-api-key',
          'test-api-key',
          '--result-json',
          'result.json',
          '--dotenv-path',
          'result.env'
        ], {
          env: {},
          executeBootstrap
        })
      ).rejects.toThrow(/project-name is required/);
    });

    expect(executeBootstrap).not.toHaveBeenCalled();
    await expect(readFile(path.join(dir, 'result.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'result.env'), 'utf8')).rejects.toThrow();
  });

  it('fails invalid CLI inputs before bootstrap side effects or output artifacts', async () => {
    const dir = await makeTempDir('postman-bootstrap-invalid-');
    const executeBootstrap = vi.fn();

    await withCwd(dir, async () => {
      await expect(
        runCli([
          '--project-name',
          'core-payments',
          '--spec-url',
          'https://example.test/openapi.yaml',
          '--postman-api-key',
          'test-api-key',
          '--workspace-team-id',
          'not-a-number',
          '--result-json',
          'result.json',
          '--dotenv-path',
          'result.env'
        ], {
          env: {},
          executeBootstrap
        })
      ).rejects.toThrow(/workspace-team-id must be a numeric sub-team ID/);
    });

    expect(executeBootstrap).not.toHaveBeenCalled();
    await expect(readFile(path.join(dir, 'result.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(path.join(dir, 'result.env'), 'utf8')).rejects.toThrow();
  });

  it('allows absolute output paths that resolve inside the real workspace', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const resultPath = path.join(workspace, 'tmp', 'result.json');
    const dotenvPath = path.join(workspace, 'tmp', 'result.env');
    const executeBootstrap = vi.fn().mockResolvedValue(createCliOutputs());

    await withCwd(workspace, async () => {
      await runCli([
        '--project-name',
        'core-payments',
        '--spec-url',
        'https://example.test/openapi.yaml',
        '--postman-api-key',
        'test-api-key',
        '--result-json',
        resultPath,
        '--dotenv-path',
        dotenvPath
      ], {
        env: {},
        executeBootstrap,
        writeStdout: () => {}
      });
    });

    expect(await readJsonFile<CliOutputs>(resultPath)).toMatchObject({ 'workspace-id': 'ws-123' });
    expect(await readFile(dotenvPath, 'utf8')).toContain('POSTMAN_BOOTSTRAP_WORKSPACE_ID');
  });

  it('refuses absolute output paths outside the real workspace', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const outside = await makeTempDir('postman-bootstrap-outside-');
    const executeBootstrap = vi.fn();

    await withCwd(workspace, async () => {
      await expect(
        runCli([
          '--project-name',
          'core-payments',
          '--spec-url',
          'https://example.test/openapi.yaml',
          '--postman-api-key',
          'test-api-key',
          '--result-json',
          path.join(outside, 'result.json')
        ], {
          env: {},
          executeBootstrap
        })
      ).rejects.toThrow(/Output path must stay within workspace/);
    });

    expect(executeBootstrap).not.toHaveBeenCalled();
    await expect(readFile(path.join(outside, 'result.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses output paths that escape the real workspace through symlinks', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const outside = await makeTempDir('postman-bootstrap-outside-');
    await symlink(outside, path.join(workspace, 'linked-dir'));
    const executeBootstrap = vi.fn().mockResolvedValue(createCliOutputs());

    await withCwd(workspace, async () => {
      await expect(
        runCli([
          '--project-name',
          'core-payments',
          '--spec-url',
          'https://example.test/openapi.yaml',
          '--postman-api-key',
          'test-api-key',
          '--result-json',
          'linked-dir/result.json'
        ], {
          env: {},
          executeBootstrap
        })
      ).rejects.toThrow(/Output path must stay within workspace/);
    });

    await expect(readFile(path.join(outside, 'result.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses preexisting symlink output files that point outside the real workspace', async () => {
    const workspace = await makeTempDir('postman-bootstrap-workspace-');
    const outside = await makeTempDir('postman-bootstrap-outside-');
    await mkdir(path.join(workspace, 'tmp'));
    await symlink(path.join(outside, 'result.json'), path.join(workspace, 'tmp', 'result.json'));
    const executeBootstrap = vi.fn().mockResolvedValue(createCliOutputs());

    await withCwd(workspace, async () => {
      await expect(
        runCli([
          '--project-name',
          'core-payments',
          '--spec-url',
          'https://example.test/openapi.yaml',
          '--postman-api-key',
          'test-api-key',
          '--result-json',
          'tmp/result.json'
        ], {
          env: {},
          executeBootstrap
        })
      ).rejects.toThrow(/Output path must stay within workspace/);
    });

    await expect(readFile(path.join(outside, 'result.json'), 'utf8')).rejects.toThrow();
  });
});

describe('package CLI bin', () => {
  it('packs and invokes postman-bootstrap from PATH without OS-level execution errors', async () => {
    const packDir = await makeTempDir('postman-bootstrap-pack-');
    const prefixDir = await makeTempDir('postman-bootstrap-prefix-');

    const packResult = await execFileAsync('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        NPM_CONFIG_CACHE: path.join(packDir, '.npm-cache'),
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    });
    const [packed] = JSON.parse(packResult.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
      name: string;
    }>;
    expect(packed.name).toBe('@postman-cse/onboarding-bootstrap');
    const packedPaths = packed.files.map((file) => file.path);
    expect(packedPaths).toEqual(expect.arrayContaining([
      'package.json',
      'action.yml',
      'dist/index.cjs',
      'dist/cli.cjs'
    ]));
    expect(packedPaths.some((filePath) => filePath === '.env' || filePath.startsWith('.env.'))).toBe(false);
    expect(packedPaths.some((filePath) => filePath.includes('.factory') || filePath.includes('mission'))).toBe(false);
    expect(packedPaths.some((filePath) => filePath.startsWith('tmp/') || filePath.startsWith('.omc/'))).toBe(false);
    expect(packedPaths.every((filePath) => (
      filePath === 'package.json' ||
      filePath === 'action.yml' ||
      filePath === 'README.md' ||
      filePath === 'LICENSE' ||
      filePath.startsWith('dist/')
    ))).toBe(true);

    const tarballPath = path.join(packDir, packed.filename);
    await execFileAsync('tar', ['-xzf', tarballPath, '-C', prefixDir], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? ''
      },
      maxBuffer: 20 * 1024 * 1024
    });

    const binDir = path.join(prefixDir, 'bin');
    await mkdir(binDir, { recursive: true });
    const cliSourcePath = path.join(prefixDir, 'package', 'dist', 'cli.cjs');
    const cliBinPath = path.join(binDir, process.platform === 'win32' ? 'postman-bootstrap.cmd' : 'postman-bootstrap');
    if (process.platform === 'win32') {
      await writeFile(cliBinPath, `@echo off\r\nnode "${cliSourcePath}" %*\r\n`, 'utf8');
    } else {
      await copyFile(cliSourcePath, cliBinPath);
      await chmod(cliBinPath, 0o755);
    }

    const execution = await runCommand('postman-bootstrap', ['--integration-backend', 'unsupported'], {
      cwd: packDir,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`
      }
    });

    expect(execution.code).not.toBe(0);
    expect(execution.stdout).toBe('');
    expect(execution.stderr).toContain('Unsupported integration-backend "unsupported"');
    expect(execution.stderr).not.toMatch(/permission denied|exec format|syntax error|unexpected token/i);
  }, 20000);

  it('keeps install identity, Node runtime support, and env-file ignore policy aligned', async () => {
    const packageJson = await readJsonFile<{
      name: string;
      bin: Record<string, string>;
      engines?: Record<string, string>;
    }>(path.join(repoRoot, 'package.json'));
    const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
    const gitignore = await readFile(path.join(repoRoot, '.gitignore'), 'utf8');

    expect(packageJson.bin['postman-bootstrap']).toBe('dist/cli.cjs');
    expect(packageJson).toMatchObject({
      files: ['action.yml', 'dist/', 'README.md', 'LICENSE']
    });
    expect(packageJson.engines?.node).toBe('>=24');
    expect(readme).toContain(`npm install -g ${packageJson.name}`);
    expect(readme).not.toContain('npm install -g postman-bootstrap-action');
    expect(readme).toContain('The CLI package supports Node.js 24+');
    expect(readme).toContain("versionSpec: '24.x'");
    expect(readme).not.toContain(`versionSpec: '${20}.x'`);
    expect(gitignore.split(/\r?\n/)).toEqual(expect.arrayContaining(['.env', '.env.*', '!.env.example']));
  });
});

describe('createCliDependencies', () => {
  it('creates internal integration dependencies under token conditions', () => {
    const inputs = resolveInputs({
      INPUT_PROJECT_NAME: 'core-payments',
      INPUT_SPEC_URL: 'https://example.test/openapi.yaml',
      INPUT_POSTMAN_API_KEY: 'pmak-test',
      INPUT_POSTMAN_ACCESS_TOKEN: 'pat-test',
      INPUT_REPO_URL: 'https://github.com/postman-cs/postman-bootstrap-action',
      INPUT_TEAM_ID: '12345'
    });

    const dependencies = createCliDependencies(inputs);

    expect(dependencies.internalIntegration).toBeDefined();
  });
});

describe('runCli credential preflight seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetIdentityMemo();
  });

  function stubIdentityFetch(pmakTeam: number, sessionTeam: number): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/me')) {
        return new Response(
          JSON.stringify({
            user: { id: 'u-pmak', fullName: 'PMAK User', teamId: pmakTeam, teamName: 'Alpha' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/sessions/current')) {
        return new Response(
          JSON.stringify({
            identity: { team: sessionTeam, domain: 'beta' },
            data: { user: { id: 'u-sess' } }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`unexpected fetch in preflight seam test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('fails closed before bootstrap when enforce sees a cross-org team mismatch', async () => {
    const fetchMock = stubIdentityFetch(111, 222);
    const executeBootstrap = vi.fn();

    await expect(
      runCli(
        [
          '--project-name', 'preflight-demo',
          '--spec-url', 'https://example.test/openapi.yaml',
          '--postman-api-key', 'pmak-xyz',
          '--postman-access-token', 'tok-xyz',
          '--credential-preflight', 'enforce'
        ],
        { env: {}, executeBootstrap }
      )
    ).rejects.toThrow(/credential preflight FAILED/);

    expect(executeBootstrap).not.toHaveBeenCalled();
    const probed = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(probed.some((url) => url.endsWith('/me'))).toBe(true);
    expect(probed.some((url) => url.includes('/api/sessions/current'))).toBe(true);
    // The preflight verdict must precede any spec fetch.
    expect(probed.some((url) => url.includes('example.test'))).toBe(false);
  });

  it('names both team ids in the enforce mismatch verdict', async () => {
    stubIdentityFetch(111, 222);
    let captured = '';
    try {
      await runCli(
        [
          '--project-name', 'preflight-demo',
          '--spec-url', 'https://example.test/openapi.yaml',
          '--postman-api-key', 'pmak-xyz',
          '--postman-access-token', 'tok-xyz',
          '--credential-preflight', 'enforce'
        ],
        { env: {}, executeBootstrap: vi.fn() }
      );
    } catch (error) {
      captured = error instanceof Error ? error.message : String(error);
    }
    expect(captured).toContain('111');
    expect(captured).toContain('222');
  });

  it('logs both identity lines and proceeds to bootstrap when teams match under warn', async () => {
    stubIdentityFetch(333, 333);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const executeBootstrap = vi.fn(async () => createCliOutputs());
    const dir = await makeTempDir('postman-bootstrap-preflight-ok-');

    await withCwd(dir, async () => {
      await runCli(
        [
          '--project-name', 'preflight-ok',
          '--spec-url', 'https://example.test/openapi.yaml',
          '--postman-api-key', 'pmak-ok',
          '--postman-access-token', 'tok-ok',
          '--credential-preflight', 'warn'
        ],
        { env: {}, executeBootstrap, writeStdout: () => undefined }
      );
    });

    expect(executeBootstrap).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('postman: PMAK identity - ');
    expect(logged).toContain('postman: access-token session identity - ');
    errorSpy.mockRestore();
  });

  it('skips the preflight entirely when credential-preflight is off', async () => {
    const fetchMock = stubIdentityFetch(111, 222);
    const executeBootstrap = vi.fn(async () => createCliOutputs());
    const dir = await makeTempDir('postman-bootstrap-preflight-off-');

    await withCwd(dir, async () => {
      await runCli(
        [
          '--project-name', 'preflight-off',
          '--spec-url', 'https://example.test/openapi.yaml',
          '--postman-api-key', 'pmak-xyz',
          '--postman-access-token', 'tok-xyz',
          '--credential-preflight', 'off'
        ],
        { env: {}, executeBootstrap, writeStdout: () => undefined }
      );
    });

    expect(executeBootstrap).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
