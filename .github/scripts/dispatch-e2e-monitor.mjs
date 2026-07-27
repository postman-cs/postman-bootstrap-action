import { pathToFileURL } from 'node:url';

// Canonical release -> live-monitor dispatch contract.
//
// The central monitor lives in postman-cs/postman-actions-e2e and is triggered
// through `workflow_dispatch` on e2e.yml. Its listener reads exactly four
// inputs: action, ref, gate_correlation_id, suite. Anything else (notably a
// `repository_dispatch` whose event type does not match) is accepted by GitHub
// with HTTP 204 and then silently dropped, so a green release job would report
// coverage that never ran. Keep this file byte-identical across releasing
// action repos; the accompanying node:test pins the listener contract.

export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
export const REDACTED_TOKEN_MARKER = '[REDACTED]';
export const SUPPORTED_SUITES = Object.freeze(['smoke', 'full', 'branch-aware']);

const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
const DEFAULT_E2E_WORKFLOW_REF = 'main';
const GITHUB_API_VERSION = '2022-11-28';
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Replace every exact occurrence of `token` in arbitrary transport error text.
 * Deterministic split/join, never regex: the token can contain regex meta.
 *
 * @param {unknown} text
 * @param {string|undefined} token
 * @returns {string}
 */
export function redactTokenOccurrences(text, token) {
  const source = text == null ? '' : String(text);
  if (!token) return source;
  return source.split(token).join(REDACTED_TOKEN_MARKER);
}

/**
 * Stable, greppable identity for one release -> monitor hop. Surfaces in the
 * monitor `run-name`, so a failed live run can be traced back to the exact
 * release job attempt that asked for it.
 *
 * @param {{repository: string, runId: string, runAttempt: string, refName: string}} input
 * @returns {string}
 */
export function buildCorrelationId({ repository, runId, runAttempt, refName }) {
  return `${repository}-${runId}-${runAttempt}-${refName}`.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

/**
 * @param {string|undefined} value
 * @returns {string}
 */
export function normalizeSuite(value) {
  const suite = value?.trim() || 'smoke';
  if (!SUPPORTED_SUITES.includes(suite)) {
    throw new Error(`E2E_GATE_SUITE must be one of ${SUPPORTED_SUITES.join('|')}; got ${suite}`);
  }
  return suite;
}

/**
 * The four keys the e2e listener actually reads. Renaming any of them silently
 * disables live coverage, so they are asserted by the contract test.
 *
 * @param {{action: string, refName: string, correlationId: string, suite: string}} input
 */
export function buildDispatchInputs({ action, refName, correlationId, suite }) {
  return {
    action,
    ref: refName,
    gate_correlation_id: correlationId,
    suite: normalizeSuite(suite)
  };
}

/**
 * @param {{workflowRef: string, action: string, refName: string, correlationId: string, suite: string}} input
 */
export function buildDispatchPayload({ workflowRef, action, refName, correlationId, suite }) {
  return {
    ref: workflowRef,
    inputs: buildDispatchInputs({ action, refName, correlationId, suite })
  };
}

/**
 * `workflow_dispatch` endpoint, never the bare `repository_dispatch` one.
 *
 * @param {string} targetRepository owner/repo
 * @param {string} workflow single path segment, e.g. e2e.yml
 * @returns {string}
 */
export function buildDispatchUrl(targetRepository, workflow) {
  const parts = String(targetRepository).split('/');
  if (parts.length !== 2 || !PATH_SEGMENT.test(parts[0]) || !PATH_SEGMENT.test(parts[1])) {
    throw new Error(`E2E_GATE_REPOSITORY must be owner/repo; got ${targetRepository}`);
  }
  if (!PATH_SEGMENT.test(String(workflow))) {
    throw new Error(`E2E_GATE_WORKFLOW must be a single path segment; got ${workflow}`);
  }
  const [owner, repo] = parts;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
}

/**
 * One-shot POST. No polling, no retry, no terminal-run wait: the monitor is an
 * asynchronous observer, not a release gate.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   abortSignal?: AbortSignal,
 *   log?: (message: string) => void
 * }} [options]
 */
export async function dispatchE2eMonitor({
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_DISPATCH_TIMEOUT_MS,
  abortSignal,
  log = console.log.bind(console)
} = {}) {
  const token = env.E2E_DISPATCH_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const refName = env.E2E_GATE_REF || env.GITHUB_REF_NAME;
  if (!token || !repository || !refName) {
    throw new Error(
      'E2E_DISPATCH_TOKEN, GITHUB_REPOSITORY, and E2E_GATE_REF (or GITHUB_REF_NAME) are required'
    );
  }

  const action = env.E2E_GATE_ACTION || repository.split('/').at(-1);
  const targetRepository = env.E2E_GATE_REPOSITORY || DEFAULT_E2E_REPOSITORY;
  const workflow = env.E2E_GATE_WORKFLOW || DEFAULT_E2E_WORKFLOW;
  const workflowRef = env.E2E_GATE_WORKFLOW_REF || DEFAULT_E2E_WORKFLOW_REF;
  const suite = normalizeSuite(env.E2E_GATE_SUITE);
  const correlationId =
    env.E2E_GATE_CORRELATION_ID ||
    buildCorrelationId({
      repository,
      runId: env.GITHUB_RUN_ID ?? 'local',
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? '1',
      refName
    });

  const url = buildDispatchUrl(targetRepository, workflow);
  const payload = buildDispatchPayload({ workflowRef, action, refName, correlationId, suite });
  const signal = abortSignal ?? AbortSignal.timeout(timeoutMs);

  log(
    `::notice::Dispatching e2e monitor: action=${action} ref=${refName} suite=${suite} correlation=${correlationId}`
  );

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Intentionally omit `cause`: the transport error may embed the token.
    // eslint-disable-next-line preserve-caught-error -- token-bearing cause must not be preserved
    throw new Error(`e2e monitor dispatch failed: ${redactTokenOccurrences(message, token)}`);
  }

  if (!response.ok) {
    const detail = await readResponseDetail(response, token);
    throw new Error(
      `e2e monitor dispatch failed with HTTP ${response.status} for ${action}@${refName}${detail}`
    );
  }

  log(
    `::notice::e2e monitor dispatch accepted (HTTP ${response.status}) for ${action}@${refName}; async coverage continues in ${targetRepository} (correlation=${correlationId}).`
  );
  return { status: response.status, url, payload, correlationId };
}

/**
 * Best-effort, always-redacted response body for failure triage. A body that
 * cannot be read must never mask the status code that did arrive.
 *
 * @param {{text?: () => Promise<string>}} response
 * @param {string} token
 * @returns {Promise<string>}
 */
async function readResponseDetail(response, token) {
  if (typeof response.text !== 'function') return '';
  try {
    const body = await response.text();
    if (!body) return '';
    return `: ${redactTokenOccurrences(body, token).slice(0, 300)}`;
  } catch {
    return ': <response body unavailable>';
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatchE2eMonitor().catch((error) => {
    const message = redactTokenOccurrences(
      error instanceof Error ? error.message : String(error),
      process.env.E2E_DISPATCH_TOKEN
    );
    console.log(`::warning::e2e monitor dispatch failed: ${message}`);
    console.error(message);
    process.exit(1);
  });
}