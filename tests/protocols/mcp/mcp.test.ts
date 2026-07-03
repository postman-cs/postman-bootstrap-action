import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

import { itemsByType } from '@postman/runtime.models/extensible';
import { describe, expect, it } from 'vitest';

import { parseMcpServerSpec } from '../../../src/lib/protocols/mcp/mcp-parser.js';
import { buildMcpCollection } from '../../../src/lib/protocols/mcp/mcp-collection-builder.js';
import { instrumentMcpCollection } from '../../../src/lib/protocols/mcp/mcp-instrumenter.js';
import { detectSpecType } from '../../../src/lib/spec/detect-spec-type.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../../fixtures/mcp');

function read(rel: string): string {
  return readFileSync(resolve(fixtures, rel), 'utf8');
}

type JsonRecord = Record<string, unknown>;

const clientConfig = JSON.stringify({
  mcpServers: {
    weather: {
      command: 'npx',
      args: ['-y', '@example/weather-mcp'],
      env: { API_TOKEN: 'abc123' }
    },
    remoteWeather: {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: '{{MCP_AUTH}}' }
    }
  }
});

// Validate a built EC node against the official runtime.models item schema for
// its type (the binding authority; the published v3.0.0 JSON Schema is 403).
function ecIssues(node: JsonRecord): unknown {
  const registry = itemsByType as Record<string, { validate?: (v: unknown) => { issues?: unknown } } | undefined>;
  const model = registry[String(node.type)];
  if (!model?.validate) return undefined;
  const logical = { type: node.type, title: node.title, payload: node.payload, extensions: node.extensions ?? {} };
  return model.validate(logical)?.issues;
}

describe('mcp detection', () => {
  it('detects the registry server.json and the mcpServers client config as mcp', () => {
    expect(detectSpecType(read('server.json'))).toBe('mcp');
    expect(detectSpecType(clientConfig)).toBe('mcp');
  });

  it('keeps unrelated JSON on the OpenAPI fallback path', () => {
    expect(detectSpecType('{"name":"not-mcp"}')).toBe('openapi');
    expect(detectSpecType('{"openapi":"3.0.3","info":{}}')).toBe('openapi');
  });
});

describe('mcp parser', () => {
  it('parses a registry server.json into remote and package servers with placeholder secrets', () => {
    const index = parseMcpServerSpec(read('server.json'));
    expect(index.title).toBe('io.github.example/weather');
    expect(index.version).toBe('1.2.0');
    expect(index.servers).toHaveLength(2);
    const remote = index.servers.find((s) => s.transport === 'sse')!;
    expect(remote.url).toBe('https://mcp.example.com/mcp');
    // Secret header values are never persisted; they become {{variable}} placeholders.
    expect(remote.headers).toEqual([{ key: 'X-API-Key', value: '{{X-API-Key}}' }]);
    expect(remote.warnings.some((w) => w.startsWith('MCP_STREAMABLE_HTTP_AS_SSE'))).toBe(true);
    const pkg = index.servers.find((s) => s.transport === 'stdio')!;
    expect(pkg.command).toBe('npx @example/weather-mcp');
    expect(pkg.env).toEqual([{ key: 'WEATHER_API_KEY', value: '{{WEATHER_API_KEY}}' }]);
    expect(index.tools.map((t) => t.name)).toEqual(['get_forecast', 'list_stations']);
    // Sample arguments are synthesized from the inputSchema (required + defaults).
    expect(index.tools[0].sampleArguments).toEqual({ city: 'string', days: 3 });
  });

  it('parses an mcpServers client config into stdio and sse servers', () => {
    const index = parseMcpServerSpec(clientConfig);
    expect(index.servers.map((s) => s.id)).toEqual(['remoteWeather', 'weather']);
    const stdio = index.servers.find((s) => s.id === 'weather')!;
    expect(stdio.transport).toBe('stdio');
    expect(stdio.command).toBe('npx -y @example/weather-mcp');
    expect(stdio.env).toEqual([{ key: 'API_TOKEN', value: 'abc123' }]);
    const sse = index.servers.find((s) => s.id === 'remoteWeather')!;
    expect(sse.transport).toBe('sse');
    expect(sse.url).toBe('https://mcp.example.com/sse');
    expect(sse.headers).toEqual([{ key: 'Authorization', value: '{{MCP_AUTH}}' }]);
  });

  it('rejects empty input, invalid JSON, and serverless documents', () => {
    expect(() => parseMcpServerSpec('   ')).toThrow(/MCP_EMPTY_INPUT/);
    expect(() => parseMcpServerSpec('not json')).toThrow(/MCP_PARSE_FAILED/);
    expect(() => parseMcpServerSpec('{"name":"x","remotes":[]}')).toThrow(/MCP_NO_SERVERS/);
  });
});

describe('mcp collection builder', () => {
  it('builds initialize, tools/list, and per-tool tools/call items valid against the EC schema', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const items = collection.item as JsonRecord[];
    // 2 servers x (initialize + tools/list + 2 tools/call) mcp-request templates,
    // plus 1 url-bearing server x (11 fixed HTTP probes + 2 tools/call probes +
    // resources/templates/list + progress tools/call).
    expect(items).toHaveLength(23);
    for (const item of items) {
      if (item.type === 'mcp-request') expect(ecIssues(item)).toBeFalsy();
    }
    const initialize = items.find((i) => String(i.title).endsWith('initialize') && (i.payload as JsonRecord).transport === 'sse')!;
    const initMessage = JSON.parse(String((initialize.payload as JsonRecord).message)) as JsonRecord;
    expect(initMessage.jsonrpc).toBe('2.0');
    expect(initMessage.method).toBe('initialize');
    expect((initMessage.params as JsonRecord).protocolVersion).toBe('2025-06-18');
    const call = items.find((i) => String(i.title).includes('tools/call get_forecast'))!;
    const callMessage = JSON.parse(String((call.payload as JsonRecord).message)) as JsonRecord;
    expect(callMessage.method).toBe('tools/call');
    expect((callMessage.params as JsonRecord).name).toBe('get_forecast');
    expect(((callMessage.params as JsonRecord).arguments as JsonRecord).city).toBe('string');
    const remoteToolCallIds = items
      .filter((i) => i.type === 'mcp-request' && String(i.title).startsWith('io.github.example/weather remote-1 · tools/call'))
      .map((i) => JSON.parse(String((i.payload as JsonRecord).message)).id);
    expect(remoteToolCallIds).toEqual([3, 4]);
    const httpInitialize = items.find((i) => i.type === 'http-request' && String(i.title).endsWith('HTTP initialize'))!;
    expect(httpInitialize.id).toBe('8855b5e4-0000-4000-8000-000000000036');
    const headers = (((httpInitialize.payload as JsonRecord).headers as JsonRecord[]) ?? []).map((h) => h.key);
    expect(headers).toEqual(['Content-Type', 'Accept', 'MCP-Protocol-Version', 'X-API-Key']);
    const script = (((httpInitialize.extensions as JsonRecord).events as JsonRecord[])[0].script as JsonRecord).exec;
    expect(script).toContain('MCP initialize response is a JSON-RPC object, not a batch');
  });

  it('is deterministic across builds', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const a = JSON.stringify(buildMcpCollection(index, { idSeed: 's' }));
    const b = JSON.stringify(buildMcpCollection(index, { idSeed: 's' }));
    expect(a).toBe(b);
  });
});

describe('mcp instrumenter (static validation)', () => {
  it('surfaces transport mapping and validates tool samples with no silent drops', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_STREAMABLE_HTTP_AS_SSE'))).toBe(true);
    // Placeholder-only secrets and self-consistent samples raise nothing.
    expect(warnings.some((w) => w.startsWith('MCP_SECRET_VALUE_PRESENT'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_SAMPLE_MISMATCH'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('MCP_RUNTIME_SURFACE_UNAVAILABLE'))).toBe(true);
  });

  it('flags synthesized arguments that violate the tool inputSchema', () => {
    const index = parseMcpServerSpec(read('server.json'));
    index.tools[0].sampleArguments = { days: 'not-an-integer' };
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_SAMPLE_MISMATCH') && w.includes('get_forecast'))).toBe(true);
  });

  it('flags concrete secret-looking values so credentials are not persisted', () => {
    const index = parseMcpServerSpec(clientConfig);
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_SECRET_VALUE_PRESENT') && w.includes('API_TOKEN'))).toBe(true);
  });

  it('flags duplicate tool names (deduped at parse) and non-object input schemas', () => {
    const doc = JSON.stringify({
      mcpServers: { s: { command: 'run-server' } },
      tools: [
        { name: 'dup', inputSchema: { type: 'object' } },
        { name: 'dup', inputSchema: { type: 'object' } },
        { name: 'scalar_tool', inputSchema: { type: 'string' } }
      ]
    });
    const index = parseMcpServerSpec(doc);
    // Only the first declaration of a duplicated name survives to generation.
    expect(index.tools.map((t) => t.name)).toEqual(['dup', 'scalar_tool']);
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_NAME_DUPLICATE'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_SCHEMA_INVALID') && w.includes('scalar_tool'))).toBe(true);
  });

  it('fails closed when the built collection drops an item', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    collection.item = (collection.item as JsonRecord[]).filter((item, i) => item.type !== 'mcp-request' || i !== 0);
    expect(() => instrumentMcpCollection(collection, index)).toThrow(/MCP_ITEM_COVERAGE_FAILED/);
  });

  it('fails closed when the built runtime HTTP surface drops an item', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    collection.item = (collection.item as JsonRecord[]).filter((item) => item.type !== 'http-request' || !String(item.title).includes('invalid cursor'));
    expect(() => instrumentMcpCollection(collection, index)).toThrow(/MCP_HTTP_ITEM_COVERAGE_FAILED/);
  });

  it('fails closed on a malformed generated JSON-RPC message', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    ((collection.item as JsonRecord[])[0].payload as JsonRecord).message = '{"jsonrpc":"1.0"}';
    expect(() => instrumentMcpCollection(collection, index)).toThrow(/MCP_MESSAGE_INVALID/);
  });

  it('fails closed when a generated request uses array params or a fractional id', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const arrayParamsCollection = buildMcpCollection(index, { idSeed: 'test' });
    ((arrayParamsCollection.item as JsonRecord[])[1].payload as JsonRecord).message = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":[]}';
    expect(() => instrumentMcpCollection(arrayParamsCollection, index)).toThrow(/MCP_MESSAGE_INVALID/);

    const fractionalIdCollection = buildMcpCollection(index, { idSeed: 'test' });
    ((fractionalIdCollection.item as JsonRecord[])[1].payload as JsonRecord).message = '{"jsonrpc":"2.0","id":2.5,"method":"tools/list","params":{}}';
    expect(() => instrumentMcpCollection(fractionalIdCollection, index)).toThrow(/MCP_MESSAGE_INVALID/);
  });

  it('fails closed when one server reuses a JSON-RPC request id across mcp-request items', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const duplicateTarget = (collection.item as JsonRecord[]).find(
      (item) => item.type === 'mcp-request' && String(item.title) === 'io.github.example/weather remote-1 · tools/call list_stations'
    )!;
    ((duplicateTarget.payload as JsonRecord).message as string) = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_stations","arguments":{}}}';
    expect(() => instrumentMcpCollection(collection, index)).toThrow(/MCP_REQUEST_ID_DUPLICATE/);
  });
});

describe('mcp runtime HTTP scripts', () => {
  it('adds session-requirement and pagination probes with their runtime gates', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const httpItems = (collection.item as JsonRecord[]).filter((item) => item.type === 'http-request');

    const noSession = httpItems.find((item) => String(item.title).endsWith('ping without session id'))!;
    const noSessionHeaders = (((noSession.payload as JsonRecord).headers as JsonRecord[]) ?? []).map((h) => h.key);
    expect(noSessionHeaders).not.toContain('Mcp-Session-Id');
    const noSessionScript = String(((((noSession.extensions as JsonRecord).events as JsonRecord[])[0]).script as JsonRecord).exec);
    expect(noSessionScript).toContain('respond 400 Bad Request');

    const nextPage = httpItems.find((item) => String(item.title).endsWith('tools/list next page'))!;
    const nextPageEvents = (nextPage.extensions as JsonRecord).events as JsonRecord[];
    expect(nextPageEvents[0].listen).toBe('beforeRequest');
    expect(String((nextPageEvents[0].script as JsonRecord).exec)).toContain('skipRequest');
    const nextPageBody = JSON.parse(String(((nextPage.payload as JsonRecord).body as JsonRecord).content)) as JsonRecord;
    expect((nextPageBody.params as JsonRecord).cursor).toBe('{{mcp_next_cursor}}');
    expect(String((nextPageEvents[1].script as JsonRecord).exec)).toContain('byte-for-byte');

    const replay = httpItems.find((item) => String(item.title).endsWith('tools/list cursor replay'))!;
    expect(String(((((replay.extensions as JsonRecord).events as JsonRecord[])[1]).script as JsonRecord).exec)).toContain('-32602');

    const toolsList = httpItems.find((item) => String(item.title).endsWith('\u00b7 HTTP tools/list'))!;
    const toolsListScriptText = String(((((toolsList.extensions as JsonRecord).events as JsonRecord[])[0]).script as JsonRecord).exec);
    expect(toolsListScriptText).toContain('mcp_next_cursor');
    expect(toolsListScriptText).toContain('capabilities.tools');
    expect(toolsListScriptText).toContain('mcpAssertPostMediaType');
  });

  it('emits deterministic HTTP runtime assertions with expected gates', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const items = collection.item as JsonRecord[];
    const httpItems = items.filter((item) => item.type === 'http-request');
    expect(httpItems.map((item) => item.title)).toEqual([
      'io.github.example/weather remote-1 · HTTP initialize',
      'io.github.example/weather remote-1 · HTTP notifications/initialized',
      'io.github.example/weather remote-1 · HTTP ping',
      'io.github.example/weather remote-1 · HTTP tools/list',
      'io.github.example/weather remote-1 · HTTP ping without session id',
      'io.github.example/weather remote-1 · HTTP tools/list next page',
      'io.github.example/weather remote-1 · HTTP tools/list cursor replay',
      'io.github.example/weather remote-1 · HTTP tools/call get_forecast',
      'io.github.example/weather remote-1 · HTTP tools/call list_stations',
      'io.github.example/weather remote-1 · HTTP resources/templates/list',
      'io.github.example/weather remote-1 · HTTP tools/call get_forecast with progressToken',
      'io.github.example/weather remote-1 · HTTP negative bad protocol version',
      'io.github.example/weather remote-1 · HTTP tools/list invalid cursor',
      'io.github.example/weather remote-1 · HTTP session DELETE',
      'io.github.example/weather remote-1 · HTTP old session ping'
    ]);
    const ping = httpItems.find((item) => String(item.title).endsWith('HTTP ping'))!;
    const pingHeaders = ((ping.payload as JsonRecord).headers as JsonRecord[]).map((h) => h.key);
    expect(pingHeaders).toContain('Mcp-Session-Id');
    const pingScript = (((ping.extensions as JsonRecord).events as JsonRecord[])[0].script as JsonRecord).exec;
    expect(pingScript).toContain('MCP ping echoes string id and empty result');
    const badVersion = httpItems.find((item) => String(item.title).includes('bad protocol version'))!;
    expect(((badVersion.payload as JsonRecord).headers as JsonRecord[]).find((h) => h.key === 'MCP-Protocol-Version')?.value).toBe('1999-01-01');
  });

  it('self-conforms generated runtime messages and headers', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const httpItems = (collection.item as JsonRecord[]).filter((item) => item.type === 'http-request');
    const messageIds: unknown[] = [];
    for (const item of httpItems) {
      const payload = item.payload as JsonRecord;
      const headers = (payload.headers as JsonRecord[]) ?? [];
      expect(String(payload.url)).not.toMatch(/[?&]Authorization=/i);
      expect(headers.some((header) => header.key === 'Accept')).toBe(true);
      if (!String(item.title).includes('initialize')) {
        expect(headers.some((header) => header.key === 'MCP-Protocol-Version')).toBe(true);
      }
      if (payload.body) {
        const parsed = JSON.parse(String((payload.body as JsonRecord).content)) as JsonRecord;
        if (parsed.id !== undefined) {
          expect(parsed.id).not.toBeNull();
          messageIds.push(parsed.id);
        }
      }
    }
    expect(new Set(messageIds).size).toBe(messageIds.length);
  });

  it('emits RFC 6570 template and progress-token probes with expected payloads', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const httpItems = (collection.item as JsonRecord[]).filter((item) => item.type === 'http-request');
    const templates = httpItems.find((item) => String(item.title).endsWith('HTTP resources/templates/list'))!;
    const templatesMessage = JSON.parse(String(((templates.payload as JsonRecord).body as JsonRecord).content)) as JsonRecord;
    expect(templatesMessage.method).toBe('resources/templates/list');
    const templatesScript = (((templates.extensions as JsonRecord).events as JsonRecord[])[0].script as JsonRecord).exec;
    expect(templatesScript).toContain('RFC 6570');
    const progress = httpItems.find((item) => String(item.title).includes('with progressToken'))!;
    const progressMessage = JSON.parse(String(((progress.payload as JsonRecord).body as JsonRecord).content)) as JsonRecord;
    expect(progressMessage.id).toBe('pm-progress-call');
    expect(((progressMessage.params as JsonRecord)._meta as JsonRecord).progressToken).toBe('pm-progress');
    const progressScript = (((progress.extensions as JsonRecord).events as JsonRecord[])[0].script as JsonRecord).exec;
    expect(progressScript).toContain('progress notifications echo the token and increase');
  });

  it('emits authorization probes only for servers with a configured Authorization header', () => {
    const withoutAuth = parseMcpServerSpec(read('server.json'));
    const plainTitles = (buildMcpCollection(withoutAuth, { idSeed: 'test' }).item as JsonRecord[]).map((item) => String(item.title));
    expect(plainTitles.some((title) => title.includes('unauthenticated') || title.includes('bearer') || title.includes('protected resource metadata'))).toBe(false);

    const index = parseMcpServerSpec(clientConfig);
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_HTTP_ITEM_COVERAGE_FAILED'))).toBe(false);
    const httpItems = (collection.item as JsonRecord[]).filter((item) => item.type === 'http-request');
    const unauth = httpItems.find((item) => String(item.title).includes('unauthenticated initialize'))!;
    const unauthHeaders = ((unauth.payload as JsonRecord).headers as JsonRecord[]).map((h) => String(h.key).toLowerCase());
    expect(unauthHeaders).not.toContain('authorization');
    const bogus = httpItems.find((item) => String(item.title).includes('invalid bearer token'))!;
    const bogusAuth = ((bogus.payload as JsonRecord).headers as JsonRecord[]).find((h) => String(h.key).toLowerCase() === 'authorization');
    expect(bogusAuth?.value).toBe('Bearer pm-invalid-token');
    const prm = httpItems.find((item) => String(item.title).includes('protected resource metadata'))!;
    expect((prm.payload as JsonRecord).url).toBe('https://mcp.example.com/.well-known/oauth-protected-resource/sse');
    expect((prm.payload as JsonRecord).method).toBe('GET');
    const prmScript = (((prm.extensions as JsonRecord).events as JsonRecord[])[0].script as JsonRecord).exec;
    expect(prmScript).toContain('authorization servers');
  });

  it('emits syntactically valid JavaScript runtime scripts', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const scripts = (collection.item as JsonRecord[])
      .filter((item) => item.type === 'http-request')
      .map((item) => {
        const events = ((item.extensions as JsonRecord).events as JsonRecord[]) ?? [];
        return String((events[0].script as JsonRecord).exec ?? '');
      });
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) {
      expect(() => new Script(`;(async () => {;\n${source}\n;})();`)).not.toThrow();
    }
  });
});

describe('mcp manifest static additions', () => {
  it('flags metadata typing, _meta grammar, reserved prefixes, unknown fields, title precedence, and mime types', () => {
    const doc = JSON.stringify({
      mcpServers: { s: { type: 'sse', url: 'https://mcp.example.com/mcp' } },
      tools: [
        {
          name: 'display',
          title: 'Display',
          description: 42,
          icons: [],
          mimeType: 'not-a-media-type',
          _meta: { 'bad key': true, 'mcp/reserved': true },
          annotations: { title: 'Annotation title' },
          inputSchema: { type: 'object' }
        }
      ]
    });
    const index = parseMcpServerSpec(doc);
    const { warnings } = instrumentMcpCollection(buildMcpCollection(index, { idSeed: 'test' }), index);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_BASE_METADATA_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_META_KEY_INVALID'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_META_KEY_RESERVED_PREFIX'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_FIELD_UNKNOWN_2025_06_18') && w.includes('icons'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_TITLE_PRECEDENCE'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_MIME_TYPE_INVALID'))).toBe(true);
  });
});


describe('mcp tool annotations and outputSchema static checks', () => {
  it('flags mis-typed annotation hints and a non-object outputSchema', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools[0];
    expect(tool).toBeDefined();
    tool.annotations = { readOnlyHint: 'yes', title: 42 };
    tool.outputSchema = { type: 'string' };
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.filter((w) => w.startsWith('MCP_TOOL_ANNOTATION_INVALID'))).toHaveLength(2);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_OUTPUT_SCHEMA_INVALID'))).toBe(true);
  });

  it('accepts boolean hints and a compilable object outputSchema', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools[0];
    tool.annotations = { readOnlyHint: true, title: 'Weather' };
    tool.outputSchema = { type: 'object', properties: { temperature: { type: 'number' } } };
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_TOOL_ANNOTATION_INVALID') || w.startsWith('MCP_TOOL_OUTPUT_SCHEMA'))).toBe(false);
  });
});
