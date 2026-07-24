import { describe, expect, it } from 'vitest';

import { detectSpecType } from '../../src/lib/spec/detect-spec-type.js';

/**
 * Content-first detection must key off ROOT-DOCUMENT structure, not on prose that
 * happens to appear anywhere in the file. A real customer OpenAPI document
 * routinely contains description prose or embedded examples whose lines begin with
 * a GraphQL SDL keyword ("enum Values are ...", "type Name is ...") or a
 * Protobuf service block. Those documents declare `openapi: 3.x` at the root and
 * must classify as `openapi`; misclassifying routes a valid OpenAPI spec into the
 * GraphQL/gRPC protocol builder, which dies with GQL_PARSE_FAILED far downstream.
 */
describe('detectSpecType root-key precedence over embedded prose', () => {
  it('classifies OpenAPI YAML whose description prose starts a line with "enum Values"', () => {
    const yaml = [
      'openapi: 3.1.0',
      'info:',
      '  title: Inventory API',
      '  version: "1.4.2"',
      'paths:',
      '  /items:',
      '    get:',
      '      parameters:',
      '        - name: status',
      '          in: query',
      '          description: |',
      '            Filter by lifecycle status.',
      '            enum Values are ACTIVE, ARCHIVED and PENDING.',
      '          schema:',
      '            type: string',
      '      responses:',
      '        "200":',
      '          description: OK'
    ].join('\n');
    expect(detectSpecType(yaml, 'openapi.yaml')).toBe('openapi');
    expect(detectSpecType(yaml)).toBe('openapi');
  });

  it('classifies OpenAPI YAML whose description prose starts a line with "type Name"', () => {
    const yaml = [
      'openapi: 3.0.3',
      'info: { title: T, version: "1" }',
      'paths:',
      '  /x:',
      '    get:',
      '      description: |',
      '        Returns the record.',
      '        type Name is returned verbatim.',
      '      responses: { "200": { description: OK } }'
    ].join('\n');
    expect(detectSpecType(yaml, 'openapi.yaml')).toBe('openapi');
  });

  it('classifies OpenAPI YAML that embeds a GraphQL SDL example in a description', () => {
    const yaml = [
      'openapi: 3.1.0',
      'info: { title: Gateway, version: "2" }',
      'paths:',
      '  /graphql:',
      '    post:',
      '      description: |',
      '        Proxies GraphQL. Example schema:',
      '        type Query { user(id: ID!): User }',
      '      responses: { "200": { description: OK } }'
    ].join('\n');
    expect(detectSpecType(yaml, 'openapi.yaml')).toBe('openapi');
  });

  it('classifies OpenAPI YAML that embeds a gRPC service block in a description', () => {
    const yaml = [
      'openapi: 3.1.0',
      'info: { title: T, version: "1" }',
      'paths:',
      '  /x:',
      '    get:',
      '      description: |',
      '        Mirrors our internal gRPC surface:',
      '        service Inventory {',
      '          rpc GetItem (Req) returns (Res);',
      '        }',
      '      responses: { "200": { description: OK } }'
    ].join('\n');
    expect(detectSpecType(yaml, 'openapi.yaml')).toBe('openapi');
  });

  it('classifies AsyncAPI YAML whose channel prose starts a line with "enum Values"', () => {
    const yaml = [
      'asyncapi: 3.0.0',
      'info: { title: Events, version: "1" }',
      'channels:',
      '  userSignedUp:',
      '    description: |',
      '      Emitted on signup.',
      '      enum Values are NEW and RETURNING.'
    ].join('\n');
    expect(detectSpecType(yaml, 'events.yaml')).toBe('asyncapi');
  });

  it('does not let an "asyncapi" filename hint override an OpenAPI root key', () => {
    const yaml = 'openapi: 3.1.0\ninfo: { title: T, version: "1" }\npaths: {}\n';
    expect(detectSpecType(yaml, 'asyncapi-migration.yaml')).toBe('openapi');
    const json = JSON.stringify({ openapi: '3.1.0', info: { title: 'T', version: '1' }, paths: {} });
    expect(detectSpecType(json, 'asyncapi-migration.json')).toBe('openapi');
  });

  it('still classifies genuine SDL, proto, and AsyncAPI documents by content', () => {
    expect(detectSpecType('type Query { hello: String }')).toBe('graphql');
    expect(detectSpecType('enum Status { ACTIVE }\ntype Query { s: Status }')).toBe('graphql');
    expect(detectSpecType('syntax = "proto3";\nservice S { rpc Do (Req) returns (Res); }')).toBe('grpc');
    expect(detectSpecType('asyncapi: 3.0.0\ninfo: { title: E, version: "1" }\nchannels: {}\n')).toBe('asyncapi');
  });
});
