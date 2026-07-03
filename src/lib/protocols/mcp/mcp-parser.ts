// MCP server description -> typed MCP contract index.
//
// Two machine-readable MCP server description formats are ingested:
//
//   1. The MCP Registry `server.json` (static.modelcontextprotocol.io/schemas):
//      `name`/`version` identity, `remotes` (streamable-http / sse endpoints
//      with headers) and `packages` (stdio launch: registry identifier,
//      runtime hint, arguments, environment variables).
//   2. The client configuration format (`mcpServers`, as used by Claude
//      Desktop / Cursor / VS Code): named entries carrying either a stdio
//      `command`+`args`+`env` or a remote `url`(+`headers`).
//
// Either format may additionally carry a top-level `tools` array in the exact
// shape returned by the MCP `tools/list` result (`{ name, description?,
// inputSchema, outputSchema? }`, per the MCP specification). Declared tools
// become `tools/call` request templates whose arguments are synthesized from
// the tool's `inputSchema` and statically validated for self-consistency in
// the instrumenter.
//
// The Postman `mcp-request` EC item models only `sse` and `stdio` transports,
// so a `streamable-http` remote is emitted as `sse` with an explicit
// MCP_STREAMABLE_HTTP_AS_SSE warning: no silent drops, matching the AsyncAPI
// module's discipline. MCP EC items carry no test-script slot and are pruned
// by the Postman CLI runner, so contract checking is generation-time/static.
import { validator, type Schema } from '@exodus/schemasafe';

type JsonRecord = Record<string, unknown>;

export type McpTransport = 'sse' | 'stdio';

export interface McpKeyValue {
  key: string;
  value: string;
}

export interface McpServerDescriptor {
  // Server identity: the mcpServers entry key, or the registry name
  // (suffixed per remote/package when a server.json declares several).
  id: string;
  transport: McpTransport;
  // Remote endpoint url (sse / streamable-http remotes).
  url?: string;
  headers: McpKeyValue[];
  // stdio launch command line (command + arguments, space-joined).
  command?: string;
  env: McpKeyValue[];
  warnings: string[];
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  // Raw JSON Schema for the tool arguments (MCP requires a type:object schema).
  inputSchema?: JsonRecord;
  outputSchema?: JsonRecord;
  // Raw MCP ToolAnnotations object (display/behavior hints), captured verbatim
  // for generation-time hint-type validation.
  annotations?: JsonRecord;
  // Synthesized sample arguments used in the generated tools/call template.
  sampleArguments: unknown;
  warnings: string[];
}

export interface McpResourceDescriptor {
  name: string;
  title?: string;
  description?: string;
  uri: string;
  mimeType?: string;
  meta?: JsonRecord;
  annotations?: JsonRecord;
  warnings: string[];
}

export interface McpResourceTemplateDescriptor {
  name: string;
  title?: string;
  description?: string;
  uriTemplate: string;
  mimeType?: string;
  meta?: JsonRecord;
  annotations?: JsonRecord;
  variables: string[];
  warnings: string[];
}

export interface McpPromptArgumentDescriptor {
  name: string;
  description?: string;
  required: boolean;
}

export interface McpPromptDescriptor {
  name: string;
  title?: string;
  description?: string;
  meta?: JsonRecord;
  annotations?: JsonRecord;
  arguments: McpPromptArgumentDescriptor[];
  warnings: string[];
}

export interface McpContractIndex {
  title: string;
  version?: string;
  servers: McpServerDescriptor[];
  capabilities?: JsonRecord;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  resourceTemplates: McpResourceTemplateDescriptor[];
  prompts: McpPromptDescriptor[];
  // The full document JSON, the $ref-resolution root for tool schemas.
  documentJson: JsonRecord;
  warnings: string[];
}

const SAMPLE_MAX_DEPTH = 5;
const REGISTRY_SCHEMA_URL_RE = /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[^/]+\/server(?:\.schema)?\.json$/;
const RFC6570_EXPRESSION_RE = /^\{[+#./;?&]?[A-Za-z0-9_%.]+(?::[1-9][0-9]{0,3}|\*)?(?:,[A-Za-z0-9_%.]+(?::[1-9][0-9]{0,3}|\*)?)*\}$/;
const RFC6570_OPERATOR_RE = /^[+#./;?&]/;
const LEGACY_REGISTRY_PACKAGE_KEYS = ['registry_type', 'runtime_hint', 'runtime_arguments', 'package_arguments', 'environment_variables', 'registry_base_url'] as const;
const LEGACY_TO_CANONICAL_KEY: Record<string, string> = {
  environment_variables: 'environmentVariables',
  file_sha256: 'fileSha256',
  is_required: 'isRequired',
  is_secret: 'isSecret',
  package_arguments: 'packageArguments',
  registry_base_url: 'registryBaseUrl',
  registry_type: 'registryType',
  runtime_arguments: 'runtimeArguments',
  runtime_hint: 'runtimeHint',
  value_hint: 'valueHint',
  website_url: 'websiteUrl'
};

const REGISTRY_SERVER_SCHEMA_SUBSET: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['name', 'description', 'version'],
  properties: {
    name: { type: 'string', minLength: 3, maxLength: 200, pattern: '^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$' },
    description: { type: 'string', minLength: 1, maxLength: 100 },
    version: { type: 'string', maxLength: 255 },
    title: { type: 'string', minLength: 1, maxLength: 100 },
    websiteUrl: { type: 'string', format: 'uri' },
    remotes: { type: 'array', items: { $ref: '#/definitions/RemoteTransport' } },
    packages: { type: 'array', items: { $ref: '#/definitions/Package' } }
  },
  definitions: {
    Input: {
      type: 'object',
      properties: {
        choices: { type: 'array', items: { type: 'string' } },
        default: { type: 'string' },
        description: { type: 'string' },
        format: { type: 'string', enum: ['string', 'number', 'boolean', 'filepath'] },
        isRequired: { type: 'boolean' },
        isSecret: { type: 'boolean' },
        placeholder: { type: 'string' },
        value: { type: 'string' }
      }
    },
    InputWithVariables: {
      allOf: [
        { $ref: '#/definitions/Input' },
        {
          type: 'object',
          properties: {
            variables: { type: 'object', additionalProperties: { $ref: '#/definitions/Input' } }
          }
        }
      ]
    },
    KeyValueInput: {
      allOf: [
        { $ref: '#/definitions/InputWithVariables' },
        { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
      ]
    },
    PositionalArgument: {
      allOf: [
        { $ref: '#/definitions/InputWithVariables' },
        {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['positional'] },
            valueHint: { type: 'string' },
            isRepeated: { type: 'boolean' }
          },
          anyOf: [{ required: ['valueHint'] }, { required: ['value'] }]
        }
      ]
    },
    NamedArgument: {
      allOf: [
        { $ref: '#/definitions/InputWithVariables' },
        {
          type: 'object',
          required: ['type', 'name'],
          properties: {
            type: { type: 'string', enum: ['named'] },
            name: { type: 'string' },
            isRepeated: { type: 'boolean' }
          }
        }
      ]
    },
    Argument: { anyOf: [{ $ref: '#/definitions/PositionalArgument' }, { $ref: '#/definitions/NamedArgument' }] },
    StdioTransport: {
      type: 'object',
      required: ['type'],
      properties: {
        type: { type: 'string', enum: ['stdio'] },
        command: { type: 'string' },
        args: { type: 'array', items: { $ref: '#/definitions/Argument' } },
        env: { type: 'array', items: { $ref: '#/definitions/KeyValueInput' } }
      }
    },
    SseTransport: {
      type: 'object',
      required: ['type', 'url'],
      properties: {
        type: { type: 'string', enum: ['sse'] },
        url: { type: 'string', pattern: '^https?://[^\\s]+$' },
        headers: { type: 'array', items: { $ref: '#/definitions/KeyValueInput' } }
      }
    },
    StreamableHttpTransport: {
      type: 'object',
      required: ['type', 'url'],
      properties: {
        type: { type: 'string', enum: ['streamable-http'] },
        url: { type: 'string', pattern: '^https?://[^\\s]+$' },
        headers: { type: 'array', items: { $ref: '#/definitions/KeyValueInput' } }
      }
    },
    LocalTransport: {
      anyOf: [
        { $ref: '#/definitions/StdioTransport' },
        { $ref: '#/definitions/StreamableHttpTransport' },
        { $ref: '#/definitions/SseTransport' }
      ]
    },
    Package: {
      type: 'object',
      required: ['registryType', 'identifier', 'transport'],
      properties: {
        registryType: { type: 'string' },
        identifier: { type: 'string' },
        version: { type: 'string', minLength: 1, not: { const: 'latest' } },
        registryBaseUrl: { type: 'string', format: 'uri' },
        runtimeHint: { type: 'string' },
        runtimeArguments: { type: 'array', items: { $ref: '#/definitions/Argument' } },
        packageArguments: { type: 'array', items: { $ref: '#/definitions/Argument' } },
        environmentVariables: { type: 'array', items: { $ref: '#/definitions/KeyValueInput' } },
        fileSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        transport: { $ref: '#/definitions/LocalTransport' }
      }
    },
    RemoteTransport: {
      type: 'object',
      required: ['type', 'url'],
      properties: {
        type: { type: 'string', enum: ['streamable-http', 'sse'] },
        url: { type: 'string', pattern: '^https?://[^\\s]+$' },
        headers: { type: 'array', items: { $ref: '#/definitions/KeyValueInput' } },
        variables: { type: 'object', additionalProperties: { $ref: '#/definitions/Input' } }
      }
    }
  }
};

const validateRegistryServerSchema = (() => {
  try {
    return validator(REGISTRY_SERVER_SCHEMA_SUBSET, {
      includeErrors: true,
      allErrors: true,
      allowUnusedKeywords: true,
      contentValidation: false,
      formatAssertion: true,
      isJSON: true,
      mode: 'default',
      removeAdditional: false,
      requireSchema: true,
      requireStringValidation: false,
      useDefaults: false
    });
  } catch {
    return null;
  }
})();

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function canonicalRegistryKey(key: string): string {
  return LEGACY_TO_CANONICAL_KEY[key] ?? key;
}

function normalizeRegistryValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeRegistryValue(entry));
  const record = asRecord(value);
  if (!record) return value;
  const out: JsonRecord = {};
  for (const [key, entry] of Object.entries(record)) {
    out[canonicalRegistryKey(key)] = normalizeRegistryValue(entry);
  }
  return out;
}

function normalizeRegistryPackage(pkg: JsonRecord): JsonRecord {
  const out = normalizeRegistryValue(pkg) as JsonRecord;
  const hadLegacyShape = LEGACY_REGISTRY_PACKAGE_KEYS.some((key) => hasOwn(pkg, key));
  if (!hasOwn(out, 'transport') && hadLegacyShape) out.transport = { type: 'stdio' };
  return out;
}

function normalizeRegistryManifest(record: JsonRecord): JsonRecord {
  const out = normalizeRegistryValue(record) as JsonRecord;
  if (Array.isArray(record.packages)) out.packages = record.packages.map((entry) => normalizeRegistryPackage(asRecord(entry) ?? {}));
  return out;
}

function isRegistrySchemaDocument(record: JsonRecord): boolean {
  return typeof record.$schema === 'string' && REGISTRY_SCHEMA_URL_RE.test(record.$schema);
}

function registrySchemaWarnings(record: JsonRecord): string[] {
  if (!validateRegistryServerSchema) {
    return ['MCP_REGISTRY_SCHEMA_NOT_VALIDATED: official registry server schema validator could not be compiled locally'];
  }
  const valid = validateRegistryServerSchema(normalizeRegistryManifest(record) as Parameters<typeof validateRegistryServerSchema>[0]);
  if (valid) return [];
  const errors = Array.isArray(validateRegistryServerSchema.errors) ? validateRegistryServerSchema.errors : [];
  return errors.map((error) => `MCP_REGISTRY_SCHEMA_INVALID: registry server.json violates the supported MCP registry schema subset at ${error.instanceLocation || '#'} (${error.keywordLocation || 'schema'})`);
}

function pickValue(record: JsonRecord, preferredKey: string, legacyKey?: string): unknown {
  if (hasOwn(record, preferredKey)) return record[preferredKey];
  if (legacyKey && hasOwn(record, legacyKey)) return record[legacyKey];
  return undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isAbsoluteUri(value: string): boolean {
  try {
    // WHATWG URL accepts custom absolute schemes (`resource://...`, `urn:...`).
    // Relative references and whitespace-only strings fail closed here.
    void new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateUriTemplate(value: string): { variables: string[]; warning?: string } {
  const variables = new Set<string>();
  let open = -1;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charAt(i);
    if (ch === '{') {
      if (open !== -1) return { variables: [...variables], warning: `nested { in URI template ${JSON.stringify(value)}` };
      open = i;
      continue;
    }
    if (ch !== '}') continue;
    if (open === -1) return { variables: [...variables], warning: `unmatched } in URI template ${JSON.stringify(value)}` };
    const expr = value.slice(open, i + 1);
    open = -1;
    if (!RFC6570_EXPRESSION_RE.test(expr)) {
      return { variables: [...variables], warning: `expression ${JSON.stringify(expr)} in URI template ${JSON.stringify(value)} is not valid RFC 6570` };
    }
    const withoutBraces = expr.slice(1, -1).replace(RFC6570_OPERATOR_RE, '');
    for (const varspec of withoutBraces.split(',')) {
      const variable = varspec.replace(/(?::[1-9][0-9]{0,3}|\*)$/, '');
      if (variable) variables.add(variable);
    }
  }
  if (open !== -1) return { variables: [...variables], warning: `unterminated { in URI template ${JSON.stringify(value)}` };
  const concreteShape = value.replace(/\{[^{}]+\}/g, 'x');
  if (!isAbsoluteUri(concreteShape)) {
    return { variables: [...variables], warning: `URI template ${JSON.stringify(value)} is not an absolute URI after RFC 6570 expansion` };
  }
  return { variables: [...variables] };
}

// Deterministic sample from a JSON Schema: prefers declared example/default/
// enum/const, otherwise synthesizes a minimal instance by type. Depth-capped
// and cycle-free (bounded by depth, not $ref tracking). Mirrors the AsyncAPI
// module's synthesizer; kept local so protocol modules stay decoupled.
function sampleFromSchema(schema: unknown, depth: number): unknown {
  const record = asRecord(schema);
  if (!record) return record === null ? null : {};
  if (record.example !== undefined) return record.example;
  if (record.default !== undefined) return record.default;
  const examples = asArray(record.examples);
  if (examples.length > 0) return examples[0];
  const enumValues = asArray(record.enum);
  if (enumValues.length > 0) return enumValues[0];
  if (record.const !== undefined) return record.const;

  if (depth >= SAMPLE_MAX_DEPTH) return {};

  const type = Array.isArray(record.type)
    ? (record.type.find((t) => t !== 'null') as string | undefined)
    : (record.type as string | undefined);

  const composite = asArray(record.allOf).concat(asArray(record.anyOf), asArray(record.oneOf));
  if (!type && composite.length > 0) return sampleFromSchema(composite[0], depth + 1);

  switch (type) {
    case 'object':
    case undefined: {
      const properties = asRecord(record.properties);
      if (!properties) return {};
      const required = new Set(asArray<string>(record.required));
      const out: JsonRecord = {};
      for (const [name, propSchema] of Object.entries(properties)) {
        if (required.has(name) || Object.keys(out).length < 8) {
          out[name] = sampleFromSchema(propSchema, depth + 1);
        }
      }
      return out;
    }
    case 'array': {
      const items = Array.isArray(record.items) ? record.items[0] : record.items;
      return items === undefined ? [] : [sampleFromSchema(items, depth + 1)];
    }
    case 'string':
      return typeof record.format === 'string' ? `<${record.format}>` : 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return {};
  }
}

function registryInputValue(name: string, input: JsonRecord): string {
  const secret = pickValue(input, 'isSecret', 'is_secret') === true;
  if (!secret) {
    for (const key of ['value', 'default', 'placeholder']) {
      const value = input[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return `{{${name}}}`;
}

function registryVariableValues(variables: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const record = asRecord(variables);
  if (!record) return out;
  for (const [name, input] of Object.entries(record)) {
    const value = asRecord(input);
    if (value) out[name] = registryInputValue(name, value);
  }
  return out;
}

function resolveRegistryVariables(value: string, variables: Record<string, string>, context: string, warnings: string[]): string {
  return value.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) return variables[name];
    warnings.push(`MCP_REMOTE_VARIABLE_UNRESOLVED: ${context} references variable ${JSON.stringify(name)} but remotes[].variables does not define it`);
    return match;
  });
}

// Registry `remotes[].headers` entries are `{ name, value?, is_required?,
// is_secret? }`; secret or valueless headers become `{{name}}` variable
// placeholders so no concrete secret is ever written into the collection.
function registryHeaderKeyValues(headers: unknown, variables: Record<string, string> = {}, warnings: string[] = [], context = 'remote header'): McpKeyValue[] {
  return asArray(headers)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null && typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => {
      const name = String(entry.name);
      const value = registryInputValue(name, entry);
      const resolvedValue = resolveRegistryVariables(value, variables, `${context} ${name}`, warnings);
      return { key: name, value: resolvedValue };
    });
}

function registryEnvKeyValues(variables: unknown): McpKeyValue[] {
  return asArray(variables)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null && typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => {
      const name = String(entry.name);
      const secret = pickValue(entry, 'isSecret', 'is_secret') === true;
      const value = typeof entry.value === 'string' && entry.value && !secret ? entry.value : `{{${name}}}`;
      return { key: name, value };
    });
}

function stringArguments(values: unknown): string[] {
  return asArray(values)
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const record = asRecord(entry);
      if (!record) return '';
      // Registry argument objects: positional { value | value_hint } or named { name, value? }.
      if (typeof record.name === 'string' && record.name) {
        return typeof record.value === 'string' && record.value ? `${record.name}=${record.value}` : String(record.name);
      }
      const valueHint = pickValue(record, 'valueHint', 'value_hint');
      if (typeof valueHint === 'string' && valueHint) return `<${valueHint}>`;
      if (typeof record.value === 'string' && record.value) return record.value;
      return '';
    })
    .filter(Boolean);
}

function remoteDescriptor(remote: JsonRecord, id: string, warnings: string[]): McpServerDescriptor | null {
  const type = String(remote.type ?? '').toLowerCase();
  const serverWarnings: string[] = [];
  const variables = registryVariableValues(remote.variables);
  const url = typeof remote.url === 'string' ? resolveRegistryVariables(remote.url, variables, `remote ${id} url`, serverWarnings) : '';
  if (type === 'streamable-http') {
    serverWarnings.push(
      `MCP_STREAMABLE_HTTP_AS_SSE: server ${id} declares a streamable-http remote; the Postman mcp-request item models only sse/stdio transports, so it is emitted as sse and the endpoint must speak SSE or be adjusted in-app`
    );
  } else if (type !== 'sse' && type !== '') {
    warnings.push(`MCP_REMOTE_TYPE_UNKNOWN: server ${id} remote type "${type}" is not recognised (expected streamable-http or sse); the remote is skipped`);
    return null;
  }
  return {
    id,
    transport: 'sse',
    url,
    headers: registryHeaderKeyValues(remote.headers, variables, serverWarnings, `remote ${id} header`),
    env: [],
    warnings: serverWarnings
  };
}

function hasModernPackageShape(pkg: JsonRecord): boolean {
  return ['registryType', 'runtimeHint', 'runtimeArguments', 'packageArguments', 'environmentVariables'].some((key) => hasOwn(pkg, key));
}

function packageDescriptor(pkg: JsonRecord, id: string, warnings: string[]): McpServerDescriptor | null {
  if (pkg.transport !== undefined && asRecord(pkg.transport) === null) {
    warnings.push(`MCP_PACKAGE_TRANSPORT_INVALID: server ${id} package transport must be an object when present; the package is skipped`);
    return null;
  }

  const transport = asRecord(pkg.transport);
  const transportType = typeof transport?.type === 'string' ? String(transport.type).toLowerCase() : '';
  if (transport) {
    if (!transportType) {
      warnings.push(`MCP_PACKAGE_TRANSPORT_INVALID: server ${id} package transport.type is missing or empty; only "stdio" package transports can be emitted, so the package is skipped`);
      return null;
    }
    if (transportType !== 'stdio') {
      warnings.push(`MCP_PACKAGE_TRANSPORT_UNSUPPORTED: server ${id} package transport "${transportType}" cannot be emitted as a package launch template; only transport.type "stdio" is supported, so the package is skipped`);
      return null;
    }
  } else if (hasModernPackageShape(pkg)) {
    warnings.push(`MCP_PACKAGE_TRANSPORT_MISSING: server ${id} package declares no transport; only transport.type "stdio" package launches are supported, so the package is skipped`);
    return null;
  }

  const identifier = typeof pkg.identifier === 'string' ? pkg.identifier : String(pkg.name ?? '');
  const runtimeHintValue = pickValue(pkg, 'runtimeHint', 'runtime_hint');
  const runtimeHint = typeof runtimeHintValue === 'string' && runtimeHintValue ? runtimeHintValue : '';
  const parts = [
    runtimeHint,
    ...stringArguments(pickValue(pkg, 'runtimeArguments', 'runtime_arguments')),
    identifier,
    ...stringArguments(pickValue(pkg, 'packageArguments', 'package_arguments'))
  ].filter(Boolean);
  const serverWarnings =
    transport === null
      ? [
          `MCP_PACKAGE_TRANSPORT_LEGACY_ASSUME_STDIO: server ${id} package omits transport.type; assuming stdio from the legacy registry package shape`
        ]
      : [];
  return {
    id,
    transport: 'stdio',
    headers: [],
    command: parts.join(' '),
    env: registryEnvKeyValues(pickValue(pkg, 'environmentVariables', 'environment_variables')),
    warnings: serverWarnings
  };
}

// mcpServers client-config entry -> descriptor. A `url` (or an http-ish
// `type`) makes it a remote; otherwise it is a stdio launch.
function clientConfigDescriptor(id: string, entry: JsonRecord): McpServerDescriptor {
  const url = typeof entry.url === 'string' ? entry.url : '';
  const type = String(entry.type ?? '').toLowerCase();
  if (url || type === 'sse' || type === 'http' || type === 'streamable-http' || type === 'streamable_http') {
    const warnings: string[] = [];
    if (type === 'http' || type === 'streamable-http' || type === 'streamable_http') {
      warnings.push(
        `MCP_STREAMABLE_HTTP_AS_SSE: server ${id} declares a ${type || 'http'} remote; the Postman mcp-request item models only sse/stdio transports, so it is emitted as sse and the endpoint must speak SSE or be adjusted in-app`
      );
    }
    const headers = Object.entries(asRecord(entry.headers) ?? {})
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => ({ key, value: String(value) }));
    return { id, transport: 'sse', url, headers, env: [], warnings };
  }
  const command = [typeof entry.command === 'string' ? entry.command : '', ...stringArguments(entry.args)]
    .filter(Boolean)
    .join(' ');
  const env = Object.entries(asRecord(entry.env) ?? {})
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => ({ key, value: String(value) }));
  return { id, transport: 'stdio', headers: [], command, env, warnings: [] };
}

function toolDescriptor(tool: JsonRecord, warnings: string[]): McpToolDescriptor | null {
  const name = typeof tool.name === 'string' ? tool.name : '';
  if (!name) {
    warnings.push('MCP_TOOL_NAME_MISSING: a tools[] entry has no name; it is skipped and generates no tools/call template');
    return null;
  }
  const inputSchema = asRecord(tool.inputSchema) ?? undefined;
  const toolWarnings: string[] = [];
  if (!inputSchema) {
    toolWarnings.push(`MCP_TOOL_NO_INPUT_SCHEMA: tool ${name} declares no inputSchema; its tools/call arguments are an empty object and are not schema-validated`);
  }
  return {
    name,
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema,
    outputSchema: asRecord(tool.outputSchema) ?? undefined,
    annotations: asRecord(tool.annotations) ?? undefined,
    sampleArguments: inputSchema ? sampleFromSchema(inputSchema, 0) : {},
    warnings: toolWarnings
  };
}

function resourceDescriptor(resource: JsonRecord, warnings: string[]): McpResourceDescriptor | null {
  const name = typeof resource.name === 'string' ? resource.name : '';
  if (!name) {
    warnings.push('MCP_RESOURCE_NAME_MISSING: a resources[] entry has no name; it is skipped and generates no static resource declaration');
    return null;
  }
  const uri = typeof resource.uri === 'string' ? resource.uri : '';
  if (!uri) {
    warnings.push(`MCP_RESOURCE_URI_MISSING: resource ${name} declares no uri; it is skipped and cannot participate in static MCP resource validation`);
    return null;
  }
  const resourceWarnings: string[] = [];
  if (!isAbsoluteUri(uri)) {
    resourceWarnings.push(`MCP_RESOURCE_URI_INVALID: resource ${name} uri ${JSON.stringify(uri)} is not an absolute URI`);
  }
  if (resource.title !== undefined && typeof resource.title !== 'string') {
    resourceWarnings.push(`MCP_RESOURCE_FIELD_INVALID: resource ${name} title must be a string when present`);
  }
  if (resource.description !== undefined && typeof resource.description !== 'string') {
    resourceWarnings.push(`MCP_RESOURCE_FIELD_INVALID: resource ${name} description must be a string when present`);
  }
  if (resource.mimeType !== undefined && typeof resource.mimeType !== 'string') {
    resourceWarnings.push(`MCP_RESOURCE_FIELD_INVALID: resource ${name} mimeType must be a string when present`);
  }
  if (resource.annotations !== undefined && !asRecord(resource.annotations)) {
    resourceWarnings.push(`MCP_RESOURCE_ANNOTATIONS_INVALID: resource ${name} annotations must be an object when present`);
  }
  return {
    name,
    title: asOptionalString(resource.title),
    description: asOptionalString(resource.description),
    uri,
    mimeType: asOptionalString(resource.mimeType),
    meta: asRecord(resource._meta) ?? undefined,
    annotations: asRecord(resource.annotations) ?? undefined,
    warnings: resourceWarnings
  };
}

function resourceTemplateDescriptor(template: JsonRecord, warnings: string[]): McpResourceTemplateDescriptor | null {
  const name = typeof template.name === 'string' ? template.name : '';
  if (!name) {
    warnings.push('MCP_RESOURCE_TEMPLATE_NAME_MISSING: a resourceTemplates[] entry has no name; it is skipped and generates no static resource-template declaration');
    return null;
  }
  const uriTemplate = typeof template.uriTemplate === 'string' ? template.uriTemplate : '';
  if (!uriTemplate) {
    warnings.push(`MCP_RESOURCE_TEMPLATE_URI_TEMPLATE_MISSING: resource template ${name} declares no uriTemplate; it is skipped and cannot participate in static MCP resource-template validation`);
    return null;
  }
  const templateWarnings: string[] = [];
  const inspectedTemplate = validateUriTemplate(uriTemplate);
  if (inspectedTemplate.warning) {
    templateWarnings.push(`MCP_RESOURCE_TEMPLATE_INVALID: resource template ${name} uriTemplate failed RFC 6570 validation (${inspectedTemplate.warning})`);
  }
  if (template.title !== undefined && typeof template.title !== 'string') {
    templateWarnings.push(`MCP_RESOURCE_TEMPLATE_FIELD_INVALID: resource template ${name} title must be a string when present`);
  }
  if (template.description !== undefined && typeof template.description !== 'string') {
    templateWarnings.push(`MCP_RESOURCE_TEMPLATE_FIELD_INVALID: resource template ${name} description must be a string when present`);
  }
  if (template.mimeType !== undefined && typeof template.mimeType !== 'string') {
    templateWarnings.push(`MCP_RESOURCE_TEMPLATE_FIELD_INVALID: resource template ${name} mimeType must be a string when present`);
  }
  if (template.annotations !== undefined && !asRecord(template.annotations)) {
    templateWarnings.push(`MCP_RESOURCE_TEMPLATE_ANNOTATIONS_INVALID: resource template ${name} annotations must be an object when present`);
  }
  return {
    name,
    title: asOptionalString(template.title),
    description: asOptionalString(template.description),
    uriTemplate,
    mimeType: asOptionalString(template.mimeType),
    meta: asRecord(template._meta) ?? undefined,
    annotations: asRecord(template.annotations) ?? undefined,
    variables: inspectedTemplate.variables,
    warnings: templateWarnings
  };
}

function promptArgumentDescriptor(promptName: string, argument: unknown, warnings: string[], index: number): McpPromptArgumentDescriptor | null {
  const record = asRecord(argument);
  if (!record) {
    warnings.push(`MCP_PROMPT_ARGUMENT_INVALID: prompt ${promptName} argument[${index}] must be an object`);
    return null;
  }
  const name = typeof record.name === 'string' ? record.name : '';
  if (!name) {
    warnings.push(`MCP_PROMPT_ARGUMENT_NAME_MISSING: prompt ${promptName} argument[${index}] has no name; it is skipped`);
    return null;
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    warnings.push(`MCP_PROMPT_ARGUMENT_INVALID: prompt ${promptName} argument ${name} description must be a string when present`);
  }
  const requiredValue = pickValue(record, 'required', 'is_required');
  if (requiredValue !== undefined && typeof requiredValue !== 'boolean') {
    warnings.push(`MCP_PROMPT_ARGUMENT_INVALID: prompt ${promptName} argument ${name} required must be a boolean when present`);
  }
  return {
    name,
    description: asOptionalString(record.description),
    required: requiredValue === true
  };
}

function promptDescriptor(prompt: JsonRecord, warnings: string[]): McpPromptDescriptor | null {
  const name = typeof prompt.name === 'string' ? prompt.name : '';
  if (!name) {
    warnings.push('MCP_PROMPT_NAME_MISSING: a prompts[] entry has no name; it is skipped and generates no static prompt declaration');
    return null;
  }
  const promptWarnings: string[] = [];
  if (prompt.title !== undefined && typeof prompt.title !== 'string') {
    promptWarnings.push(`MCP_PROMPT_FIELD_INVALID: prompt ${name} title must be a string when present`);
  }
  if (prompt.description !== undefined && typeof prompt.description !== 'string') {
    promptWarnings.push(`MCP_PROMPT_FIELD_INVALID: prompt ${name} description must be a string when present`);
  }
  if (prompt.arguments !== undefined && !Array.isArray(prompt.arguments)) {
    promptWarnings.push(`MCP_PROMPT_ARGUMENTS_INVALID: prompt ${name} arguments must be an array when present`);
  }
  if (prompt.annotations !== undefined && !asRecord(prompt.annotations)) {
    promptWarnings.push(`MCP_PROMPT_ANNOTATIONS_INVALID: prompt ${name} annotations must be an object when present`);
  }
  const seenArgumentNames = new Set<string>();
  const argumentsList: McpPromptArgumentDescriptor[] = [];
  asArray(prompt.arguments).forEach((argument, index) => {
    const descriptor = promptArgumentDescriptor(name, argument, promptWarnings, index);
    if (!descriptor) return;
    if (seenArgumentNames.has(descriptor.name)) {
      promptWarnings.push(`MCP_PROMPT_ARGUMENT_DUPLICATE: prompt ${name} declares argument ${descriptor.name} more than once; only the first declaration is kept`);
      return;
    }
    seenArgumentNames.add(descriptor.name);
    argumentsList.push(descriptor);
  });
  return {
    name,
    title: asOptionalString(prompt.title),
    description: asOptionalString(prompt.description),
    meta: asRecord(prompt._meta) ?? undefined,
    annotations: asRecord(prompt.annotations) ?? undefined,
    arguments: argumentsList,
    warnings: promptWarnings
  };
}

/**
 * Parse an MCP server description (registry server.json or mcpServers client
 * config, optionally carrying a tools/list-shaped `tools` array) into a flat,
 * deterministic contract index for the builder and instrumenter.
 */
export function parseMcpServerSpec(content: string): McpContractIndex {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('MCP_EMPTY_INPUT: MCP server description is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`MCP_PARSE_FAILED: MCP server description is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const documentJson = asRecord(parsed);
  if (!documentJson) {
    throw new Error('MCP_PARSE_FAILED: MCP server description must be a JSON object');
  }

  const warnings: string[] = [];
  const servers: McpServerDescriptor[] = [];

  if (isRegistrySchemaDocument(documentJson)) warnings.push(...registrySchemaWarnings(documentJson));

  const mcpServers = asRecord(documentJson.mcpServers);
  if (mcpServers) {
    for (const [id, entry] of Object.entries(mcpServers)) {
      const record = asRecord(entry);
      if (!record) {
        warnings.push(`MCP_SERVER_ENTRY_INVALID: mcpServers.${id} is not an object; it is skipped`);
        continue;
      }
      servers.push(clientConfigDescriptor(id, record));
    }
  }

  const registryName = typeof documentJson.name === 'string' ? documentJson.name : '';
  const remotes = asArray<unknown>(documentJson.remotes).map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => entry !== null);
  const packages = asArray<unknown>(documentJson.packages).map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => entry !== null);
  if (!mcpServers && (remotes.length > 0 || packages.length > 0)) {
    const multi = remotes.length + packages.length > 1;
    remotes.forEach((remote, i) => {
      const descriptor = remoteDescriptor(remote, multi ? `${registryName || 'server'} remote-${i + 1}` : registryName || 'server', warnings);
      if (descriptor) servers.push(descriptor);
    });
    packages.forEach((pkg, i) => {
      const descriptor = packageDescriptor(pkg, multi ? `${registryName || 'server'} package-${i + 1}` : registryName || 'server', warnings);
      if (descriptor) servers.push(descriptor);
    });
  }

  if (servers.length === 0) {
    throw new Error('MCP_NO_SERVERS: MCP description defines no servers (no mcpServers entries, remotes, or packages); contract generation requires at least one server');
  }

  const toolsRaw = asArray<unknown>(documentJson.tools)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null)
    .map((tool) => toolDescriptor(tool, warnings))
    .filter((tool): tool is McpToolDescriptor => tool !== null);
  // tools/list requires unique tool names; a duplicate would also collide in
  // the builder's deterministic item ids. Keep the first declaration and warn.
  const seenToolNames = new Set<string>();
  const tools: McpToolDescriptor[] = [];
  for (const tool of toolsRaw) {
    if (seenToolNames.has(tool.name)) {
      warnings.push(`MCP_TOOL_NAME_DUPLICATE: tool name "${tool.name}" is declared more than once; tools/list requires unique tool names, so only the first declaration generates a tools/call template`);
      continue;
    }
    seenToolNames.add(tool.name);
    tools.push(tool);
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const resourcesRaw = asArray<unknown>(documentJson.resources)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null)
    .map((resource) => resourceDescriptor(resource, warnings))
    .filter((resource): resource is McpResourceDescriptor => resource !== null);
  const seenResourceNames = new Set<string>();
  const resources: McpResourceDescriptor[] = [];
  for (const resource of resourcesRaw) {
    if (seenResourceNames.has(resource.name)) {
      warnings.push(`MCP_RESOURCE_NAME_DUPLICATE: resource name "${resource.name}" is declared more than once; only the first declaration is kept in the static MCP contract index`);
      continue;
    }
    seenResourceNames.add(resource.name);
    resources.push(resource);
  }
  resources.sort((a, b) => a.name.localeCompare(b.name));

  const resourceTemplatesRaw = asArray<unknown>(documentJson.resourceTemplates)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null)
    .map((template) => resourceTemplateDescriptor(template, warnings))
    .filter((template): template is McpResourceTemplateDescriptor => template !== null);
  const seenTemplateNames = new Set<string>();
  const resourceTemplates: McpResourceTemplateDescriptor[] = [];
  for (const template of resourceTemplatesRaw) {
    if (seenTemplateNames.has(template.name)) {
      warnings.push(`MCP_RESOURCE_TEMPLATE_NAME_DUPLICATE: resource template name "${template.name}" is declared more than once; only the first declaration is kept in the static MCP contract index`);
      continue;
    }
    seenTemplateNames.add(template.name);
    resourceTemplates.push(template);
  }
  resourceTemplates.sort((a, b) => a.name.localeCompare(b.name));

  const promptsRaw = asArray<unknown>(documentJson.prompts)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null)
    .map((prompt) => promptDescriptor(prompt, warnings))
    .filter((prompt): prompt is McpPromptDescriptor => prompt !== null);
  const seenPromptNames = new Set<string>();
  const prompts: McpPromptDescriptor[] = [];
  for (const prompt of promptsRaw) {
    if (seenPromptNames.has(prompt.name)) {
      warnings.push(`MCP_PROMPT_NAME_DUPLICATE: prompt name "${prompt.name}" is declared more than once; only the first declaration is kept in the static MCP contract index`);
      continue;
    }
    seenPromptNames.add(prompt.name);
    prompts.push(prompt);
  }
  prompts.sort((a, b) => a.name.localeCompare(b.name));

  const versionDetail = asRecord(documentJson.version_detail);
  const version =
    typeof documentJson.version === 'string'
      ? documentJson.version
      : typeof versionDetail?.version === 'string'
        ? String(versionDetail.version)
        : undefined;

  servers.sort((a, b) => a.id.localeCompare(b.id));
  const capabilities = asRecord(documentJson.capabilities);
  if (documentJson.capabilities !== undefined && !capabilities) {
    warnings.push(`MCP_CAPABILITIES_INVALID: top-level capabilities must be an object when present; got ${JSON.stringify(documentJson.capabilities)}`);
  }

  return {
    title: registryName || (typeof documentJson.title === 'string' ? documentJson.title : '') || 'MCP Server',
    version,
    servers,
    ...(capabilities ? { capabilities } : {}),
    tools,
    resources,
    resourceTemplates,
    prompts,
    documentJson,
    warnings
  };
}
