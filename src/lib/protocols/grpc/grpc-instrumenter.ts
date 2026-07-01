// Inject pm.test assertion scripts into a built gRPC v3/EC collection.
//
// Assertions, per recon assertionSurface (pm.response available after the
// grpc:status event; test script runs on the afterResponse phase):
//   1. terminal status code is OK (pm.response.code === 0 / status === 'OK').
//   2. response message shape vs the proto response message definition, walked
//      recursively into nested messages (bounded depth, cycle-guarded): proto2
//      `required` => presence asserted; proto3 fields => type asserted only when
//      present (no presence). Covers well-known-type JSON encodings, map value
//      types, and `oneof` mutual-exclusion (at most one member set).
//   3. a terminal-response-message expectation for unary and client-streaming
//      RPCs (exactly one message); server/bidi streaming may legitimately return
//      zero messages on an OK stream, so no minimum is asserted for them (a >= 1
//      assertion would false-fail a spec-legal empty stream).
// The request side is validated statically at instrumentation time (the generated
// request message content vs the request message definition), the gRPC analogue
// of the OAS CONTRACT_REQUEST_BODY_INCOMPLETE check.
//
// Discipline mirrors the OAS module (src/lib/spec/collection-contracts.ts): no
// silent drops. Anything that cannot be deterministically asserted emits a
// PROTO_*-prefixed warning carried on the instrumentation result.
//
// Grounding for the runtime surface used by the scripts:
//   - gRPC status codes 0..16: reporters/cli/modules/grpc.ts:15-21.
//   - pm.response.code/status, .json() (last message for streaming): recon
//     assertionSurface + grpc.ts:126,185-186.
//   - responseTime from grpc:status timings: summary.ts:436.

import type { GrpcContractIndex, GrpcMessageDescriptor, GrpcOperation, GrpcStreamKind } from './proto-parser.js';

type JsonRecord = Record<string, unknown>;

export interface GrpcInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

export const GRPC_INSTRUMENT_LIMITS = {
  maxTestScriptBytes: 900_000,
  maxCollectionUpdateBytes: 4_000_000
} as const;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Bounded recursion into nested messages so a cyclic or very deep proto does not
// blow the script size. Beyond the cap the field is asserted object-only.
const MAX_SHAPE_DEPTH = 5;

// Compact per-field assertion spec embedded in the generated script. We keep
// only what the runtime test needs so the script stays small and stable.
interface FieldSpec {
  name: string;
  // ProtoJSON field name; runtime response lookups try this first, then `name`.
  jsonName: string;
  jsonType: string;
  jsonFormat?: string;
  repeated: boolean;
  map: boolean;
  required: boolean;
  // Well-known wrapper types allow a present-but-null value.
  nullable?: boolean;
  enumValues?: string[];
  // Runtime kind the JSON string key must satisfy for an integral/bool-keyed map.
  mapKeyType?: string;
  // JSON type asserted on each map value.
  mapValueType?: string;
  mapValueFormat?: string;
  mapValueEnumValues?: string[];
  // Nested message shape for object fields / repeated-message fields.
  shape?: ShapeSpec;
  // Nested message shape for map<K, message> values.
  mapValueShape?: ShapeSpec;
}

// A oneof member carries both names so the runtime mutual-exclusion check can
// use the same jsonName-then-proto-name lookup as field checks.
interface OneofMemberSpec {
  jsonName: string;
  name: string;
}

// A message shape: its assertable fields plus its multi-member oneof groups.
interface ShapeSpec {
  fields: FieldSpec[];
  oneofs: OneofMemberSpec[][];
}

interface OperationSpec {
  id: string;
  methodPath: string;
  stream: GrpcStreamKind;
  responseType: string;
  responseShape?: ShapeSpec;
  // true when the response shape has at least one assertable field or oneof.
  hasResponseShape: boolean;
}

// Build a message shape descriptor, recursing into nested message fields up to
// MAX_SHAPE_DEPTH with a cycle guard on message full name. `label` names the
// slot (response / a field path) for no-silent-drop warnings.
function buildShape(
  messageFullName: string,
  index: GrpcContractIndex,
  warnings: string[],
  operationId: string,
  label: string,
  depth: number,
  stack: string[]
): ShapeSpec | undefined {
  const message: GrpcMessageDescriptor | undefined = index.messages[messageFullName];
  if (!message) {
    warnings.push(`PROTO_MESSAGE_UNKNOWN: ${operationId} ${label} message ${messageFullName} could not be resolved from the .proto; its shape is not asserted`);
    return undefined;
  }
  if (depth > MAX_SHAPE_DEPTH || stack.includes(messageFullName)) {
    warnings.push(`PROTO_NESTED_SHAPE_TRUNCATED: ${operationId} ${label} nesting into ${messageFullName} exceeded depth ${MAX_SHAPE_DEPTH} or is cyclic; deeper fields are asserted object-only`);
    return undefined;
  }

  const nextStack = [...stack, messageFullName];
  const fields: FieldSpec[] = [];
  for (const field of message.fields) {
    if (field.jsonType === 'unknown') {
      warnings.push(`PROTO_FIELD_NOT_ASSERTED: ${operationId} field ${message.fullName}.${field.name} has an unresolved type and is not asserted`);
      continue;
    }
    const enumValues = field.enumType ? index.enums[field.enumType] : undefined;
    const mapValueEnumValues = field.mapValueEnumType ? index.enums[field.mapValueEnumType] : undefined;
    const spec: FieldSpec = {
      name: field.name,
      jsonName: field.jsonName,
      jsonType: field.jsonType,
      ...(field.jsonFormat ? { jsonFormat: field.jsonFormat } : {}),
      repeated: field.repeated,
      map: field.map,
      required: field.required,
      ...(field.nullable ? { nullable: true } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(field.mapKeyType ? { mapKeyType: field.mapKeyType } : {}),
      ...(field.mapValueType ? { mapValueType: field.mapValueType } : {}),
      ...(field.mapValueFormat ? { mapValueFormat: field.mapValueFormat } : {}),
      ...(mapValueEnumValues ? { mapValueEnumValues } : {})
    };
    if (field.messageType && field.jsonType === 'object' && !field.map) {
      spec.shape = buildShape(field.messageType, index, warnings, operationId, `${label}.${field.name}`, depth + 1, nextStack);
    }
    if (field.map && field.mapValueMessageType) {
      spec.mapValueShape = buildShape(field.mapValueMessageType, index, warnings, operationId, `${label}.${field.name}[]`, depth + 1, nextStack);
    }
    fields.push(spec);
  }
  // oneof groups from the parser carry ProtoJSON names; pair each with its proto
  // name so the runtime check resolves members the same way field checks do.
  const protoNameByJsonName = new Map(message.fields.map((f) => [f.jsonName, f.name]));
  const oneofs: OneofMemberSpec[][] = message.oneofs.map((group) =>
    group.map((jsonName) => ({ jsonName, name: protoNameByJsonName.get(jsonName) ?? jsonName }))
  );
  return { fields, oneofs };
}

function shapeIsAssertable(shape: ShapeSpec | undefined): boolean {
  return Boolean(shape && (shape.fields.length > 0 || shape.oneofs.length > 0));
}

function buildOperationSpec(operation: GrpcOperation, index: GrpcContractIndex, warnings: string[]): OperationSpec {
  const responseShape = buildShape(operation.responseType, index, warnings, operation.id, 'response', 0, []);
  return {
    id: operation.id,
    methodPath: operation.methodPath,
    stream: operation.stream,
    responseType: operation.responseType,
    responseShape,
    hasResponseShape: shapeIsAssertable(responseShape)
  };
}

// The runtime test script. Written as plain ES5-ish strings to match the OAS
// module's generated-script style and run inside the Postman sandbox.
function createGrpcScript(spec: OperationSpec): string[] {
  return [
    `var grpcSpec = JSON.parse(${JSON.stringify(JSON.stringify(spec))});`,
    // Resolve the human-readable status name from the numeric code, matching
    // reporters/cli/modules/grpc.ts:15-21.
    'var GRPC_STATUS = { 0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND", 6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION", 10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED", 13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED" };',
    'function grpcStatusName() { if (typeof pm.response.status === "string" && pm.response.status) return pm.response.status; return GRPC_STATUS[pm.response.code] || ("UNKNOWN(" + pm.response.code + ")"); }',
    'function grpcMessage() { try { return pm.response.json(); } catch (error) { return undefined; } }',
    'function jsonTypeOf(value) {',
    '  if (value === null || value === undefined) return "null";',
    '  if (Array.isArray(value)) return "array";',
    '  return typeof value;',
    '}',
    'function matchesScalar(expected, value) {',
    '  function isJsonNumberString(text) { return typeof text === "string" && /^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text) && Number.isFinite(Number(text)); }',
    '  if (expected === "double") {',
    '    if (typeof value === "number") return Number.isFinite(value);',
    '    if (typeof value === "string") {',
    '      if (value === "NaN" || value === "Infinity" || value === "-Infinity") return true;',
    '      return isJsonNumberString(value);',
    '    }',
    '    return false;',
    '  }',
    '  if (expected === "number") {',
    '    if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value);',
    '    if (typeof value === "string") return isJsonNumberString(value) && Number.isInteger(Number(value));',
    '    return false;',
    '  }',
    '  if (expected === "string") return typeof value === "string";',
    '  if (expected === "boolean") return typeof value === "boolean";',
    '  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);',
    '  if (expected === "array") return Array.isArray(value);',
    '  if (expected === "enum") return typeof value === "string" || typeof value === "number";',
    '  if (expected === "any") return true;',
    '  return true;',
    '}',
    'function daysFromCivil(y, m, d) { y -= m <= 2 ? 1 : 0; var era = Math.floor(y / 400); var yoe = y - era * 400; var mp = m + (m > 2 ? -3 : 9); var doy = Math.floor((153 * mp + 2) / 5) + d - 1; var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; return era * 146097 + doe - 719468; }',
    'function validDate(y, m, d) { if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false; var mdays = [31, ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; return d <= mdays[m - 1]; }',
    'function validProtoTimestamp(value) { if (typeof value !== "string") return false; var m = value.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$/); if (!m) return false; var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), s = Number(m[6]); if (!validDate(y, mo, d) || h > 23 || mi > 59 || s > 59) return false; var off = 0; if (m[8] !== "Z") { var sign = m[8][0] === "-" ? -1 : 1; var oh = Number(m[8].slice(1, 3)), om = Number(m[8].slice(4, 6)); if (oh > 23 || om > 59) return false; off = sign * (oh * 3600 + om * 60); } var sec = daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - off; return sec >= -62135596800 && sec <= 253402300799; }',
    'function validProtoDuration(value) { if (typeof value !== "string") return false; var m = value.match(/^[+-]?(?:(0|[1-9][0-9]*)(?:\\.[0-9]{0,9})?|\\.[0-9]{0,9})s$/); if (!m) return false; return !m[1] || Number(m[1]) <= 315576000000; }',
    'function validProtoFieldMask(value) { if (typeof value !== "string") return false; if (value === "") return true; var paths = value.split(","); for (var i = 0; i < paths.length; i++) { if (!/^[a-z][A-Za-z0-9]*(\\.[a-z][A-Za-z0-9]*)*$/.test(paths[i])) return false; } return true; }',
    'function validProtoBytes(value) { if (typeof value !== "string") return false; if (!/^(?:[A-Za-z0-9+/]*|[A-Za-z0-9_-]*)={0,2}$/.test(value)) return false; var firstPad = value.indexOf("="); if (firstPad !== -1 && firstPad < value.length - (value.endsWith("==") ? 2 : 1)) return false; var pad = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0; var raw = value.length - pad; if (raw % 4 === 1) return false; return pad === 0 || (raw + pad) % 4 === 0 && pad === (4 - raw % 4) % 4; }',
    'function matchesFormat(format, value) {',
    '  if (!format) return true;',
    '  if (format === "proto-timestamp") return validProtoTimestamp(value);',
    '  if (format === "proto-duration") return validProtoDuration(value);',
    '  if (format === "proto-field-mask") return validProtoFieldMask(value);',
    '  if (format === "proto-bytes") return validProtoBytes(value);',
    '  return true;',
    '}',
    'function formatLabel(format) {',
    '  if (format === "proto-timestamp") return "a valid ProtoJSON Timestamp";',
    '  if (format === "proto-duration") return "a valid ProtoJSON Duration";',
    '  if (format === "proto-field-mask") return "a valid ProtoJSON FieldMask";',
    '  if (format === "proto-bytes") return "valid ProtoJSON base64 bytes";',
    '  return format || "valid ProtoJSON";',
    '}',
    // Recursive shape checker: validates fields (with nested message descent,
    // map value typing, enums, well-known nullable scalars) and oneof
    // mutual-exclusion. `path` is a human-readable prefix for failure messages.
    'function grpcFieldKey(obj, field) { if (Object.prototype.hasOwnProperty.call(obj, field.jsonName)) return field.jsonName; if (Object.prototype.hasOwnProperty.call(obj, field.name)) return field.name; return undefined; }',
    'function grpcCheckField(obj, field, path) {',
    '  var label = path + (field.jsonName || field.name);',
    '  var key = grpcFieldKey(obj, field);',
    '  var present = key !== undefined;',
    '  if (field.required && !present) { pm.expect.fail("gRPC response is missing required field " + label); return; }',
    '  if (!present) return;',
    '  var value = obj[key];',
    '  if (field.nullable && value === null) return;',
    '  if (field.repeated) {',
    '    if (!matchesScalar("array", value)) { pm.expect.fail("gRPC field " + label + " must be a repeated (array) value but was " + jsonTypeOf(value)); return; }',
    '    for (var i = 0; i < value.length; i++) {',
    '      var elem = value[i]; var elemLabel = label + "[" + i + "]";',
    '      if (field.shape) { if (!matchesScalar("object", elem)) { pm.expect.fail("gRPC repeated field " + elemLabel + " must be an object but was " + jsonTypeOf(elem)); } else { grpcCheckShape(elem, field.shape, elemLabel + "."); } continue; }',
    '      if (field.enumValues && field.enumValues.length > 0) { if (typeof elem === "number") { if (!Number.isInteger(elem)) pm.expect.fail("gRPC repeated enum field " + elemLabel + " must be an integer but was " + elem); continue; } if (typeof elem !== "string") { pm.expect.fail("gRPC repeated enum field " + elemLabel + " must be a string or number but was " + jsonTypeOf(elem)); } else if (field.enumValues.indexOf(elem) === -1) { pm.expect.fail("gRPC repeated enum field " + elemLabel + " has value " + elem + " not in [" + field.enumValues.join(", ") + "]"); } continue; }',
    '      if (field.jsonType === "any") continue;',
    '      if (!matchesScalar(field.jsonType, elem)) pm.expect.fail("gRPC repeated field " + elemLabel + " must be " + field.jsonType + " but was " + jsonTypeOf(elem));',
    '      else if (!matchesFormat(field.jsonFormat, elem)) pm.expect.fail("gRPC repeated field " + elemLabel + " must be " + formatLabel(field.jsonFormat));',
    '    }',
    '    return;',
    '  }',
    '  if (field.map) {',
    '    if (!matchesScalar("object", value)) { pm.expect.fail("gRPC map field " + label + " must be an object but was " + jsonTypeOf(value)); return; }',
    '    var keys = Object.keys(value);',
    '    for (var k = 0; k < keys.length; k++) {',
    '      var mk = keys[k], mv = value[mk], mvLabel = label + "[" + mk + "]";',
    '      if (field.mapKeyType === "integer") { if (!/^-?[0-9]+$/.test(mk)) pm.expect.fail("gRPC map key " + mvLabel + " must be an integer string but was " + mk); }',
    '      else if (field.mapKeyType === "boolean") { if (mk !== "true" && mk !== "false") pm.expect.fail("gRPC map key " + mvLabel + " must be the string true or false but was " + mk); }',
    '      if (field.mapValueShape && matchesScalar("object", mv)) { grpcCheckShape(mv, field.mapValueShape, mvLabel + "."); }',
    '      else if (field.mapValueEnumValues && field.mapValueEnumValues.length > 0) { if (typeof mv === "number") { if (!Number.isInteger(mv)) pm.expect.fail("gRPC map enum value " + mvLabel + " must be an integer but was " + mv); } else if (typeof mv !== "string") { pm.expect.fail("gRPC map enum value " + mvLabel + " must be a string or number but was " + jsonTypeOf(mv)); } else if (field.mapValueEnumValues.indexOf(mv) === -1) { pm.expect.fail("gRPC map enum value " + mvLabel + " has value " + mv + " not in [" + field.mapValueEnumValues.join(", ") + "]"); } }',
    '      else if (field.mapValueType && !matchesScalar(field.mapValueType, mv)) { pm.expect.fail("gRPC map value " + mvLabel + " must be " + field.mapValueType + " but was " + jsonTypeOf(mv)); }',
    '      else if (field.mapValueType && !matchesFormat(field.mapValueFormat, mv)) { pm.expect.fail("gRPC map value " + mvLabel + " must be " + formatLabel(field.mapValueFormat)); }',
    '    }',
    '    return;',
    '  }',
    '  if (field.enumValues && field.enumValues.length > 0) {',
    '    if (typeof value === "number") { if (!Number.isInteger(value)) pm.expect.fail("gRPC enum field " + label + " must be an integer but was " + value); return; }',
    '    if (typeof value !== "string") { pm.expect.fail("gRPC enum field " + label + " must be a string or number but was " + jsonTypeOf(value)); return; }',
    '    if (field.enumValues.indexOf(value) === -1) pm.expect.fail("gRPC enum field " + label + " has value " + value + " not in [" + field.enumValues.join(", ") + "]");',
    '    return;',
    '  }',
    '  if (field.jsonType === "any") return;',
    '  if (field.shape) { if (!matchesScalar("object", value)) { pm.expect.fail("gRPC field " + label + " must be an object but was " + jsonTypeOf(value)); return; } grpcCheckShape(value, field.shape, label + "."); return; }',
    '  if (!matchesScalar(field.jsonType, value)) pm.expect.fail("gRPC field " + label + " must be " + field.jsonType + " but was " + jsonTypeOf(value));',
    '  else if (!matchesFormat(field.jsonFormat, value)) pm.expect.fail("gRPC field " + label + " must be " + formatLabel(field.jsonFormat));',
    '}',
    'function grpcCheckShape(obj, shape, path) {',
    '  shape.fields.forEach(function (field) { grpcCheckField(obj, field, path); });',
    '  (shape.oneofs || []).forEach(function (group) {',
    '    var set = group.filter(function (m) { var k = grpcFieldKey(obj, m); return k !== undefined && obj[k] !== null; }).map(function (m) { return m.jsonName; });',
    '    if (set.length > 1) pm.expect.fail("gRPC response at " + path + " sets multiple members of a oneof: " + set.join(", "));',
    '  });',
    '}',
    `pm.test('gRPC status is OK for ' + grpcSpec.methodPath, function () {`,
    '  pm.expect(pm.response.code, "gRPC call for " + grpcSpec.methodPath + " returned " + grpcStatusName() + " (" + pm.response.code + ")").to.eql(0);',
    '});',
    // Terminal-response-message expectation. unary and client-streaming RPCs
    // return exactly one terminal response message; server/bidi streaming may
    // legitimately return ZERO messages on an OK stream, so no minimum is
    // asserted for them (a >= 1 check would false-fail an empty OK stream).
    ...((spec.stream === 'unary' || spec.stream === 'client') ? [
      `pm.test('gRPC ${spec.stream} RPC returns a terminal response message for ' + grpcSpec.methodPath, function () {`,
      '  if (pm.response.code !== 0) return;',
      '  pm.expect(grpcMessage(), grpcSpec.stream + " RPC " + grpcSpec.methodPath + " must return exactly one terminal response message").to.be.an("object");',
      '});'
    ] : []),
    ...(spec.hasResponseShape ? [
      `pm.test('gRPC response message matches ' + grpcSpec.responseType, function () {`,
      '  if (pm.response.code !== 0) return;',
      '  var message = grpcMessage();',
      // An empty OK server/bidi stream has no terminal message to shape-check;
      // that is spec-legal, so skip rather than false-fail on a missing message.
      '  if ((grpcSpec.stream === "server" || grpcSpec.stream === "bidi") && (message === undefined || message === null)) return;',
      '  pm.expect(message, "gRPC response for " + grpcSpec.methodPath + " is not a decodable message object").to.be.an("object");',
      '  grpcCheckShape(message, grpcSpec.responseShape, grpcSpec.responseType + ".");',
      '});'
    ] : [])
  ];
}

function createMappingFailureScript(message: string): string[] {
  return [
    `var grpcMappingError = ${JSON.stringify(message)};`,
    "pm.test('gRPC operation mapping exists', function () {",
    '  pm.expect.fail(grpcMappingError);',
    '});'
  ];
}

// Map a grpc-request item to its operation via methodPath (the canonical,
// unambiguous key the runtime invokes with).
function methodPathOf(item: JsonRecord): string {
  const payload = asRecord(item.payload);
  const value = payload?.methodPath;
  return typeof value === 'string' ? value : '';
}

function matchesScalarValue(expected: string, value: unknown): boolean {
  const isJsonNumberString = (text: string): boolean =>
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text) && Number.isFinite(Number(text));
  switch (expected) {
    case 'double': {
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'string') {
        if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') return true;
        return isJsonNumberString(value);
      }
      return false;
    }
    case 'number': {
      if (typeof value === 'number') return Number.isFinite(value) && Number.isInteger(value);
      if (typeof value === 'string') return isJsonNumberString(value) && Number.isInteger(Number(value));
      return false;
    }
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'enum': return typeof value === 'string' || typeof value === 'number';
    default: return true;
  }
}

function daysFromCivil(year: number, month: number, day: number): number {
  let y = year;
  y -= month <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const shiftedMonth = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= monthDays[month - 1];
}

function validProtoTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return false;
  let offsetSeconds = 0;
  const zone = match[8] ?? 'Z';
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offsetSeconds = (zone[0] === '-' ? -1 : 1) * (offsetHour * 3600 + offsetMinute * 60);
  }
  const utcSeconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds;
  return utcSeconds >= -62135596800 && utcSeconds <= 253402300799;
}

function validProtoDuration(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = value.match(/^[+-]?(?:(0|[1-9][0-9]*)(?:\.[0-9]{0,9})?|\.[0-9]{0,9})s$/);
  return Boolean(match && (!match[1] || Number(match[1]) <= 315576000000));
}

function validProtoFieldMask(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === '') return true;
  return value.split(',').every((path) => /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/.test(path));
}

function validProtoBytes(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!/^(?:[A-Za-z0-9+/]*|[A-Za-z0-9_-]*)={0,2}$/.test(value)) return false;
  const firstPad = value.indexOf('=');
  if (firstPad !== -1 && firstPad < value.length - (value.endsWith('==') ? 2 : 1)) return false;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const raw = value.length - pad;
  if (raw % 4 === 1) return false;
  return pad === 0 || ((raw + pad) % 4 === 0 && pad === (4 - raw % 4) % 4);
}

function matchesFormatValue(format: string | undefined, value: unknown): boolean {
  switch (format) {
    case undefined: return true;
    case 'proto-timestamp': return validProtoTimestamp(value);
    case 'proto-duration': return validProtoDuration(value);
    case 'proto-field-mask': return validProtoFieldMask(value);
    case 'proto-bytes': return validProtoBytes(value);
    default: return true;
  }
}

// Static request-side check: validate the generated request message content
// against the request message definition at instrumentation time (top-level, the
// gRPC analogue of the OAS CONTRACT_REQUEST_BODY_INCOMPLETE check). Bodies that
// carry Postman template variables are skipped.
function staticRequestCheck(
  item: JsonRecord,
  shape: ShapeSpec | undefined,
  methodPath: string,
  warnings: string[]
): void {
  if (!shape) return;
  const message = asRecord(asRecord(item.payload)?.message);
  const raw = typeof message?.content === 'string' ? message.content : '';
  if (!raw.trim()) return;
  if (/\{\{[^}]+\}\}|<[a-zA-Z]/.test(raw)) return; // placeholder / template body
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    warnings.push(`PROTO_REQUEST_BODY_INVALID_JSON: ${methodPath} generated request message content is not valid JSON and is not validated`);
    return;
  }
  const record = asRecord(body);
  if (!record) return;
  for (const field of shape.fields) {
    const key = Object.prototype.hasOwnProperty.call(record, field.jsonName)
      ? field.jsonName
      : Object.prototype.hasOwnProperty.call(record, field.name)
        ? field.name
        : undefined;
    const present = key !== undefined;
    if (field.required && !present) {
      warnings.push(`PROTO_REQUEST_BODY_INCOMPLETE: ${methodPath} generated request is missing required field ${field.name}`);
      continue;
    }
    if (!present) continue;
    const value = record[key];
    if (field.nullable && value === null) continue;
    if (field.repeated) {
      if (!Array.isArray(value)) warnings.push(`PROTO_REQUEST_FIELD_TYPE_MISMATCH: ${methodPath} request field ${field.name} must be an array`);
      continue;
    }
    if (field.jsonType === 'any' || field.enumValues || field.map || field.shape) continue;
    if (!matchesScalarValue(field.jsonType, value)) {
      warnings.push(`PROTO_REQUEST_FIELD_TYPE_MISMATCH: ${methodPath} request field ${field.name} must be ${field.jsonType}`);
    } else if (!matchesFormatValue(field.jsonFormat, value)) {
      warnings.push(`PROTO_REQUEST_FIELD_FORMAT_MISMATCH: ${methodPath} request field ${field.name} is not valid ${field.jsonFormat}`);
    }
  }
}

export function instrumentGrpcCollection(collection: JsonRecord, index: GrpcContractIndex): GrpcInstrumentationResult {
  const warnings = [...index.warnings, ...index.operations.flatMap((operation) => operation.warnings)];
  const specs = new Map<string, OperationSpec>();
  const requestShapes = new Map<string, ShapeSpec | undefined>();
  for (const operation of index.operations) {
    specs.set(operation.methodPath, buildOperationSpec(operation, index, warnings));
    requestShapes.set(operation.methodPath, buildShape(operation.requestType, index, warnings, operation.id, 'request', 0, []));
  }

  const covered = new Map<string, string>();

  const inject = (item: JsonRecord): void => {
    if (item.type === 'grpc-request') {
      const methodPath = methodPathOf(item);
      const spec = specs.get(methodPath);
      let script: string[];
      if (spec) {
        const previous = covered.get(methodPath);
        if (previous) {
          throw new Error(`PROTO_DUPLICATE_OPERATION_REQUEST: ${methodPath} matched more than one generated grpc-request (${previous}, ${String(item.name ?? item.title ?? '<unnamed>')})`);
        }
        covered.set(methodPath, String(item.name ?? item.title ?? '<unnamed>'));
        staticRequestCheck(item, requestShapes.get(methodPath), methodPath, warnings);
        script = createGrpcScript(spec);
      } else {
        script = createMappingFailureScript(`No proto service method matched grpc-request methodPath ${methodPath || '<empty>'}`);
      }
      const scriptBytes = Buffer.byteLength(script.join('\n'), 'utf8');
      if (scriptBytes > GRPC_INSTRUMENT_LIMITS.maxTestScriptBytes) {
        throw new Error(`PROTO_SCRIPT_SIZE_EXCEEDED: generated test script for ${methodPath} exceeded ${GRPC_INSTRUMENT_LIMITS.maxTestScriptBytes} bytes`);
      }
      const events = asArray(item.event).filter((entry) => asRecord(entry)?.listen !== 'test');
      item.event = [...events, { listen: 'test', script: { type: 'text/javascript', exec: script } }];
    }
    for (const child of asArray(item.item)) {
      const childRecord = asRecord(child);
      if (childRecord) inject(childRecord);
    }
  };

  for (const entry of asArray(collection.item)) {
    const item = asRecord(entry);
    if (item) inject(item);
  }

  const missing = index.operations.filter((operation) => !covered.has(operation.methodPath));
  if (missing.length > 0) {
    throw new Error(`PROTO_OPERATION_COVERAGE_FAILED: gRPC collection is missing generated grpc-request coverage for ${missing.map((operation) => operation.methodPath).join(', ')}`);
  }

  const bytes = Buffer.byteLength(JSON.stringify(collection), 'utf8');
  if (bytes > GRPC_INSTRUMENT_LIMITS.maxCollectionUpdateBytes) {
    throw new Error(`PROTO_COLLECTION_SIZE_EXCEEDED: instrumented gRPC collection exceeded ${GRPC_INSTRUMENT_LIMITS.maxCollectionUpdateBytes} bytes`);
  }

  return { collection, warnings };
}
