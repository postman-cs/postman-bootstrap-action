import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';
import { buildGraphQLCollection } from '../../../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../../../src/lib/protocols/graphql/instrumenter.js';

const fixtureSdl = readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/graphql/telecom.graphql'),
  'utf8'
);

type Item = {
  id: string;
  request: { body: { mode: string } };
  event: Array<{ listen: string; script: { exec: string[] } }>;
};

function buildInstrumented() {
  const index = parseGraphQLSchema(fixtureSdl, { service: 'Telecom' });
  const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
  return { index, ...instrumentGraphQLCollection(collection, index) };
}

function execFor(collection: { item: Item[] }, id: string): string {
  const item = collection.item.find((c) => c.id === id)!;
  const event = item.event.find((e) => e.listen === 'test')!;
  return event.script.exec.join('\n');
}

describe('instrumentGraphQLCollection', () => {
  it('injects one test script per graphql http item', () => {
    const { collection } = buildInstrumented();
    for (const item of (collection as unknown as { item: Item[] }).item) {
      const after = item.event.filter((e) => e.listen === 'test');
      expect(after).toHaveLength(1);
      expect(after[0]!.script.exec.join('\n')).toContain('pm.test(');
    }
  });

  it('asserts errors absent and data.<rootField> presence via parsed JSON body', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscribers');
    expect(exec).toContain('GraphQL errors are well-formed and not a total failure');
    expect(exec).toContain('pm.response.json()');
    expect(exec).toContain('gqlBody.errors');
    expect(exec).toContain('data.subscribers is present');
    expect(exec).toContain('to.have.property("subscribers")');
  });

  it('asserts non-null return cannot be null', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscribers');
    expect(exec).toContain('declared non-null but was null');
  });

  it('asserts list-ness and element object shape with required scalar fields', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.plans');
    expect(exec).toContain('expected a list');
    expect(exec).toContain('to.be.an("array")');
    // Plan has non-null scalar fields id, monthlyPriceCents, name.
    expect(exec).toContain("is missing non-null field 'id'");
    expect(exec).toContain("is missing non-null field 'name'");
  });

  it('asserts required variables were supplied for operations with required args', () => {
    const { collection } = buildInstrumented();
    const exec = execFor(collection as unknown as { item: Item[] }, 'query.subscriber');
    expect(exec).toContain('required variables are supplied');
    expect(exec).toContain('["id"]');
    // plans has no required args -> no variable assertion.
    const plansExec = execFor(collection as unknown as { item: Item[] }, 'query.plans');
    expect(plansExec).not.toContain('required variables are supplied');
  });

  it('warns on subscriptions (non-executable) and custom scalars', () => {
    const { warnings } = buildInstrumented();
    expect(warnings.some((w) => w.startsWith('GQL_SUBSCRIPTION'))).toBe(true);
  });

  it('throws GQL_OPERATION_COVERAGE_FAILED when an item is missing', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }) as unknown as { item: unknown[] };
    collection.item = collection.item.slice(0, 1);
    expect(() => instrumentGraphQLCollection(collection as Record<string, unknown>, index)).toThrow(/GQL_OPERATION_COVERAGE_FAILED/);
  });

  it('warns PROTO_ITEM_UNMATCHED for an extra graphql http item', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' }) as unknown as { item: Array<Record<string, unknown>> };
    collection.item.push({ id: 'query.bogus', name: 'query bogus', request: { method: 'POST', body: { mode: 'graphql', graphql: { query: '', variables: '' } } }, event: [] });
    const { warnings } = instrumentGraphQLCollection(collection as Record<string, unknown>, index);
    expect(warnings.some((w) => w.startsWith('PROTO_ITEM_UNMATCHED'))).toBe(true);
  });

  it('matches the golden snapshot of generated assertions', () => {
    const { collection } = buildInstrumented();
    const scripts = (collection as unknown as { item: Item[] }).item.map((item) => ({
      id: item.id,
      exec: item.event.find((e) => e.listen === 'test')!.script.exec.join('\n')
    }));
    expect(scripts).toMatchSnapshot();
  });

  it('produces a fully deterministic instrumented collection', () => {
    const a = JSON.stringify(buildInstrumented().collection);
    const b = JSON.stringify(buildInstrumented().collection);
    expect(a).toBe(b);
  });
});

describe('Relay connection selection expansion and runtime assertions', () => {
  const relaySdl = "type Query {\n  users(first: Int, after: String): UserConnection!\n}\ntype UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! totalCount: Int }\ntype UserEdge { node: User! cursor: String! }\ntype User { id: ID! name: String! }\ntype PageInfo { hasNextPage: Boolean! hasPreviousPage: Boolean! startCursor: String endCursor: String }\n";

  function relayCollection() {
    const index = parseGraphQLSchema(relaySdl, { service: 'Relay' });
    const collection = buildGraphQLCollection(index, { url: '{{baseUrl}}/graphql' });
    instrumentGraphQLCollection(collection, index);
    return collection as unknown as { item: Item[] };
  }

  it('expands connection fields past the depth cap: pageInfo leaves and edges { cursor }', () => {
    const item = relayCollection().item.find((entry) => entry.id === 'query.users')!;
    const body = (item.request.body as unknown as { graphql: { query: string } }).graphql;
    expect(body.query).toContain('pageInfo');
    expect(body.query).toContain('hasNextPage');
    expect(body.query).toContain('hasPreviousPage');
    expect(body.query).toContain('endCursor');
    expect(body.query).toContain('edges');
    expect(body.query).toContain('cursor');
    // node is intentionally not selected: the Relay expansion is bounded.
    expect(body.query).not.toContain('node');
  });

  it('asserts the selected Relay contract at runtime through the shared selection', () => {
    const collection = relayCollection();
    const exec = execFor(collection, 'query.users');
    expect(exec).toContain('pageInfo');
    expect(exec).toContain('hasNextPage');
    expect(exec).toContain('cursor');
    // pageInfo is non-null in this schema, so its absence must fail closed.
    expect(exec).toContain("missing non-null field 'pageInfo'");
  });
});

describe('deprecated argument/input-field edition-drift lint', () => {
  const deprecatedSdl = "type Query {\n  search(term: String @deprecated(reason: \"use query\"), query: String! @deprecated(reason: \"bad idea\"), limit: Int): [String!]\n}\ninput Filter { legacy: String @deprecated(reason: \"old\"), mode: String! @deprecated(reason: \"required but deprecated\") }\ntype Mutation { run(filter: Filter): Boolean }\n";

  it('flags @deprecated on arguments and input fields as edition drift, and required ones as violations', () => {
    const index = parseGraphQLSchema(deprecatedSdl, { service: 'Drift' });
    const drift = index.warnings.filter((warning) => warning.startsWith('GQL_DEPRECATED_INPUT_EDITION_DRIFT'));
    const required = index.warnings.filter((warning) => warning.startsWith('GQL_DEPRECATED_REQUIRED_INPUT'));
    expect(drift.some((warning) => warning.includes('Query.search.term'))).toBe(true);
    expect(drift.some((warning) => warning.includes('Filter.legacy'))).toBe(true);
    expect(required.some((warning) => warning.includes('Query.search.query'))).toBe(true);
    expect(required.some((warning) => warning.includes('Filter.mode'))).toBe(true);
    expect(required.some((warning) => warning.includes('.term'))).toBe(false);
    expect(required.some((warning) => warning.includes('legacy'))).toBe(false);
  });
});
