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

  it('embeds oneof mutual-exclusion, well-known nullable, and message-map value shape for GetNetworkEvent', () => {
    const { collection } = buildInstrumented();
    const item = grpcItems(collection).find((entry) => String((entry.payload as JsonRecord).methodPath).endsWith('/GetNetworkEvent'))!;
    const script = testScript(item);
    // oneof mutual-exclusion runtime check + both members embedded in the spec.
    expect(script).toContain('sets multiple members of a oneof');
    expect(script).toContain('pong');
    // well-known nullable wrapper carried through to the spec.
    expect(script).toContain('note');
    expect(script).toContain('nullable');
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

  it('matches the golden instrumented collection snapshot', () => {
    const { collection } = buildInstrumented();
    expect(collection).toMatchSnapshot();
  });

  it('matches the golden warnings snapshot', () => {
    const { warnings } = buildInstrumented();
    expect(warnings.slice().sort()).toMatchSnapshot();
  });
});
