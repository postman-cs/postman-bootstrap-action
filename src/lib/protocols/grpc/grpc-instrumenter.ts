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
  repeated: boolean;
  map: boolean;
  required: boolean;
  // Well-known wrapper types allow a present-but-null value.
  nullable?: boolean;
  enumValues?: string[];
  // JSON type asserted on each map value.
  mapValueType?: string;
  // Nested message shape for object fields / repeated-message fields.
  shape?: ShapeSpec;
  // Nested message shape for map<K, message> values.
  mapValueShape?: ShapeSpec;
}

// A message shape: its assertable fields plus its multi-member oneof groups.
interface ShapeSpec {
  fields: FieldSpec[];
  oneofs: string[][];
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
    const spec: FieldSpec = {
      name: field.name,
      jsonName: field.jsonName,
      jsonType: field.jsonType,
      repeated: field.repeated,
      map: field.map,
      required: field.required,
      ...(field.nullable ? { nullable: true } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(field.mapValueType ? { mapValueType: field.mapValueType } : {})
    };
    if (field.messageType && field.jsonType === 'object' && !field.map) {
      spec.shape = buildShape(field.messageType, index, warnings, operationId, `${label}.${field.name}`, depth + 1, nextStack);
    }
    if (field.map && field.mapValueMessageType) {
      spec.mapValueShape = buildShape(field.mapValueMessageType, index, warnings, operationId, `${label}.${field.name}[]`, depth + 1, nextStack);
    }
    fields.push(spec);
  }
  return { fields, oneofs: message.oneofs };
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
    '  if (expected === "number") return typeof value === "number";',
    '  if (expected === "string") return typeof value === "string";',
    '  if (expected === "boolean") return typeof value === "boolean";',
    '  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);',
    '  if (expected === "array") return Array.isArray(value);',
    '  if (expected === "enum") return typeof value === "string" || typeof value === "number";',
    '  if (expected === "any") return true;',
    '  return true;',
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
    '      if (field.enumValues && field.enumValues.length > 0) { if (typeof elem === "number") continue; if (typeof elem !== "string") { pm.expect.fail("gRPC repeated enum field " + elemLabel + " must be a string or number but was " + jsonTypeOf(elem)); } else if (field.enumValues.indexOf(elem) === -1) { pm.expect.fail("gRPC repeated enum field " + elemLabel + " has value " + elem + " not in [" + field.enumValues.join(", ") + "]"); } continue; }',
    '      if (field.jsonType === "any") continue;',
    '      if (!matchesScalar(field.jsonType, elem)) pm.expect.fail("gRPC repeated field " + elemLabel + " must be " + field.jsonType + " but was " + jsonTypeOf(elem));',
    '    }',
    '    return;',
    '  }',
    '  if (field.map) {',
    '    if (!matchesScalar("object", value)) { pm.expect.fail("gRPC map field " + label + " must be an object but was " + jsonTypeOf(value)); return; }',
    '    if (field.mapValueType) { var keys = Object.keys(value); for (var k = 0; k < keys.length; k++) { var mv = value[keys[k]]; if (field.mapValueShape && matchesScalar("object", mv)) { grpcCheckShape(mv, field.mapValueShape, label + "[" + keys[k] + "]."); } else if (!matchesScalar(field.mapValueType, mv)) { pm.expect.fail("gRPC map value " + label + "[" + keys[k] + "] must be " + field.mapValueType + " but was " + jsonTypeOf(mv)); } } }',
    '    return;',
    '  }',
    '  if (field.enumValues && field.enumValues.length > 0) {',
    '    if (typeof value === "number") return;',
    '    if (typeof value === "string" && field.enumValues.indexOf(value) === -1) pm.expect.fail("gRPC enum field " + label + " has value " + value + " not in [" + field.enumValues.join(", ") + "]");',
    '    return;',
    '  }',
    '  if (field.jsonType === "any") return;',
    '  if (field.shape) { if (!matchesScalar("object", value)) { pm.expect.fail("gRPC field " + label + " must be an object but was " + jsonTypeOf(value)); return; } grpcCheckShape(value, field.shape, label + "."); return; }',
    '  if (!matchesScalar(field.jsonType, value)) pm.expect.fail("gRPC field " + label + " must be " + field.jsonType + " but was " + jsonTypeOf(value));',
    '}',
    'function grpcCheckShape(obj, shape, path) {',
    '  shape.fields.forEach(function (field) { grpcCheckField(obj, field, path); });',
    '  (shape.oneofs || []).forEach(function (group) {',
    '    var set = group.filter(function (n) { return obj[n] !== undefined && obj[n] !== null; });',
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
  switch (expected) {
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'enum': return typeof value === 'string' || typeof value === 'number';
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
    const present = Object.prototype.hasOwnProperty.call(record, field.name);
    if (field.required && !present) {
      warnings.push(`PROTO_REQUEST_BODY_INCOMPLETE: ${methodPath} generated request is missing required field ${field.name}`);
      continue;
    }
    if (!present) continue;
    const value = record[field.name];
    if (field.nullable && value === null) continue;
    if (field.repeated) {
      if (!Array.isArray(value)) warnings.push(`PROTO_REQUEST_FIELD_TYPE_MISMATCH: ${methodPath} request field ${field.name} must be an array`);
      continue;
    }
    if (field.jsonType === 'any' || field.enumValues || field.map || field.shape) continue;
    if (!matchesScalarValue(field.jsonType, value)) {
      warnings.push(`PROTO_REQUEST_FIELD_TYPE_MISMATCH: ${methodPath} request field ${field.name} must be ${field.jsonType}`);
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
