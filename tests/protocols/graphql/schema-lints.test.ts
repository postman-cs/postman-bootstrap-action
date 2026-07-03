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

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function directiveByName(doc: Record<string, unknown>, name: string): Record<string, unknown> {
    const directives = (doc.__schema as { directives?: Array<Record<string, unknown>> }).directives ?? [];
    const directive = directives.find((entry) => entry.name === name);
    if (!directive) throw new Error('missing directive @' + name);
    return directive;
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

  it('flags raw built-in directive shape drift in introspection JSON', () => {
    const doc = introspectionOf(VALID_SDL) as { __schema: { directives: Array<Record<string, unknown>> } };
    directiveByName(doc, 'skip').args = [{ name: 'if', type: { kind: 'SCALAR', name: 'String', ofType: null }, defaultValue: null }];
    directiveByName(doc, 'include').isRepeatable = true;
    directiveByName(doc, 'deprecated').args = [
      {
        name: 'reason',
        type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'String', ofType: null } },
        defaultValue: '"retired"'
      }
    ];
    directiveByName(doc, 'specifiedBy').locations = ['SCALAR', 'FIELD_DEFINITION'];
    doc.__schema.directives = doc.__schema.directives.filter((directive) => directive.name !== 'oneOf');

    const warnings = lintIntrospectionJson(doc);
    expect(
      warnings.some((w) => w.startsWith('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @skip argument if must be Boolean!'))
    ).toBe(true);
    expect(
      warnings.some((w) => w.startsWith('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @include isRepeatable must be false'))
    ).toBe(true);
    expect(
      warnings.some((w) => w.startsWith('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @deprecated argument reason defaultValue must be'))
    ).toBe(true);
    expect(
      warnings.some((w) => w.startsWith('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @specifiedBy declares location FIELD_DEFINITION'))
    ).toBe(true);
    expect(warnings).toContain(
      'GQL_INTROSPECTION_DIRECTIVE_MISSING_BUILTIN: @oneOf is missing from __schema.directives; implementations must support @oneOf (GraphQL spec 3.13)'
    );
  });

  it('flags root-map shape violations with an explicit root map diagnostic', () => {
    const doc = introspectionOf(['type Query { user(id: ID!): User }', 'type Mutation { ping: String }', 'type User { id: ID! }'].join('\n')) as {
      __schema: { queryType?: Record<string, unknown>; mutationType?: Record<string, unknown> };
    };

    const missingQuery = clone(doc);
    delete missingQuery.__schema.queryType;
    expect(
      lintIntrospectionJson(missingQuery).some(
        (w) => w.startsWith('GQL_INTROSPECTION_ROOT_INVALID: __schema.queryType must record') && w.includes('Root map: query=<missing>, mutation=Mutation, subscription=<missing>')
      )
    ).toBe(true);

    const unknownRoot = clone(doc);
    unknownRoot.__schema.queryType = { name: 'Ghost' };
    expect(
      lintIntrospectionJson(unknownRoot).some(
        (w) => w.startsWith('GQL_INTROSPECTION_ROOT_INVALID: query root operation type Ghost must name a type present in __schema.types') && w.includes('Root map: query=Ghost, mutation=Mutation, subscription=<missing>')
      )
    ).toBe(true);

    const scalarRoot = clone(doc);
    scalarRoot.__schema.queryType = { name: 'String' };
    expect(
      lintIntrospectionJson(scalarRoot).some(
        (w) => w.startsWith('GQL_INTROSPECTION_ROOT_INVALID: query root operation type String must be an OBJECT type') && w.includes('Root map: query=String, mutation=Mutation, subscription=<missing>')
      )
    ).toBe(true);

    const duplicateRoots = clone(doc);
    duplicateRoots.__schema.mutationType = { ...(duplicateRoots.__schema.queryType as Record<string, unknown>) };
    expect(
      lintIntrospectionJson(duplicateRoots).some(
        (w) => w.startsWith('GQL_INTROSPECTION_ROOTS_NOT_DISTINCT:') && w.includes('Root map: query=Query, mutation=Query, subscription=<missing>')
      )
    ).toBe(true);
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
    expect(scripts).toContain('request-error results (no data entry) must use a 4xx or 5xx status');
    expect(scripts).toContain('must not be an empty list when present');
    expect(scripts).toContain('at most one entry per unique response path');
    expect(scripts).toContain('must be null or a map of root fields');
    expect(scripts).toContain('carries a path (a field error)');
  });
});
