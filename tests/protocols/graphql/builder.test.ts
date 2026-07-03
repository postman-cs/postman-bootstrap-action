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

  const operationItems = collection.item.filter((c) => !c.id.startsWith('__gql_probe_'));
  const probeItems = collection.item.filter((c) => c.id.startsWith('__gql_probe_'));

  it('appends transport/consistency probe items after the operation items', () => {
    expect(probeItems.map((c) => c.id)).toEqual([
      '__gql_probe_introspection_drift',
      '__gql_probe_invalid_document',
      '__gql_probe_malformed_json',
      '__gql_probe_get_mutation'
    ]);
    const getProbe = probeItems.find((c) => c.id === '__gql_probe_get_mutation')!;
    expect(getProbe.request.method).toBe('GET');
    expect(String(getProbe.request.url.raw)).toContain('query=');
    const malformed = probeItems.find((c) => c.id === '__gql_probe_malformed_json')! as unknown as { request: { body: { mode: string; raw: string } } };
    expect(malformed.request.body.mode).toBe('raw');
    expect(() => JSON.parse(malformed.request.body.raw)).toThrow();
  });

  it('emits a v2.1.0 collection with one http graphql item per operation in index order', () => {
    expect(collection.info.schema).toBe(COLLECTION_V210_SCHEMA);
    expect(operationItems.map((c) => c.id)).toEqual(index.operations.map((o) => o.id));
    for (const item of operationItems) {
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

  it('emits unquoted placeholders for input-object typed variables', () => {
    const provisionLine = index.operations.find((o) => o.id === 'mutation.provisionLine')!;
    const vars = buildVariablesJson(provisionLine);
    expect(vars).toBe('{"input":{{provisionLine_input}}}');
    const substituted = vars.replace('{{provisionLine_input}}', '{"subscriberId":"sub-1","planId":"plan-1","msisdn":"+15551230009"}');
    const parsed = JSON.parse(substituted) as { input: Record<string, string> };
    expect(parsed.input.subscriberId).toBe('sub-1');
  });

  it('emits unquoted placeholders for Int/Float/Boolean scalar variables', () => {
    const sdl = 'type Query { a(n: Int!): String b(f: Float!): String c(flag: Boolean!): String s(id: ID!): String t(v: String!): String }';
    const idx = parseGraphQLSchema(sdl, { service: 'Scalars' });
    const n = idx.operations.find((o) => o.field === 'a')!;
    const f = idx.operations.find((o) => o.field === 'b')!;
    const flag = idx.operations.find((o) => o.field === 'c')!;
    const id = idx.operations.find((o) => o.field === 's')!;
    const str = idx.operations.find((o) => o.field === 't')!;
    expect(buildVariablesJson(n)).toBe('{"n":{{a_n}}}');
    expect(buildVariablesJson(f)).toBe('{"f":{{b_f}}}');
    expect(buildVariablesJson(flag)).toBe('{"flag":{{c_flag}}}');
    expect(buildVariablesJson(id)).toBe(JSON.stringify({ id: '{{s_id}}' }));
    expect(buildVariablesJson(str)).toBe(JSON.stringify({ v: '{{t_v}}' }));
  });

  it('emits unquoted placeholders for list-typed variables', () => {
    const sdl = 'type Query { items(ids: [ID!]!): String }';
    const idx = parseGraphQLSchema(sdl, { service: 'Lists' });
    const op = idx.operations.find((o) => o.field === 'items')!;
    const vars = buildVariablesJson(op);
    expect(vars).toBe('{"ids":{{items_ids}}}');
    const substituted = vars.replace('{{items_ids}}', '["a","b"]');
    expect(JSON.parse(substituted).ids).toEqual(['a', 'b']);
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
