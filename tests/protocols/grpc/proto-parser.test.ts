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

  it('classifies float/double as the double JSON type, leaving 64-bit ints as string', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const geo = index.messages['telecom.network.v1.GeoPoint'];
    const geoFields = Object.fromEntries(geo.fields.map((field) => [field.name, field]));
    expect(geoFields.latitude?.jsonType).toBe('double');
    expect(geoFields.longitude?.jsonType).toBe('double');
    const summary = index.messages['telecom.network.v1.UplinkSummary'];
    const summaryFields = Object.fromEntries(summary.fields.map((field) => [field.name, field]));
    expect(summaryFields.average_dbm?.jsonType).toBe('double');
    expect(summaryFields.sample_count?.jsonType).toBe('string');
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

  it('maps well-known types by raw proto type name', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const event = index.messages['telecom.network.v1.NetworkEvent'];
    expect(event).toBeDefined();
    const fields = Object.fromEntries(event.fields.map((field) => [field.name, field]));
    // Timestamp/Duration/FieldMask JSON-encode as strings with ProtoJSON format validators; no messageType descent.
    expect(fields.occurred_at?.jsonType).toBe('string');
    expect(fields.occurred_at?.jsonFormat).toBe('proto-timestamp');
    expect(fields.occurred_at?.messageType).toBeUndefined();
    expect(fields.ttl?.jsonType).toBe('string');
    expect(fields.ttl?.jsonFormat).toBe('proto-duration');
    expect(fields.mask?.jsonType).toBe('string');
    expect(fields.mask?.jsonFormat).toBe('proto-field-mask');
    expect(fields.payload?.jsonType).toBe('string');
    expect(fields.payload?.jsonFormat).toBe('proto-bytes');
    // StringValue wrapper is a nullable string.
    expect(fields.note?.jsonType).toBe('string');
    expect(fields.note?.nullable).toBe(true);
    expect(fields.wrapped_payload?.jsonType).toBe('string');
    expect(fields.wrapped_payload?.jsonFormat).toBe('proto-bytes');
    expect(fields.wrapped_payload?.nullable).toBe(true);
  });

  it('captures multi-member oneof groups (member order preserved)', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const event = index.messages['telecom.network.v1.NetworkEvent'];
    expect(event.oneofs).toEqual([['tower', 'pong']]);
  });

  it('classifies a map whose value is a message', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const event = index.messages['telecom.network.v1.NetworkEvent'];
    const waypoints = event.fields.find((field) => field.name === 'waypoints');
    expect(waypoints?.map).toBe(true);
    expect(waypoints?.mapValueType).toBe('object');
    expect(waypoints?.mapValueMessageType).toBe('telecom.network.v1.GeoPoint');
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

describe.skipIf(!HAS_PROTOBUF)('proto static lints (catalog additions)', () => {
  const parse = (lines: string[]) => parseProtoSchema(lines.join('\n'), deps);
  const indexWarnings = (index: unknown): string[] => (index as { warnings?: string[] }).warnings ?? [];
  const opWarnings = (index: ReturnType<typeof parseProtoSchema>, method: string) =>
    index.operations.find((operation) => operation.method === method)?.warnings ?? [];

  const HTTP_PROTO = [
    'syntax = "proto3";',
    'package t;',
    'message Sub { string x = 1; }',
    'message Req { string name = 1; repeated Sub items = 2; map<string,string> tags = 3; Sub payload = 4; }',
    'message Res { string out = 1; }',
    'service S {',
    '  rpc A(Req) returns (Res) { option (google.api.http) = { get: "/v1/{name}" body: "payload" response_body: "missing" }; }',
    '  rpc B(Req) returns (Res) { option (google.api.http) = { get: "/v1/x" put: "/v1/y" }; }',
    '  rpc C(Req) returns (Res) { option (google.api.http) = { post: "v1/{items}" }; }',
    '  rpc D(Req) returns (Res) { option (google.api.http) = { get: "/v1/**/x/{name=a/*}" }; }',
    '  rpc E(Req) returns (Res) { option (google.api.http) = { get: "/v1/{name}/x" body: "name" }; }',
    '}'
  ];

  it('lints google.api.http rules: body on GET, query transcodability, response_body', () => {
    const index = parse(HTTP_PROTO);
    const a = opWarnings(index, 'A').join('\n');
    expect(a).toContain('GRPC_HTTP_BODY_ON_GET');
    expect(a).toContain('GRPC_HTTP_QUERY_FIELD_UNSUPPORTED');
    expect(a).toContain('field "items"');
    expect(a).toContain('map field "tags"');
    expect(a).toContain('GRPC_HTTP_RESPONSE_BODY_FIELD_UNKNOWN');
  });

  it('lints google.api.http rules: pattern oneof, template grammar, variable types, body/path overlap', () => {
    const index = parse(HTTP_PROTO);
    expect(opWarnings(index, 'B').join('\n')).toContain('GRPC_HTTP_RULE_PATTERN_CONFLICT');
    const c = opWarnings(index, 'C').join('\n');
    expect(c).toContain('GRPC_HTTP_PATH_TEMPLATE_INVALID');
    expect(c).toContain('must start with "/"');
    expect(c).toContain('GRPC_HTTP_PATH_VARIABLE_TYPE_INVALID');
    expect(opWarnings(index, 'D').join('\n')).toContain('uses "**" before the final path segment');
    expect(opWarnings(index, 'E').join('\n')).toContain('GRPC_HTTP_BODY_PATH_OVERLAP');
  });

  it('flags enum constants outside the int32 range', () => {
    const index = parse(['syntax = "proto3";', 'package t;', 'enum E { E_UNSPECIFIED = 0; E_BIG = 3000000000; }', 'message M { E e = 1; }', 'service S { rpc G(M) returns (M); }']);
    expect(indexWarnings(index).join('\n')).toContain('GRPC_ENUM_VALUE_RANGE');
  });

  it('flags malformed and overlapping enum reserved declarations', () => {
    const index = parse(['syntax = "proto3";', 'package t;', 'enum E { reserved 2 to 4; reserved 3 to 5; reserved 90 to 80; E_UNSPECIFIED = 0; }', 'message M { E e = 1; }', 'service S { rpc G(M) returns (M); }']);
    const warnings = indexWarnings(index).join('\n');
    expect(warnings).toContain('GRPC_RESERVED_DECLARATION_INVALID');
    expect(warnings).toContain('GRPC_RESERVED_RANGE_OVERLAP');
  });

  it('surfaces protobufjs rejection of enum reserved-value reuse as a parse failure (protoc parity)', () => {
    expect(() => parse(['syntax = "proto3";', 'package t;', 'enum E { reserved 2 to 4; E_UNSPECIFIED = 0; E_X = 3; }', 'message M { E e = 1; }', 'service S { rpc G(M) returns (M); }'])).toThrow(/PROTO_PARSE_FAILED/);
  });

  it('flags a syntax declaration that is not the first statement', () => {
    const index = parse(['package t;', 'syntax = "proto3";', 'message M { string a = 1; }', 'service S { rpc G(M) returns (M); }']);
    expect(indexWarnings(index).join('\n')).toContain('GRPC_SYNTAX_PLACEMENT_INVALID');
  });

  it('lints the import surface: duplicates, weak imports, unresolved disclosure', () => {
    const index = parse(['syntax = "proto3";', 'import "a.proto";', 'import "a.proto";', 'import weak "b.proto";', 'package t;', 'message M { string a = 1; }', 'service S { rpc G(M) returns (M); }']);
    const warnings = indexWarnings(index).join('\n');
    expect(warnings).toContain('GRPC_IMPORT_DUPLICATE');
    expect(warnings).toContain('GRPC_IMPORT_WEAK');
    expect(warnings).toContain('GRPC_IMPORT_UNRESOLVED_DISCLOSURE');
  });
});
