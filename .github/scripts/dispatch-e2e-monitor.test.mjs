import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCorrelationId,
  buildDispatchInputs,
  buildDispatchPayload,
  dispatchE2eMonitor,
  normalizeSuite
} from './dispatch-e2e-monitor.mjs';

test('normalizes smoke/full suite and rejects unknown values', () => {
  assert.equal(normalizeSuite(undefined), 'smoke');
  assert.equal(normalizeSuite(''), 'smoke');
  assert.equal(normalizeSuite(' smoke '), 'smoke');
  assert.equal(normalizeSuite('full'), 'full');
  assert.throws(() => normalizeSuite('fast'), /E2E_GATE_SUITE must be smoke or full/);
});

test('buildDispatchInputs carries legacy-compatible monitor fields', () => {
  assert.deepEqual(
    buildDispatchInputs({
      action: 'postman-bootstrap-action',
      refName: 'v2.10.5',
      correlationId: 'corr-123',
      suite: 'smoke'
    }),
    {
      action: 'postman-bootstrap-action',
      ref: 'v2.10.5',
      gate_correlation_id: 'corr-123',
      suite: 'smoke'
    }
  );
});

test('buildDispatchPayload pins the e2e workflow ref and exact action tag', () => {
  assert.deepEqual(
    buildDispatchPayload({
      workflowRef: 'main',
      action: 'postman-bootstrap-action',
      refName: 'v2.10.5',
      correlationId: 'corr-123',
      suite: 'smoke'
    }),
    {
      ref: 'main',
      inputs: {
        action: 'postman-bootstrap-action',
        ref: 'v2.10.5',
        gate_correlation_id: 'corr-123',
        suite: 'smoke'
      }
    }
  );
});

test('buildCorrelationId creates a stable run-scoped identifier', () => {
  assert.equal(
    buildCorrelationId({
      repository: 'postman-cs/postman-bootstrap-action',
      runId: '12345',
      runAttempt: '2',
      refName: 'v2.10.5'
    }),
    'postman-cs-postman-bootstrap-action-12345-2-v2.10.5'
  );
});

test('dispatchE2eMonitor posts once with the expected payload and never logs the token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      status: 204,
      text: async () => ''
    };
  };

  const result = await dispatchE2eMonitor({
    token: 'super-secret-token',
    repository: 'postman-cs/postman-actions-e2e',
    workflow: 'e2e.yml',
    workflowRef: 'main',
    action: 'postman-bootstrap-action',
    refName: 'v2.10.5',
    correlationId: 'corr-123',
    suite: 'smoke',
    fetchImpl
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/workflows/e2e.yml/dispatches'
  );
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer super-secret-token');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ref: 'main',
    inputs: {
      action: 'postman-bootstrap-action',
      ref: 'v2.10.5',
      gate_correlation_id: 'corr-123',
      suite: 'smoke'
    }
  });
  assert.equal(result.status, 204);
  assert.equal(JSON.stringify(result).includes('super-secret-token'), false);
});

test('dispatchE2eMonitor redacts the token from HTTP error text', async () => {
  await assert.rejects(
    () =>
      dispatchE2eMonitor({
        token: 'super-secret-token',
        repository: 'postman-cs/postman-actions-e2e',
        workflow: 'e2e.yml',
        workflowRef: 'main',
        action: 'postman-bootstrap-action',
        refName: 'v2.10.5',
        correlationId: 'corr-123',
        suite: 'smoke',
        fetchImpl: async () => ({
          status: 403,
          text: async () => 'denied for token super-secret-token'
        })
      }),
    (error) => {
      assert.match(String(error.message), /HTTP 403/);
      assert.equal(String(error.message).includes('super-secret-token'), false);
      assert.match(String(error.message), /\[redacted\]/);
      return true;
    }
  );
});
