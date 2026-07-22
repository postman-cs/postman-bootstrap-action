/* global console, fetch, process */
import { pathToFileURL } from 'node:url';

const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
const DEFAULT_E2E_REF = 'main';
const GITHUB_API_VERSION = '2026-03-10';

export function buildCorrelationId({ repository, runId, runAttempt, refName }) {
  return `${repository}-${runId}-${runAttempt}-${refName}`.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

export function normalizeSuite(value) {
  const suite = value?.trim() || 'smoke';
  if (suite !== 'smoke' && suite !== 'full') {
    throw new Error(`E2E_GATE_SUITE must be smoke or full; got ${suite}`);
  }
  return suite;
}

export function buildDispatchInputs({ action, refName, correlationId, suite }) {
  return {
    action,
    ref: refName,
    gate_correlation_id: correlationId,
    suite
  };
}

export function buildDispatchPayload({ workflowRef, action, refName, correlationId, suite }) {
  return {
    ref: workflowRef,
    inputs: buildDispatchInputs({ action, refName, correlationId, suite })
  };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function redactSecrets(text, secrets) {
  let next = text;
  for (const secret of secrets) {
    if (!secret) continue;
    next = next.split(secret).join('[redacted]');
  }
  return next;
}

export async function dispatchE2eMonitor({
  token,
  repository,
  workflow,
  workflowRef,
  action,
  refName,
  correlationId,
  suite,
  fetchImpl = fetch
}) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const payload = buildDispatchPayload({ workflowRef, action, refName, correlationId, suite });
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
      body: JSON.stringify(payload)
    });
  } catch (networkError) {
    throw new Error(
      `e2e monitor dispatch network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
      { cause: networkError }
    );
  }

  const text = await response.text();
  if (response.status !== 204 && response.status !== 200) {
    throw new Error(
      `POST ${url} failed with HTTP ${response.status}: ${redactSecrets(text, [token]).slice(0, 200)}`
    );
  }
  return { status: response.status, payload };
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
  const correlationId =
    process.env.E2E_GATE_CORRELATION_ID ??
    buildCorrelationId({ repository, runId, runAttempt, refName });
  const suite = normalizeSuite(process.env.E2E_GATE_SUITE);

  console.log(
    `Dispatching e2e monitor: action=${action} ref=${refName} suite=${suite} correlation=${correlationId}`
  );
  const result = await dispatchE2eMonitor({
    token,
    repository: e2eRepository,
    workflow: e2eWorkflow,
    workflowRef: e2eWorkflowRef,
    action,
    refName,
    correlationId,
    suite
  });
  console.log(`::notice::e2e monitor dispatch accepted (HTTP ${result.status}); async coverage continues in ${e2eRepository}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      [process.env.E2E_DISPATCH_TOKEN]
    );
    console.log(`::warning::e2e monitor dispatch failed: ${message}`);
    console.error(message);
    process.exit(1);
  });
}
