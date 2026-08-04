import { appendFileSync } from 'node:fs';
import { pathToFileURL, URLSearchParams } from 'node:url';

export const GITHUB_API_VERSION = '2022-11-28';
export const SUPPORTED_SUITES = Object.freeze(['smoke', 'full', 'branch-aware']);
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 120_000;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_INITIAL_POLL_MS = 5_000;
export const DEFAULT_MAX_POLL_MS = 30_000;
export const REDACTED_TOKEN_MARKER = '[REDACTED]';

const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
const DEFAULT_E2E_WORKFLOW_REF = 'main';
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export class ReleaseVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseVerificationError';
    this.code = code;
    this.details = details;
  }
}

export function redactTokenOccurrences(text, token) {
  const source = text == null ? '' : String(text);
  return token ? source.split(token).join(REDACTED_TOKEN_MARKER) : source;
}

export function normalizeMode(value) {
  const mode = value?.trim() || 'enforce';
  if (mode !== 'enforce' && mode !== 'report-only') {
    throw new ReleaseVerificationError(
      'blocked',
      `E2E_GATE_MODE must be enforce or report-only; got ${mode}`
    );
  }
  return mode;
}

export function normalizeSuite(value) {
  const suite = value?.trim() || 'full';
  if (!SUPPORTED_SUITES.includes(suite)) {
    throw new ReleaseVerificationError(
      'blocked',
      `E2E_GATE_SUITE must be one of ${SUPPORTED_SUITES.join('|')}; got ${suite}`
    );
  }
  return suite;
}

function requireNonEmpty(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new ReleaseVerificationError('blocked', `${name} is required`);
  return normalized;
}

function parsePositiveInteger(value, fallback, name) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ReleaseVerificationError('blocked', `${name} must be a positive integer`);
  }
  return parsed;
}

export function buildCorrelationId({ repository, runId, runAttempt, refName, sourceDigest }) {
  if (!SHA256.test(sourceDigest)) {
    throw new ReleaseVerificationError('blocked', 'E2E_GATE_SOURCE_DIGEST must be lowercase sha256');
  }
  return `${repository}-${runId}-${runAttempt}-${refName}-${sourceDigest.slice(0, 16)}`.replace(
    /[^A-Za-z0-9_.-]+/g,
    '-'
  );
}

export function expectedRunTitle({ action, refName, correlationId }) {
  return `release monitor ${action}@${refName} ${correlationId}`;
}

function parseContractScenarios(raw) {
  const value = raw?.trim();
  if (!value) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ReleaseVerificationError('blocked', 'E2E_GATE_CONTRACT_SCENARIOS must be JSON');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((entry) => typeof entry !== 'string' || entry.trim().length === 0) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new ReleaseVerificationError(
      'blocked',
      'E2E_GATE_CONTRACT_SCENARIOS must be a non-empty unique string array'
    );
  }
  return JSON.stringify([...parsed].sort());
}

export function buildDispatchInputs({
  action,
  refName,
  correlationId,
  suite,
  registryRevision,
  contractScenarios
}) {
  const inputs = {
    action,
    ref: refName,
    gate_correlation_id: correlationId,
    suite: normalizeSuite(suite)
  };
  const scenarios = parseContractScenarios(contractScenarios);
  const registry = registryRevision?.trim();
  if ((registry && !scenarios) || (!registry && scenarios)) {
    throw new ReleaseVerificationError(
      'blocked',
      'E2E_GATE_REGISTRY_REVISION and E2E_GATE_CONTRACT_SCENARIOS must be supplied together'
    );
  }
  if (registry && scenarios) {
    if (!SHA256.test(registry)) {
      throw new ReleaseVerificationError(
        'blocked',
        'E2E_GATE_REGISTRY_REVISION must be lowercase sha256'
      );
    }
    inputs.registry_revision = registry;
    inputs.contract_scenarios = scenarios;
  }
  return inputs;
}

export function buildDispatchPayload(input) {
  return {
    ref: input.workflowRef,
    return_run_details: true,
    inputs: buildDispatchInputs(input)
  };
}

export function buildDispatchUrl(targetRepository, workflow) {
  const parts = String(targetRepository).split('/');
  if (parts.length !== 2 || parts.some((part) => !PATH_SEGMENT.test(part))) {
    throw new ReleaseVerificationError(
      'blocked',
      `E2E_GATE_REPOSITORY must be owner/repo; got ${targetRepository}`
    );
  }
  if (!PATH_SEGMENT.test(String(workflow))) {
    throw new ReleaseVerificationError(
      'blocked',
      `E2E_GATE_WORKFLOW must be a single path segment; got ${workflow}`
    );
  }
  return `https://api.github.com/repos/${parts[0]}/${parts[1]}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
}

export function parseDispatchRunDetails(status, text) {
  const bodyText = String(text ?? '').trim();
  if (status === 204 && bodyText === '') return null;
  if (!bodyText) return null;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new ReleaseVerificationError('dispatch_error', 'workflow dispatch returned invalid JSON');
  }
  const id = body?.workflow_run_id;
  const runUrl = body?.run_url;
  const htmlUrl = body?.html_url;
  if ((typeof id !== 'number' && typeof id !== 'string') || String(id).trim().length === 0) {
    throw new ReleaseVerificationError(
      'dispatch_error',
      'workflow dispatch response omitted workflow_run_id'
    );
  }
  if (
    (runUrl !== undefined && typeof runUrl !== 'string') ||
    (htmlUrl !== undefined && typeof htmlUrl !== 'string')
  ) {
    throw new ReleaseVerificationError('dispatch_error', 'workflow dispatch response has invalid URLs');
  }
  return {
    workflowRunId: String(id),
    runApiUrl: typeof runUrl === 'string' && runUrl ? runUrl : undefined,
    runUrl: typeof htmlUrl === 'string' && htmlUrl ? htmlUrl : undefined
  };
}

function runCreatedAt(run) {
  const parsed = Date.parse(String(run?.created_at ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function workflowPathMatches(path, workflow) {
  if (typeof path !== 'string') return false;
  const base = path.split('@', 1)[0];
  return base.endsWith(`/${workflow}`) || base === workflow;
}

export function validateRunIdentity(run, expected) {
  if (!run || typeof run !== 'object') {
    throw new ReleaseVerificationError('correlation_mismatch', 'workflow run payload is missing');
  }
  const mismatches = [];
  if (String(run.id ?? '') !== String(expected.runId ?? run.id ?? '')) mismatches.push('run id');
  if (run.event !== 'workflow_dispatch') mismatches.push('event');
  if (run.head_branch !== expected.workflowRef) mismatches.push('workflow ref');
  if (run.display_title !== expected.runTitle) mismatches.push('action/ref/correlation/digest title');
  if (!workflowPathMatches(run.path, expected.workflow)) mismatches.push('workflow path');
  const createdAt = runCreatedAt(run);
  if (!Number.isFinite(createdAt) || createdAt < expected.notBeforeMs) mismatches.push('created_at');
  if (mismatches.length > 0) {
    throw new ReleaseVerificationError(
      'correlation_mismatch',
      `downstream run correlation mismatch: ${mismatches.join(', ')}`,
      { runId: run.id == null ? undefined : String(run.id) }
    );
  }
  return run;
}

export function electCorrelatedRun(runs, expected) {
  if (!Array.isArray(runs)) {
    throw new ReleaseVerificationError('verifier_unavailable', 'workflow run lookup omitted workflow_runs');
  }
  const matches = runs
    .filter((run) => {
      if (!run || typeof run !== 'object') return false;
      if (run.event !== 'workflow_dispatch') return false;
      if (run.head_branch !== expected.workflowRef) return false;
      if (run.display_title !== expected.runTitle) return false;
      if (!workflowPathMatches(run.path, expected.workflow)) return false;
      const createdAt = runCreatedAt(run);
      return Number.isFinite(createdAt) && createdAt >= expected.notBeforeMs;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (matches.length > 1) {
    throw new ReleaseVerificationError(
      'correlation_mismatch',
      `multiple downstream runs matched exact correlation ${expected.correlationId}`
    );
  }
  return matches[0] ?? null;
}

export function classifyTerminalRun(run) {
  if (run?.status !== 'completed') {
    if (PENDING_STATUSES.has(String(run?.status ?? ''))) return { terminal: false };
    throw new ReleaseVerificationError(
      'blocked',
      `downstream verifier returned unsupported status ${String(run?.status ?? '<missing>')}`,
      { runId: run?.id == null ? undefined : String(run.id) }
    );
  }
  const conclusion = String(run.conclusion ?? '');
  if (conclusion === 'success') return { terminal: true, outcome: 'success' };
  if (conclusion === 'failure') return { terminal: true, outcome: 'failure' };
  if (conclusion === 'cancelled') return { terminal: true, outcome: 'cancelled' };
  if (conclusion === 'timed_out') return { terminal: true, outcome: 'timed_out' };
  return { terminal: true, outcome: 'blocked' };
}

export function computeBackoffMs(attempt, initialMs, maxMs) {
  return Math.min(initialMs * 2 ** Math.max(0, attempt), maxMs);
}

function githubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION
  };
}

async function responseDetail(response, token) {
  try {
    return redactTokenOccurrences((await response.text()).slice(0, 300), token);
  } catch {
    return '<response body unavailable>';
  }
}

async function githubJson({ url, token, fetchImpl, signal, operation }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: githubHeaders(token),
      signal
    });
  } catch (error) {
    const message = redactTokenOccurrences(
      error instanceof Error ? error.message : String(error),
      token
    );
    throw new ReleaseVerificationError('verifier_unavailable', `${operation} failed: ${message}`);
  }
  if (!response.ok) {
    const detail = await responseDetail(response, token);
    throw new ReleaseVerificationError(
      'verifier_unavailable',
      `${operation} failed with HTTP ${response.status}: ${detail}`
    );
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new ReleaseVerificationError('verifier_unavailable', `${operation} returned invalid JSON`);
  }
}

export function assertCompositeUsesCapability(workflowText) {
  const checks = [
    /repository:\s*postman-cs\/postman-api-onboarding-action/,
    /uses:\s*\.\/postman-api-onboarding-action/,
    /inputs\.action\s*==\s*'postman-api-onboarding-action'/
  ];
  if (!checks.every((pattern) => pattern.test(workflowText))) {
    throw new ReleaseVerificationError(
      'blocked',
      'E2E_COMPOSITE_USES_UNAVAILABLE: harness does not execute the released composite through a real uses: step'
    );
  }
}

async function verifyRequiredCapability(config, fetchImpl, signal) {
  if (!config.requiredCapability) return;
  if (config.requiredCapability !== 'composite-uses') {
    throw new ReleaseVerificationError(
      'blocked',
      `unsupported E2E_GATE_REQUIRED_CAPABILITY ${config.requiredCapability}`
    );
  }
  const [owner, repo] = config.targetRepository.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${encodeURIComponent(config.workflow)}?ref=${encodeURIComponent(config.workflowRef)}`;
  const body = await githubJson({
    url,
    token: config.token,
    fetchImpl,
    signal,
    operation: 'verifier capability lookup'
  });
  if (body?.encoding !== 'base64' || typeof body?.content !== 'string') {
    throw new ReleaseVerificationError('verifier_unavailable', 'verifier workflow content is unavailable');
  }
  assertCompositeUsesCapability(Buffer.from(body.content, 'base64').toString('utf8'));
}

export function resolveConfig(env = process.env) {
  const token = requireNonEmpty(env.E2E_DISPATCH_TOKEN, 'E2E_DISPATCH_TOKEN');
  const repository = requireNonEmpty(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const refName = requireNonEmpty(env.E2E_GATE_REF || env.GITHUB_REF_NAME, 'E2E_GATE_REF');
  const sourceDigest = requireNonEmpty(env.E2E_GATE_SOURCE_DIGEST, 'E2E_GATE_SOURCE_DIGEST');
  const action = env.E2E_GATE_ACTION?.trim() || repository.split('/').at(-1);
  if (!action) throw new ReleaseVerificationError('blocked', 'E2E_GATE_ACTION is required');
  const targetRepository = env.E2E_GATE_REPOSITORY?.trim() || DEFAULT_E2E_REPOSITORY;
  const workflow = env.E2E_GATE_WORKFLOW?.trim() || DEFAULT_E2E_WORKFLOW;
  buildDispatchUrl(targetRepository, workflow);
  const workflowRef = env.E2E_GATE_WORKFLOW_REF?.trim() || DEFAULT_E2E_WORKFLOW_REF;
  if (!PATH_SEGMENT.test(workflowRef)) {
    throw new ReleaseVerificationError('blocked', 'E2E_GATE_WORKFLOW_REF must be a branch name');
  }
  const runId = requireNonEmpty(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const runAttempt = requireNonEmpty(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  const correlationId =
    env.E2E_GATE_CORRELATION_ID?.trim() ||
    buildCorrelationId({ repository, runId, runAttempt, refName, sourceDigest });
  return {
    token,
    repository,
    refName,
    sourceDigest,
    action,
    targetRepository,
    workflow,
    workflowRef,
    suite: normalizeSuite(env.E2E_GATE_SUITE),
    registryRevision: env.E2E_GATE_REGISTRY_REVISION,
    contractScenarios: env.E2E_GATE_CONTRACT_SCENARIOS,
    requiredCapability: env.E2E_GATE_REQUIRED_CAPABILITY?.trim() || '',
    correlationId,
    mode: normalizeMode(env.E2E_GATE_MODE),
    dispatchTimeoutMs: parsePositiveInteger(
      env.E2E_GATE_DISPATCH_TIMEOUT_MS,
      DEFAULT_DISPATCH_TIMEOUT_MS,
      'E2E_GATE_DISPATCH_TIMEOUT_MS'
    ),
    lookupTimeoutMs: parsePositiveInteger(
      env.E2E_GATE_LOOKUP_TIMEOUT_MS,
      DEFAULT_LOOKUP_TIMEOUT_MS,
      'E2E_GATE_LOOKUP_TIMEOUT_MS'
    ),
    verificationTimeoutMs: parsePositiveInteger(
      env.E2E_GATE_VERIFICATION_TIMEOUT_MS,
      DEFAULT_VERIFICATION_TIMEOUT_MS,
      'E2E_GATE_VERIFICATION_TIMEOUT_MS'
    ),
    initialPollMs: parsePositiveInteger(
      env.E2E_GATE_INITIAL_POLL_MS,
      DEFAULT_INITIAL_POLL_MS,
      'E2E_GATE_INITIAL_POLL_MS'
    ),
    maxPollMs: parsePositiveInteger(
      env.E2E_GATE_MAX_POLL_MS,
      DEFAULT_MAX_POLL_MS,
      'E2E_GATE_MAX_POLL_MS'
    )
  };
}

async function dispatchWorkflow(config, fetchImpl, signal, startedAtMs) {
  const url = buildDispatchUrl(config.targetRepository, config.workflow);
  const payload = buildDispatchPayload({
    workflowRef: config.workflowRef,
    action: config.action,
    refName: config.refName,
    correlationId: config.correlationId,
    suite: config.suite,
    registryRevision: config.registryRevision,
    contractScenarios: config.contractScenarios
  });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        ...githubHeaders(config.token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal
    });
  } catch (error) {
    const message = redactTokenOccurrences(
      error instanceof Error ? error.message : String(error),
      config.token
    );
    throw new ReleaseVerificationError('dispatch_error', `workflow dispatch failed: ${message}`);
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'dispatch_auth_error' : 'dispatch_error';
    throw new ReleaseVerificationError(
      code,
      `workflow dispatch failed with HTTP ${response.status}: ${redactTokenOccurrences(text, config.token).slice(0, 300)}`
    );
  }
  return {
    details: parseDispatchRunDetails(response.status, text),
    payload,
    startedAtMs,
    url
  };
}

async function lookupCorrelatedRun(config, expected, dependencies) {
  const deadline = dependencies.now() + config.lookupTimeoutMs;
  let attempt = 0;
  while (dependencies.now() <= deadline) {
    const [owner, repo] = config.targetRepository.split('/');
    const query = new URLSearchParams({
      event: 'workflow_dispatch',
      branch: config.workflowRef,
      created: `>=${new Date(expected.notBeforeMs).toISOString()}`,
      per_page: '100'
    });
    const body = await githubJson({
      url: `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?${query}`,
      token: config.token,
      fetchImpl: dependencies.fetchImpl,
      signal: AbortSignal.timeout(config.dispatchTimeoutMs),
      operation: 'correlated workflow run lookup'
    });
    const run = electCorrelatedRun(body?.workflow_runs, expected);
    if (run) return run;
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) break;
    await dependencies.sleep(Math.min(delay, remaining));
  }
  throw new ReleaseVerificationError(
    'verifier_unavailable',
    `no downstream run matched exact correlation ${config.correlationId} before lookup timeout`
  );
}

async function fetchExactRun(config, runId, dependencies) {
  const [owner, repo] = config.targetRepository.split('/');
  return githubJson({
    url: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}`,
    token: config.token,
    fetchImpl: dependencies.fetchImpl,
    signal: AbortSignal.timeout(config.dispatchTimeoutMs),
    operation: `exact workflow run ${runId} read`
  });
}

export async function waitForTerminalRun({ config, runId, expected, fetchRun, now, sleep }) {
  const deadline = now() + config.verificationTimeoutMs;
  let attempt = 0;
  while (now() <= deadline) {
    const run = validateRunIdentity(await fetchRun(runId), { ...expected, runId });
    const classified = classifyTerminalRun(run);
    if (classified.terminal) {
      if (classified.outcome === 'success') return run;
      throw new ReleaseVerificationError(
        classified.outcome,
        `downstream verifier ${runId} concluded ${classified.outcome}`,
        { runId: String(runId), runUrl: run.html_url }
      );
    }
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
  }
  throw new ReleaseVerificationError(
    'verification_timeout',
    `downstream verifier ${runId} did not complete before timeout`,
    { runId: String(runId) }
  );
}

export async function waitForRunIdentity({ config, runId, expected, fetchRun, now, sleep }) {
  const deadline = now() + config.lookupTimeoutMs;
  let attempt = 0;
  let lastTitleMismatch;
  while (now() <= deadline) {
    try {
      return validateRunIdentity(await fetchRun(runId), { ...expected, runId });
    } catch (error) {
      const titleIsHydrating =
        error instanceof ReleaseVerificationError &&
        error.code === 'correlation_mismatch' &&
        error.message.endsWith('action/ref/correlation/digest title');
      if (!titleIsHydrating) throw error;
      lastTitleMismatch = error;
    }
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
  }
  throw (
    lastTitleMismatch ??
    new ReleaseVerificationError(
      'correlation_mismatch',
      `downstream run ${runId} identity did not hydrate before lookup timeout`,
      { runId: String(runId) }
    )
  );
}

export async function verifyCorrelatedRelease(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = dependencies.log ?? console.log.bind(console);
  const startedAtMs = now();
  const notBeforeMs = startedAtMs - 2_000;
  const signal = dependencies.abortSignal ?? AbortSignal.timeout(config.dispatchTimeoutMs);

  await verifyRequiredCapability(config, fetchImpl, signal);
  log(
    `::notice::Dispatching correlated E2E verifier action=${config.action} ref=${config.refName} suite=${config.suite} correlation=${config.correlationId}`
  );
  const dispatched = await dispatchWorkflow(config, fetchImpl, signal, startedAtMs);
  const expected = {
    workflow: config.workflow,
    workflowRef: config.workflowRef,
    runTitle: expectedRunTitle(config),
    correlationId: config.correlationId,
    notBeforeMs
  };

  let initialRun;
  if (dispatched.details) {
    initialRun = await waitForRunIdentity({
      config,
      runId: dispatched.details.workflowRunId,
      expected,
      fetchRun: async (id) => fetchExactRun(config, id, { fetchImpl, now, sleep }),
      now,
      sleep
    });
  } else {
    initialRun = await lookupCorrelatedRun(config, expected, { fetchImpl, now, sleep });
  }
  const runId = String(initialRun.id);
  const terminal = await waitForTerminalRun({
    config,
    runId,
    expected,
    fetchRun: async (id) => fetchExactRun(config, id, { fetchImpl, now, sleep }),
    now,
    sleep
  });
  const runUrl = terminal.html_url ?? dispatched.details?.runUrl;
  log(`::notice::Exact downstream verifier succeeded: ${runUrl ?? runId}`);
  return {
    outcome: 'success',
    correlationId: config.correlationId,
    workflowRunId: runId,
    runUrl
  };
}

export function shouldFailRelease(mode, outcome) {
  return normalizeMode(mode) === 'enforce' && outcome !== 'success';
}

function appendOutput(path, key, value) {
  if (!path) return;
  appendFileSync(path, `${key}=${String(value ?? '')}\n`, 'utf8');
}

function appendSummary(path, result, mode) {
  if (!path) return;
  const lines = [
    '## Correlated release verification',
    '',
    `- **Mode:** \`${mode}\``,
    `- **Outcome:** \`${result.outcome}\``,
    `- **Correlation:** \`${result.correlationId ?? 'unavailable'}\``,
    `- **Workflow run:** ${result.runUrl ?? result.workflowRunId ?? '_unavailable_'}`,
    ''
  ];
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

export async function runReleaseVerificationCli(env = process.env, dependencies = {}) {
  let config;
  let mode = 'enforce';
  try {
    mode = normalizeMode(env.E2E_GATE_MODE);
    config = resolveConfig(env);
    const result = await verifyCorrelatedRelease(config, dependencies);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_outcome', result.outcome);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_correlation_id', result.correlationId);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_workflow_run_id', result.workflowRunId);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_run_url', result.runUrl);
    appendSummary(env.GITHUB_STEP_SUMMARY, result, mode);
    return { exitCode: 0, result };
  } catch (error) {
    const classified =
      error instanceof ReleaseVerificationError
        ? error
        : new ReleaseVerificationError(
            'verifier_unavailable',
            error instanceof Error ? error.message : String(error)
          );
    const result = {
      outcome: classified.code,
      correlationId: config?.correlationId,
      workflowRunId: classified.details?.runId,
      runUrl: classified.details?.runUrl
    };
    appendOutput(env.GITHUB_OUTPUT, 'e2e_outcome', result.outcome);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_correlation_id', result.correlationId);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_workflow_run_id', result.workflowRunId);
    appendOutput(env.GITHUB_OUTPUT, 'e2e_run_url', result.runUrl);
    appendSummary(env.GITHUB_STEP_SUMMARY, result, mode);
    const safeMessage = redactTokenOccurrences(classified.message, env.E2E_DISPATCH_TOKEN);
    if (mode === 'report-only') {
      (dependencies.log ?? console.log)(
        `::warning::REPORT-ONLY correlated E2E outcome=${classified.code}: ${safeMessage}`
      );
      return { exitCode: 0, result };
    }
    (dependencies.error ?? console.error)(
      `::error::Correlated E2E verification outcome=${classified.code}: ${safeMessage}`
    );
    return { exitCode: 1, result };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log(
      'Usage: node .github/scripts/verify-e2e-release.mjs\n' +
        'Requires E2E_DISPATCH_TOKEN, E2E_GATE_ACTION, E2E_GATE_REF, E2E_GATE_SOURCE_DIGEST, GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT.'
    );
  } else {
    const execution = await runReleaseVerificationCli();
    process.exitCode = execution.exitCode;
  }
}
