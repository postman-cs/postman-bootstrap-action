import { compileSchemaValidatorCode } from '../../spec/schema-validator-code.js';
import { isSchemaGraphOverflow, packSchema } from '../../spec/schema-pack.js';
import type { McpContractIndex, McpToolDescriptor } from './mcp-parser.js';

export interface McpRuntimeScriptResult {
  script: string;
  warnings: string[];
}

const PREAMBLE = `
function mcpResponseBody() {
  var contentType = pm.response.headers.get('Content-Type') || '';
  var raw = pm.response.text();
  if (!raw) return undefined;
  if (/text\\/event-stream/i.test(contentType)) {
    var payloads = [];
    raw.split(/\\r?\\n\\r?\\n/).forEach(function (frame) {
      var data = frame.split(/\\r?\\n/).filter(function (line) { return /^data\\s*:/i.test(line); }).map(function (line) { return line.replace(/^data\\s*:\\s?/i, ''); }).join('\\n');
      if (data) payloads.push(JSON.parse(data));
    });
    return payloads.length === 1 ? payloads[0] : payloads;
  }
  return JSON.parse(raw);
}
function mcpAssertErrorShape(message, body, expectedId) {
  pm.expect(body, message + ' body is object').to.be.an('object').and.not.an('array');
  pm.expect(body.jsonrpc, message + ' JSON-RPC 2.0 §4/§5').to.eql('2.0');
  if (expectedId !== undefined) {
    pm.expect(body.id, message + ' MCP forbids null ids in responses to id-bearing requests').to.not.eql(null);
    pm.expect(body.id, message + ' id echoes request').to.eql(expectedId);
  }
  pm.expect(body.error, message + ' JSON-RPC 2.0 §5.1 error object').to.be.an('object');
  pm.expect(body.error.code, message + ' JSON-RPC 2.0 §5.1 error.code integer').to.satisfy(function (value) { return typeof value === 'number' && Math.floor(value) === value; });
  pm.expect(body.error.message, message + ' JSON-RPC 2.0 §5.1 error.message string').to.be.a('string');
}
function mcpAssertResponseObject(message, body, expectedId) {
  pm.expect(body, message + ' batching removed by MCP 2025-06-18').to.be.an('object').and.not.an('array');
  pm.expect(body.jsonrpc, message + ' JSON-RPC 2.0 §4/§5').to.eql('2.0');
  pm.expect(body.id, message + ' MCP forbids null ids in responses to id-bearing requests').to.not.eql(null);
  pm.expect(body.id, message + ' id echoes request').to.eql(expectedId);
  if (body.error) mcpAssertErrorShape(message, body, expectedId);
}
function mcpMetaKeyOk(key) {
  var name = '[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?';
  var prefix = '(?:' + name + '\\\\.)*' + name + '\\\\/';
  return new RegExp('^(?:' + prefix + ')?' + name + '$').test(key);
}
function mcpWalkMeta(value, path, bad) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(function (entry, i) { mcpWalkMeta(entry, path + '[' + i + ']', bad); });
    return;
  }
  if (value._meta && typeof value._meta === 'object' && !Array.isArray(value._meta)) {
    Object.keys(value._meta).forEach(function (key) { if (!mcpMetaKeyOk(key)) bad.push(path + '._meta.' + key); });
  }
  Object.keys(value).forEach(function (key) { mcpWalkMeta(value[key], path + '.' + key, bad); });
}
function mcpSaveSessionAndCapabilities(body) {
  var session = pm.response.headers.get('Mcp-Session-Id');
  if (session) pm.collectionVariables.set('mcp_session_id', session);
  if (body && body.result && body.result.capabilities) pm.collectionVariables.set('mcp_capabilities', JSON.stringify(body.result.capabilities));
}
function mcpSessionHeader() {
  return pm.collectionVariables.get('mcp_session_id') || '';
}
`;

function join(lines: string[]): string {
  return [PREAMBLE.trim(), ...lines].join('\n');
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function initializeScript(): string {
  return join([
    "var body;",
    `pm.test('MCP initialize transport is HTTP 2xx (MCP 2025-06-18 Streamable HTTP)', function () { pm.expect(pm.response.code).to.be.within(200, 299); });`,
    `pm.test('MCP initialize Content-Type is JSON or SSE (MCP 2025-06-18 transports)', function () { pm.expect(pm.response.headers.get('Content-Type') || '').to.match(/application\\/json|text\\/event-stream/i); });`,
    `pm.test('MCP initialize response is a JSON-RPC object, not a batch (MCP 2025-06-18; JSON-RPC 2.0 §5)', function () { body = mcpResponseBody(); mcpAssertResponseObject('initialize', body, 1); pm.expect(body.result, 'initialize result').to.be.an('object'); });`,
    `pm.test('MCP initialize negotiates protocolVersion date (MCP 2025-06-18 initialize)', function () { pm.expect(body.result.protocolVersion).to.match(/^\\d{4}-\\d{2}-\\d{2}$/); if (['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].indexOf(body.result.protocolVersion) === -1) console.warn('MCP initialize protocolVersion is not in the known revision set: ' + body.result.protocolVersion); });`,
    `pm.test('MCP initialize capabilities have typed open sub-shapes (MCP 2025-06-18 capabilities)', function () { var caps = body.result.capabilities; pm.expect(caps).to.be.an('object'); ['tools','resources','prompts'].forEach(function (name) { if (caps[name]) Object.keys(caps[name]).filter(function (k) { return /^(listChanged|subscribe)$/.test(k); }).forEach(function (k) { pm.expect(caps[name][k], name + '.' + k).to.be.a('boolean'); }); }); ['logging','completions'].forEach(function (name) { if (caps[name] !== undefined) pm.expect(caps[name], name).to.be.an('object'); }); });`,
    `pm.test('MCP initialize serverInfo and instructions shape (MCP 2025-06-18 initialize)', function () { pm.expect(body.result.serverInfo).to.be.an('object'); pm.expect(body.result.serverInfo.name).to.be.a('string'); pm.expect(body.result.serverInfo.version).to.be.a('string'); if (body.result.instructions !== undefined) pm.expect(body.result.instructions).to.be.a('string'); });`,
    `pm.test('MCP initialize session id header is visible ASCII when present (MCP 2025-06-18 Mcp-Session-Id)', function () { var session = pm.response.headers.get('Mcp-Session-Id'); if (session) pm.expect(session).to.match(/^[\\x21-\\x7E]+$/); mcpSaveSessionAndCapabilities(body); });`
  ]);
}

export function initializedNotificationScript(): string {
  return join([
    `pm.test('MCP initialized notification returns HTTP 202 with empty body (MCP 2025-06-18 transports)', function () { pm.expect(pm.response.code).to.eql(202); pm.expect(pm.response.text()).to.eql(''); });`
  ]);
}

export function pingScript(): string {
  return join([
    `pm.test('MCP ping echoes string id and empty result (MCP 2025-06-18 utilities/ping; JSON-RPC 2.0 §4)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('ping', body, 'pm-ping'); pm.expect(body.result).to.be.an('object'); var keys = Object.keys(body.result).filter(function (key) { return key !== '_meta'; }); pm.expect(keys, 'ping result keys other than _meta').to.eql([]); });`
  ]);
}

export function toolsListScript(toolNames: string[]): string {
  return join([
    `var declaredTools = ${json(toolNames)};`,
    `pm.test('MCP tools/list result shape and manifest subset (MCP 2025-06-18 tools/list)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('tools/list', body, 2); pm.expect(body.result).to.be.an('object'); pm.expect(body.result.tools).to.be.an('array'); var live = {}; body.result.tools.forEach(function (tool) { pm.expect(tool.name).to.be.a('string'); pm.expect(tool.inputSchema, 'tool inputSchema').to.be.an('object'); pm.expect(tool.inputSchema.type, 'tool inputSchema.type').to.eql('object'); if (tool.title !== undefined) pm.expect(tool.title).to.be.a('string'); if (tool.description !== undefined) pm.expect(tool.description).to.be.a('string'); pm.expect(live[tool.name], 'tool name unique within page').to.not.eql(true); live[tool.name] = true; }); declaredTools.forEach(function (name) { pm.expect(live[name], 'declared manifest tool is live: ' + name).to.eql(true); }); if (body.result.nextCursor) console.warn('MCP tools/list returned nextCursor; deterministic contract checks only the first page for manifest subset'); var bad = []; mcpWalkMeta(body, '$', bad); pm.expect(bad, 'MCP 2025-06-18 _meta key grammar').to.eql([]); });`
  ]);
}

export function toolsCallScript(index: McpContractIndex, tool: McpToolDescriptor, requestId = 3): McpRuntimeScriptResult {
  const warnings: string[] = [];
  const lines = [
    `var toolName = ${json(tool.name)};`,
    "var body = mcpResponseBody();",
    `pm.test('MCP tools/call returns JSON-RPC result for ${tool.name} (MCP 2025-06-18 tools/call; JSON-RPC 2.0 §5)', function () { mcpAssertResponseObject('tools/call ' + toolName, body, ${requestId}); pm.expect(body.result, 'tools/call result').to.be.an('object'); });`,
    `pm.test('MCP tools/call content blocks are typed for ${tool.name} (MCP 2025-06-18 content blocks)', function () { if (body.result.isError) { pm.expect(body.result.isError).to.be.a('boolean'); console.warn('MCP tools/call returned tool-execution-error for ' + toolName + '; protocol envelope passed and content checks are skipped'); return; } if (body.result.isError !== undefined) pm.expect(body.result.isError).to.be.a('boolean'); pm.expect(body.result.content).to.be.an('array'); body.result.content.forEach(function (block) { pm.expect(block).to.be.an('object'); pm.expect(block.type).to.be.a('string'); if (block.type === 'text') pm.expect(block.text).to.be.a('string'); else if (block.type === 'image' || block.type === 'audio') { pm.expect(block.data).to.match(/^[A-Za-z0-9+/]+={0,2}$/); pm.expect(block.mimeType).to.be.a('string'); } else if (block.type === 'resource_link') { pm.expect(block.uri).to.be.a('string'); pm.expect(block.name).to.be.a('string'); } else if (block.type === 'resource') { pm.expect(block.resource).to.be.an('object'); pm.expect(block.resource.uri).to.be.a('string'); var hasText = typeof block.resource.text === 'string'; var hasBlob = typeof block.resource.blob === 'string'; pm.expect(hasText || hasBlob, 'resource has text or blob').to.eql(true); if (hasText && hasBlob) console.warn('MCP resource content block carries both text and blob for ' + toolName); } }); });`
  ];
  if (tool.outputSchema) {
    try {
      const packed = packSchema(index.documentJson, tool.outputSchema, '3.0', 'response');
      if (packed.unsupported) {
        warnings.push(`${isSchemaGraphOverflow(packed) ? 'MCP_SCHEMA_NOT_COMPILED' : 'MCP_TOOL_OUTPUT_SCHEMA_NOT_VALIDATED'}: tool ${tool.name} outputSchema runtime validator was not emitted (${packed.unsupported})`);
      } else {
        lines.push(`var validateStructuredContent = ${compileSchemaValidatorCode(packed.schema)};`);
        lines.push(`pm.test('MCP tools/call structuredContent matches outputSchema for ${tool.name} (MCP 2025-06-18 structured content)', function () { if (body.result.isError) return; if (body.result.structuredContent === undefined) { console.warn('MCP tools/call for ${tool.name} omitted structuredContent despite outputSchema; this is a SHOULD-level contract'); return; } pm.expect(validateStructuredContent(body.result.structuredContent), 'structuredContent validates against outputSchema').to.eql(true); var encoded = JSON.stringify(body.result.structuredContent); var hasTextJson = (body.result.content || []).some(function (block) { if (!block || block.type !== 'text' || typeof block.text !== 'string') return false; try { return JSON.stringify(JSON.parse(block.text)) === encoded; } catch { return false; } }); if (!hasTextJson) console.warn('MCP tools/call structuredContent was not mirrored by a JSON-deep-equal text content block for ${tool.name}; this is a SHOULD-level contract'); });`);
      }
    } catch (error) {
      warnings.push(`MCP_TOOL_OUTPUT_SCHEMA_NOT_VALIDATED: tool ${tool.name} outputSchema runtime validator could not be compiled (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`);
    }
  }
  return { script: join(lines), warnings };
}

export function badVersionScript(): string {
  return join([
    `pm.test('MCP rejects unsupported MCP-Protocol-Version with HTTP 400 (MCP 2025-06-18 protocol-version-header MUST)', function () { pm.expect(pm.response.code).to.eql(400); });`
  ]);
}

export function invalidCursorScript(): string {
  return join([
    `pm.test('MCP tools/list invalid cursor returns JSON-RPC error (MCP 2025-06-18 pagination SHOULD; JSON-RPC 2.0 §5.1)', function () { var body = mcpResponseBody(); if (body && body.result && Array.isArray(body.result.tools)) pm.expect.fail('MCP tools/list invalid cursor returned a successful tools page'); mcpAssertErrorShape('tools/list invalid cursor', body, 4); if (body.error.code !== -32602) console.warn('MCP tools/list invalid cursor error.code should be -32602 but was ' + body.error.code); });`
  ]);
}

export function terminateScript(): string {
  return join([
    `pm.test('MCP session DELETE terminates or is not supported (MCP 2025-06-18 session termination)', function () { pm.collectionVariables.set('mcp_delete_status', String(pm.response.code)); if (pm.response.code === 405) return; pm.expect(pm.response.code).to.be.within(200, 299); });`
  ]);
}

export function oldSessionPingScript(): string {
  return join([
    `pm.test('MCP old session id is rejected after DELETE (MCP 2025-06-18 session termination MUST)', function () { if (pm.collectionVariables.get('mcp_delete_status') === '405') return; pm.expect(pm.response.code).to.eql(404); });`
  ]);
}
