import { describe, expect, it } from 'vitest';
import { parseProtoSchema } from '../../../src/lib/protocols/grpc/proto-parser.js';
import { HAS_PROTOBUF, PROTOBUF, readFixture } from './helpers.js';

const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;

describe.skipIf(!HAS_PROTOBUF)('parseProtoSchema', () => {
  it('extracts package, services, and stream kinds deterministically', () => {
    const index = parseProtoSchema(readFixture(), deps);
    expect(index.package).toBe('telecom.network.v1');
    const byPath = Object.fromEntries(index.operations.map((operation) => [operation.methodPath, operation.stream]));
    expect(byPath['telecom.network.v1.TowerService/GetTower']).toBe('unary');
    expect(byPath['telecom.network.v1.TowerService/ListTowers']).toBe('server');
    expect(byPath['telecom.network.v1.TowerService/RecordUplink']).toBe('client');
    expect(byPath['telecom.network.v1.TowerService/Diagnose']).toBe('bidi');
  });

  it('orders operations by service then method name (deterministic)', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const ids = index.operations.map((operation) => operation.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('resolves request/response message types to fully-qualified names', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const get = index.operations.find((operation) => operation.method === 'GetTower');
    expect(get?.responseType).toBe('telecom.network.v1.Tower');
    expect(get?.requestType).toBe('telecom.network.v1.GetTowerRequest');
  });

  it('classifies field JSON types: 64-bit int as string, map as object, enum, repeated', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const tower = index.messages['telecom.network.v1.Tower'];
    expect(tower).toBeDefined();
    const fields = Object.fromEntries(tower.fields.map((field) => [field.name, field]));
    expect(fields.tower_id?.jsonType).toBe('string');
    expect(fields.location?.jsonType).toBe('object');
    expect(fields.location?.messageType).toBe('telecom.network.v1.GeoPoint');
    expect(fields.quality?.jsonType).toBe('enum');
    expect(fields.quality?.enumType).toBe('telecom.network.v1.SignalQuality');
    expect(fields.supported_bands?.repeated).toBe(true);
    expect(fields.subscriber_count?.jsonType).toBe('string'); // int64 -> JSON string
    expect(fields.attributes?.map).toBe(true);
    expect(fields.attributes?.jsonType).toBe('object');
  });

  it('captures enum value names sorted', () => {
    const index = parseProtoSchema(readFixture(), deps);
    expect(index.enums['telecom.network.v1.SignalQuality']).toEqual([
      'SIGNAL_QUALITY_EXCELLENT',
      'SIGNAL_QUALITY_FAIR',
      'SIGNAL_QUALITY_GOOD',
      'SIGNAL_QUALITY_POOR',
      'SIGNAL_QUALITY_UNSPECIFIED'
    ]);
  });

  it('warns PROTO_STREAMING_METHOD for every non-unary rpc', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const streamingWarnings = index.operations.flatMap((operation) => operation.warnings).filter((warning) => warning.startsWith('PROTO_STREAMING_METHOD'));
    expect(streamingWarnings).toHaveLength(3);
  });

  it('rejects empty input', () => {
    expect(() => parseProtoSchema('', deps)).toThrow(/PROTO_EMPTY_INPUT/);
  });

  it('rejects a proto with no services', () => {
    const src = 'syntax = "proto3"; package x; message A { string b = 1; }';
    expect(() => parseProtoSchema(src, deps)).toThrow(/PROTO_NO_SERVICES/);
  });

  it('wraps parse failures as PROTO_PARSE_FAILED', () => {
    expect(() => parseProtoSchema('syntax = "proto3"; this is not valid proto', deps)).toThrow(/PROTO_PARSE_FAILED/);
  });
});
