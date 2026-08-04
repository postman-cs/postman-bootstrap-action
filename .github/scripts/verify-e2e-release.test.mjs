import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ReleaseVerificationError,
  assertCompositeUsesCapability,
  buildCorrelationId,
  buildDispatchInputs,
  buildDispatchPayload,
  classifyTerminalRun,
  electCorrelatedRun,
  parseDispatchRunDetails,
  runReleaseVerificationCli,
  shouldFailRelease,
  validateRunIdentity,
  waitForRunIdentity,
  waitForTerminalRun
} from './verify-e2e-release.mjs';

const DIGEST = 'a'.repeat(64);
const CORRELATION = 'postman-cs-postman-bootstrap-action-42-1-v9.9.9-aaaaaaaaaaaaaaaa';
const RUN_TITLE = `release monitor postman-bootstrap-action@v9.9.9 ${CORRELATION}`;
const EXPECTED = {
  workflow: 'e2e.yml',
  workflowRef: 'main',
  runTitle: RUN_TITLE,
  correlationId: CORRELATION,
  notBeforeMs: Date.parse('2026-08-03T12:00:00.000Z')
};

function run(overrides = {}) {
  return {
    id: 77,
    event: 'workflow_dispatch',
    head_branch: 'main',
    display_title: RUN_TITLE,
    path: '.github/workflows/e2e.yml@refs/heads/main',
    created_at: '2026-08-03T12:00:01.000Z',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.test/postman-cs/postman-actions-e2e/actions/runs/77',
    ...overrides
  };
}

test('dispatch response parsing captures exact workflow run details and supports deterministic fallback', () => {
  assert.deepEqual(
    parseDispatchRunDetails(
      200,
      JSON.stringify({
        workflow_run_id: 77,
        run_url: 'https://api.github.test/runs/77',
        html_url: 'https://github.test/runs/77'
      })
    ),
    {
      workflowRunId: '77',
      runApiUrl: 'https://api.github.test/runs/77',
      runUrl: 'https://github.test/runs/77'
    }
  );
  assert.equal(parseDispatchRunDetails(204, ''), null);
  assert.throws(
    () => parseDispatchRunDetails(200, JSON.stringify({ run_url: 'https://api.github.test/runs/77' })),
    (error) => error instanceof ReleaseVerificationError && error.code === 'dispatch_error'
  );
});

test('dispatch pins exact action/ref/correlation/suite and supported registry metadata', () => {
  const correlationId = buildCorrelationId({
    repository: 'postman-cs/postman-bootstrap-action',
    runId: '42',
    runAttempt: '1',
    refName: 'v9.9.9',
    sourceDigest: DIGEST
  });
  assert.equal(correlationId, CORRELATION);
  const inputs = buildDispatchInputs({
    action: 'postman-bootstrap-action',
    refName: 'v9.9.9',
    correlationId,
    suite: 'full',
    registryRevision: 'b'.repeat(64),
    contractScenarios: '["bootstrap.fresh-import-finalize"]'
  });
  assert.deepEqual(inputs, {
    action: 'postman-bootstrap-action',
    ref: 'v9.9.9',
    gate_correlation_id: correlationId,
    suite: 'full',
    registry_revision: 'b'.repeat(64),
    contract_scenarios: '["bootstrap.fresh-import-finalize"]'
  });
  assert.deepEqual(
    buildDispatchPayload({
      workflowRef: 'main',
      action: 'postman-bootstrap-action',
      refName: 'v9.9.9',
      correlationId,
      suite: 'full'
    }),
    {
      ref: 'main',
      return_run_details: true,
      inputs: {
        action: 'postman-bootstrap-action',
        ref: 'v9.9.9',
        gate_correlation_id: correlationId,
        suite: 'full'
      }
    }
  );
});

test('fallback elects only one exact correlated run and never an unrelated run', () => {
  const unrelated = [
    run({ id: 1, display_title: `release monitor postman-bootstrap-action@v9.9.8 ${CORRELATION}` }),
    run({ id: 2, event: 'schedule' }),
    run({ id: 3, head_branch: 'other' }),
    run({ id: 4, created_at: '2026-08-03T11:59:00.000Z' })
  ];
  assert.equal(electCorrelatedRun([...unrelated, run()], EXPECTED)?.id, 77);
  assert.equal(electCorrelatedRun(unrelated, EXPECTED), null);
  assert.throws(
    () => electCorrelatedRun([run({ id: 77 }), run({ id: 78 })], EXPECTED),
    (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
  );
});

test('run identity rejects ref, action, correlation, digest, and run-id mismatches', () => {
  assert.equal(validateRunIdentity(run(), { ...EXPECTED, runId: '77' }).id, 77);
  for (const mismatch of [
    run({ head_branch: 'release' }),
    run({ display_title: RUN_TITLE.replace('v9.9.9', 'v9.9.8') }),
    run({ display_title: RUN_TITLE.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb') }),
    run({ path: undefined }),
    run({ id: 88 })
  ]) {
    assert.throws(
      () => validateRunIdentity(mismatch, { ...EXPECTED, runId: '77' }),
      (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
    );
  }
});

test('workflow path accepts bare GitHub API path and @ref form; rejects wrong file', () => {
  const bare = run({ path: '.github/workflows/e2e.yml' });
  const withRef = run({ path: '.github/workflows/e2e.yml@refs/heads/main' });
  const wrong = run({ path: '.github/workflows/other.yml' });

  assert.equal(validateRunIdentity(bare, { ...EXPECTED, runId: '77' }).id, 77);
  assert.equal(validateRunIdentity(withRef, { ...EXPECTED, runId: '77' }).id, 77);
  assert.throws(
    () => validateRunIdentity(wrong, { ...EXPECTED, runId: '77' }),
    (error) =>
      error instanceof ReleaseVerificationError &&
      error.code === 'correlation_mismatch' &&
      /workflow path/.test(error.message)
  );

  assert.equal(electCorrelatedRun([bare], EXPECTED)?.id, 77);
  assert.equal(electCorrelatedRun([withRef], EXPECTED)?.id, 77);
  assert.equal(electCorrelatedRun([wrong], EXPECTED), null);
});

test('terminal conclusions distinguish every release decision', () => {
  assert.deepEqual(classifyTerminalRun(run({ status: 'in_progress', conclusion: null })), {
    terminal: false
  });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'success' })), {
    terminal: true,
    outcome: 'success'
  });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'failure' })), {
    terminal: true,
    outcome: 'failure'
  });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'cancelled' })), {
    terminal: true,
    outcome: 'cancelled'
  });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'timed_out' })), {
    terminal: true,
    outcome: 'timed_out'
  });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'skipped' })), {
    terminal: true,
    outcome: 'blocked'
  });
  assert.throws(
    () => classifyTerminalRun(run({ status: 'mystery', conclusion: null })),
    (error) => error instanceof ReleaseVerificationError && error.code === 'blocked'
  );
});

test('exact-run polling is bounded and reports verification_timeout', async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      waitForTerminalRun({
        config: {
          verificationTimeoutMs: 10,
          initialPollMs: 4,
          maxPollMs: 4
        },
        runId: '77',
        expected: { ...EXPECTED, notBeforeMs: 0 },
        fetchRun: async () =>
          run({
            created_at: '1970-01-01T00:00:00.001Z',
            status: 'in_progress',
            conclusion: null
          }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms || 1;
        }
      }),
    (error) => error instanceof ReleaseVerificationError && error.code === 'verification_timeout'
  );
});

test('exact dispatch run waits for run-name hydration but rejects every other mismatch', async () => {
  let clock = 0;
  let reads = 0;
  const hydrated = await waitForRunIdentity({
    config: {
      lookupTimeoutMs: 20,
      initialPollMs: 4,
      maxPollMs: 4
    },
    runId: '77',
    expected: { ...EXPECTED, notBeforeMs: 0 },
    fetchRun: async () => {
      reads += 1;
      return run({
        created_at: '1970-01-01T00:00:00.001Z',
        display_title: reads === 1 ? 'e2e (live sandbox)' : RUN_TITLE
      });
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms || 1;
    }
  });
  assert.equal(hydrated.id, 77);
  assert.equal(reads, 2);

  await assert.rejects(
    () =>
      waitForRunIdentity({
        config: { lookupTimeoutMs: 20, initialPollMs: 4, maxPollMs: 4 },
        runId: '77',
        expected: { ...EXPECTED, notBeforeMs: 0 },
        fetchRun: async () => run({ head_branch: 'wrong-branch' }),
        now: () => 0,
        sleep: async () => {}
      }),
    (error) =>
      error instanceof ReleaseVerificationError &&
      error.code === 'correlation_mismatch' &&
      /workflow ref/.test(error.message)
  );
});

test('report-only is explicit and enforcement is the default decision', () => {
  assert.equal(shouldFailRelease(undefined, 'failure'), true);
  assert.equal(shouldFailRelease('enforce', 'blocked'), true);
  assert.equal(shouldFailRelease('enforce', 'success'), false);
  assert.equal(shouldFailRelease('report-only', 'failure'), false);
});

test('composite capability requires a real released-action uses path', () => {
  assert.throws(
    () => assertCompositeUsesCapability('name: e2e\n'),
    (error) =>
      error instanceof ReleaseVerificationError &&
      error.code === 'blocked' &&
      /E2E_COMPOSITE_USES_UNAVAILABLE/.test(error.message)
  );
  assert.doesNotThrow(() =>
    assertCompositeUsesCapability(`
repository: postman-cs/postman-api-onboarding-action
if: inputs.action == 'postman-api-onboarding-action'
uses: ./postman-api-onboarding-action
`)
  );
});

test('CLI distinguishes dispatch auth errors and only report-only converts them to a green job', async () => {
  const env = {
    E2E_DISPATCH_TOKEN: 'test-token',
    E2E_GATE_ACTION: 'postman-bootstrap-action',
    E2E_GATE_REF: 'v9.9.9',
    E2E_GATE_SOURCE_DIGEST: DIGEST,
    E2E_GATE_SUITE: 'full',
    GITHUB_REPOSITORY: 'postman-cs/postman-bootstrap-action',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1'
  };
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => 'denied test-token'
  });
  const enforced = await runReleaseVerificationCli(env, {
    fetchImpl,
    log() {},
    error() {}
  });
  assert.equal(enforced.exitCode, 1);
  assert.equal(enforced.result.outcome, 'dispatch_auth_error');

  const warnings = [];
  const reportOnly = await runReleaseVerificationCli(
    { ...env, E2E_GATE_MODE: 'report-only' },
    { fetchImpl, log: (line) => warnings.push(line), error() {} }
  );
  assert.equal(reportOnly.exitCode, 0);
  assert.equal(reportOnly.result.outcome, 'dispatch_auth_error');
  assert.ok(warnings.some((line) => line.includes('REPORT-ONLY')));
  assert.ok(warnings.every((line) => !line.includes('test-token')));
});
