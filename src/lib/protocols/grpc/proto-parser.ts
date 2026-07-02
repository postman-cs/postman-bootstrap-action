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
  // reserved ranges ([lo, hi]) and names on a Type. protobufjs rejects reserved
  // NAME reuse at parse time but silently accepts reserved NUMBER reuse, so the
  // number check is a post-parse lint here.
  reserved?: Array<[number, number] | string>;
  // Enum
  values?: Record<string, number>;
  options?: Record<string, unknown> | null;
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
  options?: Record<string, unknown> | null;
  // Aggregate option values as parsed structures (protobufjs `parsedOptions`),
  // e.g. [{ "(google.api.http)": { post, body, additional_bindings } }].
  parsedOptions?: Array<Record<string, unknown>> | null;
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
// `double` distinguishes float/double from integer scalars: proto3-JSON encodes
// non-finite doubles as the strings "NaN"/"Infinity"/"-Infinity", and all
// numeric fields may also carry numeric strings.
// `null` is google.protobuf.NullValue: ProtoJSON encodes it as JSON null, so a
// present value must be exactly null.
export type GrpcJsonType = 'number' | 'double' | 'string' | 'boolean' | 'object' | 'array' | 'enum' | 'any' | 'null' | 'unknown';
export type GrpcJsonFormat = 'proto-bytes' | 'proto-timestamp' | 'proto-duration' | 'proto-field-mask' | 'proto-float32';

export interface GrpcFieldDescriptor {
  name: string;
  // ProtoJSON field name (json_name option or lowerCamelCase of `name`); gRPC
  // responses key by this, so runtime lookups try it first, then `name`.
  jsonName: string;
  protoType: string;
  jsonType: GrpcJsonType;
  jsonFormat?: GrpcJsonFormat;
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
  // google.protobuf.Any: JSON object carrying a string "@type" URL; when the
  // trailing type name resolves in the parsed proto set, the remaining keys
  // are shape-checked against that message.
  anyType?: boolean;
  // google.api.field_behavior = REQUIRED: the field must be populated in
  // requests (AIP-203); enforced on generated request bodies at build time.
  requiredBehavior?: boolean;
  // The exact protobuf integer scalar type (e.g. `int32`, `uint64`) when this
  // field is an integer scalar; drives runtime range/sign validation.
  intType?: string;
  // For map<K,V> fields, the EXACT protobuf integer key type (`int32`.. `uint64`)
  // whose JSON string key must range/sign-validate, or `boolean` for a bool key.
  // String keys need no check and are left undefined.
  mapKeyType?: string;
  // For map<K,V> fields, the JSON type asserted on each map value.
  mapValueType?: GrpcJsonType;
  mapValueFormat?: GrpcJsonFormat;
  mapValueEnumType?: string;
  // The exact protobuf integer scalar type of an integer-typed map value.
  mapValueIntType?: string;
  // map<K, google.protobuf.Any> values get the Any grammar/shape check.
  mapValueAnyType?: boolean;
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

const SCALAR_JSON_TYPE: Record<string, { jsonType: GrpcJsonType; jsonFormat?: GrpcJsonFormat; intType?: string }> = {
  double: { jsonType: 'double' },
  // proto float is float32; carry a format so the runtime enforces float32 range
  // (a finite double like 3.5e38 overflows float32 and must fail).
  float: { jsonType: 'double', jsonFormat: 'proto-float32' },
  // 32-bit integers JSON-encode as numbers; `intType` carries the exact protobuf
  // integer domain so the runtime range/sign-checks it (not just integrality).
  int32: { jsonType: 'number', intType: 'int32' },
  sint32: { jsonType: 'number', intType: 'sint32' },
  sfixed32: { jsonType: 'number', intType: 'sfixed32' },
  fixed32: { jsonType: 'number', intType: 'fixed32' },
  uint32: { jsonType: 'number', intType: 'uint32' },
  // 64-bit integers are JSON-encoded as strings by the proto JSON mapping and by
  // protobufjs default toObject; `intType` carries the exact domain so the runtime
  // lexically validates and RANGE-checks the string (string comparison avoids JS
  // double precision loss beyond 2^53).
  int64: { jsonType: 'string', intType: 'int64' },
  uint64: { jsonType: 'string', intType: 'uint64' },
  sint64: { jsonType: 'string', intType: 'sint64' },
  fixed64: { jsonType: 'string', intType: 'fixed64' },
  sfixed64: { jsonType: 'string', intType: 'sfixed64' },
  bool: { jsonType: 'boolean' },
  string: { jsonType: 'string' },
  // bytes are base64 strings in proto JSON.
  bytes: { jsonType: 'string', jsonFormat: 'proto-bytes' }
};

// google.protobuf well-known types have a canonical proto3-JSON encoding that is
// NOT a plain object; treating them as ordinary messages (object) mis-asserts
// the runtime shape. `nullable` marks the wrapper types, which JSON-encode as a
// nullable scalar. Struct/Empty/Any encode as objects but carry no fixed field
// shape, so they map to `object` with no nested descent (messageType undefined).
// grounding: https://protobuf.dev/programming-guides/json/
const WELL_KNOWN_JSON_TYPE: Record<string, { jsonType: GrpcJsonType; jsonFormat?: GrpcJsonFormat; nullable?: boolean; intType?: string; anyType?: boolean }> = {
  'google.protobuf.Timestamp': { jsonType: 'string', jsonFormat: 'proto-timestamp' },
  'google.protobuf.Duration': { jsonType: 'string', jsonFormat: 'proto-duration' },
  'google.protobuf.FieldMask': { jsonType: 'string', jsonFormat: 'proto-field-mask' },
  'google.protobuf.DoubleValue': { jsonType: 'double', nullable: true },
  'google.protobuf.FloatValue': { jsonType: 'double', jsonFormat: 'proto-float32', nullable: true },
  'google.protobuf.Int32Value': { jsonType: 'number', intType: 'int32', nullable: true },
  'google.protobuf.UInt32Value': { jsonType: 'number', intType: 'uint32', nullable: true },
  'google.protobuf.Int64Value': { jsonType: 'string', intType: 'int64', nullable: true },
  'google.protobuf.UInt64Value': { jsonType: 'string', intType: 'uint64', nullable: true },
  'google.protobuf.BoolValue': { jsonType: 'boolean', nullable: true },
  'google.protobuf.StringValue': { jsonType: 'string', nullable: true },
  'google.protobuf.BytesValue': { jsonType: 'string', jsonFormat: 'proto-bytes', nullable: true },
  'google.protobuf.Struct': { jsonType: 'object' },
  'google.protobuf.Empty': { jsonType: 'object' },
  'google.protobuf.Any': { jsonType: 'object', anyType: true },
  'google.protobuf.Value': { jsonType: 'any' },
  'google.protobuf.ListValue': { jsonType: 'array' },
  // NullValue is an enum whose only ProtoJSON encoding is JSON null.
  'google.protobuf.NullValue': { jsonType: 'null' }
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
): { jsonType: GrpcJsonType; jsonFormat?: GrpcJsonFormat; nullable?: boolean; messageType?: string; enumType?: string; intType?: string; anyType?: boolean } {
  // Well-known types are keyed by their raw proto type name: a standalone
  // protobufjs parse does not bundle google/protobuf/*.proto, so a WKT field
  // never resolves to a reflection object (resolvedType stays null). The type
  // string (e.g. `google.protobuf.Timestamp`) is preserved verbatim whether or
  // not the reference resolves, so it is the reliable classifier.
  const wkt = WELL_KNOWN_JSON_TYPE[stripLeadingDot(protoType)];
  if (wkt) return { jsonType: wkt.jsonType, jsonFormat: wkt.jsonFormat, nullable: wkt.nullable, intType: wkt.intType, anyType: wkt.anyType };
  // google.rpc.Status rides the same name-keyed path as the WKTs: its
  // google/rpc/status.proto import is never bundled by a standalone parse, and
  // the instrumenter carries a canonical built-in shape for it.
  if (stripLeadingDot(protoType) === 'google.rpc.Status') {
    return { jsonType: 'object', messageType: 'google.rpc.Status' };
  }
  if (resolved && Array.isArray(resolved.fieldsArray)) {
    return { jsonType: 'object', messageType: stripLeadingDot(resolved.fullName) };
  }
  if (resolved && resolved.values && !Array.isArray(resolved.fieldsArray)) {
    // proto enums JSON-encode as their string name by default in protobufjs
    // toObject (enums: String); assert string membership at runtime.
    return { jsonType: 'enum', enumType: stripLeadingDot(resolved.fullName) };
  }
  const scalar = SCALAR_JSON_TYPE[protoType];
  if (scalar) return { jsonType: scalar.jsonType, jsonFormat: scalar.jsonFormat, intType: scalar.intType };
  return { jsonType: 'unknown' };
}

// proto map keys are always JSON strings, but for an integral or bool key type the
// string must still be a valid integer / "true"|"false" (proto only permits
// integral, bool, or string map keys). Returns the runtime key kind to validate,
// or undefined for string keys (which need no check).
function classifyMapKey(keyType: string | undefined): string | undefined {
  if (keyType === 'bool') return 'boolean';
  // Preserve the EXACT integer key type (not a coarse 'integer') so the runtime
  // range/sign-checks the JSON string key against that specific domain.
  if (keyType && /^(?:u?int|sint|s?fixed)(?:32|64)$/.test(keyType)) return keyType;
  return undefined;
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

// google.api.field_behavior REQUIRED on a field. protobufjs surfaces custom
// field options under the parenthesized extension key; a repeated option can
// surface as an array.
function hasRequiredBehavior(field: ProtoField): boolean {
  const value = field.options?.['(google.api.field_behavior)'];
  if (typeof value === 'string') return value === 'REQUIRED';
  return Array.isArray(value) && value.includes('REQUIRED');
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
    const mapKeyType = classifyMapKey(field.keyType);
    return {
      name: String(field.name),
      jsonName: protoJsonName(field),
      protoType,
      jsonType: 'object',
      repeated: false,
      map: true,
      optional: Boolean(field.optional),
      required: Boolean(field.required),
      ...(mapKeyType ? { mapKeyType } : {}),
      ...(value.jsonType !== 'unknown' ? { mapValueType: value.jsonType } : {}),
      ...(value.jsonFormat ? { mapValueFormat: value.jsonFormat } : {}),
      ...(value.intType ? { mapValueIntType: value.intType } : {}),
      ...(value.enumType ? { mapValueEnumType: value.enumType } : {}),
      ...(value.messageType ? { mapValueMessageType: value.messageType } : {}),
      ...(value.anyType ? { mapValueAnyType: true } : {}),
      ...(hasRequiredBehavior(field) ? { requiredBehavior: true } : {})
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
    ...(classified.jsonFormat ? { jsonFormat: classified.jsonFormat } : {}),
    repeated,
    map: false,
    optional: Boolean(field.optional),
    required: Boolean(field.required),
    ...(classified.nullable ? { nullable: true } : {}),
    ...(classified.intType ? { intType: classified.intType } : {}),
    ...(classified.messageType ? { messageType: classified.messageType } : {}),
    ...(classified.enumType ? { enumType: classified.enumType } : {}),
    ...(classified.anyType ? { anyType: true } : {}),
    ...(hasRequiredBehavior(field) ? { requiredBehavior: true } : {})
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

// --- Generation-time lints ---------------------------------------------------
// protoc-level structural rules that the protobufjs textual parser accepts
// silently, surfaced as GRPC_* warnings so generation stays resilient while the
// defect is still reported (no silent drops). Rules protobufjs itself already
// hard-rejects at parse time (duplicate field numbers, reserved NAME reuse,
// duplicate enum values without allow_alias, repeated/map fields in a oneof)
// surface as PROTO_PARSE_FAILED and need no lint here.

const FIELD_NUMBER_MAX = 536870911;
const FIELD_NUMBER_RESERVED_LO = 19000;
const FIELD_NUMBER_RESERVED_HI = 19999;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

// Built-in (non-extension) option names protoc accepts per descriptor scope
// (descriptor.proto FieldOptions/MessageOptions/EnumOptions/ServiceOptions/
// MethodOptions, plus the parser-level json_name/default pseudo-options that
// protobufjs surfaces through the same options record). Any other
// non-parenthesized option name is rejected by protoc, and a parenthesized
// custom option cannot be validated without its extension descriptor, so both
// surface as warnings (no silent drops).
const KNOWN_OPTIONS_BY_SCOPE: Record<'field' | 'message' | 'enum' | 'service' | 'rpc', Set<string>> = {
  field: new Set(['ctype', 'packed', 'jstype', 'lazy', 'unverified_lazy', 'deprecated', 'weak', 'debug_redact', 'retention', 'targets', 'edition_defaults', 'features', 'json_name', 'default', 'proto3_optional']),
  message: new Set(['message_set_wire_format', 'no_standard_descriptor_accessor', 'deprecated', 'map_entry', 'deprecated_legacy_json_field_conflicts', 'features']),
  enum: new Set(['allow_alias', 'deprecated', 'deprecated_legacy_json_field_conflicts', 'features']),
  service: new Set(['deprecated', 'features']),
  rpc: new Set(['deprecated', 'idempotency_level', 'features'])
};

// Custom (extension) options this generator itself consumes and validates; any
// other custom option is disclosed as unverifiable.
const HANDLED_CUSTOM_OPTIONS = new Set(['(google.api.http)', '(google.api.field_behavior)']);

function lintOptionSet(
  options: Record<string, unknown> | null | undefined,
  scope: 'field' | 'message' | 'enum' | 'service' | 'rpc',
  owner: string,
  warnings: string[]
): void {
  if (!options) return;
  const custom: string[] = [];
  for (const key of Object.keys(options)) {
    if (key.startsWith('(')) {
      // Nested aggregate assignments surface as "(ext).sub" keys; classify by
      // the extension name alone.
      if (!HANDLED_CUSTOM_OPTIONS.has(key.replace(/\)\..*$/, ')'))) custom.push(key);
      continue;
    }
    if (!KNOWN_OPTIONS_BY_SCOPE[scope].has(key)) {
      warnings.push(`GRPC_OPTION_UNKNOWN: ${scope} ${owner} sets option "${key}", which is not a built-in ${scope} option (descriptor.proto); protoc rejects unknown non-extension options`);
    }
  }
  if (custom.length > 0) {
    warnings.push(`GRPC_OPTION_CUSTOM_UNVERIFIED: ${scope} ${owner} uses custom option(s) ${custom.sort().join(', ')}; custom options cannot be validated without their extension descriptors and are not enforced`);
  }
  if (options.deprecated !== undefined && typeof options.deprecated !== 'boolean') {
    warnings.push(`GRPC_OPTION_VALUE_INVALID: ${scope} ${owner} option deprecated must be a boolean (descriptor.proto); got ${JSON.stringify(options.deprecated)}`);
  }
}

// packed applies only to repeated packable scalars: numeric, bool, or enum
// (protoc rejects string/bytes/message targets and non-repeated fields).
function isPackableType(field: ProtoField): boolean {
  const protoType = String(field.type);
  if (SCALAR_JSON_TYPE[protoType]) return protoType !== 'string' && protoType !== 'bytes';
  const resolved = field.resolvedType;
  return Boolean(resolved && resolved.values && !Array.isArray(resolved.fieldsArray));
}

function lintFieldOptions(field: ProtoField, owner: string, proto3: boolean, warnings: string[]): void {
  const options = field.options;
  if (!options) return;
  lintOptionSet(options, 'field', owner, warnings);
  // protoc rejects a NUL byte in an explicit json_name (C-string boundary).
  const explicit = options['json_name'];
  if (typeof explicit === 'string' && explicit.includes('\u0000')) {
    warnings.push(`GRPC_JSON_NAME_INVALID: field ${owner} json_name contains a NUL character; protoc rejects NUL in json_name`);
  }
  // proto3 removed explicit field defaults (implicit zero values only).
  if (proto3 && options['default'] !== undefined) {
    warnings.push(`GRPC_PROTO3_DEFAULT_FORBIDDEN: field ${owner} declares [default = ...]; proto3 forbids explicit field defaults (protoc rejects this)`);
  }
  if (options.packed !== undefined) {
    if (typeof options.packed !== 'boolean') {
      warnings.push(`GRPC_OPTION_PACKED_INVALID: field ${owner} option packed must be a boolean (descriptor.proto); got ${JSON.stringify(options.packed)}`);
    } else if (!(Boolean(field.repeated) && !field.map && isPackableType(field))) {
      warnings.push(`GRPC_OPTION_PACKED_INVALID: field ${owner} sets [packed]; packed applies only to repeated numeric scalar, bool, or enum fields (protoc rejects other targets)`);
    }
  }
  if (options.jstype !== undefined) {
    if (typeof options.jstype !== 'string' || !['JS_NORMAL', 'JS_STRING', 'JS_NUMBER'].includes(options.jstype)) {
      warnings.push(`GRPC_OPTION_VALUE_INVALID: field ${owner} option jstype must be one of JS_NORMAL, JS_STRING, JS_NUMBER (descriptor.proto); got ${JSON.stringify(options.jstype)}`);
    } else if (!/^(?:u?int64|sint64|s?fixed64)$/.test(String(field.type))) {
      warnings.push(`GRPC_OPTION_SCOPE_INVALID: field ${owner} sets jstype on type ${field.type}; jstype applies only to 64-bit integer fields (descriptor.proto)`);
    }
  }
  if (options.ctype !== undefined) {
    if (typeof options.ctype !== 'string' || !['STRING', 'CORD', 'STRING_PIECE'].includes(options.ctype)) {
      warnings.push(`GRPC_OPTION_VALUE_INVALID: field ${owner} option ctype must be one of STRING, CORD, STRING_PIECE (descriptor.proto); got ${JSON.stringify(options.ctype)}`);
    } else if (String(field.type) !== 'string' && String(field.type) !== 'bytes') {
      warnings.push(`GRPC_OPTION_SCOPE_INVALID: field ${owner} sets ctype on type ${field.type}; ctype applies only to string or bytes fields (descriptor.proto)`);
    }
  }
}

// Reserved declaration validity, shared by messages (field-number domain) and
// enums (int32 domain). protobufjs preserves malformed, overlapping, and
// duplicate entries verbatim, so declaration defects survive to this lint.
function lintReserved(
  reserved: Array<[number, number] | string> | undefined,
  owner: string,
  domain: { lo: number; hi: number; label: string },
  warnings: string[]
): { ranges: Array<[number, number]>; names: Set<string> } {
  const ranges: Array<[number, number]> = [];
  const names = new Set<string>();
  for (const entry of asArray<[number, number] | string>(reserved)) {
    if (typeof entry === 'string') {
      if (names.has(entry)) {
        warnings.push(`GRPC_RESERVED_NAME_DUPLICATE: ${owner} reserves name "${entry}" more than once (protoc rejects duplicate reserved names)`);
      }
      names.add(entry);
      continue;
    }
    const [lo, hi] = entry;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
      warnings.push(`GRPC_RESERVED_DECLARATION_INVALID: ${owner} reserved range ${lo} to ${hi} is malformed; the range start must not exceed its end (protoc rejects this)`);
      continue;
    }
    if (lo < domain.lo || hi > domain.hi) {
      warnings.push(`GRPC_RESERVED_DECLARATION_INVALID: ${owner} reserved range ${lo} to ${hi} is outside the ${domain.label} domain [${domain.lo}, ${domain.hi}]`);
    }
    ranges.push([lo, hi]);
  }
  const sorted = ranges.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i][0] <= sorted[i - 1][1]) {
      warnings.push(`GRPC_RESERVED_RANGE_OVERLAP: ${owner} reserved ranges ${sorted[i - 1][0]} to ${sorted[i - 1][1]} and ${sorted[i][0]} to ${sorted[i][1]} overlap (protoc rejects overlapping reserved ranges)`);
    }
  }
  return { ranges, names };
}

// protoc derives the synthetic nested map-entry message name by UpperCamelCasing
// the field name and appending "Entry".
function upperCamelCase(name: string): string {
  const camel = toLowerCamelCase(name);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function lintMessage(message: ProtoReflectionObject, warnings: string[], proto3: boolean): void {
  const fullName = stripLeadingDot(message.fullName);
  const { ranges: reservedRanges } = lintReserved(message.reserved, `message ${fullName}`, { lo: 1, hi: FIELD_NUMBER_MAX, label: 'field-number' }, warnings);
  lintOptionSet(asRecord(message.options), 'message', fullName, warnings);

  // Effective ProtoJSON name (explicit json_name or lowerCamelCase default)
  // per field; collisions make responses undecodable and protoc rejects them.
  const jsonNames = new Map<string, string>();
  for (const field of asArray<ProtoField>(message.fieldsArray)) {
    const id = field.id;
    if (id < 1 || id > FIELD_NUMBER_MAX || (id >= FIELD_NUMBER_RESERVED_LO && id <= FIELD_NUMBER_RESERVED_HI)) {
      warnings.push(`GRPC_FIELD_NUMBER_INVALID: field ${fullName}.${field.name} uses field number ${id}; protoc requires [1, ${FIELD_NUMBER_MAX}] excluding the implementation-reserved block [${FIELD_NUMBER_RESERVED_LO}, ${FIELD_NUMBER_RESERVED_HI}]`);
    }
    if (reservedRanges.some(([lo, hi]) => id >= lo && id <= hi)) {
      warnings.push(`GRPC_RESERVED_FIELD_NUMBER_REUSED: field ${fullName}.${field.name} reuses reserved field number ${id}; protoc rejects reserved-number reuse`);
    }
    if (field.options?.deprecated === true) {
      warnings.push(`GRPC_DEPRECATED: field ${fullName}.${field.name} is marked deprecated`);
    }
    lintFieldOptions(field, `${fullName}.${field.name}`, proto3, warnings);
    const jsonName = protoJsonName(field);
    const priorField = jsonNames.get(jsonName);
    if (priorField !== undefined && priorField !== String(field.name)) {
      warnings.push(`GRPC_JSON_NAME_COLLISION: fields ${fullName}.${priorField} and ${fullName}.${field.name} share the ProtoJSON name "${jsonName}"; protoc rejects JSON-name collisions and responses cannot be decoded unambiguously`);
    }
    jsonNames.set(jsonName, String(field.name));
  }
  if (asRecord(message.options)?.deprecated === true) {
    warnings.push(`GRPC_DEPRECATED: message ${fullName} is marked deprecated`);
  }

  // Map fields synthesize a nested <UpperCamel(field)>Entry message; an
  // explicit nested symbol (or another map field) with that name collides.
  const nestedNames = new Set(asArray<ProtoReflectionObject>(message.nestedArray).map((child) => child.name));
  const entryNames = new Set<string>();
  for (const field of asArray<ProtoField>(message.fieldsArray)) {
    if (!field.map) continue;
    const entryName = `${upperCamelCase(String(field.name))}Entry`;
    if (nestedNames.has(entryName) || entryNames.has(entryName)) {
      warnings.push(`GRPC_MAP_ENTRY_NAME_COLLISION: map field ${fullName}.${field.name} synthesizes nested message ${entryName}, which collides with an existing nested symbol of that name (protoc rejects this)`);
    }
    entryNames.add(entryName);
  }

  // Message-scope symbol table: fields, real oneofs, nested types, and nested
  // enum VALUES (enum constants scope to the enclosing message, C++ scoping
  // rules), which the textual parser accepts silently.
  const symbols = new Map<string, string>();
  const declare = (name: string, kind: string): void => {
    const prior = symbols.get(name);
    if (prior !== undefined) {
      warnings.push(`GRPC_MESSAGE_SCOPE_COLLISION: ${fullName} declares ${kind} "${name}", which collides with the ${prior} of the same name (enum values scope to the enclosing message; protoc rejects this)`);
      return;
    }
    symbols.set(name, kind);
  };
  for (const field of asArray<ProtoField>(message.fieldsArray)) declare(String(field.name), 'field');
  for (const oneof of asArray<ProtoOneof>(message.oneofsArray)) {
    if (asArray<ProtoField>(oneof.fieldsArray).length >= 2) declare(oneof.name, 'oneof');
  }
  for (const child of asArray<ProtoReflectionObject>(message.nestedArray)) {
    declare(child.name, isEnum(child) ? 'nested enum' : 'nested type');
    if (isEnum(child)) {
      for (const valueName of Object.keys(asRecord(child.values) ?? {})) declare(valueName, `enum value of ${child.name}`);
    }
  }
}

const ENUM_VALUE_MIN = -2147483648;
const ENUM_VALUE_MAX = 2147483647;

function lintEnum(enumObj: ProtoReflectionObject, warnings: string[], proto3: boolean, conventions: boolean): void {
  const fullName = stripLeadingDot(enumObj.fullName);
  const entries = Object.entries(asRecord(enumObj.values) ?? {});
  // Enum reserved declarations share the message machinery but span the full
  // int32 constant domain (negative enum constants are legal).
  const { ranges: reservedRanges, names: reservedNames } = lintReserved(
    enumObj.reserved,
    `enum ${fullName}`,
    { lo: ENUM_VALUE_MIN, hi: ENUM_VALUE_MAX, label: 'enum-constant' },
    warnings
  );
  for (const [name, rawValue] of entries) {
    const value = typeof rawValue === 'number' ? rawValue : Number.NaN;
    if (!Number.isInteger(value) || value < ENUM_VALUE_MIN || value > ENUM_VALUE_MAX) {
      warnings.push(`GRPC_ENUM_VALUE_RANGE: enum ${fullName} constant ${name} = ${value} is outside the int32 range [${ENUM_VALUE_MIN}, ${ENUM_VALUE_MAX}] (protoc rejects out-of-range enum constants)`);
    }
    if (reservedRanges.some(([lo, hi]) => value >= lo && value <= hi)) {
      warnings.push(`GRPC_RESERVED_ENUM_VALUE_REUSED: enum ${fullName} constant ${name} = ${value} reuses a reserved enum value (protoc rejects reserved-value reuse)`);
    }
    if (reservedNames.has(name)) {
      warnings.push(`GRPC_RESERVED_ENUM_NAME_REUSED: enum ${fullName} constant ${name} reuses a reserved name (protoc rejects reserved-name reuse)`);
    }
  }
  if (proto3 && entries.length > 0 && entries[0][1] !== 0) {
    warnings.push(`GRPC_ENUM_FIRST_VALUE_NOT_ZERO: enum ${fullName} declares ${entries[0][0]} = ${entries[0][1]} first; proto3 requires the first enum value to be 0 (protoc rejects this)`);
  }
  if (conventions) {
    const zero = entries.find(([, value]) => value === 0);
    if (zero && !zero[0].endsWith('_UNSPECIFIED')) {
      warnings.push(`GRPC_ENUM_ZERO_NAME_CONVENTION: enum ${fullName} zero value ${zero[0]} is conventionally named *_UNSPECIFIED (buf/AIP enum conventions)`);
    }
  }
  if (asRecord(enumObj.options)?.deprecated === true) {
    warnings.push(`GRPC_DEPRECATED: enum ${fullName} is marked deprecated`);
  }
}

// google.api.http annotation statics (linted only when protobufjs surfaces the
// aggregate option via parsedOptions): exactly one non-empty grammatical URL
// pattern, variables/body/response_body referencing the right message fields
// with transcodable types, and additional_bindings that do not nest further.
interface HttpRuleFieldInfo {
  repeated: boolean;
  map: boolean;
  message: boolean;
}

const HTTP_RULE_VERBS = ['get', 'put', 'post', 'delete', 'patch'] as const;

// Validate a google.api.http path template against the http.proto grammar:
// Template = "/" Segments [ ":" Verb ]; Segment = "*" | "**" | LITERAL |
// Variable; Variable = "{" FieldPath [ "=" Segments ] "}", with no variable
// nesting and "**" only in the final segment position.
function httpTemplateErrors(template: string): string[] {
  const errors: string[] = [];
  if (!template.startsWith('/')) {
    errors.push('must start with "/"');
    return errors;
  }
  let verbIdx = -1;
  let depth = 0;
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ':' && depth === 0) verbIdx = i;
    else if (ch === '/' && depth === 0) verbIdx = -1;
  }
  const path = verbIdx === -1 ? template : template.slice(0, verbIdx);
  if (verbIdx !== -1 && verbIdx === template.length - 1) errors.push('declares an empty verb after ":"');

  const segments: string[] = [];
  let current = '';
  depth = 0;
  for (let i = 1; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === '{') { depth += 1; if (depth > 1) errors.push('nests a variable inside a variable'); }
    if (ch === '}') { depth -= 1; if (depth < 0) errors.push('closes a variable that was never opened'); }
    if (ch === '/' && depth === 0) { segments.push(current); current = ''; continue; }
    current += ch;
  }
  segments.push(current);
  if (depth > 0) errors.push('leaves a variable unterminated (missing "}")');

  segments.forEach((segment, i) => {
    if (segment.length === 0) { errors.push('contains an empty path segment'); return; }
    if (segment.startsWith('{') && segment.endsWith('}')) {
      const inner = segment.slice(1, -1);
      const eq = inner.indexOf('=');
      const fieldPath = eq === -1 ? inner : inner.slice(0, eq);
      const subPattern = eq === -1 ? null : inner.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(fieldPath.trim())) {
        errors.push(`declares variable field path "${fieldPath}" that is not a dotted proto field path`);
      }
      if (subPattern !== null) {
        if (subPattern.length === 0) {
          errors.push(`declares variable {${fieldPath}=} with an empty sub-pattern`);
        } else {
          const subSegments = subPattern.split('/');
          subSegments.forEach((sub, j) => {
            if (sub.length === 0) errors.push(`declares variable {${fieldPath}} with an empty sub-pattern segment`);
            else if (sub === '**' && j !== subSegments.length - 1) errors.push('uses "**" before the final segment of a variable sub-pattern');
            else if (sub !== '*' && sub !== '**' && /[{}]/.test(sub)) errors.push(`declares sub-pattern segment "${sub}" that is not a literal or wildcard`);
          });
        }
      }
      return;
    }
    if (segment === '**') {
      if (i !== segments.length - 1) errors.push('uses "**" before the final path segment');
      return;
    }
    if (segment === '*') return;
    if (/[{}]/.test(segment)) errors.push(`mixes literals and variable braces in segment "${segment}"`);
  });
  return errors;
}

function lintHttpRule(
  rule: JsonRecord,
  requestFields: Map<string, HttpRuleFieldInfo> | null,
  responseFieldNames: Set<string> | null,
  warnings: string[],
  operationId: string,
  nested: boolean
): void {
  const patterns: Array<{ verb: string; path: string }> = [];
  for (const verb of HTTP_RULE_VERBS) {
    if (typeof rule[verb] === 'string') patterns.push({ verb, path: rule[verb] as string });
  }
  const custom = asRecord(rule.custom);
  if (custom && typeof custom.path === 'string') patterns.push({ verb: String(custom.kind ?? 'custom'), path: custom.path });

  // http.proto declares the URL pattern as a oneof: exactly one must be set.
  if (patterns.length === 0) {
    warnings.push(`GRPC_HTTP_RULE_PATTERN_MISSING: ${operationId} google.api.http ${nested ? 'additional binding' : 'rule'} declares no URL pattern (get/put/post/delete/patch/custom); transcoding requires exactly one (google.api.http pattern oneof)`);
  } else if (patterns.length > 1) {
    warnings.push(`GRPC_HTTP_RULE_PATTERN_CONFLICT: ${operationId} google.api.http ${nested ? 'additional binding' : 'rule'} declares ${patterns.length} URL patterns (${patterns.map((entry) => entry.verb).join(', ')}); the pattern is a oneof, so only one may be set (google.api.http)`);
  }

  const variableRoots = new Set<string>();
  for (const { path } of patterns) {
    if (path.length === 0) {
      warnings.push(`GRPC_HTTP_RULE_PATH_EMPTY: ${operationId} google.api.http declares an empty path template; transcoding requires a non-empty template starting with "/" (google.api.http)`);
      continue;
    }
    for (const problem of httpTemplateErrors(path)) {
      warnings.push(`GRPC_HTTP_PATH_TEMPLATE_INVALID: ${operationId} google.api.http path template "${path}" ${problem} (google/api/http.proto template grammar)`);
    }
    for (const match of path.matchAll(/\{([^}=]+)(?:=[^}]*)?\}/g)) {
      const fieldPath = match[1].trim();
      const rootSegment = fieldPath.split('.')[0];
      variableRoots.add(rootSegment);
      if (requestFields && !requestFields.has(rootSegment)) {
        warnings.push(`GRPC_HTTP_PATH_VARIABLE_UNKNOWN: ${operationId} google.api.http path template variable {${match[1]}} does not reference a request message field`);
      } else if (requestFields) {
        const info = requestFields.get(rootSegment);
        // A path variable must transcode from a single URL path value: maps,
        // repeated fields, and whole-message bindings cannot.
        if (info && (info.repeated || info.map || (info.message && !fieldPath.includes('.')))) {
          const kind = info.map ? 'a map' : info.repeated ? 'a repeated' : 'a message-typed';
          warnings.push(`GRPC_HTTP_PATH_VARIABLE_TYPE_INVALID: ${operationId} google.api.http path variable {${match[1]}} binds ${kind} field; path variables must map to non-repeated primitive fields (google.api.http)`);
        }
      }
    }
  }

  const body = typeof rule.body === 'string' ? rule.body : null;
  if (body && body !== '*') {
    if (requestFields && !requestFields.has(body)) {
      warnings.push(`GRPC_HTTP_BODY_FIELD_UNKNOWN: ${operationId} google.api.http body "${body}" is neither "*" nor a request message field`);
    }
    if (variableRoots.has(body)) {
      warnings.push(`GRPC_HTTP_BODY_PATH_OVERLAP: ${operationId} google.api.http body field "${body}" is also bound by a path template variable; path and body bindings must be disjoint (google.api.http)`);
    }
  }
  if (body && patterns.length === 1 && (patterns[0].verb === 'get' || patterns[0].verb === 'delete')) {
    warnings.push(`GRPC_HTTP_BODY_ON_${patterns[0].verb.toUpperCase()}: ${operationId} google.api.http declares a body with a ${patterns[0].verb.toUpperCase()} pattern; GET/DELETE requests must not carry a transcoded body (google.api.http / AIP-127)`);
  }

  // Fields left to URL query mapping must be primitive (possibly repeated) or
  // non-repeated messages that expand recursively; repeated messages and maps
  // have no query encoding.
  if (requestFields && body !== '*' && patterns.length > 0) {
    for (const [name, info] of requestFields) {
      if (variableRoots.has(name) || name === body) continue;
      if (info.map || (info.repeated && info.message)) {
        warnings.push(`GRPC_HTTP_QUERY_FIELD_UNSUPPORTED: ${operationId} google.api.http leaves ${info.map ? 'map' : 'repeated message-typed'} field "${name}" to URL query mapping, which has no transcoding (google.api.http)`);
      }
    }
  }

  const responseBody = typeof rule.response_body === 'string' ? rule.response_body : null;
  if (responseBody && responseBody.length > 0 && responseFieldNames && !responseFieldNames.has(responseBody)) {
    warnings.push(`GRPC_HTTP_RESPONSE_BODY_FIELD_UNKNOWN: ${operationId} google.api.http response_body "${responseBody}" is not a top-level response message field (google.api.http)`);
  }

  const bindings = rule.additional_bindings;
  const bindingList: unknown[] = Array.isArray(bindings) ? bindings : bindings ? [bindings] : [];
  if (nested && bindingList.length > 0) {
    warnings.push(`GRPC_HTTP_NESTED_ADDITIONAL_BINDINGS: ${operationId} google.api.http additional_bindings must not themselves carry additional_bindings`);
    return;
  }
  for (const binding of bindingList) {
    const record = asRecord(binding);
    if (record) lintHttpRule(record, requestFields, responseFieldNames, warnings, operationId, true);
  }
}

// Field surface of a request/response message as the transcoding lints need
// it: repeated/map flags plus whether the field is message-typed (an enum or
// unresolved type counts as primitive for query/path purposes).
function httpFieldInfo(type: ProtoReflectionObject | null | undefined): Map<string, HttpRuleFieldInfo> | null {
  if (!type) return null;
  const map = new Map<string, HttpRuleFieldInfo>();
  for (const field of asArray<ProtoField>(type.fieldsArray)) {
    if (typeof field.resolve === 'function') { try { field.resolve(); } catch { /* raw type info */ } }
    const resolved = field.resolvedType;
    const isMessage = Boolean(resolved && resolved.values === undefined);
    map.set(String(field.name), {
      repeated: field.repeated === true,
      map: field.map === true,
      message: isMessage && field.map !== true
    });
  }
  return map;
}

function lintMethodOptions(method: ProtoMethod, operationId: string, warnings: string[]): void {
  const requestFields = httpFieldInfo(method.resolvedRequestType);
  const responseFieldNames = method.resolvedResponseType
    ? new Set(asArray<ProtoField>(method.resolvedResponseType.fieldsArray).map((field) => String(field.name)))
    : null;
  for (const entry of asArray<Record<string, unknown>>(method.parsedOptions)) {
    const http = asRecord(asRecord(entry)?.['(google.api.http)']);
    if (http) lintHttpRule(http, requestFields, responseFieldNames, warnings, operationId, false);
  }
  if (asRecord(method.options)?.deprecated === true) {
    warnings.push(`GRPC_DEPRECATED: rpc ${operationId} is marked deprecated`);
  }
}

// A type name the parser classifies without reflection resolution (well-known
// types and google.rpc.Status are name-keyed; their imports are never bundled
// by a standalone parse).
function isNameKeyedType(typeName: string): boolean {
  const stripped = stripLeadingDot(typeName);
  return Boolean(WELL_KNOWN_JSON_TYPE[stripped]) || stripped === 'google.rpc.Status';
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

  const operationId = `${serviceFullName}/${method.name}`;
  if (!method.resolvedRequestType && !isNameKeyedType(requestType)) {
    warnings.push(`GRPC_RPC_TYPE_UNRESOLVED: ${operationId} request type ${requestType} does not resolve to a message in the parsed proto set (protoc rejects unresolved rpc types)`);
  }
  if (!method.resolvedResponseType && !isNameKeyedType(responseType)) {
    warnings.push(`GRPC_RPC_TYPE_UNRESOLVED: ${operationId} response type ${responseType} does not resolve to a message in the parsed proto set (protoc rejects unresolved rpc types)`);
  }
  lintMethodOptions(method, operationId, warnings);

  return {
    id: operationId,
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

export interface ProtoParseDeps {
  protobuf?: ProtoParseModule;
  // Opt-in style lints (GRPC_*_CONVENTION warnings): enum zero value named
  // *_UNSPECIFIED, file declares a package. Off by default so structural
  // warnings stay actionable.
  conventionWarnings?: boolean;
}

export function parseProtoSchema(content: string, deps?: ProtoParseDeps): GrpcContractIndex {
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

  // The fork's parse result does not surface `syntax`, so proto3-only lints key
  // off the source declaration directly (protobufjs defaults to proto2 without one).
  const proto3 = /^\s*syntax\s*=\s*["']proto3["']\s*;/m.test(content);
  // protoc requires the syntax declaration, when present, to be the first
  // non-comment, non-whitespace statement of the file.
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const firstStatement = /^\s*([^;]*);/.exec(withoutComments);
  if (/\bsyntax\s*=/.test(withoutComments) && firstStatement && !/^\s*syntax\s*=\s*["'](proto2|proto3)["']\s*$/.test(firstStatement[1])) {
    warnings.push('GRPC_SYNTAX_PLACEMENT_INVALID: the syntax declaration is not the first non-comment statement of the file; protoc requires syntax = "..." before any other declaration');
  }
  // Import surface: a standalone parse does not resolve imported files, so
  // cross-file rules (import public visibility, proto2 enums referenced from
  // proto3 messages) are disclosed rather than silently skipped.
  const importStatements = [...withoutComments.matchAll(/^\s*import\s+(public\s+|weak\s+)?"([^"]+)"\s*;/gm)];
  const seenImports = new Set<string>();
  for (const statement of importStatements) {
    const target = statement[2];
    if (seenImports.has(target)) {
      warnings.push(`GRPC_IMPORT_DUPLICATE: "${target}" is imported more than once (protoc rejects duplicate imports)`);
    }
    seenImports.add(target);
    if ((statement[1] ?? '').trim() === 'weak') {
      warnings.push(`GRPC_IMPORT_WEAK: "${target}" uses import weak, which is Google-internal and ignored or rejected by most toolchains (protobuf language guide)`);
    }
  }
  if (importStatements.length > 0) {
    warnings.push(`GRPC_IMPORT_UNRESOLVED_DISCLOSURE: ${importStatements.length} import statement(s) are not resolved by this single-file parse; cross-file rules (import public visibility, proto2 enum references from proto3) are not asserted and imported types degrade to PROTO_FIELD_TYPE_UNRESOLVED`);
  }
  const conventions = deps?.conventionWarnings === true;

  const messageIndex: Record<string, GrpcMessageDescriptor> = {};
  for (const message of messages) {
    const descriptor = messageDescriptor(message, warnings);
    messageIndex[descriptor.fullName] = descriptor;
    lintMessage(message, warnings, proto3);
  }

  const enumIndex: Record<string, string[]> = {};
  for (const enumObj of enums) {
    const values = Object.keys(asRecord(enumObj.values) ?? {}).sort();
    enumIndex[stripLeadingDot(enumObj.fullName)] = values;
    lintEnum(enumObj, warnings, proto3, conventions);
  }

  if (conventions && !parsed.package) {
    warnings.push('GRPC_FILE_PACKAGE_CONVENTION: .proto declares no package; a package is conventionally required (buf lint PACKAGE_DEFINED)');
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
