// Build a v3/EC (Extensible Collection) JSON object with mcp-request items for
// an MCP server contract: per server an `initialize` and a `tools/list`
// JSON-RPC template, plus one `tools/call` template per declared tool with
// arguments synthesized from the tool's inputSchema.
//
// Grounding for the item shape is the bundled `@postman/runtime.models`
// extensible item schema (the published v3.0.0 JSON Schema is not fetchable):
//   - mcp-request.payload = { transport:'sse', url?, headers?, settings?, message? }
//                         | { transport:'stdio', command?, env?, settings?, message? }
//   - mcp-request has no children; each JSON-RPC message is its own item.
// (see node_modules/@postman/runtime.models/dist/extensible/item-types/mcp-request.d.ts)
//
// MCP EC items expose no test-script (`extensions.events`) slot and the Postman
// CLI runner prunes them, so no runtime assertions are attached here; the
// contract check is generation-time/static (see mcp-instrumenter.ts).
//
// Output ordering is deterministic (servers/tools already sorted upstream) so
// repeated builds and golden snapshots are stable.

import type { McpContractIndex, McpServerDescriptor, McpToolDescriptor } from './mcp-parser.js';

type JsonRecord = Record<string, unknown>;

export interface McpCollectionOptions {
  // Collection display name. Defaults to `<title> Contract`.
  name?: string;
  // Deterministic id seed; when set, item ids are derived from it for stable snapshots.
  idSeed?: string;
  // Fixed createdAt for deterministic output.
  createdAt?: string;
  // MCP protocol version sent in the initialize template.
  protocolVersion?: string;
}

const DEFAULT_CREATED_AT = '1970-01-01T00:00:00.000Z';
// Latest MCP protocol revision the generated initialize template negotiates.
const DEFAULT_MCP_PROTOCOL_VERSION = '2025-06-18';

// Deterministic, dependency-free id: a stable hash of the seed + key. uuid-shaped
// but derived, matching the gRPC/AsyncAPI builders' stableId discipline.
function stableId(seed: string, key: string): string {
  let h1 = 0x811c9dc5;
  const input = `${seed}:${key}`;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-${key.length.toString(16).padStart(12, '0')}`;
}

function jsonRpc(id: number, method: string, params: JsonRecord): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }, null, 2);
}

function initializeMessage(options: McpCollectionOptions): string {
  return jsonRpc(1, 'initialize', {
    protocolVersion: options.protocolVersion ?? DEFAULT_MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'postman-contract', version: '1.0.0' }
  });
}

function toolsListMessage(): string {
  return jsonRpc(2, 'tools/list', {});
}

function toolsCallMessage(tool: McpToolDescriptor): string {
  return jsonRpc(3, 'tools/call', {
    name: tool.name,
    arguments: (tool.sampleArguments as JsonRecord) ?? {}
  });
}

function serverPayload(server: McpServerDescriptor, message: string): JsonRecord {
  if (server.transport === 'stdio') {
    const payload: JsonRecord = { transport: 'stdio', message };
    if (server.command) payload.command = server.command;
    if (server.env.length > 0) payload.env = server.env.map((entry) => ({ key: entry.key, value: entry.value }));
    return payload;
  }
  const payload: JsonRecord = { transport: 'sse', message };
  if (server.url) payload.url = server.url;
  if (server.headers.length > 0) payload.headers = server.headers.map((entry) => ({ key: entry.key, value: entry.value }));
  return payload;
}

function buildItem(
  server: McpServerDescriptor,
  key: string,
  title: string,
  message: string,
  options: McpCollectionOptions
): JsonRecord {
  const seed = options.idSeed ?? 'mcp';
  return {
    type: 'mcp-request',
    id: stableId(seed, key),
    title,
    name: title,
    createdAt: options.createdAt ?? DEFAULT_CREATED_AT,
    payload: serverPayload(server, message),
    extensions: {}
  };
}

export function buildMcpCollection(index: McpContractIndex, options: McpCollectionOptions = {}): JsonRecord {
  const name = options.name?.trim() || `${index.title} Contract`;
  const item: JsonRecord[] = [];
  for (const server of index.servers) {
    item.push(buildItem(server, `srv:${server.id}:initialize`, `${server.id} · initialize`, initializeMessage(options), options));
    item.push(buildItem(server, `srv:${server.id}:tools/list`, `${server.id} · tools/list`, toolsListMessage(), options));
    for (const tool of index.tools) {
      item.push(
        buildItem(server, `srv:${server.id}:tools/call:${tool.name}`, `${server.id} · tools/call ${tool.name}`, toolsCallMessage(tool), options)
      );
    }
  }
  return {
    $schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/',
    info: {
      name,
      schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/'
    },
    item
  };
}
