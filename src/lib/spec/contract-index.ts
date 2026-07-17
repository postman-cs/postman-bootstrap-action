import { WELL_KNOWN_URI_SUFFIXES } from './iana-registries.js';
import { collectHttpSemanticStaticLints } from './http-semantic-lints.js';
import { collectSchemaObjectLints, collectMediaParamLints } from './oas-schema-object-lints.js';
import { isSchemaGraphOverflow, packSchema, resolvePointer, type OpenApiVersion, type PackedSchema } from './schema-pack.js';
import { compileSchemaValidator } from './schema-validator-code.js';

type JsonRecord = Record<string, unknown>;

export type ContractMedia = PackedSchema;

export type ContractBodyExpectation = 'forbidden' | 'declared' | 'unknown';

export interface ContractHeader {
  name: string;
  required: boolean;
  schema?: unknown;
  items?: unknown;
  unsupported?: string;
}

export interface ContractLinkExpression {
  link: string;
  kind: 'body' | 'header' | 'requestBody' | 'requestHeader' | 'requestQuery' | 'requestPath';
  pointer?: string;
  header?: string;
  query?: string;
  path?: string;
  // Target input this response value feeds (parameter key such as "id" or
  // "query.limit", or "$requestBody") and the linkTargetValidators key whose
  // compiled schema the resolved value must satisfy.
  param?: string;
  targetKey?: string;
}

export interface ContractCallbackExpression {
  callback: string;
  expression: string;
}

export interface ContractCallbackRequestSources {
  path: string[];
  query: string[];
  header: string[];
}

export interface ContractResponse {
  content: Record<string, ContractMedia>;
  bodyExpectation: ContractBodyExpectation;
  headers: ContractHeader[];
  links?: ContractLinkExpression[];
  writeOnlyProperties?: string[];
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
  decode?: 'multi' | 'csv' | 'ssv' | 'pipes' | 'deepObject';
  pathStyle?: 'label' | 'matrix';
  items?: unknown;
}

export interface ContractSecurityCheck {
  scheme: string;
  kind: string;
  checkable: boolean;
  in?: 'header' | 'query' | 'cookie';
  name?: string;
  prefix?: string;
  bearerFormat?: string;
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
  pathMethods?: string[];
  deprecated?: boolean;
  servers?: string[];
  callbacks?: ContractCallbackExpression[];
  callbackRequestSources?: ContractCallbackRequestSources;
  linkTargetSchemas?: Record<string, unknown>;
  warnings: string[];
}

export interface ContractIndex {
  operations: ContractOperation[];
  version: OpenApiVersion;
  warnings: string[];
}

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

export function asArray(value: unknown): unknown[] {
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

export function resolveInternalRef<T extends JsonRecord>(root: JsonRecord, value: unknown): T | null {
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

function responseBodyExpectation(
  method: string,
  status: string,
  content: Record<string, ContractMedia>
): ContractBodyExpectation {
  const normalizedStatus = normalizeResponseKey(status);
  if (
    method === 'head'
    || normalizedStatus === '1XX'
    || /^1[0-9][0-9]$/.test(normalizedStatus)
    || normalizedStatus === '204'
    || normalizedStatus === '205'
    || normalizedStatus === '304'
  ) {
    return 'forbidden';
  }
  return Object.keys(content).length > 0 ? 'declared' : 'unknown';
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
    if (httpScheme === 'bearer') {
      const check: ContractSecurityCheck = { scheme: schemeName, kind, checkable: true, prefix: 'Bearer ' };
      if (typeof scheme.bearerFormat === 'string' && scheme.bearerFormat) check.bearerFormat = scheme.bearerFormat;
      return check;
    }
    // RFC 7235 credentials always open with the auth-scheme token, so any
    // registered HTTP scheme (Digest, DPoP, Negotiate, ...) is checkable by
    // prefix; the runtime comparison is case-insensitive.
    if (httpScheme) return { scheme: schemeName, kind, checkable: true, prefix: `${httpScheme.charAt(0).toUpperCase()}${httpScheme.slice(1)} ` };
    return { scheme: schemeName, kind, checkable: true, in: 'header', name: 'Authorization' };
  }
  if (scheme?.type === 'oauth2' || scheme?.type === 'openIdConnect') {
    return { scheme: schemeName, kind, checkable: true, prefix: 'Bearer ' };
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
    validateParameterExamples(root, param, packed, `${location}:${name} of ${operationId}`, warnings);
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
      // Label and matrix path values carry their style prefix in the concrete
      // segment, which the runtime strips before validating, so those styles
      // are decodable rather than warning-only.
      const decodablePathStyle = location === 'path' && (style === 'label' || style === 'matrix') && !explode ? (style as 'label' | 'matrix') : undefined;
      if (!defaultSerialization && !decodablePathStyle) continue;
      if (!defaultSerialization) warnings.push(...noteWarnings);
      const check: ContractParameterCheck = { in: location, name, required: param.required === true, schema: scalarSchema };
      if (decodablePathStyle) check.pathStyle = decodablePathStyle;
      if (location === 'query' && param.allowEmptyValue === true) check.allowEmptyValue = true;
      checks.push(check);
      continue;
    }
    // deepObject objects of scalar properties arrive as name[prop]=value query
    // pairs the runtime reassembles into an object for the schema validator.
    if (location === 'query' && style === 'deepObject' && explode) {
      const objectSchema = asRecord(packed.schema);
      const properties = objectSchema ? asRecord(objectSchema.properties) : null;
      const allScalar = properties !== null && Object.keys(properties).length > 0 && Object.values(properties).every((prop) => {
        const record = asRecord(prop);
        if (!record) return false;
        const types = Array.isArray(record.type) ? record.type : [record.type];
        return types.every((entry) => typeof entry === 'string' && SCALAR_SCHEMA_TYPES.has(entry));
      });
      if (allScalar) {
        warnings.push(...noteWarnings);
        const check: ContractParameterCheck = { in: 'query', name, required: param.required === true, schema: packed.schema, decode: 'deepObject' };
        if (param.allowEmptyValue === true) check.allowEmptyValue = true;
        checks.push(check);
        continue;
      }
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
function fieldEncodings(root: JsonRecord, base: string, mediaObject: JsonRecord | null, properties: JsonRecord, operationId: string, warnings: string[]): Record<string, ContractFieldEncoding> | undefined {
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
      // OAS: the Encoding Object keys "SHALL only apply to requestBody objects
      // ... exist as a property" of the schema; an unknown key is dead config.
      if (!(name in properties)) {
        warnings.push(`CONTRACT_MULTIPART_ENCODING_FIELD_UNKNOWN: ${operationId} ${base} encoding map names field ${name}, which is not a property of the request body schema`);
        continue;
      }
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
    const encodings = formRules ? fieldEncodings(root, base, mediaRecord, merged.properties, operationId, warnings) : undefined;
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
  for (const [contentType, mediaObject] of Object.entries(content ?? {})) {
    if (asRecord(mediaObject)?.schema === undefined) {
      warnings.push(
        `CONTRACT_REQUEST_SCHEMA_UNDOCUMENTED: request body ${contentType} on ${operationId} declares no schema; generated request payload shape is not validated`
      );
    }
  }
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

// IANA HTTP Authentication Scheme registry, 2026-06 snapshot. An http-type
// security scheme outside this set still generates a prefix check, but the
// unknown registration is surfaced instead of silently trusted.
const IANA_HTTP_AUTH_SCHEMES = new Set([
  'basic', 'bearer', 'concealed', 'digest', 'dpop', 'gnap', 'hoba', 'mutual', 'negotiate', 'oauth', 'privatetoken', 'scram-sha-1', 'scram-sha-256', 'vapid'
]);

function httpsUrlLint(value: unknown, label: string, schemeName: string): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') return `CONTRACT_SECURITY_SCHEME_URL: security scheme ${schemeName} ${label} ${value} is not an HTTPS URL`;
  } catch {
    return `CONTRACT_SECURITY_SCHEME_URL: security scheme ${schemeName} ${label} ${value} is not a valid URL`;
  }
  return undefined;
}

function collectSecurityStaticLints(root: JsonRecord, operation: JsonRecord): string[] {
  const securitySchemes = asRecord(asRecord(root.components)?.securitySchemes);
  const requirements = operation.security === undefined ? asArray(root.security) : asArray(operation.security);
  const warnings = new Set<string>();
  for (const requirement of requirements.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry))) {
    for (const [schemeName, requiredScopes] of Object.entries(requirement)) {
      let scheme: JsonRecord | null;
      try { scheme = resolveInternalRef<JsonRecord>(root, securitySchemes?.[schemeName]); } catch { scheme = null; }
      if (!scheme) {
        warnings.add(`CONTRACT_SECURITY_SCHEME_UNDECLARED: security requirement references undeclared scheme ${schemeName}`);
        continue;
      }
      if (scheme.type === 'http') {
        const httpScheme = String(scheme.scheme || '').toLowerCase();
        if (httpScheme && !IANA_HTTP_AUTH_SCHEMES.has(httpScheme)) {
          warnings.add(`CONTRACT_UNKNOWN_HTTP_AUTH_SCHEME: security scheme ${schemeName} uses "${httpScheme}", which is not in the IANA HTTP Authentication Scheme registry`);
        }
      }
      if (scheme.type === 'apiKey' && String(scheme.in) === 'query') {
        warnings.add(`CONTRACT_CREDENTIALS_IN_QUERY: security scheme ${schemeName} sends credentials in the query string, which leaks into logs and referrers`);
      }
      if (scheme.type === 'openIdConnect') {
        const urlWarning = httpsUrlLint(scheme.openIdConnectUrl, 'openIdConnectUrl', schemeName);
        if (urlWarning) warnings.add(urlWarning);
        else if (typeof scheme.openIdConnectUrl === 'string' && !scheme.openIdConnectUrl.endsWith('/.well-known/openid-configuration')) {
          warnings.add(`CONTRACT_SECURITY_SCHEME_URL: security scheme ${schemeName} openIdConnectUrl does not end in /.well-known/openid-configuration`);
        }
      }
      if (scheme.type === 'oauth2') {
        const flows = asRecord(scheme.flows) ?? {};
        const declaredScopes = new Set<string>();
        for (const [flowName, rawFlow] of Object.entries(flows)) {
          const flow = asRecord(rawFlow);
          if (!flow) continue;
          for (const scope of Object.keys(asRecord(flow.scopes) ?? {})) declaredScopes.add(scope);
          const urlFields: Array<[string, unknown]> = [['refreshUrl', flow.refreshUrl]];
          if (flowName === 'implicit' || flowName === 'authorizationCode') urlFields.push(['authorizationUrl', flow.authorizationUrl]);
          if (flowName === 'password' || flowName === 'clientCredentials' || flowName === 'authorizationCode') urlFields.push(['tokenUrl', flow.tokenUrl]);
          if ((flowName === 'implicit' || flowName === 'authorizationCode') && typeof flow.authorizationUrl !== 'string') warnings.add(`CONTRACT_SECURITY_SCHEME_URL: security scheme ${schemeName} ${flowName} authorizationUrl is required`);
          if ((flowName === 'password' || flowName === 'clientCredentials' || flowName === 'authorizationCode') && typeof flow.tokenUrl !== 'string') warnings.add(`CONTRACT_SECURITY_SCHEME_URL: security scheme ${schemeName} ${flowName} tokenUrl is required`);
          for (const [label, value] of urlFields) {
            const urlWarning = httpsUrlLint(value, `${flowName} ${label}`, schemeName);
            if (urlWarning) warnings.add(urlWarning);
          }
        }
        for (const scope of asArray(requiredScopes).filter((entry): entry is string => typeof entry === 'string')) {
          if (!declaredScopes.has(scope)) {
            warnings.add(`CONTRACT_OAUTH2_UNDECLARED_SCOPE: operation requires scope "${scope}" of ${schemeName}, which no flow of the scheme declares`);
          }
        }
      }
    }
  }
  return [...warnings];
}

function collectSecurityResponseLints(root: JsonRecord, operation: JsonRecord, responses: JsonRecord, operationId: string): string[] {
  const warnings: string[] = [];
  const requirements = operation.security === undefined ? asArray(root.security) : asArray(operation.security);
  const requirementRecords = requirements.map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry));
  const secured = requirementRecords.length > 0 && requirementRecords.every((entry) => Object.keys(entry).length > 0);
  const statusKeys = new Set(Object.keys(responses));
  const hasCatchAll = statusKeys.has('default') || statusKeys.has('4XX');
  if (secured && !statusKeys.has('401') && !hasCatchAll) {
    warnings.push(`CONTRACT_SECURITY_RESPONSES_INCOMPLETE: ${operationId} requires authentication but documents no 401 (or 4XX/default) response`);
  }
  const usesScopes = requirementRecords.some((entry) => Object.values(entry).some((scopes) => Array.isArray(scopes) && scopes.length > 0));
  if (secured && usesScopes && !statusKeys.has('403') && !hasCatchAll) {
    warnings.push(`CONTRACT_SECURITY_RESPONSES_INCOMPLETE: ${operationId} requires scopes but documents no 403 (or 4XX/default) response`);
  }
  if (requirementRecords.length === 0) {
    for (const status of ['401', '403']) {
      if (statusKeys.has(status)) warnings.push(`CONTRACT_UNSECURED_AUTH_RESPONSES: ${operationId} documents a ${status} response but declares no security requirement`);
    }
  }
  return warnings;
}

// Link parameter/requestBody values of the form $response.body#/ptr and
// $response.header.Name are runtime-evaluable against the very response the
// link is declared on; everything else ($request.*, $url, whole-body) stays
// warning-only.
// Resolve a link's target operation from operationId or operationRef so its
// declared parameter/requestBody schemas can direct runtime validation of the
// values the link feeds forward (OAS Link Object).
function resolveLinkTargetOperation(root: JsonRecord, link: JsonRecord): { operation: JsonRecord; pathItem: JsonRecord } | null {
  if (typeof link.operationRef === 'string' && link.operationRef.startsWith('#/')) {
    const operation = asRecord(resolvePointer(root, link.operationRef));
    if (!operation) return null;
    const pathItem = asRecord(resolvePointer(root, link.operationRef.replace(/\/[^/]+$/, ''))) ?? {};
    return { operation, pathItem };
  }
  if (typeof link.operationId === 'string') {
    const paths = asRecord(root.paths);
    if (!paths) return null;
    for (const rawPathItem of Object.values(paths)) {
      const pathItem = resolveInternalRef<JsonRecord>(root, rawPathItem);
      if (!pathItem) continue;
      for (const [method, rawOp] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method.toLowerCase())) continue;
        const operation = resolveInternalRef<JsonRecord>(root, rawOp);
        if (operation && operation.operationId === link.operationId) return { operation, pathItem };
      }
    }
  }
  return null;
}

function jsonRequestBodySchema(root: JsonRecord, requestBody: JsonRecord | null): unknown | undefined {
  const content = asRecord(requestBody?.content);
  if (!content) return undefined;
  for (const [contentType, mediaObject] of Object.entries(content)) {
    const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
    if (isJsonBaseType(base)) return asRecord(mediaObject)?.schema;
  }
  return undefined;
}

function linkParameterSchema(param: JsonRecord | undefined): unknown | undefined {
  if (!param) return undefined;
  return jsonContentParameterMedia(param) ?? param.schema;
}

// Link parameter/requestBody values backed by response and request runtime
// expressions are collected for runtime resolution. When the link's target
// operation and the fed parameter/requestBody schema resolve, a compiled
// validator key is attached so the resolved value is also checked against the
// target schema. $url and whole-body expressions stay unevaluated and warn.
function collectLinkExpressions(root: JsonRecord, response: JsonRecord, operationId: string, warnings: Set<string>, version: OpenApiVersion, targetSchemas: Record<string, unknown>): ContractLinkExpression[] {
  const links = asRecord(response.links);
  if (!links) return [];
  const expressions: ContractLinkExpression[] = [];
  let unevaluated = false;
  for (const [linkName, rawLink] of Object.entries(links)) {
    let link: JsonRecord | null;
    try { link = resolveInternalRef<JsonRecord>(root, rawLink); } catch { link = null; }
    if (!link) { unevaluated = true; continue; }
    const target = resolveLinkTargetOperation(root, link);
    const targetParams = target ? resolvedParameters(root, target.pathItem, target.operation) : [];
    const paramByKey = new Map<string, JsonRecord>();
    const requiredKeys = new Set<string>();
    for (const parameter of targetParams) {
      const loc = String(parameter.in || '').toLowerCase();
      const nm = String(parameter.name || '');
      if (!nm) continue;
      paramByKey.set(`${loc}.${nm}`, parameter);
      if (!paramByKey.has(nm)) paramByKey.set(nm, parameter);
      if (parameter.required === true) requiredKeys.add(`${loc}.${nm}`);
    }
    const targetRequestBody = target ? asRecord(resolveInternalRef<JsonRecord>(root, target.operation.requestBody)) : null;
    const targetRequestBodyRequired = targetRequestBody?.required === true;
    const matchParam = (key: string): JsonRecord | undefined => paramByKey.get(key) ?? paramByKey.get(key.replace(/^(path|query|header|cookie)\./i, ''));

    const entries: Array<{ key: string; value: unknown }> = Object.entries(asRecord(link.parameters) ?? {}).map(([key, value]) => ({ key, value }));
    if (link.requestBody !== undefined) entries.push({ key: '$requestBody', value: link.requestBody });
    if (entries.length === 0) unevaluated = true;

    const providedKeys = new Set<string>();
    for (const { key, value } of entries) {
      if (key === '$requestBody') providedKeys.add('$requestBody');
      else { const matched = matchParam(key); if (matched) providedKeys.add(`${String(matched.in).toLowerCase()}.${String(matched.name)}`); }
      const matchedParam = key === '$requestBody' ? undefined : matchParam(key);
      const schemaSource = key === '$requestBody' ? jsonRequestBodySchema(root, targetRequestBody) : linkParameterSchema(matchedParam);
      if (key === '$requestBody' && schemaSource !== undefined && (typeof value !== 'string' || !value.startsWith('$'))) {
        const packed = packSchema(root, schemaSource, version, 'request');
        const validate = !packed.unsupported && packed.schema !== undefined ? compileSchemaValidator(packed.schema) : null;
        if (validate && !validate(value)) {
          warnings.add(`CONTRACT_LINK_REQUEST_BODY_SCHEMA_MISMATCH: link ${linkName} on ${operationId} supplies a literal requestBody that does not satisfy the target operation schema`);
        }
      }
      if (typeof value !== 'string' || !value.startsWith('$')) continue;
      const bodyMatch = value.match(/^\$response\.body#(\/.*)$/);
      const headerMatch = bodyMatch ? null : value.match(/^\$response\.header\.([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/);
      const requestBodyMatch = bodyMatch || headerMatch ? null : value.match(/^\$request\.body#(\/.*)$/);
      const requestHeaderMatch = bodyMatch || headerMatch || requestBodyMatch ? null : value.match(/^\$request\.header\.([!#$%&'*+.^_`|~0-9A-Za-z-]+)$/);
      const requestQueryMatch = bodyMatch || headerMatch || requestBodyMatch || requestHeaderMatch ? null : value.match(/^\$request\.query\.([!$&'()*+,;=:@A-Za-z0-9._~-]+)$/);
      const requestPathMatch = bodyMatch || headerMatch || requestBodyMatch || requestHeaderMatch || requestQueryMatch ? null : value.match(/^\$request\.path\.([!$&'()*+,;=:@A-Za-z0-9._~-]+)$/);
      if (!bodyMatch && !headerMatch && !requestBodyMatch && !requestHeaderMatch && !requestQueryMatch && !requestPathMatch) { unevaluated = true; continue; }
      let targetKey: string | undefined;
      if (schemaSource !== undefined) {
        const packed = packSchema(root, schemaSource, version, 'request');
        if (!packed.unsupported && packed.schema !== undefined) {
          targetKey = `${linkName}:${key}`;
          targetSchemas[targetKey] = packed.schema;
        }
      }
      let expression: ContractLinkExpression;
      if (bodyMatch) expression = { link: linkName, kind: 'body', pointer: bodyMatch[1]!, param: key };
      else if (headerMatch) expression = { link: linkName, kind: 'header', header: headerMatch[1]!, param: key };
      else if (requestBodyMatch) expression = { link: linkName, kind: 'requestBody', pointer: requestBodyMatch[1]!, param: key };
      else if (requestHeaderMatch) expression = { link: linkName, kind: 'requestHeader', header: requestHeaderMatch[1]!, param: key };
      else if (requestQueryMatch) expression = { link: linkName, kind: 'requestQuery', query: requestQueryMatch[1]!, param: key };
      else expression = { link: linkName, kind: 'requestPath', path: requestPathMatch![1]!, param: key };
      if (targetKey) expression.targetKey = targetKey;
      expressions.push(expression);
    }
    if (target) {
      const missing: string[] = [];
      for (const requiredKey of requiredKeys) if (!providedKeys.has(requiredKey)) missing.push(requiredKey);
      if (targetRequestBodyRequired && !providedKeys.has('$requestBody')) missing.push('$requestBody');
      if (missing.length > 0) warnings.add(`CONTRACT_LINK_REQUIRED_INPUT_MISSING: link ${linkName} on ${operationId} does not supply required target input(s) ${missing.sort().join(', ')}`);
    }
  }
  if (expressions.length === 0) {
    if (unevaluated) warnings.add(`CONTRACT_LINKS_NOT_VALIDATED: response links are not validated for ${operationId}`);
  } else if (unevaluated) {
    warnings.add(`CONTRACT_LINKS_PARTIALLY_VALIDATED: some link expressions for ${operationId} are not runtime-evaluable and are skipped`);
  }
  return expressions;
}

// Collect top-level property names that OpenAPI marks writeOnly across every
// response content schema (resolving internal $refs and allOf/anyOf/oneOf
// members). Names that also appear as non-writeOnly properties anywhere in the
// same response schema are excluded to avoid runtime false positives.
function collectResponseWriteOnlyNames(root: JsonRecord, response: JsonRecord): string[] {
  const writeOnly = new Set<string>();
  const plain = new Set<string>();
  const visit = (raw: unknown, depth: number): void => {
    if (depth > 8) return;
    let schema: JsonRecord | null;
    try { schema = resolveInternalRef<JsonRecord>(root, raw); } catch { schema = null; }
    if (!schema) return;
    const properties = asRecord(schema.properties);
    if (properties) {
      for (const [name, rawProp] of Object.entries(properties)) {
        let prop: JsonRecord | null;
        try { prop = resolveInternalRef<JsonRecord>(root, rawProp); } catch { prop = null; }
        if (prop?.writeOnly === true) writeOnly.add(name); else plain.add(name);
      }
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      for (const member of asArray(schema[key])) visit(member, depth + 1);
    }
  };
  for (const mediaObject of Object.values(asRecord(response.content) ?? {})) {
    const media = asRecord(mediaObject);
    if (media?.schema !== undefined) visit(media.schema, 0);
  }
  return [...writeOnly].filter((name) => !plain.has(name));
}

function collectCallbackExpressions(root: JsonRecord, operation: JsonRecord): ContractCallbackExpression[] | undefined {
  const callbacks = asRecord(operation.callbacks);
  if (!callbacks) return undefined;
  const expressions: ContractCallbackExpression[] = [];
  for (const [callbackName, rawCallback] of Object.entries(callbacks)) {
    let callback: JsonRecord | null;
    try {
      callback = resolveInternalRef<JsonRecord>(root, rawCallback);
    } catch {
      callback = null;
    }
    if (!callback) continue;
    for (const expression of Object.keys(callback)) {
      if (/^x-/i.test(expression)) continue;
      expressions.push({ callback: callbackName, expression });
    }
  }
  return expressions.length > 0 ? expressions : undefined;
}

function collectCallbackRequestSources(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): ContractCallbackRequestSources {
  const path = new Set<string>();
  const query = new Set<string>();
  const header = new Set<string>();
  for (const param of resolvedParameters(root, pathItem, operation)) {
    const location = String(param.in || '').toLowerCase();
    const name = String(param.name || '');
    if (!name) continue;
    if (location === 'path') path.add(name);
    else if (location === 'query') query.add(name.toLowerCase());
    else if (location === 'header') header.add(name.toLowerCase());
  }
  return {
    path: [...path],
    query: [...query],
    header: [...header]
  };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Advisory-only server conformance: the request URL is matched against the
// declared servers with enum-constrained variables; mismatches surface in the
// advisory channel rather than failing, because pointing a run at a mock or
// staging host is legitimate.
function serverAdvisoryPatterns(root: JsonRecord, pathItem: JsonRecord, operation: JsonRecord): string[] | undefined {
  const serverLists = [asArray(operation.servers), asArray(pathItem.servers), asArray(root.servers)];
  const servers = serverLists.find((list) => list.length > 0) ?? [];
  const patterns: string[] = [];
  for (const rawServer of servers) {
    const server = asRecord(rawServer);
    if (!server) continue;
    const url = typeof server.url === 'string' ? server.url.trim() : '';
    if (!url || url === '/') continue;
    const variables = asRecord(server.variables);
    const pattern = url.split(/(\{[^}]+\})/).map((part) => {
      const varMatch = part.match(/^\{([^}]+)\}$/);
      if (!varMatch) return escapeRegExpLiteral(part);
      const variable = asRecord(variables?.[varMatch[1]!]);
      const enumValues = asArray(variable?.enum).filter((entry): entry is string => typeof entry === 'string');
      if (enumValues.length > 0) return `(${enumValues.map(escapeRegExpLiteral).join('|')})`;
      return '[^/]*';
    }).join('');
    patterns.push(`^${pattern}`);
  }
  return patterns.length > 0 ? patterns : undefined;
}

function validateParameterExamples(root: JsonRecord, param: JsonRecord, packed: PackedSchema, context: string, warnings: string[]): void {
  if (packed.schema === undefined || packed.unsupported) return;
  const candidates = exampleCandidates(root, param);
  if (candidates.length === 0) return;
  const validate = compileSchemaValidator(packed.schema);
  if (!validate) return;
  const location = String(param.in || '').toLowerCase();
  const defaultStyle = DEFAULT_PARAM_STYLES[location];
  const style = typeof param.style === 'string' ? param.style : defaultStyle;
  const defaultExplode = style === 'form';
  const explode = typeof param.explode === 'boolean' ? param.explode : defaultExplode;
  const itemsSchema = packedArrayItemsSchema(packed);
  const itemType = asRecord(itemsSchema)?.type;
  const serializedArrayDecode =
    location === 'query'
      ? QUERY_ARRAY_DECODES[`${style}:${explode}`]
      : location === 'header' && style === 'simple' && !explode
        ? 'csv'
        : undefined;
  for (const candidate of candidates) {
    const decodedItems = typeof candidate.value === 'string' && serializedArrayDecode && itemsSchema !== undefined
      ? (
          serializedArrayDecode === 'ssv'
            ? candidate.value.split(' ')
            : serializedArrayDecode === 'pipes'
              ? candidate.value.split('|')
              : candidate.value.split(',')
        ).map((entry) => {
          const trimmed = entry.trim();
          if (itemType === 'integer' || itemType === 'number') {
            const num = Number(trimmed);
            return Number.isFinite(num) ? num : trimmed;
          }
          if (itemType === 'boolean') {
            if (trimmed === 'true') return true;
            if (trimmed === 'false') return false;
          }
          if (itemType === 'null' && trimmed === 'null') return null;
          return trimmed;
        })
      : null;
    if (decodedItems && validate(decodedItems)) continue;
    if (!validate(candidate.value)) {
      warnings.push(`CONTRACT_EXAMPLE_SCHEMA_MISMATCH: ${candidate.label} for parameter ${context} does not match its schema`);
    }
  }
}

function isAbsoluteUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  try { return Boolean(new URL(value).protocol); } catch { return false; }
}

function schemaTypeNames(schema: JsonRecord): string[] {
  return Array.isArray(schema.type) ? schema.type.map(String) : typeof schema.type === 'string' ? [schema.type] : [];
}

function stableValueKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map((entry) => stableValueKey(entry)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value as JsonRecord).sort().map((key) => `${JSON.stringify(key)}:${stableValueKey((value as JsonRecord)[key])}`).join(',') + '}';
  }
  return JSON.stringify(value);
}

function matchesSchemaType(type: string, value: unknown): boolean {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'null': return value === null;
    case 'number': return typeof value === 'number';
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'string': return typeof value === 'string';
    default: return true;
  }
}

function requiresProperty(root: JsonRecord, schema: unknown, propertyName: string, seen = new Set<unknown>()): boolean {
  const record = resolveInternalRef<JsonRecord>(root, schema) ?? asRecord(schema);
  if (!record || seen.has(record)) return false;
  seen.add(record);
  if (asArray(record.required).map(String).includes(propertyName)) return true;
  return asArray(record.allOf).some((entry) => requiresProperty(root, entry, propertyName, seen));
}

function defaultMatchesPackedSchema(root: JsonRecord, schema: unknown, version: OpenApiVersion, value: unknown): boolean | null {
  const packed = packSchema(root, schema, version);
  if (packed.unsupported || packed.schema === undefined) return null;
  const validate = compileSchemaValidator(packed.schema);
  if (!validate) return null;
  return validate(value);
}

function collectSchemaStaticLints(root: JsonRecord, schema: unknown, version: OpenApiVersion, context: string, warnings: Set<string>, seen = new Set<unknown>()): void {
  const rawRecord = asRecord(schema);
  if (typeof rawRecord?.$ref === 'string' && version === '3.0' && Object.keys(rawRecord).some((key) => key !== '$ref' && key !== 'description' && key !== 'summary')) {
    warnings.add(`CONTRACT_REF_SIBLING_INVALID: ${context} has sibling keywords beside $ref that OpenAPI 3.0 ignores`);
  }
  let record: JsonRecord | null;
  try { record = resolveInternalRef<JsonRecord>(root, schema); } catch { record = asRecord(schema); }
  if (!record || seen.has(record)) return;
  seen.add(record);
  for (const w of collectSchemaObjectLints(root, record, version, context)) warnings.add(w);
  const types = schemaTypeNames(record);
  if (version === '3.0' && Array.isArray(record.type)) warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} uses JSON Schema type arrays; OpenAPI 3.0 uses nullable instead`);
  if (version === '3.1' && record.nullable !== undefined) warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} uses nullable, which is not an OpenAPI 3.1 Schema keyword`);
  if (version === '3.0') {
    for (const key of ['$schema', '$id', '$defs', 'prefixItems', 'unevaluatedProperties', 'unevaluatedItems', 'dependentSchemas', 'dependentRequired', 'if', 'then', 'else', 'const', 'contains', 'minContains', 'maxContains', 'contentEncoding', 'contentMediaType', 'contentSchema', 'patternProperties', 'propertyNames']) {
      // OAS 3.0.3 Schema Object is an adjusted Draft Wright-00 subset; these
      // draft-2019-09/2020-12 and conditional keywords are not listed there.
      if (record[key] !== undefined) warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} uses ${key}, which OpenAPI 3.0.3 schemas do not support`);
    }
    if (types.includes('null')) warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} uses type "null", which OpenAPI 3.0 expresses via nullable`);
  }
  if (version === '3.0') {
    if (typeof record.exclusiveMinimum === 'number' || typeof record.exclusiveMaximum === 'number') warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} uses numeric exclusiveMinimum/exclusiveMaximum, but OpenAPI 3.0 requires booleans`);
  } else if (typeof record.exclusiveMinimum === 'boolean' || typeof record.exclusiveMaximum === 'boolean') {
    warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} uses boolean exclusiveMinimum/exclusiveMaximum, but OpenAPI 3.1 requires numeric values`);
  }
  if (typeof record.$schema === 'string' && (!isAbsoluteUrl(record.$schema) || !/(2020-12|draft-07|json-schema.org)/i.test(record.$schema))) {
    warnings.add(`CONTRACT_JSON_SCHEMA_DIALECT_UNSUPPORTED: ${context} declares unsupported or non-absolute $schema ${record.$schema}`);
  }
  if (typeof record.format === 'string' && !['date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'regex', 'binary', 'byte', 'password', 'int32', 'int64', 'float', 'double'].includes(record.format)) {
    warnings.add(`CONTRACT_FORMAT_UNKNOWN: ${context} uses unknown format "${record.format}" as an annotation-only value`);
  }
  const enumEntries = asArray(record.enum);
  if (record.enum !== undefined && enumEntries.length === 0) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} enum must not be empty`);
  const enumValues = enumEntries.map((entry) => stableValueKey(entry));
  const uniqueEnumValues = new Set(enumValues);
  if (uniqueEnumValues.size !== enumValues.length) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} enum contains duplicate values`);
  for (const [label, value] of [['default', record.default], ['const', record.const]] as const) {
    if (label === 'default' && value === undefined) continue;
    if (label === 'const' && value === undefined) continue;
    const stableValue = stableValueKey(value);
    const enumMismatch = enumValues.length > 0 && !enumValues.includes(stableValue);
    if (enumMismatch) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} ${label} is not a member of enum`);
    const constMismatch = record.const !== undefined && label === 'default' && stableValueKey(record.const) !== stableValue;
    if (constMismatch) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} default does not match const`);
    const typeMismatch = label === 'default' && types.length > 0 && !types.some((type) => matchesSchemaType(type, value));
    if (typeMismatch) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} default does not match declared type`);
    if (version === '3.1' && label === 'default' && !enumMismatch && !constMismatch && !typeMismatch) {
      const valid = defaultMatchesPackedSchema(root, schema, version, value);
      if (valid === false) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} default does not validate against its schema`);
    }
  }
  if (version === '3.0' && record.nullable === true) {
    if (types.length === 0) warnings.add(`CONTRACT_SCHEMA_VERSION_MISMATCH: ${context} sets nullable: true without a sibling type`);
    if (record.const !== undefined && record.const !== null) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} sets nullable: true but const excludes null`);
    if (enumValues.length > 0 && !enumValues.includes('null')) warnings.add(`CONTRACT_SCHEMA_VALUE_MISMATCH: ${context} sets nullable: true but enum excludes null`);
  }
  if (record.readOnly === true && record.writeOnly === true) warnings.add(`CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE: ${context} cannot be both readOnly and writeOnly`);
  if (record.discriminator !== undefined) {
    const discriminator = asRecord(record.discriminator);
    const propertyName = typeof discriminator?.propertyName === 'string' ? discriminator.propertyName : '';
    const declaresDiscriminator = (value: unknown): boolean => {
      const schema = asRecord(resolveInternalRef<JsonRecord>(root, value));
      if (!schema) return false;
      return asRecord(schema.properties)?.[propertyName] !== undefined || asArray(schema.required).map(String).includes(propertyName);
    };
    if (!propertyName) {
      warnings.add(`CONTRACT_DISCRIMINATOR_INVALID: ${context} discriminator must declare propertyName`);
    } else if (record.oneOf !== undefined || record.anyOf !== undefined) {
      const members = [...asArray(record.oneOf), ...asArray(record.anyOf)];
      if (!members.every(declaresDiscriminator)) warnings.add(`CONTRACT_DISCRIMINATOR_INVALID: ${context} discriminator propertyName must be listed by every oneOf/anyOf member schema`);
    } else if (!(declaresDiscriminator(record) || asArray(record.allOf).some(declaresDiscriminator))) {
      warnings.add(`CONTRACT_DISCRIMINATOR_INVALID: ${context} discriminator propertyName must be declared in the base schema`);
    }
    if (propertyName && record.oneOf === undefined && record.anyOf === undefined && !(requiresProperty(root, record, propertyName) || asArray(record.allOf).some((entry) => requiresProperty(root, entry, propertyName)))) {
      warnings.add(`CONTRACT_DISCRIMINATOR_INVALID: ${context} discriminator propertyName must be required by the base schema`);
    }
    if (record.oneOf === undefined && record.anyOf === undefined && record.allOf === undefined) warnings.add(`CONTRACT_DISCRIMINATOR_INVALID: ${context} discriminator must appear beside oneOf, anyOf, or allOf`);
    for (const value of Object.values(asRecord(discriminator?.mapping) ?? {})) {
      if (typeof value === 'string' && value.startsWith('#/') && resolvePointer(root, value) === undefined) warnings.add(`CONTRACT_DISCRIMINATOR_INVALID: ${context} discriminator mapping ${value} does not resolve`);
    }
  }
  const variants = [...asArray(record.oneOf), ...asArray(record.anyOf)];
  for (let i = 0; i < variants.length; i += 1) {
    const left = asRecord(variants[i]);
    const leftValues = new Set(asArray(left?.enum).concat(left?.const !== undefined ? [left.const] : []).map((entry) => JSON.stringify(entry)));
    for (let j = i + 1; j < variants.length; j += 1) {
      const right = asRecord(variants[j]);
      const rightValues = new Set(asArray(right?.enum).concat(right?.const !== undefined ? [right.const] : []).map((entry) => JSON.stringify(entry)));
      if (leftValues.size > 0 && [...leftValues].some((entry) => rightValues.has(entry))) warnings.add(`CONTRACT_ONEOF_OVERLAP: ${context} has finite oneOf/anyOf branches with overlapping const/enum values`);
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === '$ref') continue;
    if (key === 'properties' && asRecord(value)) {
      for (const [propName, propSchema] of Object.entries(asRecord(value)!)) collectSchemaStaticLints(root, propSchema, version, `${context}.properties.${propName}`, warnings, seen);
    } else if (['items', 'additionalProperties', 'not'].includes(key) || key.endsWith('Schema')) {
      collectSchemaStaticLints(root, value, version, `${context}.${key}`, warnings, seen);
    } else if (['allOf', 'oneOf', 'anyOf', 'prefixItems'].includes(key)) {
      asArray(value).forEach((entry, index) => collectSchemaStaticLints(root, entry, version, `${context}.${key}[${index}]`, warnings, seen));
    }
  }
  void types;
}

function collectDocumentStaticLints(root: JsonRecord, version: OpenApiVersion): string[] {
  const warnings = new Set<string>();
  if (version === '3.0' && asRecord(root.webhooks)) warnings.add('CONTRACT_OAS_VERSION_UNSUPPORTED_FIELD: OpenAPI 3.0 documents cannot use top-level webhooks');
  if (version === '3.0' && asRecord(asRecord(root.components)?.pathItems)) warnings.add('CONTRACT_OAS_VERSION_UNSUPPORTED_FIELD: OpenAPI 3.0 documents cannot use components.pathItems');
  const dialect = root.jsonSchemaDialect;
  if (dialect !== undefined && (!isAbsoluteUrl(dialect) || !/2020-12|draft-07|json-schema.org/i.test(String(dialect)))) warnings.add(`CONTRACT_JSON_SCHEMA_DIALECT_UNSUPPORTED: jsonSchemaDialect must be an absolute supported JSON Schema dialect URI: ${String(dialect)}`);
  const operationIds = new Map<string, string>();
  const linkOperationIds: Array<{ context: string; operationId: string }> = [];
  const tags = new Set(asArray(root.tags).map((entry) => String(asRecord(entry)?.name || '')).filter(Boolean));
  const usedTags = new Set<string>();
  const templates = new Map<string, string>();
  const checkServers = (rawServers: unknown, context: string) => {
    for (const server of asArray(rawServers).map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => Boolean(entry))) {
      const url = typeof server.url === 'string' ? server.url : '';
      const urlVars = new Set([...url.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!));
      const variables = asRecord(server.variables) ?? {};
      for (const variable of urlVars) {
        const definition = asRecord(variables[variable]);
        if (!definition) warnings.add(`CONTRACT_SERVER_VARIABLE_INVALID: ${context} server URL variable {${variable}} has no variables entry`);
        else {
          if (definition.default === undefined) warnings.add(`CONTRACT_SERVER_VARIABLE_INVALID: ${context} server variable ${variable} must declare a default`);
          const enumValues = asArray(definition.enum);
          if (definition.enum !== undefined && enumValues.length === 0) warnings.add(`CONTRACT_SERVER_VARIABLE_INVALID: ${context} server variable ${variable} enum must not be empty`);
          if (enumValues.length > 0 && !enumValues.map(String).includes(String(definition.default))) warnings.add(`CONTRACT_SERVER_VARIABLE_INVALID: ${context} server variable ${variable} default must be a member of enum`);
        }
      }
      for (const variable of Object.keys(variables)) if (!urlVars.has(variable)) warnings.add(`CONTRACT_SERVER_VARIABLE_INVALID: ${context} server variable ${variable} is not used by the URL template`);
    }
  };
  checkServers(root.servers, 'root');
  for (const [path, rawPathItem] of Object.entries(asRecord(root.paths) ?? {})) {
    const skeleton = normalizePath(path).replace(/\{[^}]+\}/g, '{}');
    const previous = templates.get(skeleton);
    if (previous && previous !== path) warnings.add(`CONTRACT_TEMPLATED_PATH_COLLISION: paths ${previous} and ${path} have identical hierarchy after template names are erased`);
    templates.set(skeleton, path);
    const pathItem = resolveInternalRef<JsonRecord>(root, rawPathItem);
    if (!pathItem) continue;
    checkServers(pathItem.servers, `path ${path}`);
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method)) continue;
      const operation = resolveInternalRef<JsonRecord>(root, rawOperation);
      if (!operation) continue;
      checkServers(operation.servers, `${method.toUpperCase()} ${path}`);
      const operationId = typeof operation.operationId === 'string' ? operation.operationId : '';
      if (operationId) {
        const previousOperation = operationIds.get(operationId);
        if (previousOperation) warnings.add(`CONTRACT_OPERATION_ID_DUPLICATE: operationId ${operationId} is used by both ${previousOperation} and ${method.toUpperCase()} ${path}`);
        operationIds.set(operationId, `${method.toUpperCase()} ${path}`);
      }
      for (const tag of asArray(operation.tags).map(String)) {
        usedTags.add(tag);
        if (tags.size > 0 && !tags.has(tag)) warnings.add(`CONTRACT_TAG_UNDECLARED: ${method.toUpperCase()} ${path} uses undeclared top-level tag ${tag}`);
      }
      for (const rawResponse of Object.values(asRecord(operation.responses) ?? {})) {
        const response = resolveInternalRef<JsonRecord>(root, rawResponse);
        for (const [linkName, rawLink] of Object.entries(asRecord(response?.links) ?? {})) {
          const link = resolveInternalRef<JsonRecord>(root, rawLink);
          if (typeof link?.operationId === 'string') linkOperationIds.push({ context: `${method.toUpperCase()} ${path} link ${linkName}`, operationId: link.operationId });
        }
      }
    }
  }
  for (const link of linkOperationIds) {
    if (!operationIds.has(link.operationId)) warnings.add(`CONTRACT_LINK_TARGET_INVALID: ${link.context} references unresolved operationId ${link.operationId}`);
  }
  for (const tag of tags) if (!usedTags.has(tag)) warnings.add(`CONTRACT_TAG_UNUSED: top-level tag ${tag} is not used by any operation`);
  for (const [name, schema] of Object.entries(asRecord(asRecord(root.components)?.schemas) ?? {})) collectSchemaStaticLints(root, schema, version, `components.schemas.${name}`, warnings);
  return [...warnings];
}

function collectOperationStaticLints(root: JsonRecord, version: OpenApiVersion, path: string, pathItem: JsonRecord, operation: JsonRecord, responses: JsonRecord, operationId: string): string[] {
  const warnings = new Set<string>();
  const parameters = resolvedParameters(root, pathItem, operation);
  const seenParameters = new Set<string>();
  const templateVars = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!));
  const pathParams = new Set<string>();
  for (const param of parameters) {
    const location = String(param.in || '');
    const name = String(param.name || '');
    const key = `${location}:${name.toLowerCase()}`;
    if (seenParameters.has(key)) warnings.add(`CONTRACT_PARAMETER_DUPLICATE: ${operationId} repeats parameter ${location}:${name} after merging path and operation parameters`);
    seenParameters.add(key);
    if (location === 'path') {
      pathParams.add(name);
      if (param.required !== true) warnings.add(`CONTRACT_PATH_PARAMETER_INVALID: ${operationId} path parameter ${name} must declare required: true`);
    }
    const style = typeof param.style === 'string' ? param.style : DEFAULT_PARAM_STYLES[location];
    const validStyle = (location === 'path' && ['matrix', 'label', 'simple'].includes(String(style))) || (location === 'query' && ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'].includes(String(style))) || (location === 'header' && style === 'simple') || (location === 'cookie' && style === 'form');
    if (!validStyle) warnings.add(`CONTRACT_PARAMETER_STYLE_INVALID: ${operationId} parameter ${location}:${name} uses style ${String(style)} invalid for its location`);
    if (param.allowReserved === true && location !== 'query') warnings.add(`CONTRACT_PARAMETER_ALLOW_RESERVED_INVALID: ${operationId} parameter ${location}:${name} uses allowReserved outside query`);
    if (style === 'deepObject') {
      const schema = asRecord(param.schema);
      if (location !== 'query' || !schemaTypeNames(schema ?? {}).includes('object')) warnings.add(`CONTRACT_PARAMETER_DEEPOBJECT_INVALID: ${operationId} parameter ${location}:${name} uses deepObject without a query object schema`);
      if (asRecord(schema?.properties) && Object.values(asRecord(schema?.properties)!).some((prop) => schemaTypeNames(asRecord(prop) ?? {}).includes('object'))) warnings.add(`CONTRACT_PARAMETER_DEEPOBJECT_NESTED: ${operationId} parameter query:${name} uses nested deepObject properties that are not interoperably defined`);
    }
    if (param.schema !== undefined && param.content !== undefined) warnings.add(`CONTRACT_PARAMETER_SCHEMA_CONTENT_XOR: ${operationId} parameter ${location}:${name} declares both schema and content`);
    const content = asRecord(param.content);
    if (content && Object.keys(content).length !== 1) warnings.add(`CONTRACT_PARAMETER_CONTENT_INVALID: ${operationId} parameter ${location}:${name} content must contain exactly one media type`);
    if (param.schema !== undefined) collectSchemaStaticLints(root, param.schema, version, `${operationId} parameter ${location}:${name}`, warnings);
  }
  for (const variable of templateVars) if (!pathParams.has(variable)) warnings.add(`CONTRACT_PATH_PARAMETER_BIJECTION: ${operationId} template variable {${variable}} has no matching in:path parameter`);
  for (const paramName of pathParams) if (!templateVars.has(paramName)) warnings.add(`CONTRACT_PATH_PARAMETER_BIJECTION: ${operationId} in:path parameter ${paramName} has no matching path template variable`);
  if (Object.keys(responses).length === 0) warnings.add(`CONTRACT_RESPONSES_INVALID: ${operationId} responses must not be empty`);
  for (const status of Object.keys(responses)) if (status !== 'default' && !/^[1-5](?:[0-9][0-9]|XX)$/i.test(status)) warnings.add(`CONTRACT_RESPONSES_INVALID: ${operationId} response key ${status} is not a valid status-code, range, or default`);
  const responseHeaders = new Set<string>();
  for (const rawResponse of Object.values(responses)) {
    const response = resolveInternalRef<JsonRecord>(root, rawResponse);
    for (const headerName of Object.keys(asRecord(response?.headers) ?? {})) responseHeaders.add(headerName.toLowerCase());
    const plainJsonMedia: Array<[string, unknown]> = [];
    const suffixJsonMedia: Array<[string, unknown]> = [];
    const shadowWarn = (left: [string, unknown], right: [string, unknown]): void => {
      if (JSON.stringify(asRecord(left[1])?.schema ?? {}) !== JSON.stringify(asRecord(right[1])?.schema ?? {})) {
        warnings.add(`CONTRACT_MEDIA_RANGE_SHADOWING: ${operationId} response declares ${left[0]} and ${right[0]} with different schemas`);
      }
    };
    for (const mediaEntry of Object.entries(asRecord(response?.content) ?? {})) {
      const mediaBase = mediaEntry[0].toLowerCase().split(';')[0] ?? '';
      if (mediaBase === 'application/json') {
        for (const prior of suffixJsonMedia) shadowWarn(prior, mediaEntry);
        plainJsonMedia.push(mediaEntry);
      } else if (mediaBase === 'application/*+json') {
        for (const prior of plainJsonMedia) shadowWarn(prior, mediaEntry);
        suffixJsonMedia.push(mediaEntry);
      }
    }
    for (const [contentType, mediaObject] of Object.entries(asRecord(response?.content) ?? {})) {
      const media = asRecord(mediaObject);
      if (media?.schema !== undefined) collectSchemaStaticLints(root, media.schema, version, `${operationId} response ${contentType}`, warnings);
      const schema = asRecord(media?.schema);
      const properties = asRecord(schema?.properties) ?? {};
      const required = new Set(asArray(schema?.required).map(String));
      const writeOnlyRequired = Object.entries(properties).filter(([name, prop]) => required.has(name) && asRecord(prop)?.writeOnly === true).map(([name]) => name);
      if (writeOnlyRequired.length > 0) warnings.add(`CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE: ${operationId} response ${contentType} requires writeOnly-only properties: ${writeOnlyRequired.join(', ')}`);
    }
    for (const rawLink of Object.values(asRecord(response?.links) ?? {})) {
      const link = resolveInternalRef<JsonRecord>(root, rawLink);
      if (!link) continue;
      if ((link.operationId === undefined) === (link.operationRef === undefined)) warnings.add(`CONTRACT_LINK_TARGET_INVALID: ${operationId} link must declare exactly one of operationId or operationRef`);
      if (typeof link.operationRef === 'string' && link.operationRef.startsWith('#/') && resolvePointer(root, link.operationRef) === undefined) warnings.add(`CONTRACT_LINK_TARGET_INVALID: ${operationId} link operationRef ${link.operationRef} does not resolve`);
    }
  }
  const requestContent = asRecord(asRecord(resolveInternalRef<JsonRecord>(root, operation.requestBody))?.content) ?? {};
  for (const [contentType, mediaObject] of Object.entries(requestContent)) {
    const media = asRecord(mediaObject);
    const schema = asRecord(media?.schema);
    const properties = asRecord(schema?.properties) ?? {};
    const required = new Set(asArray(schema?.required).map(String));
    const readOnlyRequired = Object.entries(properties).filter(([name, prop]) => required.has(name) && asRecord(prop)?.readOnly === true).map(([name]) => name);
    if (readOnlyRequired.length > 0) warnings.add(`CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE: ${operationId} request ${contentType} requires readOnly-only properties: ${readOnlyRequired.join(', ')}`);
    const encoding = asRecord(media?.encoding) ?? {};
    for (const [field, rawEncoding] of Object.entries(encoding)) {
      if (!Object.prototype.hasOwnProperty.call(properties, field)) warnings.add(`CONTRACT_ENCODING_FIELD_UNKNOWN: ${operationId} encoding key ${field} is not a schema property`);
      if (asRecord(rawEncoding)?.headers && Object.keys(asRecord(rawEncoding)?.headers ?? {}).some((name) => name.toLowerCase() === 'content-type')) warnings.add(`CONTRACT_ENCODING_HEADER_INVALID: ${operationId} encoding ${field} headers must not include Content-Type`);
    }
  }
  for (const [name, rawCallback] of Object.entries(asRecord(operation.callbacks) ?? {})) {
    if (!/^(\$url|\$method|\$statusCode|\$request\.|\$response\.)/.test(name) && !/^https?:\/\//.test(name)) warnings.add(`CONTRACT_CALLBACK_EXPRESSION_INVALID: ${operationId} callback key ${name} is not a valid runtime expression`);
    const bodyMatch = name.match(/^\$request\.body#(\/.*)$/);
    if (bodyMatch) {
      const requestSchemas = Object.values(requestContent).map((media) => asRecord(asRecord(media)?.schema)).filter(Boolean);
      if (!requestSchemas.some((schema) => resolvePointer(schema!, `#${bodyMatch[1]}`) !== undefined)) warnings.add(`CONTRACT_CALLBACK_EXPRESSION_INVALID: ${operationId} callback key ${name} references a request body pointer that does not resolve`);
    }
    void rawCallback;
  }
  if (operation.deprecated === true && !responseHeaders.has('deprecation') && !responseHeaders.has('sunset')) warnings.add(`CONTRACT_DEPRECATED_HEADERS_ADVISORY: ${operationId} is deprecated but declares neither Deprecation nor Sunset response headers`);
  return [...warnings];
}

export function buildContractIndex(root: JsonRecord): ContractIndex {
  if (root.swagger === '2.0') throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (found swagger 2.0)');
  if (!('openapi' in root)) throw new Error('CONTRACT_UNSUPPORTED_OPENAPI_VERSION: Dynamic contract tests require OpenAPI 3.0 or 3.1 (missing openapi)');
  const version = detectOpenApiVersion(root);
  const paths = asRecord(root.paths);
  const operations: ContractOperation[] = [];
  const warnings: string[] = collectDocumentStaticLints(root, version);

  if (asRecord(root.webhooks)) warnings.push('CONTRACT_WEBHOOKS_NOT_VALIDATED: OpenAPI webhooks are not validated by dynamic contract tests');

  if (paths) {
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = resolveInternalRef<JsonRecord>(root, rawPathItem);
      if (!pathItem) continue;
      if (path.startsWith('/.well-known/')) {
        const suffix = path.slice('/.well-known/'.length).split('/')[0] ?? '';
        if (!WELL_KNOWN_URI_SUFFIXES.includes(suffix.toLowerCase())) {
          warnings.push(`CONTRACT_WELL_KNOWN_UNREGISTERED: path ${path} uses a /.well-known/ suffix that is not in the IANA Well-Known URIs registry snapshot (RFC 8615): ${suffix}`);
        }
      }
      for (const [method, rawOperation] of Object.entries(pathItem)) {
        const lowerMethod = method.toLowerCase();
        if (!HTTP_METHODS.has(lowerMethod)) continue;
        const operation = resolveInternalRef<JsonRecord>(root, rawOperation);
        if (!operation) continue;
        if (operation.callbacks) warnings.push(`CONTRACT_CALLBACKS_NOT_VALIDATED: callbacks are not validated for ${lowerMethod.toUpperCase()} ${path}`);
        if (operation.requestBody !== undefined && ['get', 'head', 'delete'].includes(lowerMethod)) {
          warnings.push(`CONTRACT_METHOD_BODY_SEMANTICS: ${lowerMethod.toUpperCase()} ${path} declares a request body; RFC 9110 defines no request-body semantics for ${lowerMethod.toUpperCase()}`);
        }
        const responses = asRecord(operation.responses);
        if (!responses || Object.keys(responses).length === 0) {
          throw new Error(`CONTRACT_OPERATION_NO_RESPONSES: ${lowerMethod.toUpperCase()} ${path} must define at least one response`);
        }
        const contractResponses: Record<string, ContractResponse> = {};
        const responseWarnings = new Set<string>();
        const linkTargetSchemas: Record<string, unknown> = {};
        for (const [status, rawResponse] of Object.entries(responses)) {
          const response = resolveInternalRef<JsonRecord>(root, rawResponse);
          if (!response) continue;
          if (status !== 'default' && !/^[1-5]XX$/.test(status) && !/^[1-5][0-9][0-9]$/.test(status)) {
            responseWarnings.add(`CONTRACT_INVALID_STATUS_CODE: ${lowerMethod.toUpperCase()} ${path} declares response status "${status}" outside RFC 9110's 100-599, 1XX-5XX, or default forms`);
          }
          const linkExpressions = collectLinkExpressions(root, response, `${lowerMethod.toUpperCase()} ${path}`, responseWarnings, version, linkTargetSchemas);
          const responseContext = `${lowerMethod.toUpperCase()} ${path} status ${status}`;
          const content = responseContent(root, version, response, responseContext, responseWarnings);
          const bodyExpectation = responseBodyExpectation(lowerMethod, status, content);
          if (bodyExpectation === 'forbidden' && Object.keys(content).length > 0) {
            responseWarnings.add(`CONTRACT_BODYLESS_STATUS_WITH_CONTENT: ${lowerMethod.toUpperCase()} ${path} declares content for status ${status}, which RFC 9110 forbids on the wire`);
          }
          if (bodyExpectation === 'unknown') {
            responseWarnings.add(
              `CONTRACT_RESPONSE_BODY_UNDOCUMENTED: ${responseContext} declares no response content; body presence, media type, and shape are not validated`
            );
          }
          for (const [contentType, mediaObject] of Object.entries(asRecord(response.content) ?? {})) {
            if (asRecord(mediaObject)?.schema === undefined) {
              responseWarnings.add(
                `CONTRACT_RESPONSE_SCHEMA_UNDOCUMENTED: response ${contentType} on ${responseContext} declares no schema; body shape is not validated`
              );
            }
          }
          for (const [contentType, media] of Object.entries(content)) {
            const base = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
            const schemaType = asRecord(media.schema)?.type;
            if (!isJsonBaseType(base) && media.schema !== undefined && !media.unsupported && schemaType !== 'string') {
              responseWarnings.add(`CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED: response schema for ${contentType} on ${responseContext} is not validated at runtime`);
            }
          }
          const headers = responseHeaders(root, version, response, responseContext, responseWarnings);
          const writeOnlyProperties = collectResponseWriteOnlyNames(root, response);
          contractResponses[normalizeResponseKey(status)] = {
            content,
            bodyExpectation,
            headers,
            ...(linkExpressions.length > 0 ? { links: linkExpressions } : {}),
            ...(writeOnlyProperties.length > 0 ? { writeOnlyProperties } : {})
          };
        }
        const candidates = [...new Set([
          path,
          ...operationServers(root, pathItem, operation).map((server) => joinPaths(serverPathPrefix(server), path))
        ].map(normalizePath))];
        const callbackExpressions = collectCallbackExpressions(root, operation);
        const operationId = `${lowerMethod.toUpperCase()} ${path}`;
        const opWarnings: string[] = [];
        opWarnings.push(...responseWarnings);
        opWarnings.push(...collectSecuritySchemeWarnings(root, operation));
        const parameterChecks = collectParameterChecks(root, pathItem, operation, version, operationId, path, opWarnings);
        const checkedKeys = new Set((parameterChecks ?? []).map((check) => `${check.in}:${check.name.toLowerCase()}`));
        const decodedKeys = new Set((parameterChecks ?? []).filter((check) => check.decode || check.pathStyle).map((check) => `${check.in}:${check.name.toLowerCase()}`));
        opWarnings.push(...collectSerializationWarnings(root, pathItem, operation, decodedKeys));
        if (operation.deprecated === true) {
          opWarnings.push(`CONTRACT_OPERATION_DEPRECATED: ${lowerMethod.toUpperCase()} ${path} is marked deprecated in the OpenAPI document`);
        }
        opWarnings.push(...collectSecurityStaticLints(root, operation));
        opWarnings.push(...collectSecurityResponseLints(root, operation, responses, operationId));
        opWarnings.push(...collectOperationStaticLints(root, version, path, pathItem, operation, responses, operationId));
        opWarnings.push(...collectHttpSemanticStaticLints(root, lowerMethod, path, pathItem, operation, responses));
        opWarnings.push(...collectMediaParamLints(root, version, pathItem, operation, operationId));
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
          pathMethods: Object.keys(pathItem).filter((key) => HTTP_METHODS.has(key)).map((key) => key.toUpperCase()),
          deprecated: operation.deprecated === true || undefined,
          servers: serverAdvisoryPatterns(root, pathItem, operation),
          callbacks: callbackExpressions,
          callbackRequestSources: callbackExpressions ? collectCallbackRequestSources(root, pathItem, operation) : undefined,
          linkTargetSchemas: Object.keys(linkTargetSchemas).length > 0 ? linkTargetSchemas : undefined,
          warnings: [...new Set(opWarnings)].sort()
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

  return { operations, version, warnings: [...new Set(warnings)].sort() };
}
