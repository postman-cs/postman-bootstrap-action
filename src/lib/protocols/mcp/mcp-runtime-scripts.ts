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
    var payloads = mcpSseJsonPayloads('MCP SSE response');
    var terminal; var terminalIndex = -1; var responseCount = 0;
    payloads.forEach(function (message, i) {
      pm.expect(message, 'SSE JSON-RPC payload ' + i).to.be.an('object').and.not.an('array');
      if (message.jsonrpc !== undefined) pm.expect(message.jsonrpc, 'SSE JSON-RPC version at payload ' + i).to.eql('2.0');
      var isResponse = message.id !== undefined && message.method === undefined && (message.result !== undefined || message.error !== undefined);
      if (isResponse) { terminal = message; terminalIndex = i; responseCount += 1; }
    });
    pm.expect(responseCount, 'exactly one terminal JSON-RPC response per POST stream (MCP 2025-06-18 transports)').to.eql(1);
    payloads.forEach(function (_message, i) {
      if (terminalIndex !== -1 && i > terminalIndex) pm.expect.fail('SSE POST stream must not continue after the terminal JSON-RPC response (MCP 2025-06-18 transports)');
    });
    return terminal;
  }
  return JSON.parse(raw);
}
function mcpSseFrames() {
  var raw = pm.response.text();
  if (!raw) return [];
  var frames = [];
  raw.split(/\\r?\\n\\r?\\n/).forEach(function (chunk) {
    if (!chunk.trim()) return;
    var data = [];
    var out = { event: 'message', data: '' };
    chunk.split(/\\r?\\n/).forEach(function (line) {
      if (!line || line.charAt(0) === ':') return;
      var match = /^([^:]*)(?:: ?(.*))?$/.exec(line);
      if (!match) return;
      var field = match[1];
      var value = match[2] === undefined ? '' : match[2];
      if (field === 'event') out.event = value || 'message';
      else if (field === 'id') out.id = value;
      else if (field === 'retry') out.retry = value;
      else if (field === 'data') data.push(value);
    });
    out.data = data.join('\\n');
    if (out.data) out.json = JSON.parse(out.data);
    frames.push(out);
  });
  return frames;
}
function mcpAssertSseEventIdsUnique(frames, label) {
  var seen = {};
  frames.forEach(function (frame, i) {
    if (frame.id === undefined || frame.id === '') return;
    pm.expect(seen[frame.id], label + ' duplicate SSE event id at frame ' + i + ': ' + frame.id).to.not.eql(true);
    seen[frame.id] = true;
  });
}
function mcpSseJsonPayloads(label) {
  var frames = mcpSseFrames();
  mcpAssertSseEventIdsUnique(frames, label);
  return frames.filter(function (frame) { return Object.prototype.hasOwnProperty.call(frame, 'json'); }).map(function (frame) { return frame.json; });
}
function mcpResponseMessages(label) {
  var contentType = pm.response.headers.get('Content-Type') || '';
  if (/text\\/event-stream/i.test(contentType)) return mcpSseJsonPayloads(label);
  var body = mcpResponseBody();
  return Array.isArray(body) ? body : [body];
}
function mcpIdlessPostErrorBody(label) {
  var raw = pm.response.text();
  if (!raw) return undefined;
  var contentType = pm.response.headers.get('Content-Type') || '';
  if (/text\\/event-stream/i.test(contentType)) {
    var payloads = mcpSseJsonPayloads(label);
    pm.expect(payloads.length, label + ' rejection stream contains exactly one JSON-RPC error payload').to.eql(1);
    return payloads[0];
  }
  return JSON.parse(raw);
}
function mcpAssertPreInitializedSseMessages() {
  var contentType = pm.response.headers.get('Content-Type') || '';
  if (!/text\\/event-stream/i.test(contentType)) return;
  var payloads = mcpSseJsonPayloads('MCP initialize SSE pre-initialized messages');
  var terminalIndex = -1;
  payloads.forEach(function (message, i) {
    var isResponse = message && message.id !== undefined && message.method === undefined && (message.result !== undefined || message.error !== undefined);
    if (isResponse && terminalIndex === -1) terminalIndex = i;
  });
  var known = { 'notifications/message': true, 'notifications/progress': true, 'notifications/resources/list_changed': true, 'notifications/tools/list_changed': true, 'notifications/prompts/list_changed': true, 'notifications/logging/message': true };
  payloads.forEach(function (message, i) {
    if (terminalIndex !== -1 && i >= terminalIndex) return;
    pm.expect(message, 'pre-initialized SSE payload ' + i).to.be.an('object').and.not.an('array');
    if (message.method === undefined || message.id !== undefined || !/^notifications\\//.test(String(message.method))) {
      pm.expect.fail('pre-initialized server messages must be id-less notifications before initialized; frame ' + i + ' was ' + JSON.stringify(message));
    }
    if (!known[message.method]) console.warn('MCP initialize received an uncommon pre-initialized notification method: ' + message.method);
  });
}
function mcpAssertErrorShape(message, body, expectedId) {
  pm.expect(body, message + ' body is object').to.be.an('object').and.not.an('array');
  pm.expect(body.jsonrpc, message + ' JSON-RPC 2.0 §4/§5').to.eql('2.0');
  mcpAssertMetaKeys(body, message);
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
  mcpAssertMetaKeys(body, message);
  pm.expect(body.id, message + ' MCP forbids null ids in responses to id-bearing requests').to.not.eql(null);
  pm.expect(body.id, message + ' id echoes request').to.eql(expectedId);
  if (body.error) mcpAssertErrorShape(message, body, expectedId);
}
function mcpMetaKeyOk(key) {
  var name = '[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?';
  var prefix = '(?:' + name + '\\\\.)*' + name + '\\\\/';
  return new RegExp('^(?:' + prefix + ')?' + name + '$').test(key);
}
function mcpMetaKeyReserved(key) {
  return new RegExp('^(?:.*\\\\.)?(?:modelcontextprotocol|mcp)/', 'i').test(key);
}
function mcpWalkMeta(value, path, bad) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(function (entry, i) { mcpWalkMeta(entry, path + '[' + i + ']', bad); });
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, '_meta')) {
    if (!value._meta || typeof value._meta !== 'object' || Array.isArray(value._meta)) {
      bad.push(path + '._meta');
    } else {
      Object.keys(value._meta).forEach(function (key) {
        if (!mcpMetaKeyOk(key) || mcpMetaKeyReserved(key)) bad.push(path + '._meta.' + key);
      });
    }
  }
  Object.keys(value).forEach(function (key) { mcpWalkMeta(value[key], path + '.' + key, bad); });
}
function mcpAssertMetaKeys(value, label) {
  var bad = [];
  mcpWalkMeta(value, '$', bad);
  pm.expect(bad.length, label + ' _meta key grammar and reserved prefixes').to.eql(0);
}
function mcpStableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(mcpStableJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + mcpStableJson(value[key]); }).join(',') + '}';
  }
  return JSON.stringify(value);
}
function mcpJsonTextMirrorsValue(text, value) {
  try { return mcpStableJson(JSON.parse(text)) === mcpStableJson(value); } catch (e) { return false; }
}
function mcpMimeTypeOk(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\\s*;\\s*[A-Za-z0-9!#$&^_.+-]+=(?:"[^"]*"|[A-Za-z0-9!#$&^_.+-]+))*$/.test(value);
}
function mcpBase64Ok(value) {
  return typeof value === 'string' && value.length > 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
function mcpAbsoluteUriOk(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:[^\\s]*$/.test(value);
}
function mcpAssertAnnotations(value, label) {
  if (value === undefined) return;
  pm.expect(value, label + ' annotations').to.be.an('object').and.not.an('array');
  if (value.audience !== undefined) {
    pm.expect(value.audience, label + ' annotations.audience').to.be.an('array');
    value.audience.forEach(function (entry) { if (entry !== 'user' && entry !== 'assistant') pm.expect.fail(label + ' annotations.audience entries must be user or assistant; got ' + JSON.stringify(entry)); });
  }
  if (value.priority !== undefined && (typeof value.priority !== 'number' || value.priority < 0 || value.priority > 1)) pm.expect.fail(label + ' annotations.priority must be a number from 0 through 1');
  if (value.lastModified !== undefined) pm.expect(value.lastModified, label + ' annotations.lastModified').to.be.a('string');
}
function mcpAssertResourceContents(resource, label) {
  pm.expect(resource, label + ' resource').to.be.an('object').and.not.an('array');
  pm.expect(resource.uri, label + ' resource.uri').to.be.a('string');
  if (!mcpAbsoluteUriOk(resource.uri)) pm.expect.fail(label + ' resource.uri must be an absolute URI (MCP 2025-06-18 Resources); got ' + resource.uri);
  if (resource.mimeType !== undefined && !mcpMimeTypeOk(resource.mimeType)) pm.expect.fail(label + ' resource.mimeType must be a valid media type; got ' + resource.mimeType);
  var hasText = typeof resource.text === 'string';
  var hasBlob = typeof resource.blob === 'string';
  pm.expect(hasText || hasBlob, label + ' resource has text or blob').to.eql(true);
  if (hasBlob && !mcpBase64Ok(resource.blob)) pm.expect.fail(label + ' resource.blob must be strict base64 content');
}
function mcpAssertContentBlock(block, label) {
  pm.expect(block, label + ' content block').to.be.an('object').and.not.an('array');
  pm.expect(block.type, label + ' content block type').to.be.a('string');
  mcpAssertAnnotations(block.annotations, label + ' content block');
  if (block._meta !== undefined) {
    pm.expect(block._meta, label + ' content block _meta').to.be.an('object').and.not.an('array');
    mcpAssertMetaKeys({ _meta: block._meta }, label + ' content block');
  }
  if (block.type === 'text') {
    pm.expect(block.text, label + ' text').to.be.a('string');
  } else if (block.type === 'image' || block.type === 'audio') {
    pm.expect(block.data, label + ' data').to.be.a('string');
    if (!mcpBase64Ok(block.data)) pm.expect.fail(label + ' ' + block.type + ' data must be strict base64 content');
    if (!mcpMimeTypeOk(block.mimeType)) pm.expect.fail(label + ' ' + block.type + ' mimeType must be a valid media type; got ' + block.mimeType);
  } else if (block.type === 'resource_link') {
    pm.expect(block.uri, label + ' resource_link.uri').to.be.a('string');
    if (!mcpAbsoluteUriOk(block.uri)) pm.expect.fail(label + ' resource_link.uri must be an absolute URI; got ' + block.uri);
    pm.expect(block.name, label + ' resource_link.name').to.be.a('string');
    if (block.title !== undefined) pm.expect(block.title, label + ' resource_link.title').to.be.a('string');
    if (block.description !== undefined) pm.expect(block.description, label + ' resource_link.description').to.be.a('string');
    if (block.mimeType !== undefined && !mcpMimeTypeOk(block.mimeType)) pm.expect.fail(label + ' resource_link.mimeType must be a valid media type; got ' + block.mimeType);
  } else if (block.type === 'resource') {
    mcpAssertResourceContents(block.resource, label + ' embedded');
  } else {
    pm.expect.fail(label + ' content block type "' + block.type + '" is not a known MCP 2025-06-18 content discriminator');
  }
}
function mcpReadJsonVar(name, fallback) {
  var raw = pm.collectionVariables.get(name);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}
function mcpWriteJsonVar(name, value) {
  pm.collectionVariables.set(name, JSON.stringify(value));
}
function mcpAssertToolDescriptor(tool, label) {
  var toolAnnotationBooleanHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];
  pm.expect(tool.name, label + ' name').to.be.a('string');
  pm.expect(tool.inputSchema, label + ' inputSchema').to.be.an('object');
  pm.expect(tool.inputSchema.type, label + ' inputSchema.type').to.eql('object');
  if (tool.title !== undefined) pm.expect(tool.title, label + ' title').to.be.a('string');
  if (tool.description !== undefined) pm.expect(tool.description, label + ' description').to.be.a('string');
  if (tool.annotations !== undefined) {
    pm.expect(tool.annotations, label + ' annotations').to.be.an('object');
    toolAnnotationBooleanHints.forEach(function (hint) { if (tool.annotations[hint] !== undefined) pm.expect(typeof tool.annotations[hint], label + ' annotations.' + hint).to.eql('boolean'); });
    if (tool.annotations.title !== undefined) pm.expect(tool.annotations.title, label + ' annotations.title').to.be.a('string');
  }
  if (tool.outputSchema !== undefined) {
    pm.expect(tool.outputSchema, label + ' outputSchema').to.be.an('object');
    if (tool.outputSchema.type !== undefined) pm.expect(tool.outputSchema.type, label + ' outputSchema.type').to.eql('object');
  }
}
function mcpResetToolPagination(declaredTools) {
  var missing = {};
  declaredTools.forEach(function (name) { missing[name] = true; });
  mcpWriteJsonVar('mcp_seen_tool_names', {});
  mcpWriteJsonVar('mcp_missing_tool_names', missing);
  pm.collectionVariables.set('mcp_cursor_depth', '0');
  pm.collectionVariables.unset('mcp_first_cursor');
}
function mcpRecordToolPage(tools, label) {
  var seen = mcpReadJsonVar('mcp_seen_tool_names', {});
  var missing = mcpReadJsonVar('mcp_missing_tool_names', {});
  var page = {};
  tools.forEach(function (tool, i) {
    mcpAssertToolDescriptor(tool, label + ' tool[' + i + ']');
    pm.expect(page[tool.name], label + ' tool name unique within page').to.not.eql(true);
    pm.expect(seen[tool.name], label + ' tool name unique across paginated tools/list responses').to.not.eql(true);
    page[tool.name] = true;
    seen[tool.name] = true;
    if (Object.prototype.hasOwnProperty.call(missing, tool.name)) delete missing[tool.name];
  });
  mcpWriteJsonVar('mcp_seen_tool_names', seen);
  mcpWriteJsonVar('mcp_missing_tool_names', missing);
}
function mcpAssertToolPaginationComplete(label) {
  var missing = Object.keys(mcpReadJsonVar('mcp_missing_tool_names', {}));
  pm.expect(missing.length, label + ' declared manifest tools seen across paginated tools/list responses: ' + missing.join(', ')).to.eql(0);
}
function mcpSaveToolNextCursor(cursor, label) {
  if (cursor !== undefined) {
    pm.expect(cursor, label + ' nextCursor').to.be.a('string');
    if (!pm.collectionVariables.get('mcp_first_cursor')) pm.collectionVariables.set('mcp_first_cursor', cursor);
    pm.collectionVariables.set('mcp_next_cursor', cursor);
  } else {
    pm.collectionVariables.unset('mcp_next_cursor');
    mcpAssertToolPaginationComplete(label);
  }
}
function mcpSaveSessionAndCapabilities(body) {
  var session = pm.response.headers.get('Mcp-Session-Id');
  if (session) pm.collectionVariables.set('mcp_session_id', session);
  if (body && body.result && typeof body.result.protocolVersion === 'string') pm.collectionVariables.set('mcp_protocol_version', body.result.protocolVersion);
  if (body && body.result && body.result.capabilities) pm.collectionVariables.set('mcp_capabilities', JSON.stringify(body.result.capabilities));
}
function mcpAssertPostMediaType(label) {
  var mediaType = String(pm.response.headers.get('Content-Type') || '');
  if (!mediaType) return;
  var media = mediaType.split(';')[0].trim().toLowerCase();
  if (media !== 'application/json' && media !== 'text/event-stream') pm.expect.fail(label + ' response Content-Type must be application/json or text/event-stream (MCP 2025-06-18 Transports sec. 2.1); got ' + mediaType);
  var charsetMatch = /;\\s*charset\\s*=\\s*"?([^";]+)"?/i.exec(mediaType);
  if (charsetMatch && charsetMatch[1].trim().toLowerCase() !== 'utf-8') pm.expect.fail(label + ' response charset must be utf-8 when declared (MCP messages are UTF-8 JSON); got ' + charsetMatch[1].trim());
}
function mcpCapabilityDeclared(name) {
  var raw = pm.collectionVariables.get('mcp_capabilities');
  if (!raw) return null;
  try { var caps = JSON.parse(raw); return Object.prototype.hasOwnProperty.call(caps, name); } catch (e) { return null; }
}
function mcpCapabilityFlag(name, flag) {
  var raw = pm.collectionVariables.get('mcp_capabilities');
  if (!raw) return null;
  try {
    var caps = JSON.parse(raw);
    if (!caps || typeof caps !== 'object' || Array.isArray(caps)) return null;
    if (!Object.prototype.hasOwnProperty.call(caps, name)) return false;
    var shape = caps[name];
    if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return false;
    return shape[flag] === true;
  } catch (e) { return null; }
}
function mcpAssertListChangedNotification(message, label, capabilityName) {
  pm.expect(message.jsonrpc, label + ' JSON-RPC version').to.eql('2.0');
  pm.expect(message.method, label + ' method').to.eql('notifications/' + capabilityName + '/list_changed');
  if (message.id !== undefined) pm.expect.fail(label + ' must be an id-less JSON-RPC notification; got id ' + JSON.stringify(message.id));
  if (message.params !== undefined) pm.expect(message.params, label + ' params').to.be.an('object').and.not.an('array');
  mcpAssertMetaKeys(message, label);
  var advertised = mcpCapabilityFlag(capabilityName, 'listChanged');
  if (advertised !== null) pm.expect(advertised, label + ' requires initialize capabilities.' + capabilityName + '.listChanged=true').to.eql(true);
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
    "pm.collectionVariables.unset('mcp_initialize_ok');",
    "pm.collectionVariables.unset('mcp_initialized_ok');",
    "var body;",
    `pm.test('MCP initialize transport is HTTP 2xx (MCP 2025-06-18 Streamable HTTP)', function () { pm.expect(pm.response.code).to.be.within(200, 299); });`,
    `pm.test('MCP initialize Content-Type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { pm.expect(pm.response.headers.get('Content-Type') || '').to.match(/application\\/json|text\\/event-stream/i); mcpAssertPostMediaType('initialize'); });`,
    `pm.test('MCP initialize response is a JSON-RPC object, not a batch (MCP 2025-06-18; JSON-RPC 2.0 §5)', function () { body = mcpResponseBody(); mcpAssertPreInitializedSseMessages(); mcpAssertResponseObject('initialize', body, 1); pm.expect(body.result, 'initialize result').to.be.an('object'); });`,
    `pm.test('MCP initialize negotiates a supported protocolVersion (MCP 2025-06-18 initialize)', function () { pm.expect(body.result.protocolVersion).to.match(/^\\d{4}-\\d{2}-\\d{2}$/); pm.expect(['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].indexOf(body.result.protocolVersion), 'protocolVersion is in the known MCP revision set').to.not.eql(-1); });`,
    `pm.test('MCP initialize capabilities have typed open sub-shapes (MCP 2025-06-18 capabilities)', function () { var caps = body.result.capabilities; pm.expect(caps).to.be.an('object'); ['tools','resources','prompts'].forEach(function (name) { if (caps[name]) Object.keys(caps[name]).filter(function (k) { return /^(listChanged|subscribe)$/.test(k); }).forEach(function (k) { pm.expect(caps[name][k], name + '.' + k).to.be.a('boolean'); }); }); ['logging','completions'].forEach(function (name) { if (caps[name] !== undefined) pm.expect(caps[name], name).to.be.an('object'); }); });`,
    `pm.test('MCP initialize serverInfo and instructions shape (MCP 2025-06-18 initialize)', function () { pm.expect(body.result.serverInfo).to.be.an('object'); pm.expect(body.result.serverInfo.name).to.be.a('string'); pm.expect(body.result.serverInfo.version).to.be.a('string'); if (body.result.instructions !== undefined) pm.expect(body.result.instructions).to.be.a('string'); });`,
    `pm.test('MCP initialize session id header is visible ASCII when present (MCP 2025-06-18 Mcp-Session-Id)', function () { var session = pm.response.headers.get('Mcp-Session-Id'); if (session) pm.expect(session).to.match(/^[\\x21-\\x7E]+$/); });`,
    `pm.test('MCP initialize succeeded before sending initialized notification (MCP 2025-06-18 lifecycle)', function () { pm.expect(pm.response.code).to.be.within(200, 299); body = body || mcpResponseBody(); mcpAssertPreInitializedSseMessages(); mcpAssertResponseObject('initialize', body, 1); pm.expect(body.result, 'initialize result').to.be.an('object'); pm.expect(body.result.protocolVersion).to.match(/^\\d{4}-\\d{2}-\\d{2}$/); pm.expect(['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].indexOf(body.result.protocolVersion), 'protocolVersion is in the known MCP revision set').to.not.eql(-1); pm.expect(body.result.capabilities, 'capabilities').to.be.an('object'); pm.expect(body.result.serverInfo, 'serverInfo').to.be.an('object'); pm.expect(body.result.serverInfo.name, 'serverInfo.name').to.be.a('string'); pm.expect(body.result.serverInfo.version, 'serverInfo.version').to.be.a('string'); mcpSaveSessionAndCapabilities(body); pm.collectionVariables.set('mcp_initialize_ok', 'true'); });`
  ]);
}

export function initializedNotificationScript(): string {
  return join([
    "pm.collectionVariables.unset('mcp_initialized_ok');",
    `pm.test('MCP initialized notification returns HTTP 202 with empty body (MCP 2025-06-18 transports)', function () { pm.expect(pm.response.code).to.eql(202); pm.expect(pm.response.text()).to.eql(''); pm.collectionVariables.set('mcp_initialized_ok', 'true'); });`
  ]);
}

function idlessPostFramingScript(label: string): string {
  return join([
    `var idlessPostLabel = ${json(label)};`,
    "pm.test('MCP ' + idlessPostLabel + ' POST is accepted or rejected without a response id (MCP 2025-06-18 Streamable HTTP; JSON-RPC 2.0 notifications)', function () {",
    '  if (pm.response.code === 202) { pm.expect(pm.response.text()).to.eql(\'\'); return; }',
    "  pm.expect(pm.response.code, idlessPostLabel + ' rejection status').to.be.within(400, 499);",
    '  var body = mcpIdlessPostErrorBody(idlessPostLabel);',
    "  if (body === undefined) return;",
    '  mcpAssertErrorShape(idlessPostLabel, body);',
    "  if (Object.prototype.hasOwnProperty.call(body, 'id')) pm.expect.fail(idlessPostLabel + ' rejection body must not include id for an id-less notification/client response POST; got ' + JSON.stringify(body.id));",
    '});'
  ]);
}

export function notificationPostFramingScript(): string {
  return idlessPostFramingScript('notification/client notification');
}

export function clientResponsePostFramingScript(): string {
  return idlessPostFramingScript('client response');
}

export function pingScript(): string {
  return join([
    `pm.test('MCP ping echoes string id and empty result (MCP 2025-06-18 utilities/ping; JSON-RPC 2.0 §4)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('ping', body, 'pm-ping'); pm.expect(body.result).to.be.an('object'); var keys = Object.keys(body.result).filter(function (key) { return key !== '_meta'; }); pm.expect(keys, 'ping result keys other than _meta').to.eql([]); });`,
    `pm.test('MCP ping response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('ping'); });`
  ]);
}

export function toolsListScript(toolNames: string[]): string {
  return join([
    `var declaredTools = ${json(toolNames)};`,
    `pm.test('MCP tools/list result shape and manifest subset (MCP 2025-06-18 tools/list)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('tools/list', body, 2); pm.expect(body.result).to.be.an('object'); pm.expect(body.result.tools).to.be.an('array'); mcpResetToolPagination(declaredTools); mcpRecordToolPage(body.result.tools, 'tools/list first page'); mcpAssertMetaKeys(body, 'tools/list'); });`,
    `pm.test('MCP tools/list is served only when the tools capability was declared (MCP 2025-06-18 Tools sec. 1; Lifecycle sec. 1.2)', function () { var body = mcpResponseBody(); if (!body || body.error) return; var declared = mcpCapabilityDeclared('tools'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.tools before serving tools/list').to.eql(true); });`,
    `pm.test('MCP tools/list nextCursor is an opaque string, saved verbatim for the pagination probes (MCP 2025-06-18 pagination)', function () { var body = mcpResponseBody(); if (!body || body.error) return; mcpSaveToolNextCursor(body.result.nextCursor, 'tools/list first page'); });`,
    `pm.test('MCP tools/list response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('tools/list'); });`
  ]);
}

export function resourcesListScript(resourceNames: string[]): string {
  return join([
    `var declaredResources = ${json(resourceNames)};`,
    `pm.test('MCP resources/list result shape and manifest subset (MCP 2025-06-18 resources/list)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('resources/list', body, 8); pm.expect(body.result).to.be.an('object'); pm.expect(body.result.resources).to.be.an('array'); var live = {}; body.result.resources.forEach(function (resource) { pm.expect(resource).to.be.an('object'); pm.expect(resource.uri, 'resource uri').to.be.a('string'); if (!mcpAbsoluteUriOk(resource.uri)) pm.expect.fail('resource uri must be absolute; got ' + resource.uri); pm.expect(resource.name, 'resource name').to.be.a('string'); if (resource.title !== undefined) pm.expect(resource.title).to.be.a('string'); if (resource.description !== undefined) pm.expect(resource.description).to.be.a('string'); if (resource.mimeType !== undefined && !mcpMimeTypeOk(resource.mimeType)) pm.expect.fail('resource mimeType must be a valid media type; got ' + resource.mimeType); pm.expect(live[resource.name], 'resource name unique within page').to.not.eql(true); live[resource.name] = true; }); declaredResources.forEach(function (name) { pm.expect(live[name], 'declared manifest resource is live: ' + name).to.eql(true); }); if (body.result.nextCursor !== undefined) pm.expect(body.result.nextCursor, 'resources/list nextCursor').to.be.a('string'); mcpAssertMetaKeys(body, 'resources/list'); });`,
    `pm.test('MCP resources/list is served only when the resources capability was declared (MCP 2025-06-18 Resources sec. 1; Lifecycle sec. 1.2)', function () { var body = mcpResponseBody(); if (!body || body.error) return; var declared = mcpCapabilityDeclared('resources'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.resources before serving resources/list').to.eql(true); });`,
    `pm.test('MCP resources/list response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('resources/list'); });`
  ]);
}

export function readResourceScript(resourceUri: string, requestId = `pm-resource-read:${resourceUri}`): string {
  return join([
    `var expectedResourceUri = ${json(resourceUri)};`,
    `var expectedRequestId = ${json(requestId)};`,
    `pm.test('MCP resources/read result shape for ${resourceUri} (MCP 2025-06-18 resources/read)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('resources/read', body, expectedRequestId); pm.expect(body.result).to.be.an('object'); pm.expect(body.result.contents, 'resources/read contents').to.be.an('array'); pm.expect(body.result.contents.length > 0, 'resources/read returns at least one content entry').to.eql(true); var matched = false; body.result.contents.forEach(function (entry) { pm.expect(entry).to.be.an('object'); pm.expect(entry.uri, 'resource content uri').to.be.a('string'); if (!mcpAbsoluteUriOk(entry.uri)) pm.expect.fail('resource content uri must be absolute; got ' + entry.uri); if (entry.mimeType !== undefined && !mcpMimeTypeOk(entry.mimeType)) pm.expect.fail('resource content mimeType must be a valid media type; got ' + entry.mimeType); var hasText = typeof entry.text === 'string'; var hasBlob = typeof entry.blob === 'string'; pm.expect(hasText || hasBlob, 'resource content has text or blob').to.eql(true); if (hasBlob && !mcpBase64Ok(entry.blob)) pm.expect.fail('resource content blob must be strict base64 content'); if (entry.uri === expectedResourceUri) matched = true; }); pm.expect(matched, 'declared resource URI is present in resources/read contents').to.eql(true); });`,
    `pm.test('MCP resources/read is served only when the resources capability was declared (MCP 2025-06-18 Resources sec. 1; Lifecycle sec. 1.2)', function () { var body = mcpResponseBody(); if (!body || body.error) return; var declared = mcpCapabilityDeclared('resources'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.resources before serving resources/read').to.eql(true); });`,
    `pm.test('MCP resources/read response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('resources/read'); });`
  ]);
}

export function promptsListScript(promptNames: string[]): string {
  return join([
    `var declaredPrompts = ${json(promptNames)};`,
    `pm.test('MCP prompts/list result shape and manifest subset (MCP 2025-06-18 prompts/list)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('prompts/list', body, 9); pm.expect(body.result).to.be.an('object'); pm.expect(body.result.prompts).to.be.an('array'); var live = {}; body.result.prompts.forEach(function (prompt) { pm.expect(prompt).to.be.an('object'); pm.expect(prompt.name, 'prompt name').to.be.a('string'); if (prompt.title !== undefined) pm.expect(prompt.title).to.be.a('string'); if (prompt.description !== undefined) pm.expect(prompt.description).to.be.a('string'); if (prompt.arguments !== undefined) pm.expect(prompt.arguments, 'prompt arguments').to.be.an('array'); pm.expect(live[prompt.name], 'prompt name unique within page').to.not.eql(true); live[prompt.name] = true; }); declaredPrompts.forEach(function (name) { pm.expect(live[name], 'declared manifest prompt is live: ' + name).to.eql(true); }); if (body.result.nextCursor !== undefined) pm.expect(body.result.nextCursor, 'prompts/list nextCursor').to.be.a('string'); mcpAssertMetaKeys(body, 'prompts/list'); });`,
    `pm.test('MCP prompts/list is served only when the prompts capability was declared (MCP 2025-06-18 Prompts sec. 1; Lifecycle sec. 1.2)', function () { var body = mcpResponseBody(); if (!body || body.error) return; var declared = mcpCapabilityDeclared('prompts'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.prompts before serving prompts/list').to.eql(true); });`,
    `pm.test('MCP prompts/list response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('prompts/list'); });`
  ]);
}

export function getPromptScript(promptName: string): string {
  return join([
    `var expectedPromptName = ${json(promptName)};`,
    `pm.test('MCP prompts/get result shape for ${promptName} (MCP 2025-06-18 prompts/get)', function () { var body = mcpResponseBody(); mcpAssertResponseObject('prompts/get', body, 'pm-prompt-get:' + expectedPromptName); pm.expect(body.result).to.be.an('object'); if (body.result.description !== undefined) pm.expect(body.result.description).to.be.a('string'); pm.expect(body.result.messages, 'prompts/get messages').to.be.an('array'); pm.expect(body.result.messages.length > 0, 'prompts/get returns at least one message').to.eql(true); body.result.messages.forEach(function (message, i) { pm.expect(message).to.be.an('object'); pm.expect(message.role, 'prompt message role').to.be.a('string'); mcpAssertContentBlock(message.content, 'prompt ' + expectedPromptName + ' message[' + i + ']'); }); });`,
    `pm.test('MCP prompts/get is served only when the prompts capability was declared (MCP 2025-06-18 Prompts sec. 1; Lifecycle sec. 1.2)', function () { var body = mcpResponseBody(); if (!body || body.error) return; var declared = mcpCapabilityDeclared('prompts'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.prompts before serving prompts/get').to.eql(true); });`,
    `pm.test('MCP prompts/get response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('prompts/get'); });`
  ]);
}

export function toolsCallScript(index: McpContractIndex, tool: McpToolDescriptor, requestId = 3): McpRuntimeScriptResult {
  const warnings: string[] = [];
  const lines = [
    `var toolName = ${json(tool.name)};`,
    `var expectedToolCallRequestId = ${json(requestId)};`,
    `var expectedToolArguments = ${json(tool.sampleArguments ?? {})};`,
    "var body = mcpResponseBody();",
    `pm.test('MCP tools/call request body conforms for ${tool.name} (MCP 2025-06-18 tools/call; JSON-RPC 2.0 §4)', function () { if (!pm.request || !pm.request.body) return; var raw = String(pm.request.body.raw || (typeof pm.request.body.toString === 'function' ? pm.request.body.toString() : '')); pm.expect(raw, 'tools/call request raw body').to.be.a('string'); var request = JSON.parse(raw); pm.expect(request, 'tools/call request').to.be.an('object').and.not.an('array'); pm.expect(request.jsonrpc, 'tools/call request jsonrpc').to.eql('2.0'); pm.expect(request.id, 'tools/call request id').to.eql(expectedToolCallRequestId); pm.expect(request.method, 'tools/call request method').to.eql('tools/call'); pm.expect(request.params, 'tools/call request params').to.be.an('object').and.not.an('array'); pm.expect(request.params.name, 'tools/call request tool name').to.eql(toolName); pm.expect(mcpStableJson(request.params.arguments || {}), 'tools/call request arguments').to.eql(mcpStableJson(expectedToolArguments)); });`,
    `pm.test('MCP tools/call returns JSON-RPC result for ${tool.name} (MCP 2025-06-18 tools/call; JSON-RPC 2.0 §5)', function () { mcpAssertResponseObject('tools/call ' + toolName, body, ${requestId}); pm.expect(body.result, 'tools/call result').to.be.an('object'); });`,
    `pm.test('MCP tools/call structuredContent is object-valued when present for ${tool.name} (MCP 2025-06-18 structured content)', function () { if (!body || !body.result || body.result.structuredContent === undefined) return; pm.expect(body.result.structuredContent, 'structuredContent').to.be.an('object').and.not.an('array'); });`,
    `pm.test('MCP tools/call content blocks are typed for ${tool.name} (MCP 2025-06-18 content blocks)', function () { if (body.result.isError !== undefined) pm.expect(body.result.isError).to.be.a('boolean'); pm.expect(body.result.content, 'tools/call result.content').to.be.an('array'); if (body.result.isError) console.warn('MCP tools/call returned tool-execution-error for ' + toolName + '; validating content block envelope only'); body.result.content.forEach(function (block, i) { mcpAssertContentBlock(block, 'tools/call ' + toolName + ' content[' + i + ']'); }); });`,
    `pm.test('MCP tools/call structuredContent is mirrored by a JSON text content block for ${tool.name} (MCP 2025-06-18 structured content compatibility)', function () { if (!body || !body.result || body.result.isError || body.result.structuredContent === undefined) return; pm.expect(body.result.content, 'tools/call result.content').to.be.an('array'); var mirrored = body.result.content.some(function (block) { return block && block.type === 'text' && typeof block.text === 'string' && mcpJsonTextMirrorsValue(block.text, body.result.structuredContent); }); pm.expect(mirrored, 'structuredContent must be mirrored by a JSON text content block for backwards-compatible clients').to.eql(true); });`,
    `pm.test('MCP tools/call is served only when the tools capability was declared for ${tool.name} (MCP 2025-06-18 Tools sec. 1; Lifecycle sec. 1.2)', function () { if (!body || body.error) return; var declared = mcpCapabilityDeclared('tools'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.tools before serving tools/call').to.eql(true); });`,
    `pm.test('MCP tools/call response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('tools/call'); });`
  ];
  if (tool.outputSchema) {
    try {
      const packed = packSchema(index.documentJson, tool.outputSchema, '3.0', 'response');
      if (packed.unsupported) {
        warnings.push(`${isSchemaGraphOverflow(packed) ? 'MCP_SCHEMA_NOT_COMPILED' : 'MCP_TOOL_OUTPUT_SCHEMA_NOT_VALIDATED'}: tool ${tool.name} outputSchema runtime validator was not emitted (${packed.unsupported})`);
      } else {
        lines.push(`var validateStructuredContent = ${compileSchemaValidatorCode(packed.schema)};`);
        lines.push(`pm.test('MCP tools/call structuredContent is required and matches outputSchema for ${tool.name} (MCP 2025-06-18 structured content)', function () { if (body.result.isError) return; pm.expect(body.result.structuredContent, 'structuredContent is required when outputSchema is declared').to.be.an('object').and.not.an('array'); pm.expect(validateStructuredContent(body.result.structuredContent), 'structuredContent validates against outputSchema').to.eql(true); });`);
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

export function resourceTemplatesScript(): string {
  return join([
    `pm.test('MCP resource templates compile under RFC 6570 (MCP 2025-06-18 resources; RFC 6570)', function () {`,
    '  var body = mcpResponseBody();',
    "  if (body && body.error) { mcpAssertErrorShape('resources/templates/list', body, 5); return; }",
    "  mcpAssertResponseObject('resources/templates/list', body, 5);",
    "  pm.expect(body.result, 'resources/templates/list result').to.be.an('object');",
    '  var templates = body.result.resourceTemplates;',
    "  if (body.result.nextCursor !== undefined) pm.expect(body.result.nextCursor, 'resources/templates/list nextCursor').to.be.a('string');",
    "  pm.expect(templates, 'resourceTemplates').to.be.an('array');",
    '  var exprRe = /^\\{[+#./;?&]?[A-Za-z0-9_%.]+(?::[1-9][0-9]{0,3}|\\*)?(?:,[A-Za-z0-9_%.]+(?::[1-9][0-9]{0,3}|\\*)?)*\\}$/;',
    '  templates.forEach(function (template) {',
    "    pm.expect(template, 'resource template entry').to.be.an('object');",
    "    pm.expect(template.name, 'resource template name').to.be.a('string');",
    "    pm.expect(template.uriTemplate, 'resource template uriTemplate').to.be.a('string');",
    '    var s = template.uriTemplate; var open = -1;',
    '    for (var i = 0; i < s.length; i++) {',
    "      var ch = s.charAt(i);",
    "      if (ch === '{') { if (open !== -1) { pm.expect.fail('nested { in URI template ' + s + ' (RFC 6570 syntax)'); return; } open = i; }",
    "      else if (ch === '}') { if (open === -1) { pm.expect.fail('unmatched } in URI template ' + s + ' (RFC 6570 syntax)'); return; } var expr = s.slice(open, i + 1); open = -1; if (!exprRe.test(expr)) { pm.expect.fail('expression ' + expr + ' in URI template ' + s + ' is not valid RFC 6570 (operator, varname list, optional :prefix or * modifier)'); return; } }",
    '    }',
    "    if (open !== -1) pm.expect.fail('unterminated { in URI template ' + s + ' (RFC 6570 syntax)');",
    "    var concreteTemplate = s.replace(/\\{[^{}]+\\}/g, 'x'); if (!mcpAbsoluteUriOk(concreteTemplate)) pm.expect.fail('resource template uriTemplate must be absolute after RFC 6570 expansion; got ' + s);",
    '  });',
    '});',
    `pm.test('MCP resources/templates/list is served only when the resources capability was declared (MCP 2025-06-18 Resources sec. 1; Lifecycle sec. 1.2)', function () { var body = mcpResponseBody(); if (!body || body.error) return; var declared = mcpCapabilityDeclared('resources'); if (declared === null) return; pm.expect(declared, 'initialize declared capabilities.resources before serving resources/templates/list').to.eql(true); });`,
    `pm.test('MCP resources/templates/list response media type is JSON or SSE with a utf-8 charset (MCP 2025-06-18 transports)', function () { mcpAssertPostMediaType('resources/templates/list'); });`
  ]);
}

export function progressToolCallScript(toolName: string, requestId = 'pm-progress-call', progressToken = 'pm-progress'): string {
  return join([
    `var progressToolName = ${json(toolName)};`,
    `var progressRequestId = ${json(requestId)};`,
    `var expectedProgressToken = ${json(progressToken)};`,
    `pm.test('MCP progress notifications echo the token and increase for ' + progressToolName + ' (MCP 2025-06-18 utilities/progress)', function () {`,
    "  var frames = mcpResponseMessages('MCP progress stream');",
    '  var responseIndex = -1; var responseCount = 0;',
    '  frames.forEach(function (frame, i) {',
    "    pm.expect(frame, 'every SSE data payload is a JSON-RPC object (MCP 2025-06-18 transports)').to.be.an('object');",
    "    pm.expect(frame.jsonrpc, 'SSE frame jsonrpc').to.eql('2.0');",
    '    if (frame.method === undefined) {',
    '      responseCount += 1; responseIndex = i;',
    "      pm.expect(frame.id, 'the response id echoes the request id').to.eql(progressRequestId);",
    "    } else if (frame.id !== undefined) { pm.expect.fail('a notification must not carry an id (JSON-RPC 2.0 section 4.1); got ' + frame.method + ' with id ' + JSON.stringify(frame.id)); }",
    '  });',
    "  pm.expect(responseCount, 'exactly one JSON-RPC response per POST stream (MCP 2025-06-18 transports)').to.eql(1);",
    '  var lastProgress = -Infinity;',
    '  frames.forEach(function (frame, i) {',
    "    if (frame.method !== 'notifications/progress') return;",
    '    var params = frame.params || {};',
    "    pm.expect(params.progressToken, 'progress notifications must echo the request progressToken (MCP 2025-06-18 utilities/progress)').to.eql(expectedProgressToken);",
    "    pm.expect(typeof params.progress, 'progress must be a number').to.eql('number');",
    "    if (params.total !== undefined) { pm.expect(typeof params.total, 'progress total must be a number when present').to.eql('number'); if (params.total < params.progress) pm.expect.fail('progress total must be greater than or equal to progress; got total ' + params.total + ' and progress ' + params.progress); }",
    "    if (params.message !== undefined) pm.expect(params.message, 'progress message must be a string when present').to.be.a('string');",
    "    if (!(params.progress > lastProgress)) pm.expect.fail('progress values must increase with each notification (MCP 2025-06-18 utilities/progress); got ' + params.progress + ' after ' + lastProgress);",
    '    lastProgress = params.progress;',
    "    if (responseIndex !== -1 && i > responseIndex) pm.expect.fail('progress notifications must stop after the final response (MCP 2025-06-18 utilities/progress)');",
    '  });',
    '});'
  ]);
}

export function getListenScript(): string {
  return join([
    "pm.test('MCP GET listen returns an SSE stream or HTTP 405 (MCP 2025-06-18 Streamable HTTP)', function () {",
    '  if (pm.response.code === 405) return;',
    "  pm.expect(pm.response.code, 'GET listen response code').to.eql(200);",
    "  pm.expect(pm.response.headers.get('Content-Type') || '', 'GET listen Content-Type').to.match(/text\\/event-stream/i);",
    '  var frames = mcpSseFrames();',
    "  mcpAssertSseEventIdsUnique(frames, 'GET listen');",
    '  frames.forEach(function (frame, i) {',
    "    if (frame.retry !== undefined && !/^\\d+$/.test(String(frame.retry))) pm.expect.fail('GET listen retry must be decimal milliseconds at frame ' + i);",
    "    if (!Object.prototype.hasOwnProperty.call(frame, 'json')) return;",
    '    var message = frame.json;',
    "    pm.expect(message, 'GET listen JSON-RPC frame ' + i).to.be.an('object').and.not.an('array');",
    "    if (message.jsonrpc !== undefined) pm.expect(message.jsonrpc, 'GET listen JSON-RPC version at frame ' + i).to.eql('2.0');",
    "    var isResponse = message.id !== undefined && message.method === undefined && (message.result !== undefined || message.error !== undefined);",
    "    if (isResponse) pm.expect.fail('GET listen non-resumable stream must not carry JSON-RPC responses; frame ' + i + ' had id ' + JSON.stringify(message.id));",
    "    if (message.method === 'notifications/tools/list_changed') mcpAssertListChangedNotification(message, 'GET listen tools/list_changed frame ' + i, 'tools');",
    "    if (message.method === 'notifications/prompts/list_changed') mcpAssertListChangedNotification(message, 'GET listen prompts/list_changed frame ' + i, 'prompts');",
    '  });',
    '});'
  ]);
}

export function unauthenticatedInitializeScript(): string {
  return join([
    `pm.test('MCP unauthenticated requests are rejected with 401 + WWW-Authenticate (MCP authorization; RFC 9728 section 5.1)', function () {`,
    "  pm.expect(pm.response.code, 'a request without Authorization must yield HTTP 401').to.eql(401);",
    "  var challenge = pm.response.headers.get('WWW-Authenticate') || '';",
    "  if (!challenge) { pm.expect.fail('401 responses must carry a WWW-Authenticate challenge (MCP authorization spec; RFC 9110 section 15.5.2)'); return; }",
    "  if (!/resource_metadata=/.test(challenge)) pm.expect.fail('the WWW-Authenticate challenge must advertise resource_metadata so clients can discover the authorization server (MCP authorization spec; RFC 9728 section 5.1); got: ' + challenge);",
    '});'
  ]);
}

export function bogusBearerScript(): string {
  return join([
    `pm.test('MCP rejects an invalid bearer token with HTTP 401 (MCP authorization; RFC 6750 section 3.1)', function () {`,
    "  pm.expect(pm.response.code, 'an invalid access token must yield HTTP 401').to.eql(401);",
    '});'
  ]);
}

export function protectedResourceMetadataScript(): string {
  return join([
    `pm.test('MCP protected resource metadata lists authorization servers (MCP authorization; RFC 9728 sections 2-3)', function () {`,
    "  pm.expect(pm.response.code, 'the protected-resource well-known document must be served (RFC 9728 section 3)').to.eql(200);",
    '  var doc;',
    "  try { doc = pm.response.json(); } catch (e) { pm.expect.fail('protected resource metadata must be a JSON document (RFC 9728 section 3.2)'); return; }",
    "  pm.expect(doc, 'PRM document').to.be.an('object');",
    "  pm.expect(doc.resource, 'PRM resource member (RFC 9728 section 2)').to.be.a('string');",
    "  pm.expect(doc.authorization_servers, 'authorization_servers must be a non-empty list (MCP authorization spec; RFC 9728 section 2)').to.be.an('array').and.to.have.length.above(0);",
    '});'
  ]);
}

// A request deliberately sent WITHOUT Mcp-Session-Id after initialize: servers
// that require the session id SHOULD reject it with HTTP 400 (MCP 2025-06-18
// Transports sec. 2.5 Session Management); servers that never issued one make
// the probe vacuous.
export function sessionRequiredScript(): string {
  return join([
    `pm.test('MCP requests without Mcp-Session-Id succeed or fail with HTTP 400 (MCP 2025-06-18 session management)', function () {`,
    "  if (!pm.collectionVariables.get('mcp_session_id')) return;",
    "  if (pm.response.code >= 200 && pm.response.code < 300) { console.warn('MCP server accepted a session-less request after issuing Mcp-Session-Id; the session id is advisory for this server'); return; }",
    "  pm.expect(pm.response.code, 'servers that require a session id respond 400 Bad Request to requests without one (MCP 2025-06-18 Transports sec. 2.5)').to.eql(400);",
    '});'
  ]);
}

function prerequestGuard(variableName: string, message: string): string {
  return `if (pm.collectionVariables.get('${variableName}') !== 'true' && pm.execution && typeof pm.execution.skipRequest === 'function') { console.log('${message}'); pm.execution.skipRequest(); }`;
}

export function initializeSucceededPrerequest(): string {
  return prerequestGuard('mcp_initialize_ok', 'MCP initialize did not complete successfully; skipping initialized notification');
}

export function initializedGuardPrerequest(): string {
  return prerequestGuard('mcp_initialized_ok', 'MCP initialized notification did not complete successfully; skipping post-initialize request');
}

// Pre-request guard shared by the pagination probes: without a completed
// lifecycle and saved nextCursor there is nothing deterministic to follow.
export function cursorProbePrerequest(variableName = 'mcp_next_cursor'): string {
  return [
    initializedGuardPrerequest(),
    `if (!pm.collectionVariables.get('${variableName}') && pm.execution && typeof pm.execution.skipRequest === 'function') { console.log('MCP tools/list returned no saved cursor; skipping the pagination probe'); pm.execution.skipRequest(); }`
  ].join('\n');
}

export function nextCursorScript(pageNumber = 1, requestId: string | number = `pm-tools-list-page:${pageNumber}`, maxPages = 5): string {
  return join([
    `pm.test('MCP tools/list follows nextCursor byte-for-byte to page ${pageNumber} and accumulates until termination (MCP 2025-06-18 pagination)', function () {`,
    "  if (!pm.collectionVariables.get('mcp_next_cursor')) return;",
    "  var previousCursor = pm.collectionVariables.get('mcp_next_cursor');",
    '  var body = mcpResponseBody();',
    `  if (body && body.error) { mcpAssertErrorShape('tools/list page ${pageNumber}', body, ${json(requestId)}); pm.expect.fail('a cursor copied verbatim from the previous nextCursor must be accepted (MCP 2025-06-18 pagination); got error ' + body.error.code); return; }`,
    `  mcpAssertResponseObject('tools/list page ${pageNumber}', body, ${json(requestId)});`,
    "  pm.expect(body.result, 'next page result').to.be.an('object');",
    "  pm.expect(body.result.tools, 'next page tools').to.be.an('array');",
    `  mcpRecordToolPage(body.result.tools, 'tools/list page ${pageNumber}');`,
    "  var depth = Number(pm.collectionVariables.get('mcp_cursor_depth') || '0') + 1;",
    "  pm.collectionVariables.set('mcp_cursor_depth', String(depth));",
    "  if (body.result.nextCursor !== undefined && body.result.nextCursor === previousCursor) pm.expect.fail('tools/list nextCursor must advance between pages');",
    `  mcpSaveToolNextCursor(body.result.nextCursor, 'tools/list page ${pageNumber}');`,
    `  if (pm.collectionVariables.get('mcp_next_cursor') && depth >= ${maxPages}) pm.expect.fail('tools/list pagination did not terminate within ${maxPages} cursor pages');`,
    '});'
  ]);
}

export function cursorReplayScript(requestId: string | number = 'pm-tools-list-cursor-replay'): string {
  return join([
    `pm.test('MCP tools/list cursor replay serves a page or fails as invalid params (MCP 2025-06-18 pagination; JSON-RPC 2.0 sec. 5.1)', function () {`,
    "  if (!pm.collectionVariables.get('mcp_first_cursor')) return;",
    '  var body = mcpResponseBody();',
    `  if (body && body.error) { mcpAssertErrorShape('tools/list cursor replay', body, ${json(requestId)}); if (body.error.code !== -32602) pm.expect.fail('a replayed cursor must either serve a page or fail as invalid params (-32602); got error ' + body.error.code); console.warn('MCP server treats cursors as single-use; the replay was rejected with -32602'); return; }`,
    `  mcpAssertResponseObject('tools/list cursor replay', body, ${json(requestId)});`,
    "  pm.expect(body.result.tools, 'replayed page tools').to.be.an('array');",
    '});'
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
