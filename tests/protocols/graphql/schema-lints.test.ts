import { buildSchema, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { buildGraphQLCollection } from '../../../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../../../src/lib/protocols/graphql/instrumenter.js';
import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';
import { lintIntrospectionJson } from '../../../src/lib/protocols/graphql/schema-lints.js';

const VALID_SDL = [
  'type Query { user(id: ID!): User plans: [Plan!]! }',
  'type User { id: ID! name: String }',
  'type Plan { id: ID! name: String! }'
].join('\n');

describe('GraphQL schema-static lints', () => {
  it('surfaces validateSchema violations as GQL_SCHEMA_INVALID warnings', () => {
    const sdl = [
      'type Query { a: A }',
      'interface Node { id: ID! }',
      'type A implements Node { name: String }'
    ].join('\n');
    const index = parseGraphQLSchema(sdl);
    expect(index.warnings.some((w) => w.startsWith('GQL_SCHEMA_INVALID:') && w.includes('Node.id'))).toBe(true);
  });

  it('flags SDL that explicitly redefines a built-in scalar', () => {
    const sdl = ['scalar String', 'type Query { a: String }'].join('\n');
    let warnings: string[];
    try {
      warnings = parseGraphQLSchema(sdl).warnings;
    } catch (error) {
      // graphql-js may reject the redefinition outright; either surface is a pass.
      expect(String(error)).toMatch(/GQL_PARSE_FAILED/);
      return;
    }
    expect(warnings.some((w) => w.startsWith('GQL_BUILT_IN_SCALAR_REDEFINED:'))).toBe(true);
  });

  it('flags invalid @specifiedBy URLs on custom scalars', () => {
    const sdl = ['scalar Odd @specifiedBy(url: "not a url")', 'type Query { a: Odd }'].join('\n');
    const index = parseGraphQLSchema(sdl);
    expect(index.warnings.some((w) => w.startsWith('GQL_SPECIFIED_BY_URL_INVALID:') && w.includes('Odd'))).toBe(true);
  });

  it('warns when a generated operation exercises a deprecated root field', () => {
    const sdl = 'type Query { old: String @deprecated(reason: "use fresh") fresh: String }';
    const index = parseGraphQLSchema(sdl);
    expect(index.warnings.some((w) => w.startsWith('GQL_DEPRECATED_FIELD_SELECTED:') && w.includes('query.old'))).toBe(true);
  });

  it('self-checks generated documents against the schema (no violations on a valid schema)', () => {
    const index = parseGraphQLSchema(VALID_SDL);
    expect(index.warnings.filter((w) => w.startsWith('GQL_GENERATED_DOCUMENT_'))).toEqual([]);
  });
});

describe('GraphQL introspection-shape lints', () => {
  function introspectionOf(sdl: string): Record<string, unknown> {
    return JSON.parse(JSON.stringify(introspectionFromSchema(buildSchema(sdl)))) as Record<string, unknown>;
  }

  it('flags duplicate type names', () => {
    const doc = introspectionOf(VALID_SDL) as { __schema: { types: unknown[] } };
    const plan = doc.__schema.types.find((t) => (t as { name?: string }).name === 'Plan');
    doc.__schema.types.push(JSON.parse(JSON.stringify(plan)));
    expect(lintIntrospectionJson(doc).some((w) => w.startsWith('GQL_INTROSPECTION_DUPLICATE_TYPE:') && w.includes('Plan'))).toBe(true);
  });

  it('flags non-boolean isDeprecated and NON_NULL-in-NON_NULL wrappers', () => {
    const doc = introspectionOf(VALID_SDL) as { __schema: { types: Array<{ name?: string; fields?: Array<Record<string, unknown>> }> } };
    const user = doc.__schema.types.find((t) => t.name === 'User');
    const field = user?.fields?.[0] as Record<string, unknown>;
    field.isDeprecated = 'yes';
    field.type = { kind: 'NON_NULL', ofType: { kind: 'NON_NULL', ofType: field.type } };
    const warnings = lintIntrospectionJson(doc);
    expect(warnings.some((w) => w.startsWith('GQL_INTROSPECTION_DEPRECATION_INVALID:'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('GQL_INTROSPECTION_NONNULL_NESTED:'))).toBe(true);
  });

  it('flags unknown directive locations and unknown type kinds', () => {
    const doc = introspectionOf(VALID_SDL) as { __schema: { types: Array<Record<string, unknown>>; directives: Array<Record<string, unknown>> } };
    doc.__schema.directives.push({ name: 'odd', locations: ['EVERYWHERE'], args: [] });
    doc.__schema.types.push({ kind: 'DECORATOR', name: 'Odd' });
    const warnings = lintIntrospectionJson(doc);
    expect(warnings.some((w) => w.startsWith('GQL_INTROSPECTION_DIRECTIVE_INVALID:') && w.includes('@odd'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('GQL_INTROSPECTION_KIND_INVALID:') && w.includes('DECORATOR'))).toBe(true);
  });
});

describe('GraphQL-over-HTTP request/response conformance additions', () => {
  it('sends an Accept header preferring application/graphql-response+json', () => {
    const index = parseGraphQLSchema(VALID_SDL);
    const collection = buildGraphQLCollection(index) as { item: Array<{ request: { header: Array<{ key: string; value: string }> } }> };
    const accept = collection.item[0].request.header.find((h) => h.key === 'Accept');
    expect(accept?.value).toContain('application/graphql-response+json');
    expect(accept?.value).toContain('application/json');
  });

  it('emits the new runtime response-format assertions', () => {
    const index = parseGraphQLSchema(VALID_SDL);
    const collection = buildGraphQLCollection(index);
    const { collection: instrumented } = instrumentGraphQLCollection(collection, index);
    const scripts = JSON.stringify(instrumented);
    expect(scripts).toContain('must declare their media type in a Content-Type header');
    expect(scripts).toContain('request-error results (no data entry) must use a non-2xx status');
    expect(scripts).toContain('must not be an empty list when present');
    expect(scripts).toContain('at most one entry per unique response path');
    expect(scripts).toContain('must be null or a map of root fields');
    expect(scripts).toContain('carries a path (a field error)');
  });
});
