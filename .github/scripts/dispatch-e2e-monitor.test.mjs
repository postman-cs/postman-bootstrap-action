import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCorrelationId,
  buildDispatchInputs,
  buildDispatchPayload,
  buildDispatchUrl,
  dispatchE2eMonitor,
  normalizeSuite,
  redactTokenOccurrences,
  REDACTED_TOKEN_MARKER,
  SUPPORTED_SUITES
} from './dispatch-e2e-monitor.mjs';

const baseEnv = {
  E2E_DISPATCH_TOKEN: 'test-token',
  GITHUB_REPOSITORY: 'postman-cs/postman-bootstrap-action',
  GITHUB_REF_NAME: 'v9.9.9',
  GITHUB_RUN_ID: '4242',
  GITHUB_RUN_ATTEMPT: '2',
  E2E_GATE_SUITE: 'smoke'
};

function okFetch(captured) {
  return async (url, options) => {
    captured.url = url;
    captured.options = options;
    return { ok: true, status: 204, text: async () => '' };
  };
}

// --- listener contract -------------------------------------------------
// postman-cs/postman-actions-e2e e2e.yml is triggered by workflow_dispatch and
// reads inputs.action / inputs.ref / inputs.gate_correlation_id / inputs.suite.
// A repository_dispatch whose event type does not match returns HTTP 204 and is
// then silently dropped, so these assertions are the only thing standing
// between a green release job and zero live coverage.

test('targets the workflow_dispatch endpoint, never bare repository_dispatch', async () => {
  const captured = {};
  await dispatchE2eMonitor({ env: baseEnv, fetchImpl: okFetch(captured), log() {} });
  assert.equal(
    captured.url,
    'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/workflows/e2e.yml/dispatches'
  );
  assert.ok(
    !/\/repos\/[^/]+\/[^/]+\/dispatches$/.test(String(captured.url)),
    'must not POST the repository_dispatch endpoint'
  );
});

test('sends exactly the four inputs the listener reads, and no event_type', async () => {
  const captured = {};
  await dispatchE2eMonitor({ env: baseEnv, fetchImpl: okFetch(captured), log() {} });
  const body = JSON.parse(String(captured.options.body));
  assert.equal(captured.options.method, 'POST');
  assert.equal(body.ref, 'main', 'workflow ref must be the monitor default branch');
  assert.deepEqual(Object.keys(body.inputs).sort(), [
    'action',
    'gate_correlation_id',
    'ref',
    'suite'
  ]);
  assert.equal(body.inputs.action, 'postman-bootstrap-action');
  assert.equal(body.inputs.ref, 'v9.9.9');
  assert.equal(body.inputs.suite, 'smoke');
  assert.equal(body.event_type, undefined, 'event_type belongs to repository_dispatch only');
  assert.equal(body.client_payload, undefined, 'client_payload belongs to repository_dispatch only');
  assert.match(String(captured.options.headers.Authorization), /^Bearer test-token$/);
  assert.ok(captured.options.signal, 'bounded AbortSignal must be supplied');
});

test('E2E_GATE_REF pins the immutable release tag over GITHUB_REF_NAME', async () => {
  const captured = {};
  await dispatchE2eMonitor({
    env: { ...baseEnv, E2E_GATE_REF: 'v1.2.3' },
    fetchImpl: okFetch(captured),
    log() {}
  });
  assert.equal(JSON.parse(String(captured.options.body)).inputs.ref, 'v1.2.3');
});

test('correlation id is deterministic, sanitized, and traceable to the release run', () => {
  const id = buildCorrelationId({
    repository: 'postman-cs/some-action',
    runId: '77',
    runAttempt: '1',
    refName: 'v1.0.0'
  });
  assert.equal(id, 'postman-cs-some-action-77-1-v1.0.0');
  assert.doesNotMatch(id, /[^A-Za-z0-9_.-]/);
});

test('suite accepts every value the monitor workflow offers and rejects the rest', () => {
  assert.deepEqual([...SUPPORTED_SUITES], ['smoke', 'full', 'branch-aware']);
  for (const suite of SUPPORTED_SUITES) {
    assert.equal(normalizeSuite(suite), suite);
  }
  assert.equal(normalizeSuite(undefined), 'smoke');
  assert.throws(() => normalizeSuite('nightly'), /must be one of smoke\|full\|branch-aware/);
});

test('failure text names the action and ref, and never leaks the token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        fetchImpl: async () => ({
          ok: false,
          status: 422,
          text: async () => 'workflow inputs rejected for test-token'
        }),
        log() {}
      }),
    (error) => {
      assert.match(error.message, /HTTP 422 for postman-bootstrap-action@v9\.9\.9/);
      assert.match(error.message, /workflow inputs rejected/);
      assert.doesNotMatch(error.message, /test-token/);
      assert.match(error.message, new RegExp(REDACTED_TOKEN_MARKER.replace(/[[\]]/g, '\\$&')));
      return true;
    }
  );
});

test('an unreadable error body still reports the status code', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          text: async () => {
            throw new Error('stream closed');
          }
        }),
        log() {}
      }),
    /HTTP 503 for postman-bootstrap-action@v9\.9\.9: <response body unavailable>/
  );
});

test('transport failures are redacted and carry no token-bearing cause', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: baseEnv,
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED (auth test-token)');
        },
        log() {}
      }),
    (error) => {
      assert.doesNotMatch(error.message, /test-token/);
      assert.equal(error.cause, undefined);
      return true;
    }
  );
});

test('missing required env fails closed without echoing the token', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        env: { E2E_DISPATCH_TOKEN: 'secret-token' },
        fetchImpl: okFetch({}),
        log() {}
      }),
    (error) => {
      assert.match(error.message, /E2E_DISPATCH_TOKEN, GITHUB_REPOSITORY, and E2E_GATE_REF/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    }
  );
});

test('dispatch target is validated before any network call', () => {
  assert.throws(() => buildDispatchUrl('not-a-repo', 'e2e.yml'), /must be owner\/repo/);
  assert.throws(() => buildDispatchUrl('o/r', 'nested/path.yml'), /single path segment/);
});

test('an explicit abort deadline is honoured', async () => {
  const controller = new AbortController();
  let seen;
  await dispatchE2eMonitor({
    env: baseEnv,
    fetchImpl: async (_url, options) => {
      seen = options.signal;
      return { ok: true, status: 204, text: async () => '' };
    },
    log() {},
    abortSignal: controller.signal
  });
  assert.equal(seen, controller.signal);
});

test('success is announced with the correlation id for run-name tracing', async () => {
  const lines = [];
  const result = await dispatchE2eMonitor({
    env: baseEnv,
    fetchImpl: okFetch({}),
    log: (line) => lines.push(line)
  });
  assert.equal(result.status, 204);
  assert.equal(result.correlationId, 'postman-cs-postman-bootstrap-action-4242-2-v9.9.9');
  assert.ok(lines.some((line) => line.includes(result.correlationId)));
});

test('payload builders are pure and reusable', () => {
  const inputs = buildDispatchInputs({
    action: 'a',
    refName: 'v1',
    correlationId: 'c',
    suite: 'full'
  });
  assert.deepEqual(inputs, { action: 'a', ref: 'v1', gate_correlation_id: 'c', suite: 'full' });
  assert.deepEqual(
    buildDispatchPayload({
      workflowRef: 'main',
      action: 'a',
      refName: 'v1',
      correlationId: 'c',
      suite: 'full'
    }),
    { ref: 'main', inputs }
  );
  assert.equal(redactTokenOccurrences('a-token-b', 'token'), `a-${REDACTED_TOKEN_MARKER}-b`);
  assert.equal(redactTokenOccurrences(undefined, 'token'), '');
});