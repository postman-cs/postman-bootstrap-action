import { describe, expect, it } from 'vitest';

import { detectSpecType } from '../../src/lib/spec/detect-spec-type.js';

/**
 * Detection is content-first. The load-bearing case is YAML OpenAPI: every
 * OpenAPI YAML document is dense with `type:` / `enum:` mapping keys, and a naive
 * GraphQL-SDL keyword match treats those as type-system definitions and routes a
 * valid OpenAPI spec down the GraphQL multi-protocol path (it then dies with
 * `GQL_PARSE_FAILED: Unexpected Name "openapi"`). These tests pin that YAML
 * OpenAPI classifies as `openapi` while genuine GraphQL SDL still classifies as
 * `graphql`.
 */
describe('detectSpecType', () => {
  it('classifies YAML OpenAPI as openapi despite type:/enum: mapping keys', () => {
    const yaml = [
      'openapi: 3.0.3',
      'info:',
      '  title: Telecom Service Experience API',
      '  version: 1.0.0',
      'components:',
      '  schemas:',
      '    Customer:',
      '      type: object',
      '      properties:',
      '        status:',
      '          type: string',
      '          enum:',
      '            - active',
      '            - suspended'
    ].join('\n');
    expect(detectSpecType(yaml, 'openapi.yaml')).toBe('openapi');
  });

  it('classifies YAML OpenAPI as openapi even with no filename hint', () => {
    const yaml = 'openapi: 3.1.0\npaths:\n  /x:\n    get:\n      responses:\n        "200":\n          description: ok\n          content:\n            application/json:\n              schema:\n                type: array';
    expect(detectSpecType(yaml)).toBe('openapi');
  });

  it('classifies a genuine GraphQL SDL document as graphql', () => {
    const sdl = [
      'type Query {',
      '  customer(id: ID!): Customer',
      '}',
      '',
      'type Customer {',
      '  id: ID!',
      '  status: Status!',
      '}',
      '',
      'enum Status {',
      '  ACTIVE',
      '  SUSPENDED',
      '}'
    ].join('\n');
    expect(detectSpecType(sdl)).toBe('graphql');
  });

  it('classifies GraphQL with leading docstring and schema block as graphql', () => {
    const sdl = '"""Root schema."""\nschema {\n  query: Query\n}\ntype Query { ping: String }';
    expect(detectSpecType(sdl)).toBe('graphql');
  });

  it('classifies GraphQL introspection JSON as graphql', () => {
    const json = JSON.stringify({ data: { __schema: { types: [] } } });
    expect(detectSpecType(json)).toBe('graphql');
  });

  it('classifies JSON OpenAPI as openapi', () => {
    expect(detectSpecType(JSON.stringify({ openapi: '3.0.0', info: {}, paths: {} }))).toBe('openapi');
  });

  it('honours unambiguous extension hints', () => {
    expect(detectSpecType('type Query { x: Int }', 'schema.graphql')).toBe('graphql');
    expect(detectSpecType('syntax = "proto3";', 'service.proto')).toBe('grpc');
  });

  it('classifies proto and WSDL by content', () => {
    expect(detectSpecType('syntax = "proto3";\nservice S { rpc Do (Req) returns (Res); }')).toBe('grpc');
    expect(
      detectSpecType('<?xml version="1.0"?>\n<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"></definitions>')
    ).toBe('soap');
  });
});
