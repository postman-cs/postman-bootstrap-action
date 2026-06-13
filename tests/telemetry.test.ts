import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('detectCiContext', () => {
  it('detects GitHub with runner kind', () => {
    expect(
      detectCiContext({
        GITHUB_ACTIONS: 'true',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '2',
        RUNNER_ENVIRONMENT: 'github-hosted'
      })
    ).toEqual({ ciProvider: 'github', runId: '42', runAttempt: '2', runnerKind: 'hosted' });
  });

  it('detects GitLab, Jenkins, CircleCI, Harness, Concourse', () => {
    expect(detectCiContext({ GITLAB_CI: 'true', CI_PIPELINE_ID: '7' }).ciProvider).toBe('gitlab');
    expect(detectCiContext({ JENKINS_URL: 'http://j', BUILD_ID: '9' })).toMatchObject({
      ciProvider: 'jenkins',
      runId: '9',
      runnerKind: 'self-hosted'
    });
    expect(detectCiContext({ CIRCLECI: 'true', CIRCLE_WORKFLOW_ID: 'w' }).ciProvider).toBe('circleci');
    expect(detectCiContext({ HARNESS_BUILD_ID: 'h' }).ciProvider).toBe('harness');
    expect(
      detectCiContext({ BUILD_ID: '3', BUILD_PIPELINE_NAME: 'p', BUILD_NAME: '3.1' })
    ).toMatchObject({ ciProvider: 'concourse', runId: '3', runAttempt: '3.1', runnerKind: 'self-hosted' });
  });

  it('returns unknown off-CI', () => {
    expect(detectCiContext({})).toEqual({ ciProvider: 'unknown', runnerKind: 'unknown' });
  });
});

describe('buildTelemetryEvent', () => {
  it('hashes the repo identifier and carries no secrets or names', () => {
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
});
