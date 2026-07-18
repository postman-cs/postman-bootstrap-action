import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { packSchema } from '../src/lib/spec/schema-pack.js';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { createContractScript } from '../src/lib/spec/collection-contracts.js';
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

// Round-2/3 regression coverage for the unifusion panel audit: every generated
// pm.test must be executable and behave correctly on valid AND invalid fixtures.
// This suite RUNS the emitted scripts under a mock Postman sandbox whose pm.expect
// is a STRICT Chai-equivalent (the panel's "real Chai or a strict assertion mock"
// requirement): every assertion chain is EVALUATED and throws on failure -- it is
// not a no-op. So a green test proves the generated assertion passes on valid data
// and a red test proves it fails closed on invalid data.
interface Chainable {
  to: Chainable; be: Chainable; been: Chainable; is: Chainable; that: Chainable;
  which: Chainable; and: Chainable; has: Chainable; have: Chainable; with: Chainable;
  of: Chainable; not: Chainable;
  exist: Chainable; ok: Chainable; null: Chainable; true: Chainable; false: Chainable; empty: Chainable;
  a(t: string): Chainable; an(t: string): Chainable;
  below(n: number): Chainable; above(n: number): Chainable; least(n: number): Chainable; most(n: number): Chainable;
  within(a: number, b: number): Chainable;
  equal(v: unknown): Chainable; eq(v: unknown): Chainable; eql(v: unknown): Chainable;
  oneOf(arr: unknown[]): Chainable; property(name: string): Chainable;
  match(re: RegExp): Chainable; include(v: unknown): Chainable; contain(v: unknown): Chainable;
}

type StrictExpect = ((subject: unknown, message?: string) => Chainable) & { fail: (message?: string) => never };

function makeStrictExpect(): StrictExpect {
  const chaiTypeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const deepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  };
  const includes = (subject: unknown, v: unknown): boolean =>
    typeof subject === 'string' ? subject.indexOf(String(v)) !== -1 : Array.isArray(subject) && subject.indexOf(v) !== -1;
  const sizeOf = (subject: unknown): number => {
    if (Array.isArray(subject) || typeof subject === 'string') return (subject as string).length;
    if (subject && typeof subject === 'object') return Object.keys(subject as object).length;
    return -1;
  };
  const expect = (subject: unknown, message?: string): Chainable => {
    let negate = false;
    const prefix = message ? message + ': ' : '';
    const check = (ok: boolean, why: string): Chainable => {
      if (negate ? ok : !ok) throw new Error(prefix + why);
      return chain;
    };
    const chain: Chainable = {
      get to() { return chain; },
      get be() { return chain; },
      get been() { return chain; },
      get is() { return chain; },
      get that() { return chain; },
      get which() { return chain; },
      get and() { return chain; },
      get has() { return chain; },
      get have() { return chain; },
      get with() { return chain; },
      get of() { return chain; },
      get not() { negate = !negate; return chain; },
      get exist() { return check(subject !== null && subject !== undefined, 'expected value to exist'); },
      get ok() { return check(Boolean(subject), 'expected value to be truthy'); },
      get null() { return check(subject === null, 'expected value to be null'); },
      get true() { return check(subject === true, 'expected value to be true'); },
      get false() { return check(subject === false, 'expected value to be false'); },
      get empty() { return check(sizeOf(subject) === 0, 'expected value to be empty'); },
      a: (t: string) => check(chaiTypeOf(subject) === t, 'expected a ' + t + ' but got ' + chaiTypeOf(subject)),
      an: (t: string) => check(chaiTypeOf(subject) === t, 'expected an ' + t + ' but got ' + chaiTypeOf(subject)),
      below: (n: number) => check(typeof subject === 'number' && subject < n, 'expected below ' + n),
      above: (n: number) => check(typeof subject === 'number' && subject > n, 'expected above ' + n),
      least: (n: number) => check(typeof subject === 'number' && subject >= n, 'expected at least ' + n),
      most: (n: number) => check(typeof subject === 'number' && subject <= n, 'expected at most ' + n),
      within: (a: number, b: number) => check(typeof subject === 'number' && subject >= a && subject <= b, 'expected within ' + a + '..' + b),
      equal: (v: unknown) => check(subject === v, 'expected to equal ' + String(v)),
      eq: (v: unknown) => check(subject === v, 'expected to equal ' + String(v)),
      eql: (v: unknown) => check(deepEqual(subject, v), 'expected to deep-equal ' + JSON.stringify(v)),
      oneOf: (arr: unknown[]) => check(Array.isArray(arr) && arr.indexOf(subject) !== -1, 'expected one of ' + JSON.stringify(arr)),
      property: (name: string) => check(subject !== null && subject !== undefined && Object.prototype.hasOwnProperty.call(subject, name), "expected property '" + name + "'"),
      match: (re: RegExp) => check(typeof subject === 'string' && re.test(subject), 'expected to match ' + String(re)),
      include: (v: unknown) => check(includes(subject, v), 'expected to include ' + String(v)),
      contain: (v: unknown) => check(includes(subject, v), 'expected to include ' + String(v))
    };
    return chain;
  };
  (expect as StrictExpect).fail = (message?: string): never => { throw new Error(message ?? 'pm.expect.fail'); };
  return expect as StrictExpect;
}

function runScript(script: string, response: JsonRecord): Record<string, 'pass' | 'fail'> {
  const results: Record<string, 'pass' | 'fail'> = {};
  const headers = (response.headers as JsonRecord | undefined) ?? {};
  const pm = {
    test: (name: string, cb: () => void) => {
      try { cb(); results[name] = 'pass'; } catch { results[name] = 'fail'; }
    },
    expect: makeStrictExpect(),
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

describe('OpenAPI response content omission semantics', () => {
  function indexFor(operationLines: string[]): ReturnType<typeof buildContractIndex> {
    return buildContractIndex(parseOpenApiDocument([
      'openapi: 3.0.3',
      "info: { title: Response contract, version: '1.0.0' }",
      'paths:',
      '  /health:',
      ...operationLines.map((line) => `    ${line}`)
    ].join('\n')));
  }

  function runAwsRouteOnlyResponse(): Record<string, 'pass' | 'fail'> {
    const index = indexFor([
      'post:',
      '  responses:',
      '    default:',
      '      description: Default response'
    ]);
    const script = createContractScript(index.operations[0]!).join('\n');
    return runScript(script, {
      code: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '15' },
      text: '{"status":"ok"}',
      json: { status: 'ok' }
    });
  }

  it('does not treat an AWS-style default response without content as an empty-body contract', () => {
    const results = runAwsRouteOnlyResponse();
    expect(results['Response body matches OpenAPI body contract']).toBe('pass');
  });

  it('does not require zero Content-Length for an AWS-style default response without content', () => {
    const results = runAwsRouteOnlyResponse();
    expect(results['Content-Length is consistent with OpenAPI body expectations']).toBe('pass');
  });

  it('indexes omitted and empty content as unknown and warns without constraining body presence', () => {
    for (const responseLines of [
      ['    default:', '      description: Default response'],
      ["    '200':", '      description: OK', '      content: {}']
    ]) {
      const index = indexFor(['post:', '  responses:', ...responseLines]);
      const operation = index.operations[0]!;
      const response = operation.responses.default ?? operation.responses['200']!;
      expect(response.bodyExpectation).toBe('unknown');
      expect(operation.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('CONTRACT_RESPONSE_BODY_UNDOCUMENTED:')
      ]));
      const script = createContractScript(operation).join('\n');
      expect(runScript(script, { code: 200, text: '', json: undefined })['Response body matches OpenAPI body contract']).toBe('pass');
      expect(runScript(script, { code: 200, text: '{"status":"ok"}', json: { status: 'ok' } })['Response body matches OpenAPI body contract']).toBe('pass');
    }
  });

  it('keeps media-declared responses strict while warning when their schema is absent', () => {
    const index = indexFor([
      'post:',
      '  responses:',
      "    '200':",
      '      description: OK',
      '      content:',
      '        application/json: {}'
    ]);
    const operation = index.operations[0]!;
    expect(operation.responses['200']?.bodyExpectation).toBe('declared');
    expect(operation.warnings).toContain(
      'CONTRACT_RESPONSE_SCHEMA_UNDOCUMENTED: response application/json on POST /health status 200 declares no schema; body shape is not validated'
    );
    const script = createContractScript(operation).join('\n');
    const valid = runScript(script, {
      code: 200,
      headers: { 'Content-Type': 'application/json' },
      text: '{"status":"ok"}',
      json: { status: 'ok' }
    });
    const empty = runScript(script, {
      code: 200,
      headers: { 'Content-Type': 'application/json' },
      text: '',
      json: undefined
    });
    expect(valid['Response body matches OpenAPI body contract']).toBe('pass');
    expect(valid['Content-Type matches OpenAPI response content']).toBe('pass');
    expect(valid['Response body matches OpenAPI schema']).toBe('pass');
    expect(empty['Response body matches OpenAPI body contract']).toBe('fail');
  });

  it('warns when declared request media has no schema', () => {
    const index = indexFor([
      'post:',
      '  requestBody:',
      '    content:',
      '      application/json: {}',
      '  responses:',
      "    '204': { description: No content }"
    ]);
    expect(index.operations[0]!.warnings).toContain(
      'CONTRACT_REQUEST_SCHEMA_UNDOCUMENTED: request body application/json on POST /health declares no schema; generated request payload shape is not validated'
    );
  });

  it.each([199, 204, 205, 304])('rejects carried bytes for runtime bodyless status %i', (code) => {
    const index = indexFor([
      'post:',
      '  responses:',
      '    default: { description: Default response }'
    ]);
    const script = createContractScript(index.operations[0]!).join('\n');
    const results = runScript(script, { code, text: ' ', json: undefined });
    expect(results['Response body matches OpenAPI body contract']).toBe('fail');
  });

  it('rejects carried bytes for HEAD even when a default response is selected', () => {
    const index = indexFor([
      'head:',
      '  responses:',
      '    default: { description: Default response }'
    ]);
    expect(index.operations[0]!.responses.default?.bodyExpectation).toBe('forbidden');
    const script = createContractScript(index.operations[0]!).join('\n');
    expect(runScript(script, { code: 200, text: 'x', json: undefined })['Response body matches OpenAPI body contract']).toBe('fail');
  });

  it('keeps exact response precedence over a schema-less range and default', () => {
    const index = indexFor([
      'post:',
      '  responses:',
      "    '200':",
      '      description: Exact',
      '      content:',
      '        application/json: {}',
      "    '2XX': { description: Range }",
      '    default: { description: Default response }'
    ]);
    const script = createContractScript(index.operations[0]!).join('\n');
    const results = runScript(script, {
      code: 200,
      headers: { 'Content-Type': 'application/json' },
      text: '',
      json: undefined
    });
    expect(results['Response body matches OpenAPI body contract']).toBe('fail');
  });

  it('still rejects a mismatched Content-Length for an unknown response body', () => {
    const index = indexFor([
      'post:',
      '  responses:',
      '    default: { description: Default response }'
    ]);
    const script = createContractScript(index.operations[0]!).join('\n');
    const results = runScript(script, {
      code: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '14' },
      text: '{"status":"ok"}',
      json: { status: 'ok' }
    });
    expect(results['Content-Length is consistent with OpenAPI body expectations']).toBe('fail');
  });
});

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
    'message GetResp { string user_id = 1; repeated string tags = 2; repeated Quality qualities = 3; double lat = 4; int32 count = 5; map<string, Quality> tag_quality = 6; google.protobuf.Timestamp occurred_at = 7; google.protobuf.Duration ttl = 8; google.protobuf.FieldMask mask = 9; bytes payload = 10; Quality state = 11; map<int64, string> id_names = 12; map<uint32, string> u_names = 13; int64 big = 14; float fl = 15; }',
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
  it('accepts ProtoJSON numeric-string encodings (numbers-as-strings, NaN/Infinity doubles)', () => {
    // proto3-JSON encodes some numerics as strings and non-finite doubles as
    // "NaN"/"Infinity"; those must NOT false-fail a numeric/double field.
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], count: '7', lat: 'NaN' } }))).toBe(false);
  });
  it('fails a non-numeric string in a numeric field', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], count: 'abc' } }))).toBe(true);
  });
  it('accepts exponent and zero-fraction numeric-string double spellings', () => {
    // ProtoJSON allows "1e2" and "1.0"; the old canonical round-trip guard wrongly
    // rejected both. A double field must accept every finite JSON-number spelling.
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], lat: '1e2' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], lat: '1.0' } }))).toBe(false);
  });
  it('accepts an integral numeric-string (exponent/zero-fraction) for an int32 field', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], count: '1e2' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], count: '1.0' } }))).toBe(false);
  });
  it('fails a fractional value (string or number) for an integer field', () => {
    // int32 is integral; a fractional spelling must fail closed, not pass as a generic number.
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], count: '1.5' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], count: 1.5 } }))).toBe(true);
  });
  it('enforces enum membership on map<string, enum> values', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], tagQuality: { a: 'ACTIVE' } } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], tagQuality: { a: 'BOGUS' } } }))).toBe(true);
  });
  it('validates ProtoJSON lexical formats for WKT strings and bytes', () => {
    const script = grpcScriptFor('/Get');
    const base = { userId: 'u1', tags: [], qualities: [], occurredAt: '2025-01-27T11:42:15.689823456+01:00', ttl: '-0.500000001s', mask: 'user.displayName,photo', payload: 'Zm8' };
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: base }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...base, occurredAt: '2025-01-27T11:42:15.1234567890Z' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...base, ttl: '1.1234567890s' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...base, mask: 'user.display_name' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...base, payload: 'A' } }))).toBe(true);
  });
  it('does not false-fail an empty OK server-streaming stream (zero messages)', () => {
    const script = grpcScriptFor('/List');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: null }))).toBe(false);
    expect(script).not.toContain('must return exactly one terminal response message');
    expect(script).not.toContain('must return at least');
  });
  // Round-3 fix #1: a singular enum field whose value is neither a string nor a
  // number must fail closed (the scalar-enum branch previously returned silently
  // on a boolean/object/array/null, a false-pass).
  it('fails a singular enum field whose value is neither string nor number', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], state: true } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], state: {} } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], state: [] } }))).toBe(true);
  });
  it('accepts a valid singular enum member and fails one outside the set', () => {
    const script = grpcScriptFor('/Get');
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], state: 'ACTIVE' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { userId: 'u1', tags: [], qualities: [], state: 'NOPE' } }))).toBe(true);
  });
  // Round-7 (gRPC integer map keys): ProtoJSON parses integral map keys with Go
  // strconv.ParseInt/ParseUint (verified against encoding/protojson v1.36.11) -- a
  // STRICTER accepted-set than scalar integer VALUES: decimal/exponent spellings are
  // rejected, unsigned keys take no sign, but leading zeros are accepted.
  it('validates integer map keys with ParseInt/ParseUint semantics, distinct from scalar values', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    // plain / leading-zero / signed int64 keys are ACCEPTED (Go accepts)
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '1': 'a' } } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '01': 'a' } } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '+1': 'a' } } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '-1': 'a' } } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, uNames: { '01': 'a' } } }))).toBe(false);
    // decimal/exponent map-key spellings are REJECTED (Go rejects, though scalar values accept them)
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '1.0': 'a' } } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '1e0': 'a' } } }))).toBe(true);
    // unsigned key with a sign, and signed 64-bit overflow, are REJECTED
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, uNames: { '-1': 'a' } } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, idNames: { '9223372036854775808': 'a' } } }))).toBe(true);
  });
  // Round-7 (gRPC enum numeric range): ProtoJSON enum numeric decoding is int32-bounded
  // (verified against Go): out-of-int32 numbers are rejected in singular, repeated, and
  // map-value enum positions; unknown-but-in-range numbers stay accepted (open enums).
  it('bounds numeric enum values to the int32 range in every enum position', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, state: 1 } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, state: -2147483648 } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, state: 2147483648 } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, state: 4294967296 } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, state: -2147483649 } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, qualities: [4294967296] } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, tagQuality: { a: 4294967296 } } }))).toBe(true);
  });
  // Round-9 (gRPC zero-valued exponent integer strings): Go protojson accepts a
  // zero-valued exponent spelling like "0e100"/"0e-100" as 0, so the exponent safety
  // bound must not false-fail an all-zero mantissa; non-zero out-of-range exponents
  // still fail (overflow or non-integral).
  it('accepts zero-valued exponent integer spellings, still rejecting non-zero out-of-range', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0e100' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0e-100' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0.0e100' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, count: '0e100' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '1e100' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '1e-100' } }))).toBe(true);
  });
  // Round-9, revised by the ProtoJSON null-emission policy (catalog 1381): Go
  // protojson PARSING accepts whole-field null as unset, but serializer output
  // never emits null for plain fields, so a response carrying one is a contract
  // defect. Wrapper/Value/NullValue fields keep their null acceptance; null
  // array elements and map values stay rejected.
  it('rejects JSON null on plain whole fields, null array elements, and null map values', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, count: null } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, state: null } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, qualities: null } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, tagQuality: null } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, qualities: [null] } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, tagQuality: { a: null } } }))).toBe(true);
  });
  // Round-10 (gRPC float32): proto float is float32, so a finite double that overflows
  // float32 (e.g. 3.5e38) must fail, while in-range values and NaN/Infinity pass. Verified
  // vs Go encoding/protojson (float rejects 3.5e38; the same value on a double accepts).
  it('enforces float32 range on proto float fields, distinct from double', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: 3.14 } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: '3.4028235e38' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: 'NaN' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: 'Infinity' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: '3.5e38' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: 3.5e38 } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, fl: '1e39' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, lat: '3.5e38' } }))).toBe(false);
  });
  // Round-10 (gRPC integer exponent): a legal zero-padded spelling with an exponent
  // outside the old [-60,60] guard but normalizing to an in-range integer must pass;
  // genuinely out-of-range magnitudes still fail. Verified vs Go.
  it('normalizes integer spellings by magnitude, not a fixed exponent window', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '1' + '0'.repeat(61) + 'e-61' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '1e100' } }))).toBe(true);
  });
  // Round-11 (gRPC integer exponent Go-parity): Go rejects positive-exponent spellings
  // syntactically when intpSize + exp > 20, even when the VALUE is in range (e.g.
  // '0.(20 zeros)1e21' = 1 is rejected), while intpSize + exp <= 20 with an in-range
  // value is accepted. Verified vs Go encoding/protojson.
  it('matches Go int-from-string exponent parity (syntactic intpSize+exp<=20)', () => {
    const script = grpcScriptFor('/Get');
    const ok = { userId: 'u1', tags: [], qualities: [] };
    // in-syntactic-bound, in-range: accepted
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0.' + '0'.repeat(19) + '1e20' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '1e18' } }))).toBe(false);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0.0001e20' } }))).toBe(false);
    // over syntactic bound (intpSize+exp>20): rejected even though the value is 1
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0.' + '0'.repeat(20) + '1e21' } }))).toBe(true);
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '0.0001e21' } }))).toBe(true);
    // in syntactic bound but out of int64 range: rejected by range
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { ...ok, big: '1e19' } }))).toBe(true);
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
    expect(anyFail(runScript(pingScript(), { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { ping: 'ok' }, errors: [{ message: 'deprecated field' }] } }))).toBe(false);
  });
  it('fails a total failure (errors present, no data)', () => {
    expect(anyFail(runScript(pingScript(), { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: null, errors: [{ message: 'boom' }] } }))).toBe(true);
  });
});

// Round-3 fix #2 (GraphQL): assertions are generated from the query's ACTUAL
// selection set. A non-null composite the generated query does not select must NOT
// be asserted (that was the false-fail); a selected non-null scalar still is.
describe('GraphQL selection-aligned field assertions', () => {
  function meScript(): { query: string; exec: string } {
    const sdl = 'type Query { me: User } type User { id: ID! profile: Profile! } type Profile { name: String! }';
    const index = parseGraphQLSchema(sdl, { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; request: { body: { graphql: { query: string } } }; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const item = collection.item.find((entry) => entry.id === 'query.me')!;
    return { query: item.request.body.graphql.query, exec: item.event.find((event) => event.listen === 'test')!.script.exec.join('\n') };
  }
  it('does not assert a non-null composite the generated query does not select', () => {
    const { query, exec } = meScript();
    expect(query).toContain('id');
    expect(query).not.toContain('profile');
    expect(exec).not.toContain("'profile'");
    expect(exec).toContain("User is missing non-null field 'id'");
  });
  it('does not false-fail a valid response that omits the unselected composite', () => {
    const { exec } = meScript();
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { me: { id: 'x' } } } }))).toBe(false);
  });
  it('fails when a selected non-null scalar field is missing', () => {
    const { exec } = meScript();
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { me: {} } } }))).toBe(true);
  });
});

// Round-8 fix (GraphQL): a union (and list-of-union) return renders '{ __typename }'
// in the query, so the runtime script must assert the value is an object carrying a
// string __typename that names a declared union member. A scalar union value, an
// object missing __typename, or a __typename outside the member set is a false-pass
// unless rejected. Verified as legal/illegal per the graphql execution model.
describe('GraphQL union return runtime validation', () => {
  function unionScripts(): { pet: string; pets: string; petQuery: string } {
    const sdl = 'union Pet = Cat | Dog type Cat { name: String! } type Dog { name: String! } type Query { pet: Pet! pets: [Pet!]! }';
    const index = parseGraphQLSchema(sdl, { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; request: { body: { graphql: { query: string } } }; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const pet = collection.item.find((entry) => entry.id === 'query.pet')!;
    const pets = collection.item.find((entry) => entry.id === 'query.pets')!;
    return {
      pet: pet.event.find((event) => event.listen === 'test')!.script.exec.join(String.fromCharCode(10)),
      pets: pets.event.find((event) => event.listen === 'test')!.script.exec.join(String.fromCharCode(10)),
      petQuery: pet.request.body.graphql.query
    };
  }
  it('selects { __typename } for a union field', () => {
    expect(unionScripts().petQuery).toContain('__typename');
  });
  it('accepts a union object carrying a declared member __typename', () => {
    const { pet } = unionScripts();
    expect(anyFail(runScript(pet, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { pet: { __typename: 'Cat' } } } }))).toBe(false);
  });
  it('fails a scalar union value (not an object)', () => {
    const { pet } = unionScripts();
    expect(anyFail(runScript(pet, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { pet: 'Cat' } } }))).toBe(true);
  });
  it('fails a union object missing __typename', () => {
    const { pet } = unionScripts();
    expect(anyFail(runScript(pet, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { pet: {} } } }))).toBe(true);
  });
  it('fails a __typename outside the union member set', () => {
    const { pet } = unionScripts();
    expect(anyFail(runScript(pet, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { pet: { __typename: 'Fish' } } } }))).toBe(true);
  });
  it('validates every element of a list-of-union return', () => {
    const { pets } = unionScripts();
    expect(anyFail(runScript(pets, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { pets: [{ __typename: 'Cat' }, { __typename: 'Dog' }] } } }))).toBe(false);
    expect(anyFail(runScript(pets, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { pets: ['Cat', {}] } } }))).toBe(true);
  });
});

// Round-3 fix #3 (GraphQL): enum membership, Int 32-bit range, and per-element
// list validation are enforced at runtime, not merely type-of.
describe('GraphQL scalar/enum/list runtime validation', () => {
  function scriptFor(sdl: string, id: string): string {
    const index = parseGraphQLSchema(sdl, { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const item = collection.item.find((entry) => entry.id === id)!;
    return item.event.find((event) => event.listen === 'test')!.script.exec.join('\n');
  }
  const rowSdl = 'enum Status { ACTIVE INACTIVE } type Row { id: ID! count: Int! state: Status! } type Query { row: Row }';

  it('passes a valid enum member and fails a value outside the enum set', () => {
    const exec = scriptFor(rowSdl, 'query.row');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { row: { id: 'x', count: 1, state: 'ACTIVE' } } } }))).toBe(false);
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { row: { id: 'x', count: 1, state: 'BOGUS' } } } }))).toBe(true);
  });
  it('fails an Int outside the signed 32-bit range and a fractional Int', () => {
    const exec = scriptFor(rowSdl, 'query.row');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { row: { id: 'x', count: 4294967296, state: 'ACTIVE' } } } }))).toBe(true);
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { row: { id: 'x', count: 1.5, state: 'ACTIVE' } } } }))).toBe(true);
  });
  it('validates every list element, not only the first', () => {
    const exec = scriptFor('type Plan { id: ID! } type Query { plans: [Plan!]! }', 'query.plans');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { plans: [{ id: 'a' }, { id: 'b' }] } } }))).toBe(false);
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { plans: [{ id: 'a' }, {}] } } }))).toBe(true);
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

// Defect #6 (OpenAPI), revised after ground-truth review: a SEPARABLE compound
// path segment (e.g. /reports/{name}.{ext}) is now extracted at runtime and
// schema-validated, so a spec-illegal value fails closed and a legal one passes;
// only an ambiguous adjacent-parameter segment ({a}{b}) stays warning-only.
describe('OpenAPI compound path-parameter runtime validation', () => {
  const compoundSpec = [
    'openapi: 3.0.3',
    "info: { title: t, version: '1.0.0' }",
    'paths:',
    '  /reports/{name}.{ext}:',
    '    get:',
    '      parameters:',
    '        - { name: name, in: path, required: true, schema: { type: string } }',
    '        - { name: ext, in: path, required: true, schema: { type: string, enum: [pdf] } }',
    '      responses:',
    "        '200': { description: ok }"
  ].join('\n');
  const index = buildContractIndex(parseOpenApiDocument(compoundSpec));
  const operation = index.operations[0]!;
  const exec = createContractScript(operation).join('\n');
  const PARAM_TEST = 'Request parameters match OpenAPI schemas';

  // Run a generated contract script against a mocked request whose URL path is
  // `path`; returns each pm.test's pass/fail so the path-parameter assertion can
  // be inspected in isolation.
  function runWithPath(script: string, path: string): Record<string, 'pass' | 'fail'> {
    const results: Record<string, 'pass' | 'fail'> = {};
    const pm = {
      test: (name: string, cb: () => void) => { try { cb(); results[name] = 'pass'; } catch { results[name] = 'fail'; } },
      expect: makeStrictExpect(),
      response: { code: 200, status: undefined, responseTime: 1, headers: { get: () => null }, text: () => '', json: () => undefined },
      request: { method: 'GET', headers: { each: () => undefined }, url: { query: { each: () => undefined }, getPath: () => path, path: path.split('/').filter(Boolean) } },
      environment: { get: () => undefined }
    };
    runInContext(script, createContext({ pm }));
    return results;
  }

  it('emits a runtime path check (no compound warning) for a separable segment', () => {
    const warnings = [...index.warnings, ...index.operations.flatMap((op) => op.warnings)];
    expect(warnings.some((warning) => warning.startsWith('CONTRACT_PATH_PARAM_COMPOUND_SEGMENT_NOT_VALIDATED'))).toBe(false);
    expect((operation.parameterChecks ?? []).some((check) => check.in === 'path' && check.name === 'ext')).toBe(true);
  });
  it('fails closed when a compound path parameter violates its schema', () => {
    expect(runWithPath(exec, '/reports/foo.exe')[PARAM_TEST]).toBe('fail');
  });
  it('passes when a compound path parameter satisfies its schema', () => {
    expect(runWithPath(exec, '/reports/foo.pdf')[PARAM_TEST]).toBe('pass');
  });
  it('does not false-fail a templated compound segment', () => {
    expect(runWithPath(exec, '/reports/{{file}}.pdf')[PARAM_TEST]).toBe('pass');
  });
  it('stays warning-only for an ambiguous adjacent-parameter segment', () => {
    const ambiguous = [
      'openapi: 3.0.3',
      "info: { title: t, version: '1.0.0' }",
      'paths:',
      '  /x/{a}{b}:',
      '    get:',
      '      parameters:',
      '        - { name: a, in: path, required: true, schema: { type: string } }',
      '        - { name: b, in: path, required: true, schema: { type: string } }',
      '      responses:',
      "        '200': { description: ok }"
    ].join('\n');
    const idx = buildContractIndex(parseOpenApiDocument(ambiguous));
    const warnings = [...idx.warnings, ...idx.operations.flatMap((op) => op.warnings)];
    expect(warnings.some((warning) => warning.startsWith('CONTRACT_PATH_PARAM_COMPOUND_SEGMENT_NOT_VALIDATED'))).toBe(true);
  });
});

// Round-4 fix (GraphQL): list-element and selected-field nullability. A nullable
// list [T] may legitimately contain null (skip it); a non-null list [T!] must not
// (fail closed). A SELECTED non-null field that is present but explicitly null must
// fail (the property check alone would accept it).
describe('GraphQL nullability: list elements and selected non-null fields', () => {
  function gqlScript(sdl: string, id: string): string {
    const index = parseGraphQLSchema(sdl, { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const item = collection.item.find((entry) => entry.id === id)!;
    return item.event.find((event) => event.listen === 'test')!.script.exec.join('\n');
  }
  it('accepts a null element in a nullable scalar list [String]', () => {
    const exec = gqlScript('type Query { tags: [String] }', 'query.tags');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { tags: ['a', null] } } }))).toBe(false);
  });
  it('fails a null element in a non-null scalar list [String!]', () => {
    const exec = gqlScript('type Query { tags: [String!] }', 'query.tags');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { tags: ['a', null] } } }))).toBe(true);
  });
  it('accepts a null element in a nullable object list [Thing]', () => {
    const exec = gqlScript('type Thing { id: ID! } type Query { things: [Thing] }', 'query.things');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { things: [{ id: 'a' }, null] } } }))).toBe(false);
  });
  it('fails a null element in a non-null object list [Thing!]', () => {
    const exec = gqlScript('type Thing { id: ID! } type Query { things: [Thing!] }', 'query.things');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { things: [{ id: 'a' }, null] } } }))).toBe(true);
  });
  it('fails a selected non-null field that is present but explicitly null', () => {
    const exec = gqlScript('type User { id: ID! } type Query { me: User }', 'query.me');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { me: { id: null } } } }))).toBe(true);
  });
  it('accepts a selected non-null field with a valid value', () => {
    const exec = gqlScript('type User { id: ID! } type Query { me: User }', 'query.me');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { me: { id: 'x' } } } }))).toBe(false);
  });
});

// Round-4 fix (gRPC): proto map keys JSON-encode as strings, but an integral or
// bool key type still constrains that string. A map<int32,V> key that is not an
// integer string, or a map<bool,V> key that is not "true"/"false", must fail
// closed; a map<string,V> accepts any string key.
describe.skipIf(!HAS_PROTOBUF)('gRPC map key validation (ProtoJSON integral/bool keys)', () => {
  function mapKeyScript(): string {
    const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;
    const proto = [
      'syntax = "proto3";',
      'package t;',
      'message Req { string id = 1; }',
      'message Resp { map<int32, string> by_int = 1; map<bool, string> by_bool = 2; map<string, string> by_str = 3; }',
      'service S { rpc Get(Req) returns (Resp); }'
    ].join('\n');
    const index = parseProtoSchema(proto, deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://h:443', idSeed: 'mk' });
    instrumentGrpcCollection(collection, index);
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/Get'))!;
    return ((item.event as Array<{ listen: string; script: { exec: string[] } }>).find((e) => e.listen === 'test')!.script.exec).join('\n');
  }
  it('passes ProtoJSON-valid integral, bool, and string keys', () => {
    const script = mapKeyScript();
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { byInt: { '1': 'a', '-2': 'b' }, byBool: { 'true': 'x', 'false': 'y' }, byStr: { anything: 'z' } } }))).toBe(false);
  });
  it('fails a non-integer key on a map<int32, V>', () => {
    const script = mapKeyScript();
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { byInt: { abc: 'a' } } }))).toBe(true);
  });
  it('fails a non-boolean key on a map<bool, V>', () => {
    const script = mapKeyScript();
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { byBool: { yes: 'x' } } }))).toBe(true);
  });
  it('accepts any string key on a map<string, V>', () => {
    const script = mapKeyScript();
    expect(anyFail(runScript(script, { code: 0, status: 'OK', json: { byStr: { '!@#': 'z' } } }))).toBe(false);
  });
});

// Round-5 fix (gRPC): integer scalars carry their EXACT protobuf domain so the
// runtime range/sign-checks them, instead of collapsing every int into a broad
// "number" (any finite integer) or "string" (any string). 32-bit values are
// range-checked numerically; 64-bit values via string comparison (JS doubles lose
// precision past 2^53), so an out-of-range or wrong-sign value fails closed.
describe.skipIf(!HAS_PROTOBUF)('gRPC ProtoJSON integer range/sign validation (round 5)', () => {
  function intScript(): string {
    const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;
    const proto = [
      'syntax = "proto3";',
      'package t;',
      'message Req { string id = 1; }',
      'message Resp { int32 c32 = 1; uint32 u32 = 2; int64 i64 = 3; uint64 u64 = 4; map<uint32, string> by_id = 5; }',
      'service Svc { rpc Get(Req) returns (Resp); }'
    ].join('\n');
    const index = parseProtoSchema(proto, deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://h:443', idSeed: 'r5int' });
    instrumentGrpcCollection(collection, index);
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/Get'))!;
    return ((item.event as Array<{ listen: string; script: { exec: string[] } }>).find((e) => e.listen === 'test')!.script.exec).join('\n');
  }
  it('accepts in-range integers (32-bit numbers, 64-bit boundary strings, integral map key)', () => {
    const s = intScript();
    expect(anyFail(runScript(s, { code: 0, status: 'OK', json: { c32: 7, u32: 7, i64: '9223372036854775807', u64: '18446744073709551615', byId: { '7': 'x' } } }))).toBe(false);
  });
  it('fails an int32 above 2^31-1', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { c32: 2147483648 } }))).toBe(true);
  });
  it('fails an int32 below -2^31', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { c32: -2147483649 } }))).toBe(true);
  });
  it('fails a negative uint32', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { u32: -1 } }))).toBe(true);
  });
  it('fails a uint32 above 2^32-1', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { u32: 4294967296 } }))).toBe(true);
  });
  it('fails an int64 non-numeric string (previously accepted as any string)', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { i64: 'not-a-number' } }))).toBe(true);
  });
  it('fails an int64 above 2^63-1 (string range, no double precision loss)', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { i64: '9223372036854775808' } }))).toBe(true);
  });
  it('fails a negative uint64 string', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { u64: '-1' } }))).toBe(true);
  });
  it('fails a uint64 above 2^64-1', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { u64: '18446744073709551616' } }))).toBe(true);
  });
  it('fails a negative uint32 map key', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { byId: { '-1': 'x' } } }))).toBe(true);
  });
  it('fails an out-of-range uint32 map key', () => {
    expect(anyFail(runScript(intScript(), { code: 0, status: 'OK', json: { byId: { '4294967296': 'x' } } }))).toBe(true);
  });
});

// Round-5 fix (GraphQL): nested lists (`[[Int]]`, `[[T!]!]`) are modeled as ordered
// list wrappers and asserted at EVERY dimension. Previously only one list level was
// stored, so an outer element of a nested list was type-checked as the inner named
// type (false-fail on a legal nested response, false-pass on a wrong shape).
describe('GraphQL nested-list validation (round 5)', () => {
  function nestedScript(sdl: string, id: string): string {
    const index = parseGraphQLSchema(sdl, { service: 'S' });
    const collection = buildGraphQLCollection(index, { url: '{{u}}/graphql' }) as unknown as {
      item: Array<{ id: string; event: Array<{ listen: string; script: { exec: string[] } }> }>;
    };
    instrumentGraphQLCollection(collection as unknown as JsonRecord, index);
    const item = collection.item.find((entry) => entry.id === id)!;
    return item.event.find((event) => event.listen === 'test')!.script.exec.join('\n');
  }
  it('accepts a legal [[Int]] matrix (does not false-fail the nested list)', () => {
    const exec = nestedScript('type Query { grid: [[Int]] }', 'query.grid');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { grid: [[1, 2], [3, 4]] } } }))).toBe(false);
  });
  it('fails a [[Int]] with a non-integer inner element', () => {
    const exec = nestedScript('type Query { grid: [[Int]] }', 'query.grid');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { grid: [[1, 'x']] } } }))).toBe(true);
  });
  it('fails a [[Int]] whose outer element is not itself a list', () => {
    const exec = nestedScript('type Query { grid: [[Int]] }', 'query.grid');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { grid: [1, 2] } } }))).toBe(true);
  });
  it('accepts a null inner element in a nullable inner list [[Int]]', () => {
    const exec = nestedScript('type Query { grid: [[Int]] }', 'query.grid');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { grid: [[1, null]] } } }))).toBe(false);
  });
  it('fails a null inner element when the inner list is [[Int!]!]', () => {
    const exec = nestedScript('type Query { rows: [[Int!]!] }', 'query.rows');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { rows: [[1, null]] } } }))).toBe(true);
  });
  it('fails a null outer element when the outer items are non-null [[Int!]!]', () => {
    const exec = nestedScript('type Query { rows: [[Int!]!] }', 'query.rows');
    expect(anyFail(runScript(exec, { code: 200, headers: { 'Content-Type': 'application/json' }, json: { data: { rows: [null] } } }))).toBe(true);
  });
});
