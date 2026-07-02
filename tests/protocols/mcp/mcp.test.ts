import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    // 2 servers x (initialize + tools/list + 2 tools/call) = 8 items.
    expect(items).toHaveLength(8);
    for (const item of items) {
      expect(item.type).toBe('mcp-request');
      expect(ecIssues(item)).toBeFalsy();
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
    (collection.item as JsonRecord[]).pop();
    expect(() => instrumentMcpCollection(collection, index)).toThrow(/MCP_ITEM_COVERAGE_FAILED/);
  });

  it('fails closed on a malformed generated JSON-RPC message', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    ((collection.item as JsonRecord[])[0].payload as JsonRecord).message = '{"jsonrpc":"1.0"}';
    expect(() => instrumentMcpCollection(collection, index)).toThrow(/MCP_MESSAGE_INVALID/);
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

