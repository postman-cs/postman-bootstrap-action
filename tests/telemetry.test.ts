import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { EnvHttpProxyAgent } from 'undici';

import { detectCiContext } from '../src/lib/ci-context.js';
import {
  buildTelemetryEvent,
  createTelemetryContext,
  resetTelemetryNotice,
  telemetryDisabled
} from '../src/lib/telemetry.js';

afterEach(() => {
  resetTelemetryNotice();
});

describe('telemetryDisabled', () => {
  it('is enabled by default', () => {
    expect(telemetryDisabled({})).toBe(false);
  });

  it('honors POSTMAN_ACTIONS_TELEMETRY opt-out values', () => {
    for (const value of ['off', '0', 'false', 'no', 'OFF']) {
      expect(telemetryDisabled({ POSTMAN_ACTIONS_TELEMETRY: value })).toBe(true);
    }
  });

  it('honors DO_NOT_TRACK', () => {
    expect(telemetryDisabled({ DO_NOT_TRACK: '1' })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: 'true' })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: '0' })).toBe(false);
  });

  it('does not treat CI as an opt-out', () => {
    expect(telemetryDisabled({ CI: 'true' })).toBe(false);
  });
});

describe('detectCiContext: one positive case per active provider', () => {
  it('github (with runner kind from RUNNER_ENVIRONMENT)', () => {
    expect(
      detectCiContext({
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '42',
        RUNNER_ENVIRONMENT: 'github-hosted'
      })
    ).toEqual({ ciProvider: 'github', runId: '42', runnerKind: 'hosted' });
  });

  it('gitlab (CI_PIPELINE_ID, fallback IID)', () => {
    expect(detectCiContext({ GITLAB_CI: 'true', CI_PIPELINE_ID: '7' })).toMatchObject({
      ciProvider: 'gitlab',
      runId: '7',
      runnerKind: 'unknown'
    });
    expect(detectCiContext({ GITLAB_CI: 'true', CI_PIPELINE_IID: '3' }).runId).toBe('3');
  });

  it('circleci (CIRCLE_WORKFLOW_ID, fallback CIRCLE_BUILD_NUM)', () => {
    expect(detectCiContext({ CIRCLECI: 'true', CIRCLE_WORKFLOW_ID: 'w' }).ciProvider).toBe('circleci');
    expect(detectCiContext({ CIRCLECI: 'true', CIRCLE_BUILD_NUM: '88' }).runId).toBe('88');
  });

  it('buildkite (BUILDKITE_BUILD_ID, fallback NUMBER)', () => {
    expect(detectCiContext({ BUILDKITE: 'true', BUILDKITE_BUILD_ID: 'bk-uuid' })).toMatchObject({
      ciProvider: 'buildkite',
      runId: 'bk-uuid'
    });
    expect(detectCiContext({ BUILDKITE: 'true', BUILDKITE_BUILD_NUMBER: '12' }).runId).toBe('12');
  });

  it('azure (TF_BUILD, runId BUILD_BUILDID)', () => {
    expect(detectCiContext({ TF_BUILD: 'True', BUILD_BUILDID: '5001' })).toMatchObject({
      ciProvider: 'azure',
      runId: '5001',
      runnerKind: 'unknown'
    });
  });

  it('codebuild (CODEBUILD_BUILD_ID is detection and run id)', () => {
    expect(detectCiContext({ CODEBUILD_BUILD_ID: 'proj:abc' })).toMatchObject({
      ciProvider: 'codebuild',
      runId: 'proj:abc',
      runnerKind: 'unknown'
    });
  });

  it('bitbucket (BITBUCKET_BUILD_NUMBER)', () => {
    expect(detectCiContext({ BITBUCKET_BUILD_NUMBER: '231', CI: 'true' })).toMatchObject({
      ciProvider: 'bitbucket',
      runId: '231'
    });
  });

  it('teamcity (TEAMCITY_VERSION, runId BUILD_NUMBER, self-hosted)', () => {
    expect(detectCiContext({ TEAMCITY_VERSION: '2024.03', BUILD_NUMBER: '17' })).toEqual({
      ciProvider: 'teamcity',
      runId: '17',
      runnerKind: 'self-hosted'
    });
  });

  it('harness (HARNESS_EXECUTION_ID, fallback HARNESS_BUILD_ID)', () => {
    expect(detectCiContext({ HARNESS_BUILD_ID: '9', HARNESS_EXECUTION_ID: 'exec-uuid' })).toMatchObject({
      ciProvider: 'harness',
      runId: 'exec-uuid'
    });
    expect(detectCiContext({ HARNESS_BUILD_ID: '9' }).runId).toBe('9');
  });

  it('jenkins (JENKINS_URL, runId BUILD_ID, self-hosted)', () => {
    expect(detectCiContext({ JENKINS_URL: 'http://j', BUILD_ID: '9' })).toMatchObject({
      ciProvider: 'jenkins',
      runId: '9',
      runnerKind: 'self-hosted'
    });
  });

  it('concourse (ATC_EXTERNAL_URL or BUILD_ID+BUILD_PIPELINE_NAME)', () => {
    expect(
      detectCiContext({ BUILD_ID: '3', BUILD_PIPELINE_NAME: 'p', BUILD_NAME: '3.1' })
    ).toMatchObject({ ciProvider: 'concourse', runId: '3', runnerKind: 'self-hosted' });
    expect(detectCiContext({ ATC_EXTERNAL_URL: 'http://atc' }).ciProvider).toBe('concourse');
  });

  it('other (CI truthy, no vendor match)', () => {
    expect(detectCiContext({ CI: 'true' })).toEqual({ ciProvider: 'other', runnerKind: 'unknown' });
  });

  it('unknown (not in CI)', () => {
    expect(detectCiContext({})).toEqual({ ciProvider: 'unknown', runnerKind: 'unknown' });
  });
});

describe('detectCiContext: collision regressions (first-match ordering)', () => {
  it('BUILD_ID with JENKINS_URL resolves to jenkins, not concourse', () => {
    expect(detectCiContext({ JENKINS_URL: 'http://j', BUILD_ID: '5' }).ciProvider).toBe('jenkins');
  });

  it('BUILD_ID + BUILD_PIPELINE_NAME (no JENKINS_URL/ATC) resolves to concourse', () => {
    expect(detectCiContext({ BUILD_ID: '5', BUILD_PIPELINE_NAME: 'p' }).ciProvider).toBe('concourse');
  });

  it('bare BUILD_ID alone does NOT resolve to concourse', () => {
    expect(detectCiContext({ BUILD_ID: '5' }).ciProvider).toBe('unknown');
  });

  it('BUILD_NUMBER with TEAMCITY_VERSION resolves to teamcity', () => {
    expect(detectCiContext({ TEAMCITY_VERSION: '2024', BUILD_NUMBER: '5' }).ciProvider).toBe('teamcity');
  });

  it('CODEBUILD_BUILD_ID together with GITHUB_ACTIONS resolves to github', () => {
    expect(detectCiContext({ GITHUB_ACTIONS: 'true', CODEBUILD_BUILD_ID: 'x', GITHUB_RUN_ID: '1' }).ciProvider).toBe('github');
  });

  it('Harness env carrying DRONE_BUILD_NUMBER + HARNESS_BUILD_ID resolves to harness', () => {
    expect(detectCiContext({ DRONE: 'true', DRONE_BUILD_NUMBER: '4', HARNESS_BUILD_ID: '9' }).ciProvider).toBe('harness');
  });

  it('bare CI=true with no vendor flag resolves to other', () => {
    expect(detectCiContext({ CI: 'true' }).ciProvider).toBe('other');
  });
});

describe('buildkite runner_kind via BUILDKITE_COMPUTE_TYPE', () => {
  it('hosted', () => {
    expect(detectCiContext({ BUILDKITE: 'true', BUILDKITE_COMPUTE_TYPE: 'hosted' }).runnerKind).toBe('hosted');
  });
  it('self-hosted', () => {
    expect(detectCiContext({ BUILDKITE: 'true', BUILDKITE_COMPUTE_TYPE: 'self-hosted' }).runnerKind).toBe('self-hosted');
  });
  it('unset -> unknown', () => {
    expect(detectCiContext({ BUILDKITE: 'true' }).runnerKind).toBe('unknown');
  });
});

describe('buildTelemetryEvent', () => {
  it('hashes the repo identifier and carries no secrets, names, or run_attempt', () => {
    const event = buildTelemetryEvent(
      'postman-bootstrap-action',
      '10490519',
      'success',
      { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/widgets', GITHUB_RUN_ID: '5' },
      () => 1700000000000
    );
    expect(event).toMatchObject({
      schema_version: 1,
      event: 'completion',
      action: 'postman-bootstrap-action',
      team_id: '10490519',
      ci_provider: 'github',
      run_id: '5',
      outcome: 'success',
      ts: 1700000000000
    });
    expect(event.repo_id).toMatch(/^[a-f0-9]{64}$/);
    expect('run_attempt' in event).toBe(false);
    expect(JSON.stringify(event)).not.toContain('acme/widgets');
  });
});

describe('createTelemetryContext', () => {
  it('sends one completion event via the transport when enabled', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/widgets' },
      transport: transport as unknown as typeof fetch
    });
    ctx.setTeamId('10490519');
    ctx.emitCompletion('success');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const init = (transport.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(JSON.parse(String(init?.body)).team_id).toBe('10490519');
  });

  it('passes a dispatcher (the proxy agent) on every send', async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      transport: transport as unknown as typeof fetch
    });
    ctx.setTeamId('10490519');
    ctx.emitCompletion('success');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const init = (transport.mock.calls[0] as unknown[])[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
  });

  it('does not send when no team_id was resolved', () => {
    const transport = vi.fn();
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      transport: transport as unknown as typeof fetch
    });
    ctx.emitCompletion('failure');
    expect(transport).not.toHaveBeenCalled();
  });

  it('does not send when disabled', () => {
    const transport = vi.fn();
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { POSTMAN_ACTIONS_TELEMETRY: 'off' },
      transport: transport as unknown as typeof fetch
    });
    ctx.setTeamId('10490519');
    ctx.emitCompletion('success');
    expect(transport).not.toHaveBeenCalled();
  });

  it('never throws when the transport rejects, and only emits once', async () => {
    const transport = vi.fn(async () => {
      throw new Error('network down');
    });
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      transport: transport as unknown as typeof fetch
    });
    ctx.setTeamId('10490519');
    expect(() => ctx.emitCompletion('success')).not.toThrow();
    expect(() => ctx.emitCompletion('failure')).not.toThrow();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
  });

  it('aborts a hung-connect send at the timeout and never throws into the host', async () => {
    let aborted = false;
    const transport = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    );
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      transport: transport as unknown as typeof fetch,
      timeoutMs: 25
    });
    ctx.setTeamId('10490519');
    expect(() => ctx.emitCompletion('success')).not.toThrow();
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('clears the abort timer on a successful send', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      transport: transport as unknown as typeof fetch
    });
    ctx.setTeamId('10490519');
    ctx.emitCompletion('success');
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe('corporate-proxy behavior (real local servers)', () => {
  let proxy: Server;
  let origin: Server;
  let proxyReqs: string[] = [];
  let originReqs: string[] = [];
  let connectReqs: string[] = [];
  let proxyPort = 0;
  let originPort = 0;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    origin = createServer((req: IncomingMessage, res: ServerResponse) => {
      originReqs.push(String(req.url));
      res.writeHead(204).end();
    });
    proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
      proxyReqs.push(String(req.url));
      res.writeHead(204).end();
    });
    // undici tunnels even http origins via CONNECT. Record the CONNECT target
    // (proves routing through the proxy) and complete a real tunnel to the local
    // origin so undici sends exactly one request instead of retry-flooding.
    proxy.on('connect', (req, clientSocket, head: Buffer) => {
      connectReqs.push(String(req.url));
      const upstream = netConnect(originPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    originPort = (origin.address() as AddressInfo).port;
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => proxy.close(() => r()));
    await new Promise<void>((r) => origin.close(() => r()));
  });

  afterEach(() => {
    proxyReqs = [];
    originReqs = [];
    connectReqs = [];
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) {
      if (k in savedEnv) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
        delete savedEnv[k];
      }
    }
  });

  const setEnv = (k: string, v: string) => {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  };

  it('with HTTP_PROXY set, the send is routed through the proxy agent', async () => {
    setEnv('HTTP_PROXY', `http://127.0.0.1:${proxyPort}`);
    const dispatcher = new EnvHttpProxyAgent();
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      endpoint: 'http://collector.telemetry.test/v1/events',
      dispatcher
    });
    ctx.setTeamId('10490519');
    ctx.emitCompletion('success');
    await vi.waitFor(() => expect(connectReqs.length).toBe(1));
    expect(connectReqs[0]).toBe('collector.telemetry.test:80');
    await dispatcher.close();
  });

  it('with NO_PROXY matching the endpoint host, the send goes direct', async () => {
    setEnv('HTTP_PROXY', `http://127.0.0.1:${proxyPort}`);
    setEnv('NO_PROXY', '127.0.0.1');
    const dispatcher = new EnvHttpProxyAgent();
    const ctx = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env: { GITHUB_ACTIONS: 'true' },
      endpoint: `http://127.0.0.1:${originPort}/v1/events`,
      dispatcher
    });
    ctx.setTeamId('10490519');
    ctx.emitCompletion('success');
    await vi.waitFor(() => expect(originReqs.length).toBe(1));
    expect(originReqs[0]).toBe('/v1/events');
    expect(proxyReqs.length).toBe(0);
    expect(connectReqs.length).toBe(0);
    await dispatcher.close();
  });
});
