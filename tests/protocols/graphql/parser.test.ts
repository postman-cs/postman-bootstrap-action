import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';

const fixtureSdl = readFileSync(
  resolve(import.meta.dirname, '../../../fixtures/graphql/telecom.graphql'),
  'utf8'
);

describe('parseGraphQLSchema', () => {
  it('parses SDL into a deterministic, sorted operation index', () => {
    const index = parseGraphQLSchema(fixtureSdl, { service: 'Telecom' });
    expect(index.service).toBe('Telecom');
    const ids = index.operations.map((op) => op.id);
    expect(ids).toEqual([
      'query.lineByMsisdn',
      'query.plans',
      'query.subscriber',
      'query.subscribers',
      'mutation.provisionLine',
      'mutation.suspendLine',
      'subscription.lineStatusChanged'
    ]);
  });

  it('classifies return-type wrappers (non-null, list, item non-null)', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const subscribers = index.operations.find((op) => op.id === 'query.subscribers');
    expect(subscribers?.returns).toMatchObject({ name: 'Subscriber', kind: 'object', nonNull: true, list: true, listItemNonNull: true });

    const subscriber = index.operations.find((op) => op.id === 'query.subscriber');
    expect(subscriber?.returns).toMatchObject({ name: 'Subscriber', kind: 'object', nonNull: false, list: false });

    const provision = index.operations.find((op) => op.id === 'mutation.provisionLine');
    expect(provision?.returns).toMatchObject({ name: 'Line', kind: 'object', nonNull: true, list: false });
  });

  it('marks required arguments and sorts them', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const subscriber = index.operations.find((op) => op.id === 'query.subscriber');
    expect(subscriber?.args).toEqual([{ name: 'id', required: true, type: expect.objectContaining({ name: 'ID', nonNull: true }) }]);
    const plans = index.operations.find((op) => op.id === 'query.plans');
    expect(plans?.args).toEqual([]);
  });

  it('captures object shapes with sorted scalar/enum fields', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    const plan = index.objectShapes.Plan;
    expect(plan?.fields.map((f) => f.name)).toEqual(['dataCapGb', 'id', 'monthlyPriceCents', 'name']);
    const idField = plan?.fields.find((f) => f.name === 'id');
    expect(idField?.type).toMatchObject({ name: 'ID', kind: 'scalar', nonNull: true });
  });

  it('warns on subscriptions and union/unknown return types', () => {
    const index = parseGraphQLSchema(fixtureSdl);
    expect(index.warnings.some((w) => w.startsWith('GQL_SUBSCRIPTION_NOT_EXECUTABLE'))).toBe(true);
  });

  it('warns when SDL root operation types are not distinct and includes the root map', () => {
    const index = parseGraphQLSchema(['schema { query: Root mutation: Root }', 'type Root { read: String write: String }'].join('\n'));
    expect(index.warnings.some((w) => w.startsWith('GQL_ROOT_TYPES_NOT_DISTINCT:') && w.includes('Root map: query=Root, mutation=Root'))).toBe(true);
  });

  it('parses an introspection JSON document (buildClientSchema path)', () => {
    const schema = buildSchema(fixtureSdl);
    const introspection = introspectionFromSchema(schema);
    const fromIntrospection = parseGraphQLSchema(JSON.stringify(introspection));
    const fromSdl = parseGraphQLSchema(fixtureSdl);
    expect(fromIntrospection.operations.map((o) => o.id)).toEqual(fromSdl.operations.map((o) => o.id));
  });

  it('parses an introspection result wrapped in a { data: { __schema } } envelope', () => {
    const schema = buildSchema(fixtureSdl);
    const introspection = introspectionFromSchema(schema);
    const enveloped = parseGraphQLSchema(JSON.stringify({ data: introspection }));
    expect(enveloped.operations.length).toBeGreaterThan(0);
  });

  it('surfaces raw built-in directive shape drift when parsing introspection JSON', () => {
    const schema = buildSchema('type Query { a: String }');
    const introspection = JSON.parse(JSON.stringify(introspectionFromSchema(schema))) as { __schema: { directives: Array<Record<string, unknown>> } };
    const skip = introspection.__schema.directives.find((directive) => directive.name === 'skip');
    if (!skip) throw new Error('missing @skip');
    skip.args = [{ name: 'if', type: { kind: 'SCALAR', name: 'String', ofType: null }, defaultValue: null }];

    const index = parseGraphQLSchema(JSON.stringify(introspection));
    expect(
      index.warnings.some((warning) => warning.startsWith('GQL_INTROSPECTION_BUILTIN_DIRECTIVE_SHAPE_DRIFT: @skip argument if must be Boolean!'))
    ).toBe(true);
  });

  it('surfaces introspection root-map diagnostics before buildClientSchema rejects the root map', () => {
    const schema = buildSchema('type Query { a: String }');
    const introspection = introspectionFromSchema(schema) as { __schema: { queryType: { name: string } } };
    introspection.__schema.queryType = { name: 'String' };

    let message = '';
    try {
      parseGraphQLSchema(JSON.stringify(introspection));
    } catch (error) {
      message = String(error);
    }

    expect(message).toMatch(/GQL_INTROSPECTION_ROOT_INVALID: query root operation type String must be an OBJECT type/);
    expect(message).toMatch(/Root map: query=String, mutation=<missing>, subscription=<missing>/);
  });

  it('throws GQL_PARSE_FAILED on empty or unparseable content', () => {
    expect(() => parseGraphQLSchema('')).toThrow(/GQL_PARSE_FAILED/);
    expect(() => parseGraphQLSchema('type Query {')).toThrow(/GQL_PARSE_FAILED/);
    expect(() => parseGraphQLSchema('{ not: "introspection" }')).toThrow(/GQL_PARSE_FAILED/);
  });

  it('throws GQL_NO_EXECUTABLE_OPERATIONS when no root fields exist', () => {
    expect(() => parseGraphQLSchema('type Foo { id: ID }')).toThrow(/GQL_NO_EXECUTABLE_OPERATIONS|GQL_PARSE_FAILED/);
  });
});
