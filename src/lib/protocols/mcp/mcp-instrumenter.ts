// Generation-time (static) contract validation for the built MCP EC collection.
//
// MCP EC items carry no test-script slot and the Postman CLI runner prunes
// `mcp-request`, so there is no runtime pm.test surface to instrument. The
// contract check is therefore performed here at generation time, mirroring the
// AsyncAPI module's discipline: every generated JSON-RPC message must be a
// well-formed JSON-RPC 2.0 request (a malformed one is a builder bug and fails
// closed), each tool's inputSchema is compiled and the synthesized tools/call
// arguments are validated against it (the MCP analogue of the OAS
// CONTRACT_EXAMPLE_SCHEMA_MISMATCH self-consistency check), server transport
// material is checked (sse url scheme, stdio command presence, no concrete
// secret values), item coverage is enforced, and the collection size gate is
// applied. No silent drops: anything not deterministically checkable emits an
// MCP_*-prefixed warning.

import { compileSchemaValidator } from '../../spec/schema-validator-code.js';
import { packSchema, isSchemaGraphOverflow } from '../../spec/schema-pack.js';
import type { McpContractIndex, McpServerDescriptor, McpToolDescriptor } from './mcp-parser.js';
import { expectedRuntimeItemCount } from './mcp-collection-builder.js';
import { toolsCallScript } from './mcp-runtime-scripts.js';

type JsonRecord = Record<string, unknown>;

export interface McpInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

export const MCP_INSTRUMENT_LIMITS = {
  maxCollectionUpdateBytes: 4_000_000
} as const;

// MCP tool names: the registry/spec convention is a short programmatic
// identifier; anything outside this set still works on the wire but is flagged
// for auditability.
const TOOL_NAME_RE = /^[A-Za-z0-9_./-]{1,128}$/;
const META_KEY_RE = /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?\/)?[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const RESERVED_META_PREFIX_RE = /^(?:.*\.)?(?:modelcontextprotocol|mcp)\//i;
const MIME_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:"[^"]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;
const TOOL_FIELDS_2025_06_18 = new Set(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', '_meta']);

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function walkManifest(value: unknown, path: string, warnings: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => walkManifest(entry, `${path}[${i}]`, warnings));
    return;
  }
  const record = value as JsonRecord;
  if (Object.prototype.hasOwnProperty.call(record, '_meta') && asRecord(record._meta) === null) {
    warnings.push(`MCP_META_OBJECT_INVALID: ${path}._meta must be an object when present (MCP 2025-06-18 BaseMetadata)`);
  }
  const meta = asRecord(record._meta);
  if (meta) {
    for (const key of Object.keys(meta)) {
      if (!META_KEY_RE.test(key)) {
        warnings.push(`MCP_META_KEY_INVALID: ${path}._meta key "${key}" does not match the MCP 2025-06-18 _meta key grammar`);
      } else if (RESERVED_META_PREFIX_RE.test(key)) {
        warnings.push(`MCP_META_KEY_RESERVED_PREFIX: ${path}._meta key "${key}" uses the reserved modelcontextprotocol/mcp prefix`);
      }
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (/mimeType$/i.test(key) && typeof child === 'string' && !MIME_TYPE_RE.test(child)) {
      warnings.push(`MCP_MIME_TYPE_INVALID: ${path}.${key} value "${child}" is not an RFC 6838 type/subtype media type`);
    }
    walkManifest(child, `${path}.${key}`, warnings);
  }
}

function validateManifestDocument(index: McpContractIndex, warnings: string[]): void {
  walkManifest(index.documentJson, '$', warnings);
  const tools = asArray(index.documentJson.tools).map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => entry !== null);
  const seen = new Set<string>();
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name : '<unnamed>';
    if (typeof tool.name === 'string') {
      if (seen.has(tool.name)) warnings.push(`MCP_TOOL_NAME_DUPLICATE: tool name "${tool.name}" is declared more than once; tools/list requires unique tool names`);
      seen.add(tool.name);
    }
    if (tool.title !== undefined && typeof tool.title !== 'string') {
      warnings.push(`MCP_TOOL_BASE_METADATA_INVALID: tool ${name} title must be a string when present (MCP 2025-06-18 BaseMetadata)`);
    }
    if (tool.description !== undefined && typeof tool.description !== 'string') {
      warnings.push(`MCP_TOOL_BASE_METADATA_INVALID: tool ${name} description must be a string when present (MCP 2025-06-18 BaseMetadata)`);
    }
    for (const field of Object.keys(tool)) {
      if (!TOOL_FIELDS_2025_06_18.has(field)) {
        warnings.push(`MCP_TOOL_FIELD_UNKNOWN_2025_06_18: tool ${name} field "${field}" is not part of the MCP 2025-06-18 Tool object`);
      }
    }
    const annotations = asRecord(tool.annotations);
    if (typeof tool.title === 'string' && typeof annotations?.title === 'string') {
      warnings.push(`MCP_TOOL_TITLE_PRECEDENCE: tool ${name} declares both title and annotations.title; clients should prefer title for MCP 2025-06-18 display metadata`);
    }
  }
}

// JSON-RPC 2.0 request well-formedness (jsonrpc === '2.0', string method,
// string|number id, object params when present). The messages are generated by
// our own builder, so a violation is a generation bug: fail closed.
function itemServerScope(itemTitle: string): string {
  const separator = itemTitle.indexOf(' · ');
  return separator === -1 ? itemTitle : itemTitle.slice(0, separator);
}

function assertRecordValue(value: unknown, reason: string, fail: (reason: string) => never): JsonRecord {
  const record = asRecord(value);
  if (!record) fail(reason);
  return record;
}

function assertObjectParams(record: JsonRecord, method: string, fail: (reason: string) => never): JsonRecord {
  return assertRecordValue(record.params, `${method} params must be an object`, fail);
}

function assertOptionalObjectParams(record: JsonRecord, method: string, fail: (reason: string) => never): JsonRecord | null {
  if (record.params === undefined) return null;
  return assertObjectParams(record, method, fail);
}

function assertJsonRpcRequest(message: unknown, itemTitle: string): JsonRecord {
  const fail = (reason: string): never => {
    throw new Error(`MCP_MESSAGE_INVALID: item "${itemTitle}" carries a malformed JSON-RPC message (${reason}); generated MCP contract collection is invalid`);
  };
  if (typeof message !== 'string' || !message) fail('message is not a non-empty string');
  let parsed: unknown;
  try {
    parsed = JSON.parse(message as string);
  } catch {
    return fail('message is not valid JSON');
  }
  const record = asRecord(parsed);
  if (!record) return fail('message is not a JSON object');
  if (record.jsonrpc !== '2.0') return fail('jsonrpc must be the string "2.0"');
  if (typeof record.method !== 'string' || !record.method) return fail('method must be a non-empty string');
  if (typeof record.id === 'string') {
    if (!record.id) return fail('id string must be non-empty');
  } else if (typeof record.id === 'number') {
    if (!Number.isFinite(record.id) || Math.floor(record.id) !== record.id) return fail('id number must be a finite integer');
  } else {
    return fail('id must be a string or number');
  }
  if (record.params !== undefined && asRecord(record.params) === null) return fail('params must be an object when present');

  switch (record.method) {
    case 'initialize': {
      const params = assertObjectParams(record, 'initialize', fail);
      if (typeof params.protocolVersion !== 'string' || !params.protocolVersion) fail('initialize params.protocolVersion must be a non-empty string');
      assertRecordValue(params.capabilities, 'initialize params.capabilities must be an object', fail);
      const clientInfo = assertRecordValue(params.clientInfo, 'initialize params.clientInfo must be an object', fail);
      if (typeof clientInfo.name !== 'string' || !clientInfo.name) fail('initialize params.clientInfo.name must be a non-empty string');
      if (typeof clientInfo.version !== 'string' || !clientInfo.version) fail('initialize params.clientInfo.version must be a non-empty string');
      break;
    }
    case 'tools/list': {
      const params = assertOptionalObjectParams(record, 'tools/list', fail);
      if (params?.cursor !== undefined && typeof params.cursor !== 'string') fail('tools/list params.cursor must be a string when present');
      break;
    }
    case 'resources/list':
    case 'prompts/list': {
      const params = assertOptionalObjectParams(record, record.method, fail);
      if (params?.cursor !== undefined && typeof params.cursor !== 'string') fail(record.method + ' params.cursor must be a string when present');
      break;
    }
    case 'resources/read': {
      const params = assertObjectParams(record, 'resources/read', fail);
      if (typeof params.uri !== 'string' || !params.uri) fail('resources/read params.uri must be a non-empty string');
      break;
    }
    case 'prompts/get': {
      const params = assertObjectParams(record, 'prompts/get', fail);
      if (typeof params.name !== 'string' || !params.name) fail('prompts/get params.name must be a non-empty string');
      if (params.arguments !== undefined && asRecord(params.arguments) === null) fail('prompts/get params.arguments must be an object when present');
      break;
    }
    case 'tools/call': {
      const params = assertObjectParams(record, 'tools/call', fail);
      if (typeof params.name !== 'string' || !params.name) fail('tools/call params.name must be a non-empty string');
      if (params.arguments !== undefined && asRecord(params.arguments) === null) fail('tools/call params.arguments must be an object when present');
      if (params._meta !== undefined && asRecord(params._meta) === null) fail('tools/call params._meta must be an object when present');
      break;
    }
    case 'ping':
    case 'resources/templates/list':
      assertOptionalObjectParams(record, record.method, fail);
      break;
    default:
      break;
  }

  return record;
}

function validateServer(server: McpServerDescriptor, warnings: string[]): void {
  if (server.transport === 'sse') {
    if (!server.url) {
      warnings.push(`MCP_SERVER_URL_MISSING: server ${server.id} declares a remote transport but no url; the generated request must be completed before use`);
    } else if (!/^https?:\/\//i.test(server.url)) {
      warnings.push(`MCP_SERVER_URL_INVALID: server ${server.id} remote url "${server.url}" is not an http(s) endpoint`);
    }
  } else if (!server.command) {
    warnings.push(`MCP_SERVER_COMMAND_MISSING: server ${server.id} declares a stdio transport but no launch command; the generated request must be completed before use`);
  }
  // Secret hygiene: env/header values that look like concrete credentials
  // (rather than {{variable}} placeholders) are flagged so no secret is
  // persisted into the collection.
  for (const entry of [...server.headers, ...server.env]) {
    const looksSecret = /(?:key|token|secret|password|credential)/i.test(entry.key);
    const isPlaceholder = /^\{\{[^}]+\}\}$/.test(entry.value) || entry.value === '';
    if (looksSecret && !isPlaceholder) {
      warnings.push(`MCP_SECRET_VALUE_PRESENT: server ${server.id} carries a concrete value for "${entry.key}"; replace it with a {{variable}} placeholder so the credential is not persisted in the collection`);
    }
  }
}

// MCP 2025-06-18 ToolAnnotations: the behavior hints are booleans and title is
// a string; a mis-typed hint is a manifest bug a client would misread.
const TOOL_ANNOTATION_BOOLEAN_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

function validateToolAnnotations(tool: McpToolDescriptor, warnings: string[]): void {
  if (!tool.annotations) return;
  for (const hint of TOOL_ANNOTATION_BOOLEAN_HINTS) {
    const value = tool.annotations[hint];
    if (value !== undefined && typeof value !== 'boolean') {
      warnings.push(`MCP_TOOL_ANNOTATION_INVALID: tool ${tool.name} annotations.${hint} must be a boolean (MCP ToolAnnotations); got ${JSON.stringify(value)}`);
    }
  }
  if (tool.annotations.title !== undefined && typeof tool.annotations.title !== 'string') {
    warnings.push(`MCP_TOOL_ANNOTATION_INVALID: tool ${tool.name} annotations.title must be a string (MCP ToolAnnotations); got ${JSON.stringify(tool.annotations.title)}`);
  }
}

// MCP 2025-06-18: a tool that declares an outputSchema commits its tools/call
// results to carry structuredContent conforming to it, so the schema itself
// must be a compilable object schema. There is no runtime surface on
// mcp-request items, so conformance of live results stays out of scope; the
// deterministic generation-time contract is schema validity.
function validateToolOutputSchema(index: McpContractIndex, tool: McpToolDescriptor, warnings: string[]): void {
  if (!tool.outputSchema) return;
  const declaredType = tool.outputSchema.type;
  if (declaredType !== undefined && declaredType !== 'object') {
    warnings.push(`MCP_TOOL_OUTPUT_SCHEMA_INVALID: tool ${tool.name} outputSchema type is ${JSON.stringify(declaredType)}; the MCP specification requires tool output schemas to describe the structuredContent object`);
  }
  const packed = packSchema(index.documentJson, tool.outputSchema, '3.0', 'response');
  if (packed.unsupported) {
    const code = isSchemaGraphOverflow(packed) ? 'MCP_SCHEMA_NOT_COMPILED' : 'MCP_TOOL_OUTPUT_SCHEMA_NOT_VALIDATED';
    warnings.push(`${code}: tool ${tool.name} outputSchema is not validated (${packed.unsupported})`);
    return;
  }
  if (!compileSchemaValidator(packed.schema)) {
    warnings.push(`MCP_TOOL_OUTPUT_SCHEMA_NOT_VALIDATED: tool ${tool.name} outputSchema could not be compiled to a validator`);
  }
}

function validateTool(index: McpContractIndex, tool: McpToolDescriptor, warnings: string[]): void {
  if (!TOOL_NAME_RE.test(tool.name)) {
    warnings.push(`MCP_TOOL_NAME_UNCONVENTIONAL: tool name "${tool.name}" is outside the conventional [A-Za-z0-9_./-]{1,128} identifier set`);
  }
  validateToolAnnotations(tool, warnings);
  validateToolOutputSchema(index, tool, warnings);
  if (!tool.inputSchema) return;
  const declaredType = tool.inputSchema.type;
  if (declaredType !== undefined && declaredType !== 'object') {
    warnings.push(`MCP_TOOL_SCHEMA_INVALID: tool ${tool.name} inputSchema type is ${JSON.stringify(declaredType)}; the MCP specification requires tool input schemas to describe an object`);
  }
  const packed = packSchema(index.documentJson, tool.inputSchema, '3.0', 'request');
  if (packed.unsupported) {
    const code = isSchemaGraphOverflow(packed) ? 'MCP_SCHEMA_NOT_COMPILED' : 'MCP_TOOL_SCHEMA_NOT_VALIDATED';
    warnings.push(`${code}: tool ${tool.name} inputSchema is not validated (${packed.unsupported})`);
    return;
  }
  const validate = compileSchemaValidator(packed.schema);
  if (!validate) {
    warnings.push(`MCP_TOOL_SCHEMA_NOT_VALIDATED: tool ${tool.name} inputSchema could not be compiled to a validator`);
    return;
  }
  if (!validate(tool.sampleArguments)) {
    warnings.push(`MCP_TOOL_SAMPLE_MISMATCH: tool ${tool.name} synthesized tools/call arguments do not validate against the tool's own inputSchema; the generated template will not satisfy the contract`);
  }
}

export function instrumentMcpCollection(collection: JsonRecord, index: McpContractIndex): McpInstrumentationResult {
  const warnings: string[] = [
    ...index.warnings,
    ...index.servers.flatMap((server) => server.warnings),
    ...index.tools.flatMap((tool) => tool.warnings),
    ...index.resources.flatMap((resource) => resource.warnings),
    ...index.resourceTemplates.flatMap((template) => template.warnings),
    ...index.prompts.flatMap((prompt) => prompt.warnings)
  ];

  for (const server of index.servers) validateServer(server, warnings);

  for (const tool of index.tools) validateTool(index, tool, warnings);
  validateManifestDocument(index, warnings);
  for (const tool of index.tools) warnings.push(...toolsCallScript(index, tool).warnings);

  // Coverage + message well-formedness over the built items: every server must
  // materialize initialize + tools/list + one tools/call per tool, each with a
  // distinct id and a well-formed JSON-RPC message. Fail closed on drift.
  const items = asArray(collection.item).map((entry) => asRecord(entry)).filter((entry): entry is JsonRecord => entry !== null);
  const ids: string[] = [];
  const httpIds: string[] = [];
  const requestIdsByServer = new Set<string>();
  for (const item of items) {
    if (String(item.type) === 'mcp-request') {
      ids.push(typeof item.id === 'string' && item.id ? item.id : `#${ids.length}`);
      const itemTitle = String(item.title ?? item.id ?? 'mcp-request');
      const request = assertJsonRpcRequest(asRecord(item.payload)?.message, itemTitle);
      const scopedId = `${itemServerScope(itemTitle)}\u0000${typeof request.id === 'number' ? `n:${request.id}` : `s:${request.id}`}`;
      if (requestIdsByServer.has(scopedId)) {
        throw new Error(
          `MCP_REQUEST_ID_DUPLICATE: server "${itemServerScope(itemTitle)}" reuses JSON-RPC id ${JSON.stringify(request.id)} across generated mcp-request items; generated contract collection is ambiguous`
        );
      }
      requestIdsByServer.add(scopedId);
    } else if (String(item.type) === 'http-request' && String(item.title ?? '').includes('HTTP')) {
      httpIds.push(typeof item.id === 'string' && item.id ? item.id : `#${httpIds.length}`);
    }
  }
  const expected = index.servers.length * (4 + index.tools.length + index.resources.length + index.prompts.length);
  const unique = new Set(ids).size;
  if (ids.length !== expected || unique !== expected) {
    throw new Error(
      `MCP_ITEM_COVERAGE_FAILED: built collection has ${ids.length} mcp-request item(s) (${unique} distinct) but the MCP index requires ${expected}; generated contract collection is incomplete or duplicated`
    );
  }
  const expectedHttp = index.servers.reduce((total, server) => total + expectedRuntimeItemCount(index, server), 0);
  const uniqueHttp = new Set(httpIds).size;
  if (httpIds.length !== expectedHttp || uniqueHttp !== expectedHttp) {
    throw new Error(
      `MCP_HTTP_ITEM_COVERAGE_FAILED: built collection has ${httpIds.length} MCP http-request item(s) (${uniqueHttp} distinct) but the MCP index requires ${expectedHttp}; generated runtime contract surface is incomplete or duplicated`
    );
  }
  for (const server of index.servers) {
    if (server.transport === 'stdio' || !server.url) {
      warnings.push(`MCP_RUNTIME_SURFACE_UNAVAILABLE: server ${server.id} has no Streamable HTTP/SSE url; only static mcp-request templates are generated`);
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(collection), 'utf8');
  if (bytes > MCP_INSTRUMENT_LIMITS.maxCollectionUpdateBytes) {
    throw new Error(`MCP_COLLECTION_SIZE_EXCEEDED: built MCP collection exceeded ${MCP_INSTRUMENT_LIMITS.maxCollectionUpdateBytes} bytes`);
  }

  return { collection, warnings: [...new Set(warnings)] };
}
