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

export interface McpContractIndex {
  title: string;
  version?: string;
  servers: McpServerDescriptor[];
  tools: McpToolDescriptor[];
  // The full document JSON, the $ref-resolution root for tool schemas.
  documentJson: JsonRecord;
  warnings: string[];
}

const SAMPLE_MAX_DEPTH = 5;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
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

// Registry `remotes[].headers` entries are `{ name, value?, is_required?,
// is_secret? }`; secret or valueless headers become `{{name}}` variable
// placeholders so no concrete secret is ever written into the collection.
function registryHeaderKeyValues(headers: unknown): McpKeyValue[] {
  return asArray(headers)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null && typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => {
      const name = String(entry.name);
      const secret = entry.is_secret === true;
      const value = typeof entry.value === 'string' && entry.value && !secret ? entry.value : `{{${name}}}`;
      return { key: name, value };
    });
}

function registryEnvKeyValues(variables: unknown): McpKeyValue[] {
  return asArray(variables)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null && typeof entry.name === 'string' && entry.name !== '')
    .map((entry) => {
      const name = String(entry.name);
      const secret = entry.is_secret === true;
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
      if (typeof record.value === 'string' && record.value) return record.value;
      if (typeof record.name === 'string' && record.name) {
        return typeof record.value === 'string' && record.value ? `${record.name}=${record.value}` : String(record.name);
      }
      if (typeof record.value_hint === 'string' && record.value_hint) return `<${record.value_hint}>`;
      return '';
    })
    .filter(Boolean);
}

function remoteDescriptor(remote: JsonRecord, id: string, warnings: string[]): McpServerDescriptor | null {
  const type = String(remote.type ?? '').toLowerCase();
  const url = typeof remote.url === 'string' ? remote.url : '';
  const serverWarnings: string[] = [];
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
    headers: registryHeaderKeyValues(remote.headers),
    env: [],
    warnings: serverWarnings
  };
}

function packageDescriptor(pkg: JsonRecord, id: string): McpServerDescriptor {
  const identifier = typeof pkg.identifier === 'string' ? pkg.identifier : String(pkg.name ?? '');
  const runtimeHint = typeof pkg.runtime_hint === 'string' && pkg.runtime_hint ? pkg.runtime_hint : '';
  const parts = [
    runtimeHint,
    ...stringArguments(pkg.runtime_arguments),
    identifier,
    ...stringArguments(pkg.package_arguments)
  ].filter(Boolean);
  return {
    id,
    transport: 'stdio',
    headers: [],
    command: parts.join(' '),
    env: registryEnvKeyValues(pkg.environment_variables),
    warnings: []
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
      servers.push(packageDescriptor(pkg, multi ? `${registryName || 'server'} package-${i + 1}` : registryName || 'server'));
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

  const versionDetail = asRecord(documentJson.version_detail);
  const version =
    typeof documentJson.version === 'string'
      ? documentJson.version
      : typeof versionDetail?.version === 'string'
        ? String(versionDetail.version)
        : undefined;

  servers.sort((a, b) => a.id.localeCompare(b.id));

  return {
    title: registryName || (typeof documentJson.title === 'string' ? documentJson.title : '') || 'MCP Server',
    version,
    servers,
    tools,
    documentJson,
    warnings
  };
}
