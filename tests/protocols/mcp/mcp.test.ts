import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';

import { itemsByType } from '@postman/runtime.models/extensible';
import { describe, expect, it } from 'vitest';

import { parseMcpServerSpec } from '../../../src/lib/protocols/mcp/mcp-parser.js';
import { buildMcpCollection } from '../../../src/lib/protocols/mcp/mcp-collection-builder.js';
import { instrumentMcpCollection } from '../../../src/lib/protocols/mcp/mcp-instrumenter.js';
import { getPromptScript, initializeScript, nextCursorScript, progressToolCallScript, readResourceScript, resourceTemplatesScript, resourcesListScript, toolsCallScript, toolsListScript } from '../../../src/lib/protocols/mcp/mcp-runtime-scripts.js';
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

const registryPackageWithTransport = JSON.stringify({
  name: 'io.github.example/weather',
  version: '1.2.0',
  packages: [
    {
      registryType: 'npm',
      identifier: '@example/weather-mcp',
      version: '1.2.0',
      runtimeHint: 'npx',
      runtimeArguments: [{ type: 'named', name: '-y' }],
      packageArguments: [
        { type: 'named', name: '--port', value: '9090' },
        { type: 'positional', valueHint: 'tenant' }
      ],
      environmentVariables: [{ name: 'WEATHER_API_KEY', isSecret: true }],
      transport: { type: 'stdio' }
    }
  ]
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

type RuntimeTestResult = { name: string; passed: boolean; error?: string };

function headerList(entries: Array<{ key: string; value: string }>) {
  return {
    get(key: string): string {
      const match = [...entries].reverse().find((entry) => entry.key.toLowerCase() === key.toLowerCase());
      return match?.value ?? '';
    }
  };
}

function createPmExpect() {
  const expectFn = ((actual: unknown, message?: string) => {
    const fail = (fallback: string): never => {
      throw new Error(message ?? fallback);
    };
    const matchesType = (type: string): boolean => {
      if (type === 'array') return Array.isArray(actual);
      if (type === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual);
      return typeof actual === type;
    };
    const chain = (negated = false): Record<string, unknown> => ({
      get to() {
        return this;
      },
      get be() {
        return this;
      },
      get and() {
        return this;
      },
      get not() {
        return chain(!negated);
      },
      a(type: string) {
        const ok = matchesType(type);
        if (negated ? ok : !ok) fail(`expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}to be a ${type}`);
        return chain();
      },
      an(type: string) {
        const ok = matchesType(type);
        if (negated ? ok : !ok) fail(`expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}to be an ${type}`);
        return chain();
      },
      eql(expected: unknown) {
        const ok = Object.is(actual, expected);
        if (negated ? ok : !ok) fail(`expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}to equal ${JSON.stringify(expected)}`);
        return chain();
      },
      match(pattern: RegExp) {
        const ok = typeof actual === 'string' && pattern.test(actual);
        if (negated ? ok : !ok) fail(`expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}to match ${String(pattern)}`);
        return chain();
      },
      satisfy(predicate: (value: unknown) => boolean) {
        const ok = Boolean(predicate(actual));
        if (negated ? ok : !ok) fail(`expected predicate ${negated ? 'not ' : ''}to accept ${JSON.stringify(actual)}`);
        return chain();
      },
      within(min: number, max: number) {
        const ok = typeof actual === 'number' && actual >= min && actual <= max;
        if (negated ? ok : !ok) fail(`expected ${JSON.stringify(actual)} ${negated ? 'not ' : ''}to be within ${min}..${max}`);
        return chain();
      }
    });
    return chain();
  }) as ((actual: unknown, message?: string) => Record<string, unknown>) & { fail: (message?: string) => never };
  expectFn.fail = (message?: string): never => {
    throw new Error(message ?? 'pm.expect.fail');
  };
  return expectFn;
}

function runMcpScript(script: string, responseBody: unknown, vars = new Map<string, string>()): { results: RuntimeTestResult[]; warnings: string[]; vars: Map<string, string> } {
  const results: RuntimeTestResult[] = [];
  const warnings: string[] = [];
  const pm = {
    response: {
      code: 200,
      headers: headerList([{ key: 'Content-Type', value: 'application/json; charset=utf-8' }]),
      text: (): string => JSON.stringify(responseBody)
    },
    collectionVariables: {
      get(key: string): string | undefined {
        return vars.get(key);
      },
      set(key: string, value: unknown): void {
        vars.set(key, String(value));
      },
      unset(key: string): void {
        vars.delete(key);
      }
    },
    expect: createPmExpect(),
    test(name: string, fn: () => void): void {
      try {
        fn();
        results.push({ name, passed: true });
      } catch (error) {
        results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  };
  new Script(script).runInContext(createContext({ pm, console: { warn: (...parts: unknown[]) => warnings.push(parts.map((part) => String(part)).join(' ')) }, JSON, Array, Object, Number, String, RegExp, Math, Boolean }));
  return { results, warnings, vars };
}

function runtimeTestResult(results: RuntimeTestResult[], name: string): RuntimeTestResult | undefined {
  return results.find((entry) => entry.name === name);
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
    expect(index.warnings.filter((warning) => warning.startsWith('MCP_REGISTRY_SCHEMA_INVALID'))).toEqual([]);
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
    expect(index.resources.map((resource) => resource.name)).toEqual(['Forecast Index', 'Station Directory']);
    expect(index.resourceTemplates.map((template) => template.name)).toEqual(['Forecast Template', 'Station Template']);
    expect(index.resourceTemplates[0]?.variables).toEqual(['city', 'days']);
    expect(index.prompts).toHaveLength(1);
    expect(index.prompts[0]).toMatchObject({
      name: 'forecast_summary',
      title: 'Forecast Summary',
      arguments: [
        { name: 'city', description: 'City to summarize', required: true },
        { name: 'tone', description: 'Optional response tone', required: false }
      ]
    });
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

  it('parses a registry package transport using the nested camelCase schema fields', () => {
    const index = parseMcpServerSpec(registryPackageWithTransport);
    expect(index.servers).toHaveLength(1);
    expect(index.warnings).toEqual([]);
    const pkg = index.servers[0]!;
    expect(pkg.transport).toBe('stdio');
    expect(pkg.command).toBe('npx -y @example/weather-mcp --port=9090 <tenant>');
    expect(pkg.env).toEqual([{ key: 'WEATHER_API_KEY', value: '{{WEATHER_API_KEY}}' }]);
    expect(pkg.warnings).toEqual([]);
  });

  it('skips non-stdio package transports instead of inferring stdio from package fields', () => {
    const doc = JSON.stringify({
      name: 'io.github.example/weather',
      remotes: [{ type: 'sse', url: 'https://mcp.example.com/sse' }],
      packages: [
        {
          registryType: 'npm',
          identifier: '@example/weather-mcp',
          transport: { type: 'sse', url: 'https://127.0.0.1:3000/sse' }
        }
      ]
    });
    const index = parseMcpServerSpec(doc);
    expect(index.servers).toHaveLength(1);
    expect(index.servers[0]?.transport).toBe('sse');
    expect(index.warnings.some((w) => w.startsWith('MCP_PACKAGE_TRANSPORT_UNSUPPORTED') && w.includes('"sse"'))).toBe(true);
  });

  it('warns when a registry server.json with $schema violates required schema fields', () => {
    const doc = JSON.stringify({
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: 'io.github.example/weather',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http' }]
    });
    const index = parseMcpServerSpec(doc);
    expect(index.warnings.some((warning) => warning.startsWith('MCP_REGISTRY_SCHEMA_INVALID') && warning.includes('#/description'))).toBe(true);
    expect(index.warnings.some((warning) => warning.startsWith('MCP_REGISTRY_SCHEMA_INVALID') && warning.includes('#/remotes/0/url'))).toBe(true);
  });

  it('parses prompt/resource declarations but keeps invalid entries auditable with warnings', () => {
    const doc = JSON.stringify({
      mcpServers: { weather: { command: 'npx weather-server' } },
      resources: [
        { name: 'Broken Resource', uri: 'not a uri', mimeType: 42 },
        { uri: 'resource://missing-name' }
      ],
      resourceTemplates: [
        { name: 'Broken Template', uriTemplate: 'resource://forecast/{city', mimeType: 'application/json' }
      ],
      prompts: [
        {
          name: 'forecast_prompt',
          arguments: [{ name: 'city', required: 'yes' }, { description: 'missing name' }, { name: 'city' }]
        }
      ],
      _meta: 'invalid'
    });
    const index = parseMcpServerSpec(doc);
    expect(index.resources.map((resource) => resource.name)).toEqual(['Broken Resource']);
    expect(index.resourceTemplates[0]?.name).toBe('Broken Template');
    expect(index.prompts[0]?.arguments).toEqual([{ name: 'city', required: false }]);
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
    // 2 servers x (initialize + initialized + tools/list + resources/list + prompts/list +
    // 2 tools/call + 2 resources/read + 1 prompts/get) mcp-request templates,
    // plus 1 url-bearing server x (24 HTTP runtime probes/items).
    expect(items).toHaveLength(44);
    for (const item of items) {
      if (item.type === 'mcp-request') expect(ecIssues(item)).toBeFalsy();
    }
    const initialize = items.find((i) => String(i.title).endsWith('initialize') && (i.payload as JsonRecord).transport === 'sse')!;
    const initMessage = JSON.parse(String((initialize.payload as JsonRecord).message)) as JsonRecord;
    expect(initMessage.jsonrpc).toBe('2.0');
    expect(initMessage.method).toBe('initialize');
    expect((initMessage.params as JsonRecord).protocolVersion).toBe('2025-06-18');
    const initialized = items.find((i) => String(i.title) === 'io.github.example/weather remote-1 · notifications/initialized')!;
    const initializedMessage = JSON.parse(String((initialized.payload as JsonRecord).message)) as JsonRecord;
    expect(initializedMessage).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const call = items.find((i) => String(i.title).includes('tools/call get_forecast'))!;
    const callMessage = JSON.parse(String((call.payload as JsonRecord).message)) as JsonRecord;
    expect(callMessage.method).toBe('tools/call');
    expect((callMessage.params as JsonRecord).name).toBe('get_forecast');
    expect(((callMessage.params as JsonRecord).arguments as JsonRecord).city).toBe('string');
    const remoteToolCallIds = items
      .filter((i) => i.type === 'mcp-request' && String(i.title).startsWith('io.github.example/weather remote-1 · tools/call'))
      .map((i) => JSON.parse(String((i.payload as JsonRecord).message)).id);
    expect(remoteToolCallIds).toEqual([3, 4]);
    const remoteCall = items.find((i) => i.type === 'mcp-request' && String(i.title) === 'io.github.example/weather remote-1 · tools/call get_forecast')!;
    const remoteHeaders = (((remoteCall.payload as JsonRecord).headers as JsonRecord[]) ?? []).map((h) => h.key);
    expect(remoteHeaders).toEqual(['MCP-Protocol-Version', 'X-API-Key']);
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

  it('emits compact stdio JSON-RPC payloads with no embedded newlines', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const stdioMessages = (collection.item as JsonRecord[])
      .filter((item) => item.type === 'mcp-request' && (item.payload as JsonRecord).transport === 'stdio')
      .map((item) => String((item.payload as JsonRecord).message));
    expect(stdioMessages).toHaveLength(10);
    for (const message of stdioMessages) {
      expect(message).not.toContain('\n');
      expect(message).toBe(JSON.stringify(JSON.parse(message)));
    }
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

  it('surfaces invalid resource/template/prompt declarations during generation-time validation', () => {
    const doc = JSON.stringify({
      mcpServers: { weather: { command: 'npx weather-server' } },
      resources: [
        { name: 'Broken Resource', uri: 'not a uri', mimeType: 42 },
        { uri: 'resource://missing-name' }
      ],
      resourceTemplates: [{ name: 'Broken Template', uriTemplate: 'resource://forecast/{city', mimeType: 'application/json' }],
      prompts: [
        {
          name: 'forecast_prompt',
          arguments: [{ name: 'city', required: 'yes' }, { description: 'missing name' }, { name: 'city' }]
        }
      ],
      _meta: 'invalid'
    });
    const index = parseMcpServerSpec(doc);
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentMcpCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('MCP_RESOURCE_URI_INVALID') && w.includes('Broken Resource'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_RESOURCE_FIELD_INVALID') && w.includes('Broken Resource') && w.includes('mimeType'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_RESOURCE_NAME_MISSING'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_RESOURCE_TEMPLATE_INVALID') && w.includes('Broken Template'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_PROMPT_ARGUMENT_INVALID') && w.includes('forecast_prompt') && w.includes('required'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_PROMPT_ARGUMENT_NAME_MISSING') && w.includes('forecast_prompt'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_PROMPT_ARGUMENT_DUPLICATE') && w.includes('forecast_prompt'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('MCP_META_OBJECT_INVALID') && w.includes('$._meta'))).toBe(true);
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
  it('fails initialize responses that negotiate an unknown protocol version', () => {
    const { results } = runMcpScript(initializeScript(), {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2099-01-01',
        capabilities: {},
        serverInfo: { name: 'weather', version: '1.0.0' }
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP initialize negotiates a supported protocolVersion (MCP 2025-06-18 initialize)'
      )?.passed
    ).toBe(false);
  });

  it('adds session-requirement and pagination probes with their runtime gates', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const collection = buildMcpCollection(index, { idSeed: 'test' });
    const httpItems = (collection.item as JsonRecord[]).filter((item) => item.type === 'http-request');

    const noSession = httpItems.find((item) => String(item.title).endsWith('ping without session id'))!;
    const noSessionHeaders = (((noSession.payload as JsonRecord).headers as JsonRecord[]) ?? []).map((h) => h.key);
    expect(noSessionHeaders).not.toContain('Mcp-Session-Id');
    const noSessionScript = String(((((noSession.extensions as JsonRecord).events as JsonRecord[])[0]).script as JsonRecord).exec);
    expect(noSessionScript).toContain('respond 400 Bad Request');

    const pageItems = httpItems.filter((item) => /tools\/list page \d+$/.test(String(item.title)));
    expect(pageItems).toHaveLength(5);
    const nextPage = pageItems[0];
    const nextPageEvents = (nextPage.extensions as JsonRecord).events as JsonRecord[];
    expect(nextPageEvents[0].listen).toBe('beforeRequest');
    expect(String((nextPageEvents[0].script as JsonRecord).exec)).toContain('skipRequest');
    const nextPageBody = JSON.parse(String(((nextPage.payload as JsonRecord).body as JsonRecord).content)) as JsonRecord;
    expect(nextPageBody.id).toBe('pm-tools-list-page:1');
    expect((nextPageBody.params as JsonRecord).cursor).toBe('{{mcp_next_cursor}}');
    expect(String((nextPageEvents[1].script as JsonRecord).exec)).toContain('byte-for-byte');
    expect(String((nextPageEvents[1].script as JsonRecord).exec)).toContain('did not terminate within 5 cursor pages');

    const replay = httpItems.find((item) => String(item.title).endsWith('tools/list cursor replay'))!;
    const replayBody = JSON.parse(String(((replay.payload as JsonRecord).body as JsonRecord).content)) as JsonRecord;
    expect((replayBody.params as JsonRecord).cursor).toBe('{{mcp_first_cursor}}');
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
      'io.github.example/weather remote-1 · HTTP resources/list',
      'io.github.example/weather remote-1 · HTTP prompts/list',
      'io.github.example/weather remote-1 · HTTP ping without session id',
      'io.github.example/weather remote-1 · HTTP tools/list page 1',
      'io.github.example/weather remote-1 · HTTP tools/list page 2',
      'io.github.example/weather remote-1 · HTTP tools/list page 3',
      'io.github.example/weather remote-1 · HTTP tools/list page 4',
      'io.github.example/weather remote-1 · HTTP tools/list page 5',
      'io.github.example/weather remote-1 · HTTP tools/list cursor replay',
      'io.github.example/weather remote-1 · HTTP tools/call get_forecast',
      'io.github.example/weather remote-1 · HTTP tools/call list_stations',
      'io.github.example/weather remote-1 · HTTP resources/read Forecast Index',
      'io.github.example/weather remote-1 · HTTP resources/read Station Directory',
      'io.github.example/weather remote-1 · HTTP prompts/get forecast_summary',
      'io.github.example/weather remote-1 · HTTP resources/templates/list',
      'io.github.example/weather remote-1 · HTTP tools/call get_forecast with progressToken',
      'io.github.example/weather remote-1 · HTTP negative bad protocol version',
      'io.github.example/weather remote-1 · HTTP tools/list invalid cursor',
      'io.github.example/weather remote-1 · HTTP session DELETE',
      'io.github.example/weather remote-1 · HTTP old session ping'
    ]);
    const ping = httpItems.find((item) => String(item.title).endsWith('HTTP ping'))!;
    const pingHeaders = ((ping.payload as JsonRecord).headers as JsonRecord[]);
    expect(pingHeaders.map((h) => h.key)).toContain('Mcp-Session-Id');
    expect(pingHeaders.find((h) => h.key === 'MCP-Protocol-Version')?.value).toBe('{{mcp_protocol_version}}');
    const pingScript = (((ping.extensions as JsonRecord).events as JsonRecord[])[0].script as JsonRecord).exec;
    expect(pingScript).toContain('MCP ping echoes string id and empty result');
    const badVersion = httpItems.find((item) => String(item.title).includes('bad protocol version'))!;
    expect(((badVersion.payload as JsonRecord).headers as JsonRecord[]).find((h) => h.key === 'MCP-Protocol-Version')?.value).toBe('1999-01-01');
  });

  it('rejects generated initialize messages with unsupported protocol versions', () => {
    const index = parseMcpServerSpec(read('server.json'));
    expect(() => buildMcpCollection(index, { protocolVersion: '2099-01-01' })).toThrow(/MCP_PROTOCOL_VERSION_UNSUPPORTED/);
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

  it('validates optional progress notification total and message fields', () => {
    const script = progressToolCallScript('get_forecast');
    const invalid = runMcpScript(script, [
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'pm-progress', progress: 3, total: 2, message: 5 } },
      { jsonrpc: '2.0', id: 'pm-progress-call', result: {} }
    ]);
    expect(
      runtimeTestResult(
        invalid.results,
        'MCP progress notifications echo the token and increase for get_forecast (MCP 2025-06-18 utilities/progress)'
      )?.passed
    ).toBe(false);

    const valid = runMcpScript(script, [
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'pm-progress', progress: 1, total: 2, message: 'halfway' } },
      { jsonrpc: '2.0', id: 'pm-progress-call', result: {} }
    ]);
    expect(
      runtimeTestResult(
        valid.results,
        'MCP progress notifications echo the token and increase for get_forecast (MCP 2025-06-18 utilities/progress)'
      )?.passed
    ).toBe(true);
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

describe('mcp tools/call runtime structuredContent assertions', () => {
  it('fails when structuredContent is present but not object-valued', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'list_stations')!;
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [],
        structuredContent: []
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP tools/call structuredContent is object-valued when present for list_stations (MCP 2025-06-18 structured content)'
      )?.passed
    ).toBe(false);
  });

  it('fails when an outputSchema tool omits required structuredContent', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'get_forecast')!;
    tool.outputSchema = {
      type: 'object',
      required: ['temperature'],
      properties: {
        temperature: { type: 'number' }
      }
    };
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [{ type: 'text', text: '{}' }]
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP tools/call structuredContent is required and matches outputSchema for get_forecast (MCP 2025-06-18 structured content)'
      )?.passed
    ).toBe(false);
  });

  it('fails invalid outputSchema structuredContent and accepts a conforming object', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'get_forecast')!;
    tool.outputSchema = {
      type: 'object',
      required: ['temperature'],
      properties: {
        temperature: { type: 'number' }
      }
    };
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);

    const invalid = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ temperature: 'hot' }) }],
        structuredContent: { temperature: 'hot' }
      }
    });
    expect(
      runtimeTestResult(
        invalid.results,
        'MCP tools/call structuredContent is required and matches outputSchema for get_forecast (MCP 2025-06-18 structured content)'
      )?.passed
    ).toBe(false);

    const validBody = {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ temperature: 72 }) }],
        structuredContent: { temperature: 72 }
      }
    };
    const valid = runMcpScript(script, validBody);
    expect(
      runtimeTestResult(
        valid.results,
        'MCP tools/call structuredContent is required and matches outputSchema for get_forecast (MCP 2025-06-18 structured content)'
      )?.passed
    ).toBe(true);
    expect(valid.warnings).toEqual([]);
  });

  it('requires content blocks even on tool-execution-error results', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'list_stations')!;
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        isError: true
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP tools/call content blocks are typed for list_stations (MCP 2025-06-18 content blocks)'
      )?.passed
    ).toBe(false);
  });

  it('fails unknown content discriminators, invalid base64/media types, and invalid resource URIs', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'list_stations')!;
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);
    const runContent = (content: unknown[]) => runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: { content }
    });
    const testName = 'MCP tools/call content blocks are typed for list_stations (MCP 2025-06-18 content blocks)';

    expect(runtimeTestResult(runContent([{ type: 'video', url: 'resource://x' }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'image', data: '', mimeType: 'image/png' }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'image', data: 'not base64?', mimeType: 'image/png' }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'audio', data: 'QUJD', mimeType: 'not-media' }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'resource_link', uri: 'relative/path', name: 'r' }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'resource', resource: { uri: 'resource://station/1', blob: 'not base64?', mimeType: 'application/json' } }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'text', text: 'ok', _meta: { 'mcp/reserved': true } }]).results, testName)?.passed).toBe(false);
    expect(runtimeTestResult(runContent([{ type: 'text', text: 'ok', annotations: { audience: ['user'], priority: 0.5 }, _meta: { 'pm-cse/key': true } }]).results, testName)?.passed).toBe(true);
  });

  it('requires structuredContent to be mirrored by JSON text content', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'list_stations')!;
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);
    const testName = 'MCP tools/call structuredContent is mirrored by a JSON text content block for list_stations (MCP 2025-06-18 structured content compatibility)';

    const invalid = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [{ type: 'text', text: 'station list' }],
        structuredContent: { stations: ['SFO'] }
      }
    });
    expect(runtimeTestResult(invalid.results, testName)?.passed).toBe(false);

    const valid = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ stations: ['SFO'] }) }],
        structuredContent: { stations: ['SFO'] }
      }
    });
    expect(runtimeTestResult(valid.results, testName)?.passed).toBe(true);
  });

  it('rejects reserved _meta prefixes anywhere in a JSON-RPC response', () => {
    const index = parseMcpServerSpec(read('server.json'));
    const tool = index.tools.find((entry) => entry.name === 'list_stations')!;
    const { script, warnings } = toolsCallScript(index, tool, 10);
    expect(warnings).toEqual([]);
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 10,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        _meta: { 'mcp/reserved': true }
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP tools/call returns JSON-RPC result for list_stations (MCP 2025-06-18 tools/call; JSON-RPC 2.0 §5)'
      )?.passed
    ).toBe(false);
  });
});

describe('mcp resource runtime URI assertions', () => {
  it('rejects relative resource URIs in resources/list and resources/read results', () => {
    const listScript = resourcesListScript(['Forecast Index']);
    const list = runMcpScript(listScript, {
      jsonrpc: '2.0',
      id: 8,
      result: {
        resources: [{ name: 'Forecast Index', uri: 'relative/path' }]
      }
    });
    expect(
      runtimeTestResult(
        list.results,
        'MCP resources/list result shape and manifest subset (MCP 2025-06-18 resources/list)'
      )?.passed
    ).toBe(false);

    const readScript = readResourceScript('resource://forecast-index');
    const read = runMcpScript(readScript, {
      jsonrpc: '2.0',
      id: 'pm-resource-read:resource://forecast-index',
      result: {
        contents: [{ uri: 'relative/path', text: '{}' }]
      }
    });
    expect(
      runtimeTestResult(
        read.results,
        'MCP resources/read result shape for resource://forecast-index (MCP 2025-06-18 resources/read)'
      )?.passed
    ).toBe(false);
  });
});

describe('mcp tools/list runtime descriptor assertions', () => {
  it('fails when a live tool descriptor has invalid annotations or outputSchema typing', () => {
    const script = toolsListScript(['get_forecast']);
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          {
            name: 'get_forecast',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: 'yes' },
            outputSchema: { type: 'string' }
          }
        ]
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP tools/list result shape and manifest subset (MCP 2025-06-18 tools/list)'
      )?.passed
    ).toBe(false);
  });

  it('accepts typed annotations and object outputSchema in live tool descriptors', () => {
    const script = toolsListScript(['get_forecast']);
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          {
            name: 'get_forecast',
            inputSchema: { type: 'object' },
            annotations: { readOnlyHint: true, title: 'Forecast' },
            outputSchema: { type: 'object', properties: { temperature: { type: 'number' } } }
          }
        ]
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP tools/list result shape and manifest subset (MCP 2025-06-18 tools/list)'
      )?.passed
    ).toBe(true);
  });

  it('accumulates declared tools across pages and rejects cross-page duplicate tool names', () => {
    const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });
    const vars = new Map<string, string>();
    const first = runMcpScript(toolsListScript(['first', 'second']), {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [tool('first')],
        nextCursor: 'cursor-1'
      }
    }, vars);
    expect(runtimeTestResult(first.results, 'MCP tools/list result shape and manifest subset (MCP 2025-06-18 tools/list)')?.passed).toBe(true);
    expect(runtimeTestResult(first.results, 'MCP tools/list nextCursor is an opaque string, saved verbatim for the pagination probes (MCP 2025-06-18 pagination)')?.passed).toBe(true);
    expect(vars.get('mcp_first_cursor')).toBe('cursor-1');
    expect(vars.get('mcp_next_cursor')).toBe('cursor-1');

    const duplicate = runMcpScript(nextCursorScript(1, 'pm-tools-list-page:1', 5), {
      jsonrpc: '2.0',
      id: 'pm-tools-list-page:1',
      result: {
        tools: [tool('first')],
        nextCursor: 'cursor-2'
      }
    }, vars);
    expect(
      runtimeTestResult(
        duplicate.results,
        'MCP tools/list follows nextCursor byte-for-byte to page 1 and accumulates until termination (MCP 2025-06-18 pagination)'
      )?.passed
    ).toBe(false);
  });

  it('passes when pagination terminates after all declared tools are seen', () => {
    const tool = (name: string) => ({ name, inputSchema: { type: 'object' } });
    const vars = new Map<string, string>();
    runMcpScript(toolsListScript(['first', 'second']), {
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [tool('first')],
        nextCursor: 'cursor-1'
      }
    }, vars);

    const second = runMcpScript(nextCursorScript(1, 'pm-tools-list-page:1', 5), {
      jsonrpc: '2.0',
      id: 'pm-tools-list-page:1',
      result: {
        tools: [tool('second')]
      }
    }, vars);
    expect(
      runtimeTestResult(
        second.results,
        'MCP tools/list follows nextCursor byte-for-byte to page 1 and accumulates until termination (MCP 2025-06-18 pagination)'
      )?.passed
    ).toBe(true);
    expect(vars.get('mcp_next_cursor')).toBeUndefined();
  });
});

describe('mcp prompts/get runtime content assertions', () => {
  it('reuses MCP content-block validation for prompt messages', () => {
    const script = getPromptScript('forecast_summary');
    const invalid = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 'pm-prompt-get:forecast_summary',
      result: {
        messages: [{ role: 'assistant', content: { type: 'image', data: 'bad?', mimeType: 'image/png' } }]
      }
    });
    expect(
      runtimeTestResult(
        invalid.results,
        'MCP prompts/get result shape for forecast_summary (MCP 2025-06-18 prompts/get)'
      )?.passed
    ).toBe(false);

    const valid = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 'pm-prompt-get:forecast_summary',
      result: {
        messages: [{ role: 'assistant', content: { type: 'text', text: 'hello', annotations: { audience: ['assistant'] } } }]
      }
    });
    expect(
      runtimeTestResult(
        valid.results,
        'MCP prompts/get result shape for forecast_summary (MCP 2025-06-18 prompts/get)'
      )?.passed
    ).toBe(true);
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

describe('mcp resource template runtime checks', () => {
  it('fails when a resource template is not absolute after RFC 6570 expansion', () => {
    const script = resourceTemplatesScript();
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 5,
      result: {
        resourceTemplates: [{ name: 'Relative Template', uriTemplate: 'forecast/{city}' }]
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP resource templates compile under RFC 6570 (MCP 2025-06-18 resources; RFC 6570)'
      )?.passed
    ).toBe(false);
  });

  it('fails when resources/templates/list omits the resourceTemplates array', () => {
    const script = resourceTemplatesScript();
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 5,
      result: {}
    });
    expect(
      runtimeTestResult(
        results,
        'MCP resource templates compile under RFC 6570 (MCP 2025-06-18 resources; RFC 6570)'
      )?.passed
    ).toBe(false);
  });

  it('fails when resources/templates/list nextCursor is not a string', () => {
    const script = resourceTemplatesScript();
    const { results } = runMcpScript(script, {
      jsonrpc: '2.0',
      id: 5,
      result: {
        nextCursor: 42,
        resourceTemplates: []
      }
    });
    expect(
      runtimeTestResult(
        results,
        'MCP resource templates compile under RFC 6570 (MCP 2025-06-18 resources; RFC 6570)'
      )?.passed
    ).toBe(false);
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
