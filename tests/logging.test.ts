import { describe, expect, it } from 'vitest';
import { createLogger, type LogSink } from '@postman-cse/automation-core';

import { readActionInputs, runBootstrap, withPhaseGroups, type CoreLike } from '../src/index.js';

/**
 * A log line is evidence. These tests pin the properties that make it worth
 * trusting: a credential an upstream echoes back never survives into output,
 * a failure names the stage it died in, and debug chatter stays opt-in.
 */

const PMAK = 'PMAK-bootstraploggingtest-0123456789';
const ACCESS_TOKEN = 'pma_at_bootstraploggingtest';

// A spec that parses, so the run reaches the Postman stages this test is about
// instead of dying in the retrying fetch ahead of them.
const SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Logging Test API', version: '1.0.0' },
  paths: {
    '/payments': {
      get: {
        summary: 'GET /payments',
        responses: { '200': { description: 'ok' } }
      }
    }
  }
});

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      debug: (message) => lines.push('debug ' + message),
      info: (message) => lines.push('info ' + message),
      warning: (message) => lines.push('warning ' + message),
      error: (message) => lines.push('error ' + message)
    }
  };
}

function coreStub(): CoreLike {
  const values: Record<string, string> = {
    'project-name': 'core-payments',
    'spec-url': 'https://example.test/openapi.yaml',
    'postman-api-key': PMAK,
    'postman-access-token': ACCESS_TOKEN,
    'credential-preflight': 'warn'
  };
  return {
    error: () => undefined,
    getInput: (name: string, options?: { required?: boolean }) => {
      const value = values[name] ?? '';
      if (options?.required && !value) throw new Error('Input required and not supplied: ' + name);
      return value;
    },
    group: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
    info: () => undefined,
    setFailed: () => undefined,
    setOutput: () => undefined,
    setSecret: () => undefined,
    warning: () => undefined
  };
}

// An upstream that reflects the credential back must not turn a diagnostic line
// into a leak. The stub answers enough of the client to reach a real stage,
// then fails there with the key embedded in the upstream message.
function echoingPostman(): never {
  return {
    configureTeamContext: () => undefined,
    findWorkspacesByName: async () => [],
    getAutoDerivedTeamId: async () => '12345',
    getTeams: async () => [],
    getWorkspaceGitRepoUrl: async () => null,
    getWorkspaceVisibility: async () => 'team',
    createWorkspace: async () => {
      throw new Error('Postman rejected the request for key ' + PMAK);
    }
  } as never;
}

function run(logger: ReturnType<typeof createLogger>): Promise<unknown> {
  const core = coreStub();
  const inputs = readActionInputs(core);
  return runBootstrap(inputs, {
    core,
    exec: { exec: async () => 0, getExecOutput: async () => ({ exitCode: 0, stdout: '{"violations":[]}', stderr: '' }) } as never,
    io: { which: async () => '/usr/local/bin/postman' },
    logger,
    postman: echoingPostman(),
    specFetcher: (async () => new Response(SPEC, { status: 200 })) as never
  } as never);
}

describe('bootstrap logging', () => {
  it('never emits the credential it was handed, even when upstream echoes it back', async () => {
    const { sink, lines } = recordingSink();

    await expect(run(createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(PMAK);
    expect(all).not.toContain(ACCESS_TOKEN);
    expect(all).toContain('***');
  });

  it('names the stage that failed, which setFailed alone would not', async () => {
    const { sink, lines } = recordingSink();

    await expect(run(createLogger({ sink, level: 'debug' }))).rejects.toThrow();

    const all = lines.join('\n');
    expect(all).toContain('bootstrap failed');
    expect(all).toContain('phase=');
    expect(all).toContain('phase failed');
  });

  it('keeps debug chatter out of a default run and opens it under RUNNER_DEBUG', async () => {
    async function collect(env: NodeJS.ProcessEnv): Promise<string[]> {
      const { sink, lines } = recordingSink();
      await run(createLogger({ sink, env })).catch(() => undefined);
      return lines;
    }

    expect((await collect({})).filter((line) => line.startsWith('debug'))).toHaveLength(0);
    expect(
      (await collect({ RUNNER_DEBUG: '1' })).filter((line) => line.startsWith('debug')).length
    ).toBeGreaterThan(0);
  });
});

describe('phase-group core wrapping (CLI class-instance core)', () => {
  it('preserves prototype methods (setOutput) through withPhaseGroups', async () => {
    // The CLI hands runBootstrap a class instance whose methods live on the
    // prototype (ConsoleReporter). The old object-spread wrapper dropped those,
    // which shipped as "dependencies.core.setOutput is not a function" on the
    // ADO CLI path. The wrapper must keep the whole prototype chain.
    const outputs: Array<[string, string]> = [];
    class InstanceCore {
      error(): void {}
      async group<T>(_name: string, fn: () => Promise<T>): Promise<T> {
        return fn();
      }
      info(): void {}
      setOutput(name: string, value: string): void {
        outputs.push([name, value]);
      }
      warning(): void {}
    }
    const { sink } = recordingSink();
    const logger = createLogger({ sink });
    const wrapped = withPhaseGroups(
      new InstanceCore() as never,
      logger
    ) as unknown as InstanceCore;

    expect(typeof wrapped.setOutput).toBe('function');
    wrapped.setOutput('workspace-id', 'ws-1');
    expect(outputs).toContainEqual(['workspace-id', 'ws-1']);

    // The redefined methods still work and still route through the logger.
    (wrapped as unknown as { info: (message: string) => void }).info('hello');
    await wrapped.group('stage', async () => 'ok');
  });
});

