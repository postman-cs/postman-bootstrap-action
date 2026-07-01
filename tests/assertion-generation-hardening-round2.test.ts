import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { packSchema } from '../src/lib/spec/schema-pack.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { parseOpenApiDocument } from '../src/lib/spec/openapi-loader.js';
import { parseGraphQLSchema } from '../src/lib/protocols/graphql/parser.js';
import { buildGraphQLCollection } from '../src/lib/protocols/graphql/builder.js';
import { instrumentGraphQLCollection } from '../src/lib/protocols/graphql/instrumenter.js';
import { parseWsdl } from '../src/lib/protocols/soap/parser.js';
import { buildSoapCollection } from '../src/lib/protocols/soap/builder.js';
import { instrumentSoapCollection } from '../src/lib/protocols/soap/instrumenter.js';
import { parseProtoSchema } from '../src/lib/protocols/grpc/proto-parser.js';
import { buildGrpcCollection } from '../src/lib/protocols/grpc/grpc-collection-builder.js';
import { instrumentGrpcCollection } from '../src/lib/protocols/grpc/grpc-instrumenter.js';
import { HAS_PROTOBUF, PROTOBUF } from './protocols/grpc/helpers.js';

type JsonRecord = Record<string, unknown>;

// Round-2 regression coverage for the unifusion panel audit (2026-06-30): every
// generated pm.test must be executable and behave correctly on valid AND invalid
// fixtures. This suite RUNS the emitted scripts under a mock Postman sandbox.
//
// Harness note: chai-style assertion chains (`.to.be.an(...)`) are no-ops here, so
// a pm.test is marked failed ONLY when the script calls pm.expect.fail(...). That
// is precisely the fail-closed mechanism every fix below uses, so "no fail across
// all tests" is a clean pass and "a fail fired" is the intended rejection.
function runScript(script: string, response: JsonRecord): Record<string, 'pass' | 'fail'> {
  const results: Record<string, 'pass' | 'fail'> = {};
  const permissive: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'fail' ? (message: string) => { throw new Error(message); } : permissive),
    apply: () => permissive
  });
  const headers = (response.headers as JsonRecord | undefined) ?? {};
  const pm = {
    test: (name: string, cb: () => void) => {
      try { cb(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
    },
    expect: permissive,
    response: {
      code: Number(response.code ?? 0),
      status: response.status,
      responseTime: 1,
      headers: { get: (key: string) => (headers[key] ?? null) },
      text: () => (typeof response.text === 'string' ? response.text : ''),
      json: () => response.json
    },
    request: { method: 'POST', headers: { each: () => undefined }, url: { query: { each: () => undefined } } },
    environment: { get: () => undefined }
  };
  runInContext(script, createContext({ pm }));
  return results;
}

const anyFail = (results: Record<string, 'pass' | 'fail'>): boolean =>
  Object.values(results).some((value) => value === 'fail');

function grpcItems(collection: JsonRecord): JsonRecord[] {
  const out: JsonRecord[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        const record = node as JsonRecord;
        if (record.type === 'grpc-request') out.push(record);
        walk(record.item);
      }
    }
  };
  walk(collection.item);
  return out;
}

function grpcScriptFor(methodSuffix: string): string {
  const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;
  const proto = [
    'syntax = "proto3";',
    'package telecom;',
    'enum Quality { QUALITY_UNKNOWN = 0; ACTIVE = 1; }',
    'message GetReq { string user_id = 1; }',
    'message GetResp { string user_id = 1; repeated string tags = 2; repeated Quality qualities = 3; }',
    'service Svc { rpc Get(GetReq) returns (GetResp); rpc List(GetReq) returns (stream GetResp); }'
  ].join('\n');
  const index = parseProtoSchema(proto, deps);
  const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://h:443', idSeed: 'r2' });
  instrumentGrpcCollection(collection, index);
  const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith(methodSuffix))!;
  const test = (item.event as JsonRecord[]).find((event) => event.listen === 'test')!;
  return ((test.script as JsonRecord).exec as string[]).join('\n');
}

// Defect #4 + #3 (gRPC): repeated scalar/enum elements are validated per-element,
// and fields resolve by ProtoJSON (camelCase json) name.
describe.skipIf(!HAS_PROTOBUF)('gRPC repeated-element + ProtoJSON-name runtime validation', () => {
  it('passes a valid ProtoJSON (camelCase) response', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: ['a'], qualities: ['ACTIVE'] } }))).toBe(false);
  });
  it('fails a repeated scalar element of the wrong type', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [123], qualities: [] } }))).toBe(true);
  });
  it('fails a repeated enum element not in the enum set', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: ['BOGUS'] } }))).toBe(true);
  });
  it('resolves fields by ProtoJSON name: a camelCase field with a wrong type still fails', () => {
    // Without json-name lookup, "userId" would be invisible (proto field is
    // "user_id"), a proto3 singular field, so the type mismatch would be missed.
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 123, tags: [], qualities: [] } }))).toBe(true);
  });
  it('does not false-fail an empty OK server-streaming stream (zero messages)', () => {
    const script = grpcScriptFor('/List');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: null }))).toBe(false);
    expect(script).not.toContain('must return exactly one terminal response message');
    expect(script).not.toContain('must return at least');
  });
});

// Defect #1 (GraphQL): a 200 with data + field errors is legitimate partial
// success and must not false-fail; a 200 with errors and no data is a total
// failure and must fail closed.
describe('GraphQL 200-with-errors partial success vs total failure', () => {
  function pingScript(): string {
    const index = parseGraphQLSchema('type Query { ping: String }', { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const item = collection.item.find((entry) => entry.id === 'query.ping')!;
    return item.event.find((event) => event.listen === 'test')!.script.exec.join('\n');
  }
  it('does not false-fail a legitimate partial success (data + errors)', () => {
    expect(anyFail(runScript(pingScript(), { code: 200, json: { data: { ping: 'ok' }, errors: [{ message: 'deprecated field' }] } }))).toBe(false);
  });
  it('fails a total failure (errors present, no data)', () => {
    expect(anyFail(runScript(pingScript(), { code: 200, json: { data: null, errors: [{ message: 'boom' }] } }))).toBe(true);
  });
});

// Defect (GraphQL): non-null OBJECT/interface sub-fields are presence-asserted,
// not only non-null scalars.
describe('GraphQL non-null composite field presence', () => {
  it('presence-asserts a non-null object sub-field (previously omitted)', () => {
    const sdl = 'type Query { me: User } type User { id: ID! profile: Profile! } type Profile { name: String! }';
    const index = parseGraphQLSchema(sdl, { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const item = collection.item.find((entry) => entry.id === 'query.me')!;
    const exec = item.event.find((event) => event.listen === 'test')!.script.exec.join('\n');
    expect(exec).toContain("User is missing non-null field 'profile'");
    expect(exec).toContain("User is missing non-null field 'id'");
  });
});

// Defect #7 (OpenAPI): a nullable enum/const must accept a legitimate null.
describe('OpenAPI nullable enum/const schema packing', () => {
  it('adds null to a nullable enum that also declares a type', () => {
    const packed = packSchema({}, { type: 'string', enum: ['a', 'b'], nullable: true }, '3.0');
    const schema = packed.schema as JsonRecord;
    expect(schema.enum).toContain(null);
    expect(schema.type).toEqual(expect.arrayContaining(['string', 'null']));
  });
  it('wraps a nullable const so null is accepted', () => {
    const packed = packSchema({}, { const: 'x', nullable: true }, '3.0');
    const schema = packed.schema as JsonRecord;
    const anyOf = schema.anyOf as JsonRecord[] | undefined;
    expect(anyOf, 'nullable const should widen to anyOf(null, const)').toBeDefined();
    expect(anyOf!.some((member) => (member as JsonRecord).type === 'null')).toBe(true);
  });
});

// Defect (SOAP): coverage enforcement - a WSDL operation with no request item
// must throw rather than ship silently unasserted.
describe('SOAP operation coverage enforcement', () => {
  it('throws SOAP_OPERATION_COVERAGE_FAILED when an operation has no request item', () => {
    const wsdl = readFileSync(resolve(import.meta.dirname, '../fixtures/soap/stockquote.wsdl'), 'utf8');
    const index = parseWsdl(wsdl);
    const built = buildSoapCollection(index) as unknown as { item: Array<Record<string, unknown>> };
    const folder = built.item[0] as { item: Array<unknown> };
    folder.item.pop(); // simulate a builder that dropped an operation
    expect(() => instrumentSoapCollection(built as unknown as JsonRecord, index)).toThrow(/SOAP_OPERATION_COVERAGE_FAILED/);
  });
});

// Defect #6 (OpenAPI): a compound path segment emits a visible warning rather
// than silently skipping the path-parameter schema check.
describe('OpenAPI compound path-parameter warning', () => {
  it('emits CONTRACT_PATH_PARAM_COMPOUND_SEGMENT_NOT_VALIDATED', () => {
    const spec = [
      'openapi: 3.0.3',
      "info: { title: t, version: '1.0.0' }",
      'paths:',
      '  /reports/{id}.json:',
      '    get:',
      '      parameters:',
      '        - { name: id, in: path, required: true, schema: { type: string } }',
      '      responses:',
      "        '200': { description: ok }"
    ].join('\n');
    const index = buildContractIndex(parseOpenApiDocument(spec));
    const warnings = [...index.warnings, ...index.operations.flatMap((operation) => operation.warnings)];
    expect(warnings.some((warning) => warning.startsWith('CONTRACT_PATH_PARAM_COMPOUND_SEGMENT_NOT_VALIDATED'))).toBe(true);
  });
});
