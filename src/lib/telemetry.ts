// Anonymous usage telemetry. Fire-and-forget, framework-agnostic (no
// @actions/core), must never block or fail the host action. One completion
// event per run, emitted after team_id is resolved. Opt-out via
// POSTMAN_ACTIONS_TELEMETRY=off or DO_NOT_TRACK; auto-disabled when no team_id.
//
// Payload is account/CI-level only: no secrets, no spec content, no repo names
// in clear, no personal data. team_id is sent clear (legitimate-interest basis,
// see each action's README Telemetry section).

import { createHash } from 'node:crypto';

import { detectCiContext } from './ci-context.js';
import { detectRepoContext } from './repo/context.js';

// Injected at build via esbuild --define; undefined under vitest/tsc.
declare const __ACTION_VERSION__: string | undefined;

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 1500;
// Placeholder host until a Postman-owned collector subdomain is provisioned.
// Override with POSTMAN_ACTIONS_TELEMETRY_ENDPOINT.
const DEFAULT_ENDPOINT = 'https://actions-telemetry.postman.invalid/v1/events';

export interface TelemetryLogger {
  info(message: string): void;
}

export interface TelemetryOptions {
  action: string;
  logger?: TelemetryLogger;
  env?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface TelemetryContext {
  setTeamId(teamId: string | undefined): void;
  emitCompletion(outcome: 'success' | 'failure'): void;
}

export interface TelemetryEvent {
  schema_version: number;
  event: 'completion';
  action: string;
  action_version: string;
  team_id: string;
  ci_provider: string;
  run_id?: string;
  run_attempt?: string;
  runner_kind: string;
  repo_id?: string;
  outcome: 'success' | 'failure';
  ts: number;
}

function actionVersion(): string {
  return typeof __ACTION_VERSION__ !== 'undefined' && __ACTION_VERSION__
    ? __ACTION_VERSION__
    : 'unknown';
}

export function telemetryDisabled(env: NodeJS.ProcessEnv): boolean {
  const flag = String(env.POSTMAN_ACTIONS_TELEMETRY ?? '').trim().toLowerCase();
  if (flag === 'off' || flag === '0' || flag === 'false' || flag === 'no') {
    return true;
  }
  const dnt = String(env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (dnt && dnt !== '0' && dnt !== 'false') {
    return true;
  }
  return false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let noticeShown = false;

// Exposed for tests to reset the per-process first-send notice.
export function resetTelemetryNotice(): void {
  noticeShown = false;
}

function maybeNotice(logger: TelemetryLogger | undefined): void {
  if (noticeShown || !logger) {
    return;
  }
  noticeShown = true;
  logger.info(
    'note: postman-actions sends anonymous usage data (team id, action, CI provider). ' +
      'Disable with POSTMAN_ACTIONS_TELEMETRY=off or DO_NOT_TRACK=1.'
  );
}

export function buildTelemetryEvent(
  action: string,
  teamId: string,
  outcome: 'success' | 'failure',
  env: NodeJS.ProcessEnv,
  now: () => number
): TelemetryEvent {
  const ci = detectCiContext(env);
  const repo = detectRepoContext({}, env);
  const repoSource = repo.repoSlug ?? repo.repoUrl;
  return {
    schema_version: SCHEMA_VERSION,
    event: 'completion',
    action,
    action_version: actionVersion(),
    team_id: teamId,
    ci_provider: ci.ciProvider,
    run_id: ci.runId,
    run_attempt: ci.runAttempt,
    runner_kind: ci.runnerKind,
    repo_id: repoSource ? sha256(repoSource) : undefined,
    outcome,
    ts: now()
  };
}

async function send(event: TelemetryEvent, options: TelemetryOptions): Promise<void> {
  const env = options.env ?? process.env;
  const endpoint =
    options.endpoint ?? env.POSTMAN_ACTIONS_TELEMETRY_ENDPOINT ?? DEFAULT_ENDPOINT;
  const transport = options.transport ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    await transport(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export function createTelemetryContext(options: TelemetryOptions): TelemetryContext {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  let teamId = '';
  let emitted = false;

  return {
    setTeamId(value) {
      if (value) {
        teamId = String(value);
      }
    },
    emitCompletion(outcome) {
      if (emitted) {
        return;
      }
      emitted = true;
      try {
        if (telemetryDisabled(env) || !teamId) {
          return;
        }
        const event = buildTelemetryEvent(options.action, teamId, outcome, env, now);
        maybeNotice(options.logger);
        void send(event, options).catch(() => {});
      } catch {
        // Telemetry must never surface an error into the host action.
      }
    }
  };
}
