import { Script, createContext } from 'node:vm';

import { describe, expect, it } from 'vitest';
import { parseProtoSchema } from '../../../src/lib/protocols/grpc/proto-parser.js';
import { buildGrpcCollection } from '../../../src/lib/protocols/grpc/grpc-collection-builder.js';
import { instrumentGrpcCollection } from '../../../src/lib/protocols/grpc/grpc-instrumenter.js';
import { HAS_PROTOBUF, PROTOBUF, readFixture } from './helpers.js';

const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;

type JsonRecord = Record<string, unknown>;

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

function testScript(item: JsonRecord): string {
  const events = (item.event as JsonRecord[]) ?? [];
  const test = events.find((event) => event.listen === 'test');
  const script = test?.script as JsonRecord | undefined;
  return ((script?.exec as string[]) ?? []).join('\n');
}

function buildInstrumented() {
  const index = parseProtoSchema(readFixture(), deps);
  const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://telecom.example.com:443', idSeed: 'golden', schemaLocation: 'fixtures/grpc/routeguide.proto' });
  return instrumentGrpcCollection(collection, index);
}

interface TestResult { name: string; passed: boolean; error?: string; }

// Execute a generated gRPC test script in a real VM against a mock `pm`, driving
// pm.response.json() to a crafted ProtoJSON message. This proves the embedded
// validators actually accept/reject values at runtime, not merely that their
// source text is present in the script.
function runGrpcScript(source: string, message: unknown): TestResult[] {
  const results: TestResult[] = [];
  const expect = ((actual: unknown, msg?: string) => ({
    to: {
      eql: (exp: unknown): void => { if (actual !== exp) throw new Error(msg ?? 'expected values to be equal'); },
      be: {
        an: (type: string): void => {
          const ok = type === 'object'
            ? actual !== null && typeof actual === 'object' && !Array.isArray(actual)
            : typeof actual === type;
          if (!ok) throw new Error(msg ?? `expected an ${type}`);
        }
      }
    }
  })) as ((actual: unknown, msg?: string) => unknown) & { fail: (m?: string) => never };
  expect.fail = (m?: string): never => { throw new Error(m ?? 'pm.expect.fail'); };
  const pm = {
    response: { code: 0, status: 'OK', json: (): unknown => message },
    expect,
    test: (name: string, fn: () => void): void => {
      try { fn(); results.push({ name, passed: true }); }
      catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }); }
    }
  };
  const context = createContext({ pm, Number, Array, Object, Math, JSON, String, RegExp, Boolean });
  new Script(source).runInContext(context);
  return results;
}

describe.skipIf(!HAS_PROTOBUF)('instrumentGrpcCollection', () => {
  it('injects a test event on every grpc-request and covers all operations', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'cov' });
    const { warnings } = instrumentGrpcCollection(collection, index);
    const items = grpcItems(collection);
    expect(items.length).toBe(index.operations.length);
    for (const item of items) {
      expect(testScript(item)).toContain('pm.test');
    }
    // no PROTO_RESPONSE_MESSAGE_UNKNOWN once response types resolve to FQN
    expect(warnings.some((warning) => warning.startsWith('PROTO_RESPONSE_MESSAGE_UNKNOWN'))).toBe(false);
  });

  it('asserts gRPC status OK (code === 0) on the unary GetTower', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    const script = testScript(item);
    expect(script).toContain('gRPC status is OK');
    expect(script).toContain('.to.eql(0)');
  });

  it('asserts response message field types vs the proto response message', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    const script = testScript(item);
    expect(script).toContain('gRPC response message matches');
    // Tower fields embedded in the spec, including the enum membership set.
    expect(script).toContain('subscriber_count');
    expect(script).toContain('SIGNAL_QUALITY_EXCELLENT');
  });

  it('emits an exactly-one terminal-message test for unary/client and omits the minimum for server/bidi', () => {
    const { collection } = buildInstrumented();
    const get = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    const list = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/ListTowers'))!;
    // unary asserts exactly one terminal response message; server-streaming omits
    // any minimum-message assertion (an empty OK stream is spec-legal).
    expect(testScript(get)).toContain('must return exactly one terminal response message');
    expect(testScript(list)).not.toContain('must return exactly one terminal response message');
    expect(testScript(list)).not.toContain('must return at least');
    // The spec carries the right stream label. The spec is JSON.stringify'd into a
    // JS string literal, so the inner quotes are backslash-escaped in the source.
    expect(testScript(get)).toContain('\\"stream\\":\\"unary\\"');
    expect(testScript(list)).toContain('\\"stream\\":\\"server\\"');
  });

  it('validates google.rpc.Status shapes semantically when the proto declares them', () => {
    const statusProto = `syntax = "proto3";
package demo;
import "google/rpc/status.proto";
message OpResult { string name = 1; google.rpc.Status error = 2; }
service Ops { rpc GetOp (OpResult) returns (OpResult); }
`;
    const index = parseProtoSchema(statusProto, deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'rpcstatus' });
    instrumentGrpcCollection(collection, index);
    const item = grpcItems(collection)[0]!;
    const script = testScript(item);
    expect(script).toContain('grpcCheckRpcStatus');
    const run = (message: unknown) => runGrpcScript(script, message).find((entry) => entry.name.startsWith('gRPC response message matches'));
    expect(run({ name: 'op', error: { code: 5, message: 'not found' } })?.passed).toBe(true);
    expect(run({ name: 'op', error: { code: 99, message: 'bogus' } })?.passed).toBe(false);
    expect(run({ name: 'op', error: { code: 5, details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo' }] } })?.passed).toBe(true);
    expect(run({ name: 'op', error: { code: 5, details: [{ reason: 'no type' }] } })?.passed).toBe(false);
  });

  it('warns PROTO_STREAMING_METHOD for server/client/bidi rpcs', () => {
    const { warnings } = buildInstrumented();
    const streaming = warnings.filter((warning) => warning.startsWith('PROTO_STREAMING_METHOD'));
    expect(streaming).toHaveLength(3);
  });

  it('embeds oneof mutual-exclusion, well-known formats, well-known nullable, and message-map value shape for GetNetworkEvent', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetNetworkEvent'))!;
    const script = testScript(item);
    // oneof mutual-exclusion runtime check + both members embedded in the spec.
    expect(script).toContain('sets multiple members of a oneof');
    expect(script).toContain('pong');
    // well-known nullable wrapper carried through to the spec.
    expect(script).toContain('note');
    expect(script).toContain('nullable');
    // WKT/scalar lexical validators carried through to the generated assertion.
    expect(script).toContain('validProtoTimestamp');
    expect(script).toContain('proto-field-mask');
    expect(script).toContain('proto-bytes');
    // map<string, GeoPoint> value shape recurses into GeoPoint's fields.
    expect(script).toContain('mapValueShape');
    expect(script).toContain('latitude');
  });

  it('statically flags a request body field type mismatch', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'req' });
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    // tower_id is a string; a numeric literal must be flagged at instrument time.
    (item.payload as JsonRecord).message = { content: '{"tower_id": 123}' };
    const { warnings } = instrumentGrpcCollection(collection, index);
    expect(warnings.some((warning) => warning.startsWith('PROTO_REQUEST_FIELD_TYPE_MISMATCH'))).toBe(true);
  });

  it('accepts proto3-JSON non-finite/numeric-string double encodings in the shape checker', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/RecordUplink'))!;
    const script = testScript(item);
    expect(script).toContain('if (expected === "double")');
    expect(script).toContain('"-Infinity"');
    // UplinkSummary.average_dbm (double) carries the double jsonType in the spec.
    expect(script).toContain('double');
  });

  it('bounds numeric enum values to the int32 range in the generated shape checker', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    const script = testScript(item);
    expect(script).toContain('matchesEnumNumber');
    expect(script).toContain('Number.isInteger');
    expect(script).toContain('must be an int32-range integer');
    expect(script).toContain('2147483647');
  });

  it('resolves oneof members with the same jsonName/proto-name lookup as field checks', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetNetworkEvent'))!;
    const script = testScript(item);
    expect(script).toContain('grpcFieldKey(obj, m)');
  });

  it('statically flags a request body keyed by the ProtoJSON (jsonName) field', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'reqjson' });
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    // GetTowerRequest.tower_id -> ProtoJSON name towerId; a numeric literal keyed
    // by the jsonName must still be flagged as a string-field mismatch.
    (item.payload as JsonRecord).message = { content: '{"towerId": 123}' };
    const { warnings } = instrumentGrpcCollection(collection, index);
    expect(warnings.some((warning) => warning.startsWith('PROTO_REQUEST_FIELD_TYPE_MISMATCH'))).toBe(true);
  });

  it('executes the emitted ProtoJSON validators: accepts valid WKT/bytes values and rejects malformed ones', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetNetworkEvent'))!;
    const source = testScript(item);
    const shapeTest = 'gRPC response message matches telecom.network.v1.NetworkEvent';

    // Spec-legal values across all four formats must pass the shape assertion:
    // RFC 3339 timestamp, seconds Duration, lowerCamelCase FieldMask, base64 bytes.
    const ok = runGrpcScript(source, {
      occurredAt: '2026-06-30T23:59:59.021Z',
      ttl: '1.500340012s',
      mask: 'towerId,location',
      payload: 'YWJj',
      wrappedPayload: 'YWJj'
    });
    expect(ok.find((r) => r.name === shapeTest)?.passed, JSON.stringify(ok)).toBe(true);

    // Each malformed ProtoJSON string must fail the shape assertion with the
    // format-specific message, proving lexical enforcement (not type-only).
    const malformed: Array<[Record<string, unknown>, string]> = [
      [{ occurredAt: '2026-13-01T00:00:00Z' }, 'Timestamp'],
      [{ ttl: '1min' }, 'Duration'],
      [{ mask: 'BadCaps' }, 'FieldMask'],
      [{ payload: 'not base64!!' }, 'base64']
    ];
    for (const [payload, label] of malformed) {
      const result = runGrpcScript(source, payload).find((r) => r.name === shapeTest);
      expect(result?.passed, `${label}: ${JSON.stringify(result)}`).toBe(false);
      expect(result?.error, label).toContain(label);
    }
  });

  it('emitted Duration/bytes validators match the ProtoJSON (Go parseDuration / base64) accepted-set', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetNetworkEvent'))!;
    const all = testScript(item);
    const extract = (name: string): string => {
      const start = all.indexOf(`function ${name}(value) {`);
      if (start < 0) throw new Error(`missing ${name}`);
      let depth = 0;
      for (let k = all.indexOf('{', start); k < all.length; k++) {
        if (all[k] === '{') depth++;
        else if (all[k] === '}') { depth--; if (depth === 0) return all.slice(start, k + 1); }
      }
      throw new Error(`unbalanced ${name}`);
    };
    // Run the real emitted validator functions in a VM to prove their accepted-set,
    // not merely that their source text is present.
    const context = createContext({ Number, Array, Object, Math, JSON, String, RegExp, Boolean }) as Record<string, unknown>;
    new Script(`${extract('validProtoDuration')}\n${extract('validProtoBytes')}`).runInContext(context);
    const validDuration = context.validProtoDuration as (v: unknown) => boolean;
    const validBytes = context.validProtoBytes as (v: unknown) => boolean;

    // ProtoJSON Duration accepted-set mirrors Go encoding/protojson parseDuration:
    // optional +/- sign, fractional-only (.5s) and trailing-dot (1.s) forms, up to
    // 9 fractional digits; leading-zero integers (01s) and >9 digits are rejected.
    const durationVectors: Array<[string, boolean]> = [
      ['1s', true], ['0s', true], ['0.5s', true], ['1.s', true], ['.5s', true],
      ['+1s', true], ['-1.5s', true], ['3.000000001s', true], ['315576000000s', true],
      ['01s', false], ['s', false], ['1', false], ['1.1234567890s', false],
      ['315576000001s', false], ['1e3s', false], ['1S', false]
    ];
    for (const [value, ok] of durationVectors) {
      expect(validDuration(value), `Duration ${JSON.stringify(value)}`).toBe(ok);
    }

    // ProtoJSON bytes accept standard or URL-safe base64, padded or unpadded, but
    // never a mix of the two alphabets in one string.
    const bytesVectors: Array<[string, boolean]> = [
      ['', true], ['SGVsbG8=', true], ['SGVs', true], ['SGk', true],
      ['a-_9', true], ['a+/b', true],
      ['a+b_', false], ['a=b', false], ['SGVsb', false], ['====', false]
    ];
    for (const [value, ok] of bytesVectors) {
      expect(validBytes(value), `bytes ${JSON.stringify(value)}`).toBe(ok);
    }
  });

  it('matches the golden instrumented collection snapshot', () => {
    const { collection } = buildInstrumented();
    expect(collection).toMatchSnapshot();
  });

  it('matches the golden warnings snapshot', () => {
    const { warnings } = buildInstrumented();
    expect(warnings.slice().sort()).toMatchSnapshot();
  });
});
