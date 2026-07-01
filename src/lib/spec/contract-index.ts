import { isSchemaGraphOverflow, packSchema, resolvePointer, type OpenApiVersion, type PackedSchema } from './schema-pack.js';
import { compileSchemaValidator } from './schema-validator-code.js';

type JsonRecord = Record<string, unknown>;

export type ContractMedia = PackedSchema;

export interface ContractHeader {
  name: string;
  required: boolean;
  schema?: unknown;
  items?: unknown;
  unsupported?: string;
}

export interface ContractResponse {
  content: Record<string, ContractMedia>;
  hasBody: boolean;
  headers: ContractHeader[];
}

export interface ContractParameterRequirement {
  in: 'path' | 'query' | 'header' | 'cookie';
  name: string;
  securityDerived?: boolean;
}

export interface ContractFieldEncoding {
  contentType?: string;
  binary?: boolean;
  nonDefaultSerialization?: boolean;
  hasHeaders?: boolean;
}

export interface ContractBodyFieldRules {
  required: string[];
  readOnly: string[];
  encodings?: Record<string, ContractFieldEncoding>;
  fieldSchemas?: Record<string, unknown>;
}

export interface ContractRequestBodyRequirement {
  contentTypes: string[];
  required: boolean;
  fieldRules?: Record<string, ContractBodyFieldRules>;
  jsonSchemas?: Record<string, unknown>;
}

export interface ContractParameterCheck {
  in: 'query' | 'header' | 'path' | 'cookie';
  name: string;
  required: boolean;
  allowEmptyValue?: boolean;
  content?: boolean;
  schema: unknown;
  decode?: 'multi' | 'csv' | 'ssv' | 'pipes';
  items?: unknown;
}

export interface ContractSecurityCheck {
  scheme: string;
  kind: string;
  checkable: boolean;
  in?: 'header' | 'query' | 'cookie';
  name?: string;
  prefix?: string;
}

export interface ContractOperation {
  id: string;
  method: string;
  path: string;
  pointer: string;
  candidates: string[];
  responses: Record<string, ContractResponse>;
  requiredParameters: ContractParameterRequirement[];
  declaredQueryParameters: string[];
  parameterChecks?: ContractParameterCheck[];
  requestBody?: ContractRequestBodyRequirement;
  security?: ContractSecurityCheck[][];
  warnings: string[];
}

export interface ContractIndex {
  operations: ContractOperation[];
  version: OpenApiVersion;
  warnings: string[];
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function detectOpenApiVersion(root: JsonRecord): OpenApiVersion {
  const raw = root.openapi;
  if (typeof raw !== 'string') throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: missing openapi');
  const match = raw.trim().match(/^3\.(0|1)(?:\.\d+)?$/);
  if (!match?.[1]) {
    throw new Error(`CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (found openapi ${raw})`);
  }
  return match[1] === '1' ? '3.1' : '3.0';
}

function resolveInternalRef<T extends JsonRecord>(root: JsonRecord, value: unknown): T | null {
  const record = asRecord(value);
  if (!record) return null;
  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (!ref) return record as T;
  if (!ref.startsWith('#/')) throw new Error(`CONTRACT_UNRESOLVED_REF: External ref remained after bundling: ${ref}`);
  const resolved = asRecord(resolvePointer(root, ref));
  if (!resolved) throw new Error(`CONTRACT_UNRESOLVED_REF: Unresolved OpenAPI $ref: ${ref}`);
  return resolved as T;
}

function safeDecodeSegment(segment: string): string {
  const preservedSlash = segment.replace(/%2f/gi, '__encoded_slash__');
  try {
    return decodeURIComponent(preservedSlash).replace(/__encoded_slash__/g, '%2F');
  } catch {
    return segment;
  }
}

export function normalizePath(path: string): string {
  const raw = String(path || '').split(/[?#]/, 1)[0] || '/';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  const normalized = withSlash.replace(/\/+/g, '/');
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/g, '') : normalized;
  return trimmed.split('/').map((segment, index) => (index === 0 ? '' : safeDecodeSegment(segment))).join('/') || '/';
}

function pathItemServers(pathItem: JsonRecord): string[] {
  return asArray(pathItem.servers)
    .map((entry) => asRecord(entry))
    .map((entry) => (typeof entry?.url === 'string' ? entry.url : ''))
    .filter(Boolean);
}

function operationServers(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): string[] {
  const rawServers = asArray(operation.servers).length > 0
    ? asArray(operation.servers)
    : pathItemServers(pathItem).length > 0
      ? asArray(pathItem.servers)
      : asArray(root.servers);
  const values = rawServers
    .map((entry) => asRecord(entry))
    .map((entry) => (typeof entry?.url === 'string' ? entry.url : ''))
    .filter(Boolean);
  return values.length > 0 ? values : [''];
}

function serverPathPrefix(url: string): string {
  if (!url) return '';
  const withVariables = url.replace(/\{[^}]+\}/g, '__server_variable__');
  try {
    return normalizePath(new URL(withVariables).pathname).replace(/__server_variable__/g, '{serverVariable}');
  } catch {
    const noProtocol = withVariables.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
    return normalizePath(noProtocol).replace(/__server_variable__/g, '{serverVariable}');
  }
}

function joinPaths(prefix: string, path: string): string {
  return normalizePath(`${prefix}/${path}`.replace(/\/+/g, '/'));
}

function normalizeResponseKey(status: string): string {
  const raw = String(status);
  return /^[1-5]xx$/i.test(raw) ? raw.toUpperCase() : raw;
}

function collectSecurityApiKeys(root: JsonRecord, operation: JsonRecord): Set<string> {
  const securitySchemes = asRecord(asRecord(root.components)?.securitySchemes);
  const requirements = operation.security === undefined ? asArray(root.security) : asArray(operation.security);
  const names = new Set<string>();
  for (const requirement of requirements.map((entry) => asRecord(entry)).filter(Boolean)) {
    for (const schemeName of Object.keys(requirement!)) {
      const scheme = resolveInternalRef<JsonRecord>(root, securitySchemes?.[schemeName]);
      if (scheme?.type === 'apiKey' && typeof scheme.name === 'string' && ['query', 'header', 'cookie'].includes(String(scheme.in))) {
        names.add(`${String(scheme.in)}:${scheme.name.toLowerCase()}`);
      }
    }
  }
  return names;
}

function securitySchemeKind(scheme: JsonRecord | null): string {
  if (!scheme) return 'unknown';
  const type = String(scheme.type || 'unknown');
  if (type === 'apiKey') return `apiKey:${String(scheme.in || 'unknown')}`;
  if (type === 'http') return `http:${String(scheme.scheme || 'unknown').toLowerCase()}`;
  return type;
}

function collectSecuritySchemeWarnings(root: JsonRecord, operation: JsonRecord): string[] {
  const securitySchemes = asRecord(asRecord(root.components)?.securitySchemes);
  const requirements = operation.security === undefined ? asArray(root.security) : asArray(operation.security);
  const warnings = new Set<string>();
  for (const requirement of requirements.map((entry) => asRecord(entry)).filter(Boolean)) {
    for (const schemeName of Object.keys(requirement!)) {
      const scheme = resolveInternalRef<JsonRecord>(root, securitySchemes?.[schemeName]);
      warnings.add(
        `CONTRACT_SECURITY_NOT_VALIDATED: security scheme ${schemeName} (${securitySchemeKind(scheme)}) is not runtime-proven beyond credential presence by dynamic contract tests`
      );
    }
  }
  return [...warnings];
}

function securityCheckFor(schemeName: string, scheme: JsonRecord | null): ContractSecurityCheck {
  const kind = securitySchemeKind(scheme);
  if (scheme?.type === 'apiKey' && typeof scheme.name === 'string' && ['header', 'query', 'cookie'].includes(String(scheme.in))) {
    return { scheme: schemeName, kind, checkable: true, in: String(scheme.in) as 'header' | 'query' | 'cookie', name: scheme.name };
  }
  if (scheme?.type === 'http') {
    const httpScheme = String(scheme.scheme || '').toLowerCase();
    if (httpScheme === 'basic') return { scheme: schemeName, kind, checkable: true, prefix: 'Basic ' };
    if (httpScheme === 'bearer') return { scheme: schemeName, kind, checkable: true, prefix: 'Bearer ' };
    // RFC 7235 credentials always open with the auth-scheme token, so any
    // registered HTTP scheme (Digest, DPoP, Negotiate, ...) is checkable by
    // prefix; the runtime comparison is case-insensitive.
    if (httpScheme) return { scheme: schemeName, kind, checkable: true, prefix: `${httpScheme.charAt(0).toUpperCase()}${httpScheme.slice(1)} ` };
    return { scheme: schemeName, kind, checkable: true, in: 'header', name: 'Authorization' };
  }
  if (scheme?.type === 'oauth2' || scheme?.type === 'openIdConnect') {
    return { scheme: schemeName, kind, checkable: true, in: 'header', name: 'Authorization' };
  }
  return { scheme: schemeName, kind, checkable: false };
}

function collectSecurityRuntimeChecks(root: JsonRecord, operation: JsonRecord): ContractSecurityCheck[][] | undefined {
  const securitySchemes = asRecord(asRecord(root.components)?.securitySchemes);
  const requirements = operation.security === undefined ? asArray(root.security) : asArray(operation.security);
  const alternatives: ContractSecurityCheck[][] = [];
  for (const requirement of requirements.map((entry) => asRecord(entry)).filter(Boolean)) {
    const schemeNames = Object.keys(requirement!);
    // An empty security requirement object means anonymous access is allowed,
    // so the credential check cannot be required at runtime.
    if (schemeNames.length === 0) return undefined;
    alternatives.push(schemeNames.map((schemeName) => securityCheckFor(schemeName, resolveInternalRef<JsonRecord>(root, securitySchemes?.[schemeName]))));
  }
  // An alternative made up entirely of uncheckable schemes always evaluates
  // satisfied, which makes the whole OR unfalsifiable; emitting a test that
  // can never fail would imply coverage that does not exist.
  if (alternatives.some((alternative) => alternative.length > 0 && alternative.every((check) => !check.checkable))) return undefined;
  return alternatives.length > 0 ? alternatives : undefined;
}

function resolvedParameters(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): JsonRecord[] {
  return [...asArray(pathItem.parameters), ...asArray(operation.parameters)]
    .map((rawParam) => {
      try {
        return resolveInternalRef<JsonRecord>(root, rawParam);
      } catch {
        return null;
      }
    })
    .filter((param): param is JsonRecord => Boolean(param));
}

const DEFAULT_PARAM_STYLES: Record<string, string> = { query: 'form', path: 'simple', header: 'simple', cookie: 'form' };

// OAS Parameter Object: header parameters named Accept, Content-Type, or
// Authorization SHALL be ignored; content negotiation and credentials are
// described by the media types and security schemes instead.
const IGNORED_HEADER_PARAMS = new Set(['accept', 'content-type', 'authorization']);

function isIgnoredParameter(location: string, name: string): boolean {
  return location === 'header' && IGNORED_HEADER_PARAMS.has(name.toLowerCase());
}

// A content parameter qualifies for runtime JSON validation when it declares
// exactly one JSON media type with a schema.
function jsonContentParameterMedia(param: JsonRecord): unknown | undefined {
  const content = asRecord(param.content);
  if (!content) return undefined;
  const entries = Object.entries(content);
  if (entries.length !== 1) return undefined;
  const [contentType, mediaObject] = entries[0]!;
  const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!isJsonBaseType(base)) return undefined;
  const schema = asRecord(mediaObject)?.schema;
  return schema === undefined ? undefined : schema;
}

function collectSerializationWarnings(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord, decodedKeys: Set<string>): string[] {
  const warnings: string[] = [];
  for (const param of resolvedParameters(root, pathItem, operation)) {
    const location = String(param.in || '').toLowerCase();
    const name = String(param.name || '');
    const defaultStyle = DEFAULT_PARAM_STYLES[location];
    if (!name || !defaultStyle || isIgnoredParameter(location, name)) continue;
    const style = typeof param.style === 'string' ? param.style : defaultStyle;
    const defaultExplode = style === 'form';
    const explode = typeof param.explode === 'boolean' ? param.explode : defaultExplode;
    // Content parameters with a single JSON media type are parsed and
    // validated at runtime, but only in the query/header locations the
    // runtime check covers; every other content shape or location warns.
    const unvalidatedContent = param.content !== undefined
      && (jsonContentParameterMedia(param) === undefined || (location !== 'query' && location !== 'header'));
    if (style !== defaultStyle || explode !== defaultExplode || param.allowReserved === true || unvalidatedContent) {
      // A non-default style the runtime check decodes back into items is
      // validated rather than warned; allowReserved and content keep the
      // warning because neither is interpreted.
      if (decodedKeys.has(`${location}:${name.toLowerCase()}`) && param.allowReserved !== true && param.content === undefined) continue;
      warnings.push(`CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED: parameter ${location}:${name} declares non-default style, explode, allowReserved, or content and its serialization is not validated`);
    }
  }
  return warnings;
}

const SCALAR_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

function packedScalarSchema(packed: PackedSchema): unknown | undefined {
  if (packed.unsupported || packed.schema === undefined) return undefined;
  const record = asRecord(packed.schema);
  if (!record) return undefined;
  const types = Array.isArray(record.type) ? record.type : [record.type];
  if (!types.every((entry) => typeof entry === 'string' && SCALAR_SCHEMA_TYPES.has(entry))) return undefined;
  return packed.schema;
}

// Arrays of scalars are runtime-decodable: the serialized parameter or
// header value is split back into items, so the validator sees a real array.
// Tuple forms, $ref items, and non-scalar items stay undecodable.
function packedArrayItemsSchema(packed: PackedSchema): unknown | undefined {
  if (packed.unsupported || packed.schema === undefined) return undefined;
  const record = asRecord(packed.schema);
  if (!record) return undefined;
  const types = Array.isArray(record.type) ? record.type : [record.type];
  if (types.length !== 1 || types[0] !== 'array') return undefined;
  if (record.prefixItems !== undefined || Array.isArray(record.items)) return undefined;
  if (record.items === undefined) return {};
  const items = asRecord(record.items);
  if (!items || typeof items.$ref === 'string') return undefined;
  const itemTypes = Array.isArray(items.type) ? items.type : [items.type];
  if (!itemTypes.every((entry) => typeof entry === 'string' && SCALAR_SCHEMA_TYPES.has(entry))) return undefined;
  return items;
}

const QUERY_ARRAY_DECODES: Record<string, ContractParameterCheck['decode']> = {
  'form:true': 'multi',
  'form:false': 'csv',
  'spaceDelimited:false': 'ssv',
  'pipeDelimited:false': 'pipes'
};

// Runtime parameter value checks cover scalar query/header/path/cookie
// parameters with default serialization, plus array-of-scalar query and
// header parameters whose declared style the test script can decode:
// exploded form arrays arrive as repeated query keys, and non-exploded
// form/spaceDelimited/pipeDelimited arrays are delimiter-joined values.
// Object schemas and undecodable style combinations are skipped and stay
// covered by CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED.
function collectParameterChecks(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord, version: OpenApiVersion, operationId: string, pathTemplate: string, warnings: string[]): ContractParameterCheck[] | undefined {
  const securityKeys = collectSecurityApiKeys(root, operation);
  const checks: ContractParameterCheck[] = [];
  const seen = new Set<string>();
  // Operation-level parameters override path-item parameters, so they are
  // resolved first and win the dedupe.
  const orderedParams = [...asArray(operation.parameters), ...asArray(pathItem.parameters)]
    .map((rawParam) => {
      try {
        return resolveInternalRef<JsonRecord>(root, rawParam);
      } catch {
        return null;
      }
    })
    .filter((param): param is JsonRecord => Boolean(param));
  for (const param of orderedParams) {
    const location = String(param.in || '').toLowerCase();
    if (location !== 'query' && location !== 'header' && location !== 'path' && location !== 'cookie') continue;
    const name = String(param.name || '');
    if (!name || isIgnoredParameter(location, name)) continue;
    const key = `${location}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (securityKeys.has(key)) continue;
    // A parameter declared through content with a single JSON media type
    // carries a literal JSON value; it is parsed and validated at runtime
    // instead of being treated as style serialization.
    const contentMedia = jsonContentParameterMedia(param);
    if (contentMedia !== undefined && (location === 'query' || location === 'header')) {
      // Parameters are request-side: readOnly properties must strip and
      // writeOnly properties must stay, same as request body packing.
      const packed = packSchema(root, contentMedia, version, 'request');
      warnings.push(...packNoteWarnings(packed, `parameter ${location}:${name} of ${operationId}`));
      if (packed.unsupported) {
        warnings.push(`CONTRACT_SCHEMA_NOT_COMPILED: parameter ${location}:${name} schema on ${operationId} skipped (${packed.unsupported})`);
      } else if (packed.schema !== undefined) {
        const check: ContractParameterCheck = { in: location as 'query' | 'header', name, required: param.required === true, content: true, schema: packed.schema };
        if (location === 'query' && param.allowEmptyValue === true) check.allowEmptyValue = true;
        checks.push(check);
      }
      continue;
    }
    if (param.content !== undefined || param.schema === undefined) continue;
    const defaultStyle = DEFAULT_PARAM_STYLES[location]!;
    const style = typeof param.style === 'string' ? param.style : defaultStyle;
    const defaultExplode = style === 'form';
    const explode = typeof param.explode === 'boolean' ? param.explode : defaultExplode;
    const defaultSerialization = style === defaultStyle && explode === defaultExplode;
    const packed = packSchema(root, param.schema, version);
    // Pack notes follow validation attempts: default-serialization parameters
    // always packed before this change, and decoded array parameters emit
    // their notes where the check is created below.
    const noteWarnings = packNoteWarnings(packed, `parameter ${location}:${name} of ${operationId}`);
    if (defaultSerialization) warnings.push(...noteWarnings);
    if (packed.unsupported) {
      // Non-default serialization already carries its own warning, so only
      // parameters that would otherwise have produced a check surface the
      // pack failure.
      if (defaultSerialization) warnings.push(`CONTRACT_SCHEMA_NOT_COMPILED: parameter ${location}:${name} schema on ${operationId} skipped (${packed.unsupported})`);
      continue;
    }
    // A path parameter embedded in a compound segment such as /reports/{name}.{ext}
    // is extracted at runtime by matching the concrete request segment against the
    // template segment (see pathParamValue), so it IS schema-validated. Only an
    // ambiguous adjacent-parameter segment ({a}{b}) cannot be resolved and stays
    // warning-only.
    if (location === 'path') {
      const containingSegment = pathTemplate.split('/').find((segment) => segment.includes(`{${name}}`));
      if (containingSegment !== undefined && containingSegment !== `{${name}}`) {
        const segmentParts = containingSegment.split(/(\{[^}]+\})/).filter(Boolean);
        let extractable = true;
        for (let partIndex = 0; partIndex < segmentParts.length - 1; partIndex += 1) {
          if (/^\{[^}]+\}$/.test(segmentParts[partIndex]!) && /^\{[^}]+\}$/.test(segmentParts[partIndex + 1]!)) extractable = false;
        }
        if (!extractable) {
          warnings.push(`CONTRACT_PATH_PARAM_COMPOUND_SEGMENT_NOT_VALIDATED: path parameter ${name} of ${operationId} is in an ambiguous adjacent-parameter path segment and is not schema-validated`);
          continue;
        }
      }
    }
    const scalarSchema = packedScalarSchema(packed);
    if (scalarSchema !== undefined) {
      if (!defaultSerialization) continue;
      const check: ContractParameterCheck = { in: location, name, required: param.required === true, schema: scalarSchema };
      if (location === 'query' && param.allowEmptyValue === true) check.allowEmptyValue = true;
      checks.push(check);
      continue;
    }
    if (location !== 'query' && location !== 'header') continue;
    const items = packedArrayItemsSchema(packed);
    if (items === undefined) continue;
    const decode = location === 'query' ? QUERY_ARRAY_DECODES[`${style}:${explode}`] : style === 'simple' && !explode ? 'csv' : undefined;
    if (!decode) continue;
    if (!defaultSerialization) warnings.push(...noteWarnings);
    const check: ContractParameterCheck = { in: location, name, required: param.required === true, schema: packed.schema, decode, items };
    if (location === 'query' && param.allowEmptyValue === true) check.allowEmptyValue = true;
    checks.push(check);
  }
  return checks.length > 0 ? checks : undefined;
}

// packSchema notes mark constructs it handled by stripping rather than
// asserting; each becomes a visible warning at the call site.
function packNoteWarnings(packed: PackedSchema, context: string): string[] {
  return (packed.notes ?? []).map((note) =>
    note === 'discriminator'
      ? `CONTRACT_DISCRIMINATOR_NOT_VALIDATED: discriminator on ${context} has no sibling oneOf/anyOf of internal $ref members and is not validated`
      : `CONTRACT_SCHEMA_NOT_COMPILED: ${note} on ${context} is not validated`
  );
}

function collectDeclaredQueryParameters(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): string[] {
  const names = new Set<string>();
  for (const param of resolvedParameters(root, pathItem, operation)) {
    if (String(param.in || '').toLowerCase() !== 'query') continue;
    const name = String(param.name || '');
    if (name) names.add(name.toLowerCase());
  }
  for (const key of collectSecurityApiKeys(root, operation)) {
    if (key.startsWith('query:')) names.add(key.slice('query:'.length));
  }
  return [...names];
}

function collectParameters(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): ContractParameterRequirement[] {
  const securityKeys = collectSecurityApiKeys(root, operation);
  const requirements: ContractParameterRequirement[] = [];
  const params = [...asArray(pathItem.parameters), ...asArray(operation.parameters)];
  const seen = new Set<string>();
  for (const rawParam of params) {
    const param = resolveInternalRef<JsonRecord>(root, rawParam);
    if (!param) continue;
    const location = String(param.in || '').toLowerCase();
    if (!['path', 'query', 'header', 'cookie'].includes(location)) continue;
    const name = String(param.name || '');
    if (!name || param.required !== true || isIgnoredParameter(location, name)) continue;
    const key = `${location}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      in: location as 'path' | 'query' | 'header' | 'cookie',
      name,
      securityDerived: securityKeys.has(key)
    });
  }
  return requirements;
}

const BODY_FIELD_RULE_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data']);

function isJsonBaseType(base: string): boolean {
  return base === 'application/json' || /\+json$/.test(base);
}

interface MergedObjectSchema {
  required: string[];
  properties: JsonRecord;
}

function mergeObjectSchema(root: JsonRecord, rawSchema: unknown, depth: number): MergedObjectSchema | null {
  if (depth > 10) return null;
  let schema: JsonRecord | null;
  try {
    schema = resolveInternalRef<JsonRecord>(root, rawSchema);
  } catch {
    return null;
  }
  if (!schema) return null;
  const merged: MergedObjectSchema = {
    required: asArray(schema.required).map((entry) => String(entry)).filter(Boolean),
    properties: { ...(asRecord(schema.properties) ?? {}) }
  };
  for (const member of asArray(schema.allOf)) {
    const child = mergeObjectSchema(root, member, depth + 1);
    if (!child) continue;
    merged.required.push(...child.required);
    merged.properties = { ...merged.properties, ...child.properties };
  }
  merged.required = [...new Set(merged.required)];
  return merged;
}

function propertyIsReadOnly(root: JsonRecord, properties: JsonRecord, name: string): boolean {
  try {
    return resolveInternalRef<JsonRecord>(root, properties[name])?.readOnly === true;
  } catch {
    return false;
  }
}

// 3.0 marks binary multipart fields with format: binary; 3.1 replaces that
// with contentMediaType and no contentEncoding (contentEncoding means the
// value is an encoded string carried inline, which stays a text part). JSON
// and text/* media types are excluded because those are legitimately sent as
// text parts even when declared through contentMediaType.
function propertyIsBinary(root: JsonRecord, properties: JsonRecord, name: string): boolean {
  let schema: JsonRecord | null;
  try {
    schema = resolveInternalRef<JsonRecord>(root, properties[name]);
  } catch {
    return false;
  }
  if (!schema) return false;
  if (schema.format === 'binary') return true;
  if (typeof schema.contentMediaType !== 'string' || typeof schema.contentEncoding === 'string') return false;
  const media = schema.contentMediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!media) return false;
  return media !== 'application/json' && !media.endsWith('+json') && !media.startsWith('text/');
}

// Encoding Objects describe per-field serialization of form bodies. The wire
// form is not reconstructed here, but the generated artifact can be checked
// against the declaration: explicit per-part contentType, binary fields as
// file parts, and non-default style/explode/allowReserved surfaced as
// serialization warnings.
function fieldEncodings(root: JsonRecord, base: string, mediaObject: JsonRecord | null, properties: JsonRecord): Record<string, ContractFieldEncoding> | undefined {
  const declared = asRecord(mediaObject?.encoding);
  const encodings: Record<string, ContractFieldEncoding> = {};
  for (const name of Object.keys(properties)) {
    if (base === 'multipart/form-data' && propertyIsBinary(root, properties, name)) {
      encodings[name] = { ...encodings[name], binary: true };
    }
  }
  if (declared) {
    for (const [name, rawEncoding] of Object.entries(declared)) {
      const encoding = asRecord(rawEncoding);
      if (!encoding) continue;
      const entry: ContractFieldEncoding = { ...encodings[name] };
      if (typeof encoding.contentType === 'string' && encoding.contentType.trim()) {
        entry.contentType = encoding.contentType.toLowerCase();
      }
      // Per-part headers only apply to multipart bodies, and Postman formdata
      // entries can only carry a contentType, so declared headers are
      // unrepresentable in the generated artifact.
      if (base === 'multipart/form-data' && asRecord(encoding.headers)) {
        entry.hasHeaders = true;
      }
      if (base === 'application/x-www-form-urlencoded') {
        const style = typeof encoding.style === 'string' ? encoding.style : 'form';
        const explode = typeof encoding.explode === 'boolean' ? encoding.explode : style === 'form';
        if (style !== 'form' || explode !== (style === 'form') || encoding.allowReserved === true) {
          entry.nonDefaultSerialization = true;
        }
      }
      if (Object.keys(entry).length > 0) encodings[name] = entry;
    }
  }
  return Object.keys(encodings).length > 0 ? encodings : undefined;
}

// Scalar form-field schemas pack per property (request direction) so the
// generated urlencoded and multipart text values can be statically validated;
// non-scalar properties are covered by the JSON-encoding value check and the
// required/readOnly rules.
function formFieldSchemas(root: JsonRecord, version: OpenApiVersion, properties: JsonRecord, context: string, warnings: string[]): Record<string, unknown> | undefined {
  const schemas: Record<string, unknown> = {};
  for (const name of Object.keys(properties)) {
    const packed = packSchema(root, properties[name], version, 'request');
    warnings.push(...packNoteWarnings(packed, `field ${name} of ${context}`));
    if (packed.unsupported) {
      // The static field check is the only value-level coverage form fields
      // get, so a pack failure is surfaced rather than silently skipped.
      warnings.push(`CONTRACT_SCHEMA_NOT_COMPILED: field ${name} of ${context} skipped (${packed.unsupported})`);
      continue;
    }
    if (packed.schema === undefined) continue;
    const schema = packedScalarSchema(packed);
    if (schema !== undefined) schemas[name] = schema;
  }
  return Object.keys(schemas).length > 0 ? schemas : undefined;
}

function requestBodyFieldRules(root: JsonRecord, content: JsonRecord, version: OpenApiVersion, operationId: string, warnings: string[]): Record<string, ContractBodyFieldRules> | undefined {
  const rules: Record<string, ContractBodyFieldRules> = {};
  for (const [contentType, mediaObject] of Object.entries(content)) {
    const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (!isJsonBaseType(base) && !BODY_FIELD_RULE_TYPES.has(base)) continue;
    const mediaRecord = asRecord(mediaObject);
    const merged = mergeObjectSchema(root, mediaRecord?.schema, 0);
    if (!merged) continue;
    const readOnly = Object.keys(merged.properties).filter((name) => propertyIsReadOnly(root, merged.properties, name));
    // readOnly properties may be required in responses without being sent in
    // requests, so they are excluded from the request-side required list.
    const required = merged.required.filter((name) => !propertyIsReadOnly(root, merged.properties, name));
    const formRules = BODY_FIELD_RULE_TYPES.has(base);
    const encodings = formRules ? fieldEncodings(root, base, mediaRecord, merged.properties) : undefined;
    const fieldSchemas = formRules ? formFieldSchemas(root, version, merged.properties, `request body ${contentType} of ${operationId}`, warnings) : undefined;
    if (required.length > 0 || readOnly.length > 0 || encodings || fieldSchemas) {
      const rule: ContractBodyFieldRules = { required, readOnly };
      if (encodings) rule.encodings = encodings;
      if (fieldSchemas) rule.fieldSchemas = fieldSchemas;
      rules[base] = rule;
    }
  }
  return Object.keys(rules).length > 0 ? rules : undefined;
}

function requestBodyJsonSchemas(
  root: JsonRecord,
  content: JsonRecord,
  version: OpenApiVersion,
  operationId: string,
  warnings: string[]
): Record<string, unknown> | undefined {
  const schemas: Record<string, unknown> = {};
  const exampleWarnings = new Set<string>();
  for (const [contentType, mediaObject] of Object.entries(content)) {
    const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    const mediaRecord = asRecord(mediaObject);
    const schema = mediaRecord?.schema;
    if (!isJsonBaseType(base)) {
      // urlencoded/multipart bodies get static field rules; other non-JSON
      // request schemas mirror the response-side not-validated warning so the
      // skip is never silent.
      if (schema !== undefined && !BODY_FIELD_RULE_TYPES.has(base)) {
        warnings.push(`CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED: request body schema for ${contentType} on ${operationId} is not validated at runtime`);
      }
      continue;
    }
    if (schema === undefined) continue;
    const packed = packSchema(root, schema, version, 'request');
    warnings.push(...packNoteWarnings(packed, `request body ${contentType} of ${operationId}`));
    if (mediaRecord) validateExamples(root, mediaRecord, packed, contentType, operationId, exampleWarnings);
    if (packed.unsupported) {
      warnings.push(`CONTRACT_REQUEST_SCHEMA_NOT_VALIDATED: request body schema for ${contentType} on ${operationId} is not validated (${packed.unsupported})`);
      continue;
    }
    if (packed.schema !== undefined) schemas[base] = packed.schema;
  }
  warnings.push(...exampleWarnings);
  return Object.keys(schemas).length > 0 ? schemas : undefined;
}

function collectRequestBody(
  root: JsonRecord,
  operation: JsonRecord,
  version: OpenApiVersion,
  operationId: string,
  warnings: string[]
): ContractRequestBodyRequirement | undefined {
  const body = resolveInternalRef<JsonRecord>(root, operation.requestBody);
  if (!body) return undefined;
  const content = asRecord(body.content);
  const fieldRules = content ? requestBodyFieldRules(root, content, version, operationId, warnings) : undefined;
  if (fieldRules) {
    for (const [base, rule] of Object.entries(fieldRules)) {
      for (const [field, encoding] of Object.entries(rule.encodings ?? {})) {
        if (encoding.nonDefaultSerialization) {
          warnings.push(
            `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED: ${base} request body field ${field} on ${operationId} declares non-default encoding style, explode, or allowReserved and its serialization is not validated`
          );
        }
        if (encoding.hasHeaders) {
          warnings.push(
            `CONTRACT_ENCODING_HEADERS_NOT_VALIDATED: ${base} request body field ${field} on ${operationId} declares per-part headers that generated formdata entries cannot carry`
          );
        }
      }
    }
  }
  return {
    required: body.required === true,
    contentTypes: content ? Object.keys(content) : [],
    fieldRules,
    jsonSchemas: content ? requestBodyJsonSchemas(root, content, version, operationId, warnings) : undefined
  };
}

function exampleCandidates(root: JsonRecord, mediaObject: JsonRecord): Array<{ label: string; value: unknown }> {
  const candidates: Array<{ label: string; value: unknown }> = [];
  if ('example' in mediaObject) candidates.push({ label: 'example', value: mediaObject.example });
  const examples = asRecord(mediaObject.examples);
  if (examples) {
    for (const [name, rawExample] of Object.entries(examples)) {
      let example: JsonRecord | null;
      try {
        example = resolveInternalRef<JsonRecord>(root, rawExample);
      } catch {
        continue;
      }
      if (example && 'value' in example) candidates.push({ label: `examples.${name}`, value: example.value });
    }
  }
  return candidates;
}

function validateExamples(root: JsonRecord, mediaObject: JsonRecord, packed: PackedSchema, contentType: string, context: string, warnings: Set<string>): void {
  if (packed.schema === undefined || packed.unsupported) return;
  const candidates = exampleCandidates(root, mediaObject);
  if (candidates.length === 0) return;
  const validate = compileSchemaValidator(packed.schema);
  if (!validate) return;
  for (const candidate of candidates) {
    if (!validate(candidate.value)) {
      warnings.add(`CONTRACT_EXAMPLE_SCHEMA_MISMATCH: ${candidate.label} for ${contentType} on ${context} does not match its schema`);
    }
  }
}

function responseContent(root: JsonRecord, version: OpenApiVersion, response: JsonRecord, context: string, warnings: Set<string>): Record<string, ContractMedia> {
  const content = asRecord(response.content);
  if (!content) return {};
  const media: Record<string, ContractMedia> = {};
  for (const [contentType, mediaObject] of Object.entries(content)) {
    const mediaRecord = asRecord(mediaObject);
    const schema = mediaRecord?.schema;
    let packed = schema === undefined ? {} : packSchema(root, schema, version);
    for (const warning of packNoteWarnings(packed, `response ${contentType} of ${context}`)) warnings.add(warning);
    // A reference graph past the embed cap degrades to a presence-only media
    // check with a warning; an always-failing runtime test would make every
    // run red on very large specs such as Stripe's.
    if (isSchemaGraphOverflow(packed)) {
      warnings.add(`CONTRACT_SCHEMA_NOT_COMPILED: response schema for ${contentType} on ${context} skipped (${packed.unsupported})`);
      packed = {};
    }
    // Example self-consistency only applies to JSON media: an Example Object
    // for XML or text legally holds the serialized string form, which would
    // spuriously mismatch an object schema.
    const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (mediaRecord && isJsonBaseType(base)) validateExamples(root, mediaRecord, packed, contentType, context, warnings);
    media[contentType] = packed;
  }
  return media;
}

function responseHeaders(root: JsonRecord, version: OpenApiVersion, response: JsonRecord, context: string, warnings: Set<string>): ContractHeader[] {
  const headers = asRecord(response.headers);
  if (!headers) return [];
  const entries: ContractHeader[] = [];
  for (const [name, rawHeader] of Object.entries(headers)) {
    // OAS: a response header named Content-Type SHALL be ignored.
    if (name.toLowerCase() === 'content-type') continue;
    const header = resolveInternalRef<JsonRecord>(root, rawHeader);
    if (!header) {
      entries.push({ name, required: true, unsupported: 'Unresolved response header' });
      continue;
    }
    const required = header.required === true;
    if (header.content) {
      entries.push({ name, required, unsupported: 'OpenAPI response header content is unsupported' });
      continue;
    }
    if (!header.schema) {
      entries.push({ name, required });
      continue;
    }
    const packed = packSchema(root, header.schema, version);
    for (const warning of packNoteWarnings(packed, `response header ${name} of ${context}`)) warnings.add(warning);
    if (isSchemaGraphOverflow(packed)) {
      warnings.add(`CONTRACT_SCHEMA_NOT_COMPILED: response header ${name} schema on ${context} skipped (${packed.unsupported})`);
      entries.push({ name, required });
      continue;
    }
    // Array-of-scalar headers serialize as comma-joined simple style, which
    // the runtime splits back into items before validating. Other non-scalar
    // header schemas would feed a serialized string into an object validator
    // and fail every run, so those drop to presence-only with a warning.
    if (!packed.unsupported && packed.schema !== undefined && packedScalarSchema(packed) === undefined) {
      const items = packedArrayItemsSchema(packed);
      if (items !== undefined) {
        entries.push({ name, required, schema: packed.schema, items });
        continue;
      }
      warnings.add(`CONTRACT_HEADER_SCHEMA_NOT_VALIDATED: response header ${name} on ${context} declares a non-scalar schema and its value is not validated`);
      entries.push({ name, required });
      continue;
    }
    entries.push({ name, required, ...packed });
  }
  return entries;
}

export function buildContractIndex(root: JsonRecord): ContractIndex {
  if (root.swagger === '2.0') throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (found swagger 2.0)');
  if (!('openapi' in root)) throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (missing openapi)');
  const version = detectOpenApiVersion(root);
  const paths = asRecord(root.paths);
  const operations: ContractOperation[] = [];
  const warnings: string[] = [];

  if (asRecord(root.webhooks)) warnings.push('CONTRACT_WEBHOOKS_NOT_VALIDATED: OpenAPI webhooks are not validated by dynamic contract tests');

  if (paths) {
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = resolveInternalRef<JsonRecord>(root, rawPathItem);
      if (!pathItem) continue;
      for (const [method, rawOperation] of Object.entries(pathItem)) {
        const lowerMethod = method.toLowerCase();
        if (!HTTP_METHODS.has(lowerMethod)) continue;
        const operation = resolveInternalRef<JsonRecord>(root, rawOperation);
        if (!operation) continue;
        if (operation.callbacks) warnings.push(`CONTRACT_CALLBACKS_NOT_VALIDATED: callbacks are not validated for ${lowerMethod.toUpperCase()} ${path}`);
        const responses = asRecord(operation.responses);
        if (!responses || Object.keys(responses).length === 0) {
          throw new Error(`CONTRACT_OPERATION_NO_RESPONSES: ${lowerMethod.toUpperCase()} ${path} must define at least one response`);
        }
        const contractResponses: Record<string, ContractResponse> = {};
        const responseWarnings = new Set<string>();
        for (const [status, rawResponse] of Object.entries(responses)) {
          const response = resolveInternalRef<JsonRecord>(root, rawResponse);
          if (!response) continue;
          if (asRecord(response.links)) {
            responseWarnings.add(`CONTRACT_LINKS_NOT_VALIDATED: response links are not validated for ${lowerMethod.toUpperCase()} ${path}`);
          }
          const responseContext = `${lowerMethod.toUpperCase()} ${path} status ${status}`;
          const content = responseContent(root, version, response, responseContext, responseWarnings);
          for (const [contentType, media] of Object.entries(content)) {
            const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
            const schemaType = asRecord(media.schema)?.type;
            if (!isJsonBaseType(base) && media.schema !== undefined && !media.unsupported && schemaType !== 'string') {
              responseWarnings.add(`CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED: response schema for ${contentType} on ${responseContext} is not validated at runtime`);
            }
          }
          const headers = responseHeaders(root, version, response, responseContext, responseWarnings);
          contractResponses[normalizeResponseKey(status)] = {
            content,
            hasBody: Object.keys(content).length > 0,
            headers
          };
        }
        const candidates = [...new Set([
          path,
          ...operationServers(root, pathItem, operation).map((server) => joinPaths(serverPathPrefix(server), path))
        ].map(normalizePath))];
        const operationId = `${lowerMethod.toUpperCase()} ${path}`;
        const opWarnings: string[] = [];
        opWarnings.push(...responseWarnings);
        opWarnings.push(...collectSecuritySchemeWarnings(root, operation));
        const parameterChecks = collectParameterChecks(root, pathItem, operation, version, operationId, path, opWarnings);
        const checkedKeys = new Set((parameterChecks ?? []).map((check) => `${check.in}:${check.name.toLowerCase()}`));
        const decodedKeys = new Set((parameterChecks ?? []).filter((check) => check.decode).map((check) => `${check.in}:${check.name.toLowerCase()}`));
        opWarnings.push(...collectSerializationWarnings(root, pathItem, operation, decodedKeys));
        if (operation.deprecated === true) {
          opWarnings.push(`CONTRACT_OPERATION_DEPRECATED: ${lowerMethod.toUpperCase()} ${path} is marked deprecated in the OpenAPI document`);
        }
        const requiredParameters = collectParameters(root, pathItem, operation);
        for (const parameter of requiredParameters.filter((entry) => entry.securityDerived)) {
          opWarnings.push(`CONTRACT_SECURITY_NOT_VALIDATED: security parameter ${parameter.in}:${parameter.name} is not statically required in generated requests`);
        }
        for (const parameter of requiredParameters.filter((entry) => entry.in === 'cookie' && !entry.securityDerived)) {
          // The fail-until-supplied claim only holds when a runtime check was
          // actually created; undecodable cookie schemas get the weaker text.
          opWarnings.push(checkedKeys.has(`cookie:${parameter.name.toLowerCase()}`)
            ? `CONTRACT_COOKIE_PARAM_NOT_VALIDATED: required cookie parameter ${parameter.name} is not included in generated requests; the runtime test fails until the cookie is supplied at send time`
            : `CONTRACT_COOKIE_PARAM_NOT_VALIDATED: required cookie parameter ${parameter.name} is not included in generated requests and its value is not runtime-validated`);
        }
        const pathParamWarnings = new Set<string>();
        for (const param of resolvedParameters(root, pathItem, operation)) {
          if (String(param.in || '').toLowerCase() !== 'path') continue;
          const name = String(param.name || '');
          if (name && !checkedKeys.has(`path:${name.toLowerCase()}`)) {
            pathParamWarnings.add(`CONTRACT_PATH_PARAM_NOT_VALIDATED: path parameter ${name} value is not validated at runtime`);
          }
        }
        opWarnings.push(...pathParamWarnings);
        operations.push({
          id: operationId,
          method: lowerMethod.toUpperCase(),
          path,
          pointer: `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${lowerMethod}`,
          candidates,
          responses: contractResponses,
          requiredParameters,
          declaredQueryParameters: collectDeclaredQueryParameters(root, pathItem, operation),
          parameterChecks,
          requestBody: collectRequestBody(root, operation, version, operationId, opWarnings),
          security: collectSecurityRuntimeChecks(root, operation),
          warnings: opWarnings
        });
      }
    }
  }

  if (operations.length === 0) throw new Error('CONTRACT_NO_ELIGIBLE_OPERATIONS: Dynamic contract tests require at least one OpenAPI paths operation with responses');

  const seenCandidates = new Map<string, ContractOperation>();
  for (const operation of operations) {
    for (const candidate of operation.candidates) {
      const key = `${operation.method} ${candidate}`;
      const previous = seenCandidates.get(key);
      if (previous && previous.id !== operation.id) {
        throw new Error(`CONTRACT_DUPLICATE_OPERATION_MATCH: ${previous.id} and ${operation.id} both map to ${key}`);
      }
      seenCandidates.set(key, operation);
    }
  }

  return { operations, version, warnings };
}
