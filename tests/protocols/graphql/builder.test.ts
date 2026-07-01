import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';
import {
  COLLECTION_V210_SCHEMA,
  buildGraphQLCollection,
  buildOperationDocument,
  buildVariablesJson
} from '../../../src/lib/protocols/graphql/builder.js';

const fixtureSdl = readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/graphql/telecom.graphql'),
  'utf8'
);

type Item = {
  id: string;
  name: string;
  request: {
    method: string;
    header: Array<{ key: string; value: string }>;
    body: { mode: string; graphql: { query: string; variables: string } };
    url: { raw: string; host?: string[]; path?: string[] };
  };
  event: unknown[];
};

describe('buildGraphQLCollection', () => {
  const index = parseGraphQLSchema(fixtureSdl, { service: 'Telecom' });
  const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }) as unknown as {
    info: { name: string; schema: string };
    variable: Array<{ key: string; value: string }>;
    item: Item[];
  };

  it('emits a v2.1.0 collection with one http graphql item per operation in index order', () => {
    expect(collection.info.schema).toBe(COLLECTION_V210_SCHEMA);
    expect(collection.item.map((c) => c.id)).toEqual(index.operations.map((o) => o.id));
    for (const item of collection.item) {
      expect(item.request.method).toBe('POST');
      expect(item.request.body.mode).toBe('graphql');
      expect(item.event).toEqual([]);
      expect(item.request.header).toContainEqual({ key: 'Content-Type', value: 'application/json' });
    }
  });

  it('shapes the request body exactly per the v2.1.0 graphql body mode', () => {
    const subscriber = collection.item.find((c) => c.id === 'query.subscriber')!;
    expect(subscriber.request.body.mode).toBe('graphql');
    expect(Object.keys(subscriber.request.body.graphql).sort()).toEqual(['query', 'variables']);
    expect(subscriber.request.url.raw).toBe('{{baseUrl}}/graphql');
    expect(subscriber.request.url.host).toEqual(['{{baseUrl}}']);
    expect(subscriber.request.url.path).toEqual(['graphql']);
  });

  it('produces valid GraphQL documents with declared variables for required args', () => {
    const subscriber = index.operations.find((o) => o.id === 'query.subscriber')!;
    const doc = buildOperationDocument(subscriber, index);
    expect(() => parse(doc)).not.toThrow();
    expect(doc).toContain('query Subscriber($id: ID!)');
    expect(doc).toContain('subscriber(id: $id)');
    expect(buildVariablesJson(subscriber)).toBe(JSON.stringify({ id: '{{subscriber_id}}' }));
  });

  it('produces valid documents with empty variables for arg-less operations', () => {
    const plans = index.operations.find((o) => o.id === 'query.plans')!;
    const doc = buildOperationDocument(plans, index);
    expect(() => parse(doc)).not.toThrow();
    expect(doc).toContain('query Plans {');
    expect(buildVariablesJson(plans)).toBe('');
  });

  it('builds mutation and subscription documents that parse', () => {
    for (const id of ['mutation.provisionLine', 'subscription.lineStatusChanged']) {
      const op = index.operations.find((o) => o.id === id)!;
      expect(() => parse(buildOperationDocument(op, index))).not.toThrow();
    }
  });

  it('defaults collection title and variables, overridable via options', () => {
    const def = buildGraphQLCollection(index) as unknown as { info: { name: string }; variable: Array<{ key: string }> };
    expect(def.info.name).toBe('Telecom Contract');
    expect(def.variable.map((v) => v.key)).toEqual(['baseUrl']);
    const custom = buildGraphQLCollection(index, { name: 'Custom', variables: [{ key: 'gqlUrl', value: 'x' }] }) as unknown as { info: { name: string } };
    expect(custom.info.name).toBe('Custom');
  });

  it('is deterministic across repeated builds', () => {
    const a = JSON.stringify(buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }));
    const b = JSON.stringify(buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }));
    expect(a).toBe(b);
  });
});
