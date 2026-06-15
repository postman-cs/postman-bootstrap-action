/* global console, fetch, process, setTimeout */
import { pathToFileURL } from 'node:url';

const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
const DEFAULT_E2E_REF = 'main';
const DEFAULT_TIMEOUT_SECONDS = 13200;
const DEFAULT_POLL_SECONDS = 10;
const TRANSIENT_BACKOFF_BASE_SECONDS = 15;
const TRANSIENT_BACKOFF_CAP_SECONDS = 120;
const GITHUB_API_VERSION = '2026-03-10';

export function buildCorrelationId({ repository, runId, runAttempt, refName }) {
  return `${repository}-${runId}-${runAttempt}-${refName}`.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

export function isTerminalStatus(status) {
  return status === 'completed';
}

export function isSuccessfulConclusion(conclusion) {
  return conclusion === 'success';
}

// Pure. Transient GitHub failures (rate-limit 403/429, 5xx, network blips) must
// not fail a release gate mid-wait; the caller backs off and retries until its
// own deadline. Honor a server Retry-After when present, else exponential+cap.
export function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number.parseInt(headerValue, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const when = Date.parse(headerValue);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

export function transientBackoffMs(attempt, retryAfterMs, baseMs = TRANSIENT_BACKOFF_BASE_SECONDS * 1000, capMs = TRANSIENT_BACKOFF_CAP_SECONDS * 1000) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, capMs);
  }
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(exp, capMs);
}

// Pure. +/-20% spread so a fleet of gate waiters does not poll in lockstep.
export function jitter(ms, rand = Math.random()) {
  return Math.round(ms * (0.8 + rand * 0.4));
}

export function normalizeRunDetails(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const source = payload.workflow_run ?? payload.run ?? payload;
  const id = source.id ?? source.workflow_run_id ?? payload.workflow_run_id ?? null;
  const url = source.url ?? source.api_url ?? payload.api_url ?? null;
  const htmlUrl = source.html_url ?? source.workflow_url ?? payload.workflow_url ?? null;

  if (!id && !url && !htmlUrl) {
    return null;
  }

  return { id, url, htmlUrl };
}

export function findRunByCorrelation(runs, correlationId, createdAfterIso) {
  const createdAfterMs = Date.parse(createdAfterIso);
  const matches = runs.filter((run) => {
    const title = String(run.display_title ?? run.name ?? '');
    const createdAtMs = Date.parse(String(run.created_at ?? ''));
    return title.includes(correlationId) && Number.isFinite(createdAtMs) && createdAtMs >= createdAfterMs;
  });

  if (matches.length > 1) {
    const ids = matches.map((run) => run.id).join(', ');
    throw new Error(`Found multiple e2e workflow runs for correlation ${correlationId}: ${ids}`);
  }

  return matches[0] ?? null;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInteger(value, fallback, name) {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer; got ${value}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TransientHttpError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
    this.transient = true;
  }
}

async function githubRequest({ token, method = 'GET', url, body, okStatuses = [200], retryTransient = false }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (networkError) {
    if (retryTransient) {
      throw new TransientHttpError(`network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`, null);
    }
    throw networkError;
  }

  const text = await response.text();
  if (!okStatuses.includes(response.status)) {
    if (retryTransient && (response.status === 403 || response.status === 429 || response.status >= 500)) {
      throw new TransientHttpError(
        `${method} ${url} failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
        parseRetryAfterMs(response.headers.get('retry-after'))
      );
    }
    throw new Error(`${method} ${url} failed with HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// GET poller that survives transient GitHub failures over a long wait: retries
// with backoff until the caller's deadline rather than failing the gate. Only
// for idempotent reads -- the dispatch POST stays single-shot so a retry can
// never spawn a second e2e run.
async function pollGet({ token, url, deadlineMs }) {
  let attempt = 0;
  for (;;) {
    try {
      return await githubRequest({ token, url, retryTransient: true });
    } catch (error) {
      if (!error || error.transient !== true || Date.now() >= deadlineMs) {
        throw error;
      }
      attempt += 1;
      const backoff = jitter(transientBackoffMs(attempt, error.retryAfterMs));
      console.log(`::warning::e2e gate poll failed (${error.message}); retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt}).`);
      await sleep(backoff);
    }
  }
}

function workflowRunsUrl({ repository, workflow }) {
  return `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=50`;
}

async function dispatchE2e({ token, repository, workflow, workflowRef, action, refName, correlationId, failureInjection }) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const payload = {
    ref: workflowRef,
    return_run_details: true,
    inputs: {
      action,
      ref: refName,
      gate_correlation_id: correlationId,
      failure_injection: failureInjection
    }
  };
  return githubRequest({
    token,
    method: 'POST',
    url,
    body: payload,
    okStatuses: [200, 204]
  });
}

async function waitForMatchingRun({ token, repository, workflow, correlationId, createdAfterIso, deadlineMs, pollMs }) {
  const runsUrl = workflowRunsUrl({ repository, workflow });

  while (Date.now() < deadlineMs) {
    const payload = await pollGet({ token, url: runsUrl, deadlineMs });
    const run = findRunByCorrelation(payload.workflow_runs ?? [], correlationId, createdAfterIso);
    if (run) {
      return run;
    }
    console.log(`Waiting for e2e run registration (correlation=${correlationId})...`);
    await sleep(jitter(pollMs));
  }

  throw new Error(`Timed out waiting for e2e workflow run registration (correlation=${correlationId})`);
}

async function waitForTerminalRun({ token, run, deadlineMs, pollMs }) {
  let current = run;
  while (Date.now() < deadlineMs) {
    current = await pollGet({ token, url: current.url, deadlineMs });
    console.log(`e2e run ${current.html_url}: status=${current.status} conclusion=${current.conclusion ?? 'pending'}`);

    if (isTerminalStatus(current.status)) {
      if (isSuccessfulConclusion(current.conclusion)) {
        return current;
      }
      throw new Error(`e2e run concluded ${current.conclusion}: ${current.html_url}`);
    }

    await sleep(jitter(pollMs));
  }

  throw new Error(`Timed out waiting for e2e workflow run to complete: ${current.html_url}`);
}

async function main() {
  const token = requiredEnv('E2E_DISPATCH_TOKEN');
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const runId = requiredEnv('GITHUB_RUN_ID');
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
  const refName = process.env.E2E_GATE_REF ?? requiredEnv('GITHUB_REF_NAME');
  const action = process.env.E2E_GATE_ACTION ?? repository.split('/').at(-1);
  const e2eRepository = process.env.E2E_GATE_REPOSITORY ?? DEFAULT_E2E_REPOSITORY;
  const e2eWorkflow = process.env.E2E_GATE_WORKFLOW ?? DEFAULT_E2E_WORKFLOW;
  const e2eWorkflowRef = process.env.E2E_GATE_WORKFLOW_REF ?? DEFAULT_E2E_REF;
  const timeoutSeconds = parsePositiveInteger(process.env.E2E_GATE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS, 'E2E_GATE_TIMEOUT_SECONDS');
  const pollSeconds = parsePositiveInteger(process.env.E2E_GATE_POLL_SECONDS, DEFAULT_POLL_SECONDS, 'E2E_GATE_POLL_SECONDS');
  const correlationId =
    process.env.E2E_GATE_CORRELATION_ID ??
    buildCorrelationId({ repository, runId, runAttempt, refName });
  const failureInjection = process.env.E2E_GATE_FAILURE_INJECTION ?? '';
  const createdAfterIso = new Date(Date.now() - 30_000).toISOString();
  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  const pollMs = pollSeconds * 1000;

  console.log(`Dispatching e2e gate: action=${action} ref=${refName} correlation=${correlationId}`);
  const dispatchPayload = await dispatchE2e({
    token,
    repository: e2eRepository,
    workflow: e2eWorkflow,
    workflowRef: e2eWorkflowRef,
    action,
    refName,
    correlationId,
    failureInjection
  });
  const runDetails = normalizeRunDetails(dispatchPayload);
  if (runDetails?.htmlUrl ?? runDetails?.url) {
    console.log(`Dispatch accepted; returned run details: ${runDetails.htmlUrl ?? runDetails.url}`);
  } else {
    console.log('Dispatch accepted; waiting for correlated run to register.');
  }

  const run = await waitForMatchingRun({
    token,
    repository: e2eRepository,
    workflow: e2eWorkflow,
    correlationId,
    createdAfterIso,
    deadlineMs,
    pollMs
  });
  console.log(`Matched e2e run: ${run.html_url}`);

  const completed = await waitForTerminalRun({ token, run, deadlineMs, pollMs });
  console.log(`::notice::e2e gate passed: ${completed.html_url}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
