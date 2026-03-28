import { describe, expect, it, vi } from 'vitest';

import { ConsoleReporter, createCliDependencies, parseCliArgs, runCli, toDotenv } from '../src/cli.js';
import { resolveInputs } from '../src/index.js';

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
};

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
        '--team-id',
        '12345',
        '--repo-url',
        'https://github.com/postman-cs/postman-bootstrap-action',
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
    expect(config.inputEnv.INPUT_TEAM_ID).toBe('12345');
    expect(config.inputEnv.INPUT_REPO_URL).toBe('https://github.com/postman-cs/postman-bootstrap-action');
    expect(config.resultJsonPath).toBe('tmp/result.json');
    expect(config.dotenvPath).toBe('tmp/result.env');
  });
});

describe('toDotenv', () => {
  it('formats planned outputs as POSTMAN_BOOTSTRAP_* dotenv pairs', () => {
    const dotenv = toDotenv({
      'workspace-id': 'ws-123',
      'workspace-url': 'https://go.postman.co/workspace/ws-123',
      'workspace-name': '[AF] core-payments',
      'spec-id': 'spec-123',
      'baseline-collection-id': 'col-baseline',
      'smoke-collection-id': 'col-smoke',
      'contract-collection-id': 'col-contract',
      'collections-json': '{"baseline":"col-baseline"}',
      'lint-summary-json': '{"errors":0}'
    } satisfies CliOutputs);

    expect(dotenv).toContain('POSTMAN_BOOTSTRAP_WORKSPACE_ID="ws-123"');
    expect(dotenv).toContain('POSTMAN_BOOTSTRAP_SPEC_ID="spec-123"');
    expect(dotenv).toContain('POSTMAN_BOOTSTRAP_LINT_SUMMARY_JSON="{\\"errors\\":0}"');
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
        'pmak-secret',
        '--result-json',
        'tmp/cli-run-result.json'
      ],
      {
        env: {},
        executeBootstrap: async (inputs, dependencies) => {
          await dependencies.exec.exec('node', ['-e', `process.stdout.write(${JSON.stringify(inputs.postmanApiKey)})`]);
          return {
            'workspace-id': 'ws-123',
            'workspace-url': 'https://go.postman.co/workspace/ws-123',
            'workspace-name': '[AF] core-payments',
            'spec-id': 'spec-123',
            'baseline-collection-id': 'col-baseline',
            'smoke-collection-id': 'col-smoke',
            'contract-collection-id': 'col-contract',
            'collections-json': '{"baseline":"col-baseline","smoke":"col-smoke","contract":"col-contract"}',
            'lint-summary-json': '{"errors":0,"total":0,"violations":[],"warnings":0}'
          } satisfies CliOutputs;
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
    expect(stderrCombined).not.toContain('pmak-secret');

    stderrSpy.mockRestore();
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
