import { packSchema, resolvePointer, type OpenApiVersion, type PackedSchema } from './schema-pack.js';

type JsonRecord = Record<string, unknown>;

export type ContractMedia = PackedSchema;

export interface ContractHeader {
  name: string;
  required: boolean;
  schema?: unknown;
  unsupported?: string;
}

export interface ContractResponse {
  content: Record<string, ContractMedia>;
  hasBody: boolean;
  headers: ContractHeader[];
}

export interface ContractParameterRequirement {
  in: 'path' | 'query' | 'header';
  name: string;
  securityDerived?: boolean;
}

export interface ContractRequestBodyRequirement {
  contentTypes: string[];
  required: boolean;
}

export interface ContractOperation {
  id: string;
  method: string;
  path: string;
  pointer: string;
  candidates: string[];
  responses: Record<string, ContractResponse>;
  requiredParameters: ContractParameterRequirement[];
  requestBody?: ContractRequestBodyRequirement;
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
      if (scheme?.type === 'apiKey' && typeof scheme.name === 'string' && ['query', 'header'].includes(String(scheme.in))) {
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
        `CONTRACT_SECURITY_NOT_VALIDATED: security scheme ${schemeName} (${securitySchemeKind(scheme)}) is not runtime-proven by dynamic contract tests`
      );
    }
  }
  return [...warnings];
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
    if (!['path', 'query', 'header'].includes(location)) continue;
    const name = String(param.name || '');
    if (!name || param.required !== true) continue;
    const key = `${location}:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requirements.push({
      in: location as 'path' | 'query' | 'header',
      name,
      securityDerived: securityKeys.has(key)
    });
  }
  return requirements;
}

function collectRequestBody(root: JsonRecord, operation: JsonRecord): ContractRequestBodyRequirement | undefined {
  const body = resolveInternalRef<JsonRecord>(root, operation.requestBody);
  if (!body || body.required !== true) return undefined;
  const content = asRecord(body.content);
  return {
    required: true,
    contentTypes: content ? Object.keys(content) : []
  };
}

function responseContent(root: JsonRecord, version: OpenApiVersion, response: JsonRecord): Record<string, ContractMedia> {
  const content = asRecord(response.content);
  if (!content) return {};
  const media: Record<string, ContractMedia> = {};
  for (const [contentType, mediaObject] of Object.entries(content)) {
    const schema = asRecord(mediaObject)?.schema;
    media[contentType] = schema === undefined ? {} : packSchema(root, schema, version);
  }
  return media;
}

function responseHeaders(root: JsonRecord, version: OpenApiVersion, response: JsonRecord): ContractHeader[] {
  const headers = asRecord(response.headers);
  if (!headers) return [];
  return Object.entries(headers).map(([name, rawHeader]) => {
    const header = resolveInternalRef<JsonRecord>(root, rawHeader);
    if (!header) return { name, required: true, unsupported: 'Unresolved response header' };
    const required = header.required === true;
    if (header.content) return { name, required, unsupported: 'OpenAPI response header content is unsupported' };
    if (!header.schema) return { name, required };
    return { name, required, ...packSchema(root, header.schema, version) };
  });
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
        for (const [status, rawResponse] of Object.entries(responses)) {
          const response = resolveInternalRef<JsonRecord>(root, rawResponse);
          if (!response) continue;
          const content = responseContent(root, version, response);
          const headers = responseHeaders(root, version, response);
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
        const opWarnings: string[] = [];
        opWarnings.push(...collectSecuritySchemeWarnings(root, operation));
        const requiredParameters = collectParameters(root, pathItem, operation);
        for (const parameter of requiredParameters.filter((entry) => entry.securityDerived)) {
          opWarnings.push(`CONTRACT_SECURITY_NOT_VALIDATED: security parameter ${parameter.in}:${parameter.name} is not statically required in generated requests`);
        }
        operations.push({
          id: `${lowerMethod.toUpperCase()} ${path}`,
          method: lowerMethod.toUpperCase(),
          path,
          pointer: `/paths/${path.replace(/~/g, '~0').replace(/\//g, '~1')}/${lowerMethod}`,
          candidates,
          responses: contractResponses,
          requiredParameters,
          requestBody: collectRequestBody(root, operation),
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
