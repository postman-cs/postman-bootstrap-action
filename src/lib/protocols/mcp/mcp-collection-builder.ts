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
import {
  badVersionScript,
  bogusBearerScript,
  initializeScript,
  initializedNotificationScript,
  cursorProbePrerequest,
  cursorReplayScript,
  invalidCursorScript,
  nextCursorScript,
  oldSessionPingScript,
  sessionRequiredScript,
  pingScript,
  progressToolCallScript,
  protectedResourceMetadataScript,
  resourceTemplatesScript,
  terminateScript,
  toolsCallScript,
  toolsListScript,
  unauthenticatedInitializeScript
} from './mcp-runtime-scripts.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

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

function jsonRpcWithId(id: string | number, method: string, params?: JsonRecord): string {
  const message: JsonRecord = { jsonrpc: '2.0', id, method };
  if (params !== undefined) message.params = params;
  return JSON.stringify(message, null, 2);
}

function jsonRpcNotification(method: string): string {
  return JSON.stringify({ jsonrpc: '2.0', method }, null, 2);
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

function toolArguments(tool: McpToolDescriptor): JsonRecord {
  return (asRecord(tool.sampleArguments) ?? {}) as JsonRecord;
}

function toolsCallMessage(tool: McpToolDescriptor, id: string | number = 3): string {
  return jsonRpcWithId(id, 'tools/call', {
    name: tool.name,
    arguments: toolArguments(tool)
  });
}

function toolsCallProgressMessage(tool: McpToolDescriptor): string {
  return jsonRpcWithId('pm-progress-call', 'tools/call', {
    name: tool.name,
    arguments: toolArguments(tool),
    _meta: { progressToken: 'pm-progress' }
  });
}

function hasAuthorizationHeader(server: McpServerDescriptor): boolean {
  return server.headers.some((entry) => entry.key.toLowerCase() === 'authorization');
}

// RFC 9728 §3: the protected-resource metadata well-known path is inserted
// between the host and the resource's path component. Templated {{...}} urls
// do not parse as URLs, so no PRM probe can be derived for them.
function protectedResourceMetadataUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    const path = url.pathname.replace(/\/$/, '');
    return `${url.origin}/.well-known/oauth-protected-resource${path}`;
  } catch {
    return null;
  }
}

// Shared with the instrumenter's coverage gate so builder drift fails closed.
export function expectedRuntimeItemCount(index: McpContractIndex, server: McpServerDescriptor): number {
  if (server.transport !== 'sse' || !server.url) return 0;
  let count = 12 + index.tools.length;
  if (index.tools.length > 0) count += 1;
  if (hasAuthorizationHeader(server)) {
    count += 2;
    if (protectedResourceMetadataUrl(server.url)) count += 1;
  }
  return count;
}

function baseHeaders(server: McpServerDescriptor): Array<{ key: string; value: string }> {
  const headers = [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'Accept', value: 'application/json, text/event-stream' },
    { key: 'MCP-Protocol-Version', value: DEFAULT_MCP_PROTOCOL_VERSION },
    ...server.headers.map((entry) => ({ key: entry.key, value: entry.value }))
  ];
  const seen = new Set<string>();
  return headers.filter((entry) => {
    const key = entry.key.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withSession(headers: Array<{ key: string; value: string }>): Array<{ key: string; value: string }> {
  return [...headers, { key: 'Mcp-Session-Id', value: '{{mcp_session_id}}' }];
}

function body(content: string): JsonRecord {
  return { type: 'json', content };
}

function event(script: string): JsonRecord {
  return {
    listen: 'afterResponse',
    script: { exec: script, type: 'text/javascript' }
  };
}

function httpItem(idSeed: string, key: string, title: string, url: string, method: string, headers: Array<{ key: string; value: string }>, content: string | undefined, script: string, prerequest?: string): JsonRecord {
  const payload: JsonRecord = {
    url,
    method,
    headers
  };
  if (content !== undefined) payload.body = body(content);
  const events: JsonRecord[] = [];
  if (prerequest !== undefined) events.push({ listen: 'beforeRequest', script: { exec: prerequest, type: 'text/javascript' } });
  events.push(event(script));
  return {
    type: 'http-request',
    id: stableId(idSeed, key),
    title,
    name: title,
    createdAt: DEFAULT_CREATED_AT,
    payload,
    extensions: { events }
  };
}

function runtimeItems(index: McpContractIndex, server: McpServerDescriptor, options: McpCollectionOptions): JsonRecord[] {
  if (server.transport !== 'sse' || !server.url) return [];
  const seed = options.idSeed ?? 'mcp';
  const headers = baseHeaders(server);
  const sessionHeaders = withSession(headers);
  const items: JsonRecord[] = [
    httpItem(seed, `srv:${server.id}:http:initialize`, `${server.id} · HTTP initialize`, server.url, 'POST', headers, initializeMessage(options), initializeScript()),
    httpItem(seed, `srv:${server.id}:http:initialized`, `${server.id} · HTTP notifications/initialized`, server.url, 'POST', sessionHeaders, jsonRpcNotification('notifications/initialized'), initializedNotificationScript()),
    httpItem(seed, `srv:${server.id}:http:ping`, `${server.id} · HTTP ping`, server.url, 'POST', sessionHeaders, jsonRpcWithId('pm-ping', 'ping'), pingScript()),
    httpItem(seed, `srv:${server.id}:http:tools/list`, `${server.id} · HTTP tools/list`, server.url, 'POST', sessionHeaders, toolsListMessage(), toolsListScript(index.tools.map((tool) => tool.name))),
    // Session-requirement probe: same ping, deliberately without the session
    // header (base headers), after initialize has had a chance to issue one.
    httpItem(seed, `srv:${server.id}:http:no-session-ping`, `${server.id} · HTTP ping without session id`, server.url, 'POST', headers, jsonRpcWithId('pm-nosession', 'ping'), sessionRequiredScript()),
    // Pagination probes: follow the saved nextCursor byte-for-byte, then
    // replay it; both self-skip when tools/list returned no nextCursor.
    httpItem(seed, `srv:${server.id}:http:tools/list:next-page`, `${server.id} · HTTP tools/list next page`, server.url, 'POST', sessionHeaders, jsonRpcWithId(6, 'tools/list', { cursor: '{{mcp_next_cursor}}' }), nextCursorScript(), cursorProbePrerequest()),
    httpItem(seed, `srv:${server.id}:http:tools/list:cursor-replay`, `${server.id} · HTTP tools/list cursor replay`, server.url, 'POST', sessionHeaders, jsonRpcWithId(7, 'tools/list', { cursor: '{{mcp_next_cursor}}' }), cursorReplayScript(), cursorProbePrerequest())
  ];
  for (const [i, tool] of index.tools.entries()) {
    const requestId = 10 + i;
    const { script } = toolsCallScript(index, tool, requestId);
    items.push(
      httpItem(seed, `srv:${server.id}:http:tools/call:${tool.name}`, `${server.id} · HTTP tools/call ${tool.name}`, server.url, 'POST', sessionHeaders, toolsCallMessage(tool, requestId), script)
    );
  }
  items.push(
    httpItem(seed, `srv:${server.id}:http:resources/templates`, `${server.id} · HTTP resources/templates/list`, server.url, 'POST', sessionHeaders, jsonRpcWithId(5, 'resources/templates/list', {}), resourceTemplatesScript())
  );
  if (index.tools.length > 0) {
    const progressTool = index.tools[0];
    items.push(
      httpItem(seed, `srv:${server.id}:http:progress:${progressTool.name}`, `${server.id} · HTTP tools/call ${progressTool.name} with progressToken`, server.url, 'POST', sessionHeaders, toolsCallProgressMessage(progressTool), progressToolCallScript(progressTool.name))
    );
  }
  if (hasAuthorizationHeader(server)) {
    const noAuthHeaders = headers.filter((entry) => entry.key.toLowerCase() !== 'authorization');
    const bogusHeaders = headers.map((entry) => entry.key.toLowerCase() === 'authorization' ? { ...entry, value: 'Bearer pm-invalid-token' } : entry);
    items.push(
      httpItem(seed, `srv:${server.id}:http:auth:unauthenticated`, `${server.id} · HTTP negative unauthenticated initialize`, server.url, 'POST', noAuthHeaders, initializeMessage(options), unauthenticatedInitializeScript()),
      httpItem(seed, `srv:${server.id}:http:auth:bogus-bearer`, `${server.id} · HTTP negative invalid bearer token`, server.url, 'POST', bogusHeaders, initializeMessage(options), bogusBearerScript())
    );
    const prmUrl = protectedResourceMetadataUrl(server.url);
    if (prmUrl) {
      items.push(
        httpItem(seed, `srv:${server.id}:http:auth:prm`, `${server.id} · HTTP protected resource metadata`, prmUrl, 'GET', [{ key: 'Accept', value: 'application/json' }], undefined, protectedResourceMetadataScript())
      );
    }
  }
  items.push(
    httpItem(seed, `srv:${server.id}:http:bad-version`, `${server.id} · HTTP negative bad protocol version`, server.url, 'POST', sessionHeaders.map((entry) => entry.key === 'MCP-Protocol-Version' ? { ...entry, value: '1999-01-01' } : entry), jsonRpcWithId('pm-badver', 'ping'), badVersionScript()),
    httpItem(seed, `srv:${server.id}:http:invalid-cursor`, `${server.id} · HTTP tools/list invalid cursor`, server.url, 'POST', sessionHeaders, jsonRpcWithId(4, 'tools/list', { cursor: 'pm-invalid-cursor-§' }), invalidCursorScript()),
    httpItem(seed, `srv:${server.id}:http:terminate`, `${server.id} · HTTP session DELETE`, server.url, 'DELETE', sessionHeaders, undefined, terminateScript()),
    httpItem(seed, `srv:${server.id}:http:old-session-ping`, `${server.id} · HTTP old session ping`, server.url, 'POST', sessionHeaders, jsonRpcWithId('pm-old-session-ping', 'ping'), oldSessionPingScript())
  );
  return items;
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
    for (const [i, tool] of index.tools.entries()) {
      item.push(
        buildItem(server, `srv:${server.id}:tools/call:${tool.name}`, `${server.id} · tools/call ${tool.name}`, toolsCallMessage(tool, 3 + i), options)
      );
    }
    item.push(...runtimeItems(index, server, options));
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
