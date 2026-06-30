// Inject pm.test assertion scripts into a built gRPC v3/EC collection.
//
// Assertions, per recon assertionSurface (pm.response available after the
// grpc:status event; test script runs on the afterResponse phase):
//   1. terminal status code is OK (pm.response.code === 0 / status === 'OK').
//   2. response message field presence + JSON type vs the proto response
//      message definition (proto2 `required` => presence asserted; proto3
//      fields => type asserted only when present, since proto3 has no presence).
//   3. streaming message-count expectations (server/client/bidi) using the
//      stream-count surfaced on the execution/response.
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

// Compact per-field assertion spec embedded in the generated script. We keep
// only what the runtime test needs so the script stays small and stable.
interface FieldSpec {
  name: string;
  jsonType: string;
  repeated: boolean;
  map: boolean;
  required: boolean;
  enumValues?: string[];
}

interface OperationSpec {
  id: string;
  methodPath: string;
  stream: GrpcStreamKind;
  responseType: string;
  responseFields: FieldSpec[];
  // true when at least one field is statically assertable; drives whether the
  // field-shape test is emitted.
  hasResponseShape: boolean;
}

function fieldSpecs(message: GrpcMessageDescriptor | undefined, index: GrpcContractIndex, warnings: string[], operationId: string): { fields: FieldSpec[]; hasShape: boolean } {
  if (!message) {
    warnings.push(`PROTO_RESPONSE_MESSAGE_UNKNOWN: ${operationId} response message could not be resolved from the .proto; response field shape is not asserted`);
    return { fields: [], hasShape: false };
  }
  const fields: FieldSpec[] = [];
  let assertable = false;
  for (const field of message.fields) {
    if (field.jsonType === 'unknown') {
      warnings.push(`PROTO_FIELD_NOT_ASSERTED: ${operationId} response field ${message.fullName}.${field.name} has an unresolved type and is not asserted`);
      continue;
    }
    const enumValues = field.enumType ? index.enums[field.enumType] : undefined;
    fields.push({
      name: field.name,
      jsonType: field.jsonType,
      repeated: field.repeated,
      map: field.map,
      required: field.required,
      ...(enumValues ? { enumValues } : {})
    });
    assertable = true;
  }
  return { fields, hasShape: assertable };
}

function buildOperationSpec(operation: GrpcOperation, index: GrpcContractIndex, warnings: string[]): OperationSpec {
  const message = index.messages[operation.responseType];
  const { fields, hasShape } = fieldSpecs(message, index, warnings, operation.id);
  return {
    id: operation.id,
    methodPath: operation.methodPath,
    stream: operation.stream,
    responseType: operation.responseType,
    responseFields: fields,
    hasResponseShape: hasShape
  };
}

// The runtime test script. Written as plain ES5-ish strings to match the OAS
// module's generated-script style and run inside the Postman sandbox.
function createGrpcScript(spec: OperationSpec): string[] {
  const streamCountExpectation = (() => {
    switch (spec.stream) {
      case 'unary': return 1;       // exactly one response message
      case 'server': return 1;      // server-streaming: at least one
      case 'client': return 1;      // client-streaming: single terminal response
      case 'bidi': return 1;        // bidi: at least one
      default: return 1;
    }
  })();

  return [
    `var grpcSpec = JSON.parse(${JSON.stringify(JSON.stringify(spec))});`,
    `var grpcMinMessages = ${streamCountExpectation};`,
    // Resolve the human-readable status name from the numeric code, matching
    // reporters/cli/modules/grpc.ts:15-21.
    'var GRPC_STATUS = { 0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT", 4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND", 6: "ALREADY_EXISTS", 7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION", 10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED", 13: "INTERNAL", 14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED" };',
    'function grpcStatusName() { if (typeof pm.response.status === "string" && pm.response.status) return pm.response.status; return GRPC_STATUS[pm.response.code] || ("UNKNOWN(" + pm.response.code + ")"); }',
    'function grpcMessage() { try { return pm.response.json(); } catch (error) { return undefined; } }',
    // Stream message count is surfaced by the runtime on the execution; fall
    // back to 1 when the response carries a single message object so unary
    // assertions still hold.
    'function grpcMessageCount() {',
    '  var count;',
    '  try { count = pm.response && pm.response.stream && typeof pm.response.stream.count === "number" ? pm.response.stream.count : undefined; } catch (ignored) {}',
    '  if (typeof count !== "number") { var msg = grpcMessage(); count = (msg === undefined || msg === null) ? 0 : 1; }',
    '  return count;',
    '}',
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
    '  return true;',
    '}',
    `pm.test('gRPC status is OK for ' + grpcSpec.methodPath, function () {`,
    '  pm.expect(pm.response.code, "gRPC call for " + grpcSpec.methodPath + " returned " + grpcStatusName() + " (" + pm.response.code + ")").to.eql(0);',
    '});',
    // Message-count expectation by stream kind.
    `pm.test('gRPC message count for ' + grpcSpec.methodPath, function () {`,
    '  if (pm.response.code !== 0) return;',
    '  var count = grpcMessageCount();',
    '  if (grpcSpec.stream === "unary" || grpcSpec.stream === "client") {',
    '    pm.expect(count, grpcSpec.stream + " RPC " + grpcSpec.methodPath + " must return exactly one response message").to.eql(1);',
    '  } else {',
    '    pm.expect(count, grpcSpec.stream + "-streaming RPC " + grpcSpec.methodPath + " must return at least " + grpcMinMessages + " response message(s)").to.be.at.least(grpcMinMessages);',
    '  }',
    '});',
    ...(spec.hasResponseShape ? [
      `pm.test('gRPC response message matches ' + grpcSpec.responseType, function () {`,
      '  if (pm.response.code !== 0) return;',
      '  var message = grpcMessage();',
      '  pm.expect(message, "gRPC response for " + grpcSpec.methodPath + " is not a decodable message object").to.be.an("object");',
      '  grpcSpec.responseFields.forEach(function (field) {',
      '    var present = Object.prototype.hasOwnProperty.call(message, field.name);',
      // proto2 required => presence asserted; proto3 has no presence semantics
      // so absent fields are allowed (they carry proto defaults).
      '    if (field.required && !present) { pm.expect.fail("gRPC response for " + grpcSpec.methodPath + " is missing required field " + field.name + " of " + grpcSpec.responseType); return; }',
      '    if (!present) return;',
      '    var value = message[field.name];',
      '    if (field.repeated) { if (!matchesScalar("array", value)) pm.expect.fail("gRPC field " + field.name + " of " + grpcSpec.responseType + " must be a repeated (array) value but was " + jsonTypeOf(value)); return; }',
      '    if (field.map) { if (!matchesScalar("object", value)) pm.expect.fail("gRPC map field " + field.name + " of " + grpcSpec.responseType + " must be an object but was " + jsonTypeOf(value)); return; }',
      '    if (field.enumValues && field.enumValues.length > 0) {',
      '      if (typeof value === "number") return;',
      '      if (typeof value === "string" && field.enumValues.indexOf(value) === -1) pm.expect.fail("gRPC enum field " + field.name + " of " + grpcSpec.responseType + " has value " + value + " not in [" + field.enumValues.join(", ") + "]");',
      '      return;',
      '    }',
      '    if (!matchesScalar(field.jsonType, value)) pm.expect.fail("gRPC field " + field.name + " of " + grpcSpec.responseType + " must be " + field.jsonType + " but was " + jsonTypeOf(value));',
      '  });',
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

export function instrumentGrpcCollection(collection: JsonRecord, index: GrpcContractIndex): GrpcInstrumentationResult {
  const warnings = [...index.warnings, ...index.operations.flatMap((operation) => operation.warnings)];
  const specs = new Map<string, OperationSpec>();
  for (const operation of index.operations) {
    specs.set(operation.methodPath, buildOperationSpec(operation, index, warnings));
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
        script = createGrpcScript(spec);
      } else {
        script = createMappingFailureScript(`No proto service method matched grpc-request methodPath ${methodPath || '<empty>'}`);
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
