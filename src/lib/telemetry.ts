// Anonymous usage telemetry. Fire-and-forget, framework-agnostic (no
// @actions/core), must never block or fail the host action. One completion
// event per run, emitted after team_id is resolved. Opt-out via
// POSTMAN_ACTIONS_TELEMETRY=off or DO_NOT_TRACK; auto-disabled when no team_id.
//
// Payload is account/CI-level only: no secrets, no spec content, no repo names
// in clear, no personal data. team_id is sent clear (legitimate-interest basis,
// see each action's README Telemetry section).

import { createHash } from 'node:crypto';

import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { detectCiContext } from './ci-context.js';
import { detectRepoContext } from './repo/context.js';

// Injected at build via esbuild --define; undefined under vitest/tsc.
declare const __ACTION_VERSION__: string | undefined;

const SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 1500;
// Live collector on the Postman CSE + FDE Cloudflare account.
// Override with POSTMAN_ACTIONS_TELEMETRY_ENDPOINT.
const DEFAULT_ENDPOINT = 'https://events.pm-cse.dev/v1/events';

// Corporate-proxy support: Node's global fetch ignores HTTP(S)_PROXY, which
// silently blackholes the beacon in proxy-only enterprises (the locked-down
// cohort this metric exists to count). EnvHttpProxyAgent reads HTTPS_PROXY /
// HTTP_PROXY / NO_PROXY itself; construct it once at module load and pass it
// per-request as the dispatcher. This deliberately avoids setGlobalDispatcher so
// the action's own Postman/Bifrost HTTP clients stay on the default agent. The
// 1500 ms abort still applies through the proxy.
let proxyDispatcher: EnvHttpProxyAgent | undefined;
function getProxyDispatcher(): EnvHttpProxyAgent {
  // Lazy so importing this module never triggers undici's experimental EHPA
  // warning on the opt-out path; send() runs only when telemetry is enabled
  // with a resolved team id.
  return (proxyDispatcher ??= new EnvHttpProxyAgent());
}

export interface TelemetryLogger {
  info(message: string): void;
}

export interface TelemetryOptions {
  action: string;
  logger?: TelemetryLogger;
  env?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  dispatcher?: Dispatcher;
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
  // Default to undici's fetch: Node's global fetch ignores the per-request
  // dispatcher option, so the EnvHttpProxyAgent would be silently bypassed and
  // proxy-only enterprises would never be counted. Tests inject their own
  // transport.
  const transport = options.transport ?? (undiciFetch as unknown as typeof fetch);
  const dispatcher = options.dispatcher ?? getProxyDispatcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: controller.signal
  };
  // undici's fetch reads `dispatcher` off the init; the global RequestInit's
  // Dispatcher type can skew from the undici package's own across dependency
  // trees, so attach it without re-asserting that type.
  (init as { dispatcher?: unknown }).dispatcher = dispatcher;
  try {
    await transport(endpoint, init);
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
