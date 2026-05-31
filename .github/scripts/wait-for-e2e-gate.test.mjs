import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCorrelationId,
  findRunByCorrelation,
  isSuccessfulConclusion,
  isTerminalStatus,
  normalizeRunDetails
} from './wait-for-e2e-gate.mjs';

test('buildCorrelationId creates a stable run-scoped identifier', () => {
  assert.equal(
    buildCorrelationId({
      repository: 'postman-cs/postman-bootstrap-action',
      runId: '12345',
      runAttempt: '2',
      refName: 'v0.13.1'
    }),
    'postman-cs-postman-bootstrap-action-12345-2-v0.13.1'
  );
});

test('findRunByCorrelation requires exactly one matching run after dispatch time', () => {
  const createdAfter = '2026-05-31T05:00:00Z';
  const matchingRun = {
    id: 101,
    html_url: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/101',
    display_title: 'release gate postman-bootstrap-action@v0.13.1 corr-123',
    created_at: '2026-05-31T05:00:02Z'
  };

  assert.deepEqual(
    findRunByCorrelation(
      [
        { ...matchingRun, display_title: 'old corr-123', created_at: '2026-05-31T04:59:59Z' },
        matchingRun,
        { id: 102, display_title: 'other corr-999', created_at: '2026-05-31T05:00:03Z' }
      ],
      'corr-123',
      createdAfter
    ),
    matchingRun
  );

  assert.equal(findRunByCorrelation([], 'corr-123', createdAfter), null);
  assert.throws(
    () => findRunByCorrelation([matchingRun, { ...matchingRun, id: 103 }], 'corr-123', createdAfter),
    /multiple e2e workflow runs/
  );
});

test('normalizes dispatch response run details when present', () => {
  assert.deepEqual(
    normalizeRunDetails({
      workflow_run: {
        id: 456,
        url: 'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/runs/456',
        html_url: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/456'
      }
    }),
    {
      id: 456,
      url: 'https://api.github.com/repos/postman-cs/postman-actions-e2e/actions/runs/456',
      htmlUrl: 'https://github.com/postman-cs/postman-actions-e2e/actions/runs/456'
    }
  );

  assert.equal(normalizeRunDetails(null), null);
});

test('classifies terminal status and successful conclusions', () => {
  assert.equal(isTerminalStatus('completed'), true);
  assert.equal(isTerminalStatus('queued'), false);
  assert.equal(isSuccessfulConclusion('success'), true);
  assert.equal(isSuccessfulConclusion('failure'), false);
  assert.equal(isSuccessfulConclusion(null), false);
});
