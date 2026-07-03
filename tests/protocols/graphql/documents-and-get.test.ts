import { parse } from 'graphql';
import { describe, expect, it } from 'vitest';

import { buildGraphQLCollection, buildOperationDocument, buildVariablesJson, GRAPHQL_PROBE_IDS } from '../../../src/lib/protocols/graphql/builder.js';
import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';

const SDL = [
  'type Query { user(id: ID!): User old: String @deprecated(reason: "gone") }',
  'type Mutation { addPlan(name: String!): Plan }',
  'type User { id: ID! legacy: String @deprecated(reason: "old field") }',
  'type Plan { id: ID! name: String! }'
].join('\n');

describe('GraphQL generation documents-static (graphql_generation_documents_static)', () => {
  const index = parseGraphQLSchema(SDL);

  it('row 1/6/7: every generated operation document is a single named operation with no operationName ambiguity', () => {
    for (const op of index.operations) {
      const doc = buildOperationDocument(op, index);
      const ast = parse(doc);
      const operations = ast.definitions.filter((d) => d.kind === 'OperationDefinition');
      expect(operations.length).toBe(1);
      expect((operations[0] as { name?: { value: string } }).name?.value).toBeTruthy();
    }
  });

  it('row 35: generated variable values are Postman placeholders (no concrete coercion needed)', () => {
    const withArgs = index.operations.find((o) => o.args.some((a) => a.required));
    expect(withArgs).toBeTruthy();
    const vars = JSON.parse(buildVariablesJson(withArgs!)) as Record<string, string>;
    for (const value of Object.values(vars)) expect(value).toMatch(/^\{\{.+\}\}$/);
  });

  it('row 36: warns on a deprecated nested field the generated document selects', () => {
    expect(index.warnings.some((w) => w.startsWith('GQL_DEPRECATED_FIELD_SELECTED:') && w.includes('User.legacy'))).toBe(true);
  });

  it('row 23: oneOf sample/default gate + schema validation cover input literal/default types', () => {
    const bad = parseGraphQLSchema(['input F @oneOf { a: String! }', 'type Query { s(f: F): String }'].join('\n')).warnings;
    expect(bad.some((w) => w.startsWith('GQL_ONE_OF_FIELD_NON_NULL:'))).toBe(true);
  });
});

describe('GraphQL-over-HTTP GET discipline (graphql_runtime_over_http GET rows 10-15)', () => {
  const index = parseGraphQLSchema(SDL);
  interface GraphQLTestItem {
    id?: string;
    request: {
      method: string;
      body?: unknown;
      url: { raw?: string; query?: Array<{ key: string; value?: string }> };
    };
  }
  const collection = buildGraphQLCollection(index) as { item: GraphQLTestItem[] };
  const getItems = collection.item.filter((it) => it.request?.method === 'GET');

  it('row 14: emits a GET mutation-rejection probe', () => {
    const probe = collection.item.find((it) => it.id === GRAPHQL_PROBE_IDS.getMutation);
    expect(probe).toBeTruthy();
    expect(probe!.request.method).toBe('GET');
  });

  it('rows 10/11/15: every generated GET item carries the query in the URL (no body), non-empty, percent-encoded', () => {
    expect(getItems.length).toBeGreaterThan(0);
    for (const it of getItems) {
      expect(it.request.body).toBeUndefined();
      const q = (it.request.url.query as Array<{ key: string; value: string }>).find((p) => p.key === 'query');
      expect(q && q.value.length > 0).toBe(true);
      expect(String(it.request.url.raw)).toContain('?query=');
      expect(String(it.request.url.raw)).toContain('%20');
    }
  });

  it('rows 12/13: no generated GET item carries variables/extensions/operationName (POST-only operation generation)', () => {
    for (const it of getItems) {
      const query = (it.request.url.query as Array<{ key: string }>).map((p) => p.key);
      expect(query).not.toContain('variables');
      expect(query).not.toContain('extensions');
      expect(query).not.toContain('operationName');
    }
  });
});
