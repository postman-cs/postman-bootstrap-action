// Protocol Buffers (.proto) -> typed gRPC contract index.
//
// Parsing uses protobufjs `parse`, which yields a reflection `Root` whose
// nested objects we walk into a flat, deterministic contract index. The index
// is the single source of truth consumed by the builder (one grpc-request per
// RPC method) and the instrumenter (field/type assertions vs the response
// message definition). Nothing here is Postman-specific; it is pure proto
// reflection -> plain data.
//
// Grounding: the v3/EC executable item type is `grpc-request` (postman-cli
// lib/run/unified/run.ts:17-19 SUPPORTED_ITEM_TYPES). Method streaming flags
// and request/response message names come straight from the proto service
// definition, which is what the runtime invokes against.

type JsonRecord = Record<string, unknown>;

// Statically imported so esbuild bundles the parser into the published `dist/`
// (the action ships only the bundle, not node_modules). Uses the Postman fork
// `@postman/protobufjs`, which aligns descriptor parsing with our gRPC
// stack (same 7.5.x reflection surface). Tests can still inject a double via the
// `custom` parameter of `loadProtoModule` / `deps.protobuf` of `parseProtoSchema`.
import * as protobufjs from '@postman/protobufjs';

// Mirrors the protobufjs reflection surface we depend on, kept minimal so the
// parser stays decoupled from the concrete dependency version and so the same
// code path works whether the dependency resolves to `protobufjs` or
// `@postman/protobufjs` (the runtime fork). We only read; we never construct.
export interface ProtoParseModule {
  parse(source: string, options?: { keepCase?: boolean; alternateCommentMode?: boolean }): { root: ProtoNamespace; package: string | undefined };
  Root: new () => ProtoNamespace;
  Service: unknown;
  Type: unknown;
  Enum: unknown;
  Method: unknown;
}

interface ProtoNamespace {
  fullName: string;
  nestedArray?: ProtoReflectionObject[];
  resolveAll?(): ProtoNamespace;
  lookup?(path: string): ProtoReflectionObject | null;
}

interface ProtoOneof {
  name: string;
  fieldsArray?: ProtoField[];
}

interface ProtoReflectionObject {
  name: string;
  fullName: string;
  nestedArray?: ProtoReflectionObject[];
  // Service
  methodsArray?: ProtoMethod[];
  // Type (message)
  fieldsArray?: ProtoField[];
  oneofsArray?: ProtoOneof[];
  // Enum
  values?: Record<string, number>;
  comment?: string | null;
}

interface ProtoMethod {
  name: string;
  fullName: string;
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
  resolvedRequestType?: ProtoReflectionObject | null;
  resolvedResponseType?: ProtoReflectionObject | null;
  comment?: string | null;
  resolve?(): ProtoMethod;
}

interface ProtoField {
  name: string;
  type: string;
  id: number;
  repeated?: boolean;
  map?: boolean;
  required?: boolean;
  optional?: boolean;
  keyType?: string;
  comment?: string | null;
  jsonName?: string;
  options?: Record<string, unknown> | null;
  resolvedType?: ProtoReflectionObject | null;
  resolve?(): ProtoField;
}

export type GrpcStreamKind = 'unary' | 'server' | 'client' | 'bidi';

// Proto scalar wire types we can deterministically assert on the JSON-encoded
// response. protobufjs surfaces 64-bit ints as strings by default, which we
// reflect in `jsonType`.
// `any` is a value whose JSON type cannot be constrained (google.protobuf.Value):
// present-only, no runtime type assertion.
export type GrpcJsonType = 'number' | 'string' | 'boolean' | 'object' | 'array' | 'enum' | 'any' | 'unknown';

export interface GrpcFieldDescriptor {
  name: string;
  // ProtoJSON field name (json_name option or lowerCamelCase of `name`); gRPC
  // responses key by this, so runtime lookups try it first, then `name`.
  jsonName: string;
  protoType: string;
  jsonType: GrpcJsonType;
  repeated: boolean;
  map: boolean;
  // proto3 explicit `optional` or proto2 `optional`: presence is not asserted.
  optional: boolean;
  // proto2 `required`: presence IS asserted.
  required: boolean;
  // Well-known wrapper types (google.protobuf.*Value) JSON-encode as a nullable
  // scalar, so a present-but-null value is legal and skips the type assertion.
  nullable?: boolean;
  // For message-typed fields, the fully-qualified message name (for nested
  // shape reference); undefined for scalars/enums/well-known scalar mappings.
  messageType?: string;
  enumType?: string;
  // For map<K,V> fields, the JSON type asserted on each map value.
  mapValueType?: GrpcJsonType;
  // For map<K,V> fields whose value is a message, the value message name (for
  // nested shape reference).
  mapValueMessageType?: string;
}

export interface GrpcMessageDescriptor {
  name: string;
  fullName: string;
  fields: GrpcFieldDescriptor[];
  // Non-synthetic oneof groups (>= 2 members): at most one member may be set.
  oneofs: string[][];
}

export interface GrpcOperation {
  id: string;
  service: string;
  serviceFullName: string;
  method: string;
  // `package.Service/Method` — the runtime payload `methodPath`.
  methodPath: string;
  stream: GrpcStreamKind;
  requestType: string;
  responseType: string;
  warnings: string[];
}

export interface GrpcContractIndex {
  package: string;
  operations: GrpcOperation[];
  messages: Record<string, GrpcMessageDescriptor>;
  enums: Record<string, string[]>;
  warnings: string[];
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const SCALAR_JSON_TYPE: Record<string, GrpcJsonType> = {
  double: 'number',
  float: 'number',
  int32: 'number',
  sint32: 'number',
  sfixed32: 'number',
  fixed32: 'number',
  uint32: 'number',
  // 64-bit integers are JSON-encoded as strings by the proto JSON mapping and
  // by protobufjs default toObject, so we assert `string`.
  int64: 'string',
  uint64: 'string',
  sint64: 'string',
  fixed64: 'string',
  sfixed64: 'string',
  bool: 'boolean',
  string: 'string',
  // bytes are base64 strings in proto JSON.
  bytes: 'string'
};

// google.protobuf well-known types have a canonical proto3-JSON encoding that is
// NOT a plain object; treating them as ordinary messages (object) mis-asserts
// the runtime shape. `nullable` marks the wrapper types, which JSON-encode as a
// nullable scalar. Struct/Empty/Any encode as objects but carry no fixed field
// shape, so they map to `object` with no nested descent (messageType undefined).
// grounding: https://protobuf.dev/programming-guides/json/
const WELL_KNOWN_JSON_TYPE: Record<string, { jsonType: GrpcJsonType; nullable?: boolean }> = {
  'google.protobuf.Timestamp': { jsonType: 'string' },
  'google.protobuf.Duration': { jsonType: 'string' },
  'google.protobuf.FieldMask': { jsonType: 'string' },
  'google.protobuf.DoubleValue': { jsonType: 'number', nullable: true },
  'google.protobuf.FloatValue': { jsonType: 'number', nullable: true },
  'google.protobuf.Int32Value': { jsonType: 'number', nullable: true },
  'google.protobuf.UInt32Value': { jsonType: 'number', nullable: true },
  'google.protobuf.Int64Value': { jsonType: 'string', nullable: true },
  'google.protobuf.UInt64Value': { jsonType: 'string', nullable: true },
  'google.protobuf.BoolValue': { jsonType: 'boolean', nullable: true },
  'google.protobuf.StringValue': { jsonType: 'string', nullable: true },
  'google.protobuf.BytesValue': { jsonType: 'string', nullable: true },
  'google.protobuf.Struct': { jsonType: 'object' },
  'google.protobuf.Empty': { jsonType: 'object' },
  'google.protobuf.Any': { jsonType: 'object' },
  'google.protobuf.Value': { jsonType: 'any' },
  'google.protobuf.ListValue': { jsonType: 'array' }
};

function streamKind(requestStream: boolean, responseStream: boolean): GrpcStreamKind {
  if (requestStream && responseStream) return 'bidi';
  if (responseStream) return 'server';
  if (requestStream) return 'client';
  return 'unary';
}

function isService(obj: ProtoReflectionObject): boolean {
  return Array.isArray(obj.methodsArray);
}

function isMessageType(obj: ProtoReflectionObject): boolean {
  return Array.isArray(obj.fieldsArray);
}

function isEnum(obj: ProtoReflectionObject): boolean {
  return Boolean(obj.values) && !Array.isArray(obj.fieldsArray) && !Array.isArray(obj.methodsArray);
}

// Recursively collect every service, message, and enum reachable from a
// namespace, in a deterministic (sorted-by-fullName) order so builder output
// is stable across runs.
function collectObjects(root: ProtoNamespace): {
  services: ProtoReflectionObject[];
  messages: ProtoReflectionObject[];
  enums: ProtoReflectionObject[];
} {
  const services: ProtoReflectionObject[] = [];
  const messages: ProtoReflectionObject[] = [];
  const enums: ProtoReflectionObject[] = [];

  const walk = (obj: ProtoReflectionObject): void => {
    if (isService(obj)) services.push(obj);
    else if (isMessageType(obj)) messages.push(obj);
    else if (isEnum(obj)) enums.push(obj);
    for (const child of asArray<ProtoReflectionObject>(obj.nestedArray)) walk(child);
  };

  for (const child of asArray<ProtoReflectionObject>(root.nestedArray)) walk(child);

  const byFullName = (a: ProtoReflectionObject, b: ProtoReflectionObject): number => a.fullName.localeCompare(b.fullName);
  services.sort(byFullName);
  messages.sort(byFullName);
  enums.sort(byFullName);
  return { services, messages, enums };
}

function stripLeadingDot(name: string): string {
  return name.startsWith('.') ? name.slice(1) : name;
}

// Classify a single value type (used for both a direct field and a map value):
// well-known type first, then message -> object (with descent name), enum,
// scalar. Returns `unknown` when nothing resolves so the caller can warn.
function classifyValueType(
  protoType: string,
  resolved: ProtoReflectionObject | null | undefined
): { jsonType: GrpcJsonType; nullable?: boolean; messageType?: string; enumType?: string } {
  // Well-known types are keyed by their raw proto type name: a standalone
  // protobufjs parse does not bundle google/protobuf/*.proto, so a WKT field
  // never resolves to a reflection object (resolvedType stays null). The type
  // string (e.g. `google.protobuf.Timestamp`) is preserved verbatim whether or
  // not the reference resolves, so it is the reliable classifier.
  const wkt = WELL_KNOWN_JSON_TYPE[stripLeadingDot(protoType)];
  if (wkt) return { jsonType: wkt.jsonType, nullable: wkt.nullable };
  if (resolved && Array.isArray(resolved.fieldsArray)) {
    return { jsonType: 'object', messageType: stripLeadingDot(resolved.fullName) };
  }
  if (resolved && resolved.values && !Array.isArray(resolved.fieldsArray)) {
    // proto enums JSON-encode as their string name by default in protobufjs
    // toObject (enums: String); assert string membership at runtime.
    return { jsonType: 'enum', enumType: stripLeadingDot(resolved.fullName) };
  }
  if (SCALAR_JSON_TYPE[protoType]) {
    return { jsonType: SCALAR_JSON_TYPE[protoType] as GrpcJsonType };
  }
  return { jsonType: 'unknown' };
}

// The ProtoJSON name for a field: the explicit `json_name` option when set,
// otherwise the lowerCamelCase of the proto field name (the canonical ProtoJSON
// mapping). gRPC responses decode to canonical ProtoJSON, so runtime assertions
// must look responses up by this name (with the raw proto name as a fallback).
function toLowerCamelCase(name: string): string {
  return name.replace(/_+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase()).replace(/_+$/g, '');
}

function protoJsonName(field: ProtoField): string {
  const options = field.options;
  if (options) {
    const explicit = options['json_name'] ?? (options as Record<string, unknown>).jsonName;
    if (typeof explicit === 'string' && explicit) return explicit;
  }
  if (typeof field.jsonName === 'string' && field.jsonName) return field.jsonName;
  return toLowerCamelCase(String(field.name));
}

function fieldDescriptor(field: ProtoField, warnings: string[], context: string): GrpcFieldDescriptor {
  if (typeof field.resolve === 'function') {
    try { field.resolve(); } catch { /* unresolved type left as raw name below */ }
  }
  const repeated = Boolean(field.repeated) && !field.map;
  const map = Boolean(field.map);
  const protoType = String(field.type);
  const resolved = field.resolvedType;

  if (map) {
    // proto map<K,V> JSON-encodes as a JSON object keyed by string; classify the
    // value type so each entry's value can be asserted.
    const value = classifyValueType(protoType, resolved);
    if (value.jsonType === 'unknown') {
      warnings.push(`PROTO_FIELD_TYPE_UNRESOLVED: map field ${context}.${field.name} has value type ${protoType} that could not be resolved; map values are not asserted`);
    }
    return {
      name: String(field.name),
      jsonName: protoJsonName(field),
      protoType,
      jsonType: 'object',
      repeated: false,
      map: true,
      optional: Boolean(field.optional),
      required: Boolean(field.required),
      ...(value.jsonType !== 'unknown' ? { mapValueType: value.jsonType } : {}),
      ...(value.messageType ? { mapValueMessageType: value.messageType } : {})
    };
  }

  const classified = classifyValueType(protoType, resolved);
  if (classified.jsonType === 'unknown') {
    // A type name that did not resolve and is not a known scalar. We cannot
    // assert its runtime shape — surface a no-silent-drop warning.
    warnings.push(`PROTO_FIELD_TYPE_UNRESOLVED: field ${context}.${field.name} has type ${protoType} that could not be resolved to a scalar, message, or enum; its runtime shape is not asserted`);
  }

  return {
    name: String(field.name),
    jsonName: protoJsonName(field),
    protoType,
    jsonType: classified.jsonType,
    repeated,
    map: false,
    optional: Boolean(field.optional),
    required: Boolean(field.required),
    ...(classified.nullable ? { nullable: true } : {}),
    ...(classified.messageType ? { messageType: classified.messageType } : {}),
    ...(classified.enumType ? { enumType: classified.enumType } : {})
  };
}

// proto3 `optional` scalars are modeled by protobufjs as a synthetic single-field
// oneof named `_field`; those are presence wrappers, not real oneofs, so only
// multi-member oneofs are surfaced for the mutual-exclusion assertion.
function collectOneofs(message: ProtoReflectionObject): string[][] {
  return asArray<ProtoOneof>(message.oneofsArray)
    .map((oneof) => asArray<ProtoField>(oneof.fieldsArray).map((field) => protoJsonName(field)))
    .filter((names) => names.length >= 2)
    .sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

function messageDescriptor(message: ProtoReflectionObject, warnings: string[]): GrpcMessageDescriptor {
  const fullName = stripLeadingDot(message.fullName);
  const fields = asArray<ProtoField>(message.fieldsArray)
    .slice()
    .sort((a, b) => (a.id - b.id) || a.name.localeCompare(b.name))
    .map((field) => fieldDescriptor(field, warnings, fullName));
  return { name: message.name, fullName, fields, oneofs: collectOneofs(message) };
}

function methodPath(serviceFullName: string, methodName: string): string {
  // Runtime `methodPath` is `package.Service/Method`. fullName already carries
  // the package-qualified service name (without leading dot once stripped).
  return `${stripLeadingDot(serviceFullName)}/${methodName}`;
}

function operationFrom(service: ProtoReflectionObject, method: ProtoMethod): GrpcOperation {
  if (typeof method.resolve === 'function') {
    try { method.resolve(); } catch { /* request/response names stay raw */ }
  }
  const warnings: string[] = [];
  const requestStream = Boolean(method.requestStream);
  const responseStream = Boolean(method.responseStream);
  const stream = streamKind(requestStream, responseStream);
  // Prefer the resolved (fully-qualified) message name so it keys into the
  // message index, which is FQN-keyed. protobufjs leaves method.requestType /
  // responseType as the unqualified name written in the .proto; only the
  // resolved*Type carries the package-qualified fullName.
  const requestType = stripLeadingDot(method.resolvedRequestType?.fullName ?? String(method.requestType));
  const responseType = stripLeadingDot(method.resolvedResponseType?.fullName ?? String(method.responseType));
  const serviceFullName = stripLeadingDot(service.fullName);

  if (stream !== 'unary') {
    warnings.push(`PROTO_STREAMING_METHOD: ${serviceFullName}/${method.name} is a ${stream}-streaming RPC; assertions cover terminal status and (for the final response message) field shape, plus message-count expectations, but per-message ordering and intermediate frames are not asserted`);
  }

  return {
    id: `${serviceFullName}/${method.name}`,
    service: service.name,
    serviceFullName,
    method: method.name,
    methodPath: methodPath(service.fullName, method.name),
    stream,
    requestType,
    responseType,
    warnings
  };
}

// Resolve the protobufjs module. A custom module (the runtime fork
// `@postman/protobufjs`, or a test double) takes precedence; otherwise the
// statically-bundled canonical `protobufjs` is used.
export function loadProtoModule(custom?: ProtoParseModule): ProtoParseModule {
  if (custom) return custom;
  // CJS (the esbuild dist bundle) exposes `parse` on the namespace; ESM interop
  // (tsx, the live harness) hoists the CJS module under `.default`. Accept both
  // so the same loader works in the bundle and under a TS runner.
  const ns = protobufjs as unknown as ProtoParseModule & { default?: ProtoParseModule };
  if (typeof ns.parse === 'function') return ns;
  if (ns.default && typeof ns.default.parse === 'function') return ns.default;
  throw new Error('PROTO_PARSER_UNAVAILABLE: protobufjs could not be loaded; add the dependency to run gRPC contract generation');
}

export function parseProtoSchema(content: string, deps?: { protobuf?: ProtoParseModule }): GrpcContractIndex {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('PROTO_EMPTY_INPUT: .proto source is empty');
  }
  const protobuf = loadProtoModule(deps?.protobuf);

  let parsed: { root: ProtoNamespace; package: string | undefined };
  try {
    parsed = protobuf.parse(content, { keepCase: true, alternateCommentMode: true });
  } catch (error) {
    throw new Error(`PROTO_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const root = parsed.root;
  // resolveAll links request/response/field type references so descriptors can
  // be classified. Failure here is non-fatal: unresolved references degrade to
  // PROTO_FIELD_TYPE_UNRESOLVED warnings rather than aborting.
  if (typeof root.resolveAll === 'function') {
    try { root.resolveAll(); } catch { /* per-field resolve() retries below */ }
  }

  const warnings: string[] = [];
  const { services, messages, enums } = collectObjects(root);

  const messageIndex: Record<string, GrpcMessageDescriptor> = {};
  for (const message of messages) {
    const descriptor = messageDescriptor(message, warnings);
    messageIndex[descriptor.fullName] = descriptor;
  }

  const enumIndex: Record<string, string[]> = {};
  for (const enumObj of enums) {
    const values = Object.keys(asRecord(enumObj.values) ?? {}).sort();
    enumIndex[stripLeadingDot(enumObj.fullName)] = values;
  }

  const operations: GrpcOperation[] = [];
  for (const service of services) {
    const methods = asArray<ProtoMethod>(service.methodsArray)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const method of methods) {
      operations.push(operationFrom(service, method));
    }
  }

  if (operations.length === 0) {
    throw new Error('PROTO_NO_SERVICES: .proto defines no service methods; gRPC contract tests require at least one rpc');
  }

  return {
    package: parsed.package ?? '',
    operations,
    messages: messageIndex,
    enums: enumIndex,
    warnings
  };
}
