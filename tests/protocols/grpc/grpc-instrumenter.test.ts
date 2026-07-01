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

  it('requires integer enum numbers in the generated shape checker', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetTower'))!;
    const script = testScript(item);
    expect(script).toContain('Number.isInteger');
    expect(script).toContain('must be an integer');
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

  it('matches the golden instrumented collection snapshot', () => {
    const { collection } = buildInstrumented();
    expect(collection).toMatchSnapshot();
  });

  it('matches the golden warnings snapshot', () => {
    const { warnings } = buildInstrumented();
    expect(warnings.slice().sort()).toMatchSnapshot();
  });
});
