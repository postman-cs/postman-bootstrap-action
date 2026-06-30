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

  it('throws GQL_PARSE_FAILED on empty or unparseable content', () => {
    expect(() => parseGraphQLSchema('')).toThrow(/GQL_PARSE_FAILED/);
    expect(() => parseGraphQLSchema('type Query {')).toThrow(/GQL_PARSE_FAILED/);
    expect(() => parseGraphQLSchema('{ not: "introspection" }')).toThrow(/GQL_PARSE_FAILED/);
  });

  it('throws GQL_NO_EXECUTABLE_OPERATIONS when no root fields exist', () => {
    expect(() => parseGraphQLSchema('type Foo { id: ID }')).toThrow(/GQL_NO_EXECUTABLE_OPERATIONS|GQL_PARSE_FAILED/);
  });
});
