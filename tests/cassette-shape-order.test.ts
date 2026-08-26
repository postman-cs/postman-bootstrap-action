import type { Cassette } from '@postman-cs/automation-core/cassette';
import { describe, expect, it } from 'vitest';

import { cassetteShape, diffCassetteShapes } from '../scripts/cassette-shape.js';

const key = 'GET https://api.getpostman.com/repeated';

function interaction(status: number, body: string): Cassette['interactions'][number] {
  return {
    key,
    body,
    status,
    requestQuery: '',
    responseHeaders: { 'content-type': 'application/json' }
  };
}

function shapeOf(...interactions: Cassette['interactions']) {
  return cassetteShape({ version: 2, interactions });
}

describe('repeated cassette interaction shape comparison', () => {
  it('ignores recording-order changes among same-key status and schema members', () => {
    const baseline = shapeOf(interaction(200, '{"result":{"id":"one"}}'), interaction(202, '{"accepted":true}'));
    const fresh = shapeOf(interaction(202, '{"accepted":false}'), interaction(200, '{"result":{"id":"two"}}'));

    expect(diffCassetteShapes(baseline, fresh)).toEqual([]);
  });

  it('reports a genuine status change with the exact repeated-interaction key and statuses', () => {
    const baseline = shapeOf(interaction(200, '{"result":{"id":"one"}}'), interaction(202, '{"accepted":true}'));
    const fresh = shapeOf(interaction(201, '{"result":{"id":"two"}}'), interaction(202, '{"accepted":false}'));

    expect(diffCassetteShapes(baseline, fresh)).toEqual([
      {
        key,
        axis: 'status',
        detail: 'status changed: baseline 200 -> live 201'
      }
    ]);
  });

  it('reports a genuine nested schema change with the exact key and nested path', () => {
    const baseline = shapeOf(interaction(200, '{"result":{"profile":{"id":"one"}}}'), interaction(202, '{"accepted":true}'));
    const fresh = shapeOf(interaction(202, '{"accepted":false}'), interaction(200, '{"result":{"profile":{"uuid":"two"}}}'));

    const findings = diffCassetteShapes(baseline, fresh);

    expect(findings).toEqual([
      {
        key,
        axis: 'body-schema',
        detail: 'response body schema drift at result.profile: key "id" removed'
      }
    ]);
  });
});
