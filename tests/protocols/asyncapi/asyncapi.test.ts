import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { itemsByType } from '@postman/runtime.models/extensible';
import { describe, expect, it } from 'vitest';

import { parseAsyncApi } from '../../../src/lib/protocols/asyncapi/asyncapi-parser.js';
import { buildAsyncApiCollection } from '../../../src/lib/protocols/asyncapi/asyncapi-collection-builder.js';
import { instrumentAsyncApiCollection } from '../../../src/lib/protocols/asyncapi/asyncapi-instrumenter.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../../fixtures/asyncapi');

function read(rel: string): string {
  return readFileSync(resolve(fixtures, rel), 'utf8');
}

type JsonRecord = Record<string, unknown>;

// Validate a built EC node against the official runtime.models item schema for
// its type (the binding authority; the published v3.0.0 JSON Schema is 403).
function ecIssues(node: JsonRecord): unknown {
  const registry = itemsByType as Record<string, { validate?: (v: unknown) => { issues?: unknown } } | undefined>;
  const model = registry[String(node.type)];
  if (!model?.validate) return undefined;
  const logical = { type: node.type, title: node.title, payload: node.payload, extensions: node.extensions ?? {} };
  return model.validate(logical)?.issues;
}

describe('asyncapi parser', () => {
  it('parses an AsyncAPI 2.6 WebSocket document into a ws-raw channel index', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    expect(index.version).toBe('2.6.0');
    expect(index.channels).toHaveLength(1);
    const channel = index.channels[0];
    expect(channel.transport).toBe('ws-raw');
    expect(channel.url).toBe('wss://stream.example.com/telemetry');
    expect(channel.messages).toHaveLength(2);
    expect(channel.headers.map((h) => h.key)).toContain('Authorization');
    expect(channel.queryParams.map((q) => q.key)).toContain('token');
  });

  it('infers Socket.IO from the x-ack convention and warns', async () => {
    const index = await parseAsyncApi(read('socketio.yaml'));
    const channel = index.channels[0];
    expect(channel.transport).toBe('socketio');
    expect(channel.socketioNamespace).toBe('/chat');
    const send = channel.messages.find((m) => m.eventName === 'message:send');
    expect(send?.ackSchema).toBeDefined();
    const conventionWarning = [...index.warnings, ...channel.warnings].some((w) => w.startsWith('ASYNCAPI_SOCKETIO_CONVENTION'));
    expect(conventionWarning).toBe(true);
  });

  it('rejects AsyncAPI 3.x with ASYNCAPI_VERSION_UNSUPPORTED', async () => {
    const doc = 'asyncapi: 3.0.0\ninfo:\n  title: X\n  version: 1.0.0\nchannels: {}\n';
    await expect(parseAsyncApi(doc)).rejects.toThrow(/ASYNCAPI_VERSION_UNSUPPORTED/);
  });

  it('rejects empty input', async () => {
    await expect(parseAsyncApi('   ')).rejects.toThrow(/ASYNCAPI_EMPTY_INPUT/);
  });
});

describe('asyncapi collection builder', () => {
  it('builds a ws-raw-request per channel with message children valid against the EC schema', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    const collection = buildAsyncApiCollection(index, { name: 'T Contract', idSeed: 'test' });
    const items = collection.item as JsonRecord[];
    expect(items).toHaveLength(1);
    const request = items[0];
    expect(request.type).toBe('ws-raw-request');
    expect((request.payload as JsonRecord).url).toBe('wss://stream.example.com/telemetry');
    expect(ecIssues(request)).toBeFalsy();
    const children = request.children as JsonRecord[];
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.type).toBe('ws-raw-message');
      expect(ecIssues(child)).toBeFalsy();
    }
  });

  it('builds a ws-socketio-request with events, acknowledgement, and schema-valid children', async () => {
    const index = await parseAsyncApi(read('socketio.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const request = (collection.item as JsonRecord[])[0];
    expect(request.type).toBe('ws-socketio-request');
    const payload = request.payload as JsonRecord;
    expect((payload.settings as JsonRecord).version).toBe('4');
    expect(Array.isArray(payload.events)).toBe(true);
    expect(ecIssues(request)).toBeFalsy();
    const children = request.children as JsonRecord[];
    const send = children.find((c) => (c.payload as JsonRecord).eventName === 'message:send');
    expect(send).toBeDefined();
    expect((send!.payload as JsonRecord).acknowledgement).toBe(true);
    for (const child of children) {
      expect(child.type).toBe('ws-socketio-message');
      expect(ecIssues(child)).toBeFalsy();
    }
  });

  it('is deterministic across builds', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    const a = JSON.stringify(buildAsyncApiCollection(index, { idSeed: 's' }));
    const b = JSON.stringify(buildAsyncApiCollection(index, { idSeed: 's' }));
    expect(a).toBe(b);
  });
});

describe('asyncapi instrumenter (static validation)', () => {
  it('validates message examples and reports coverage with no silent drops', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    // TelemetryCommand has no example -> synthesized content warning.
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_NO_EXAMPLE'))).toBe(true);
    // The valid TelemetryEvent example must not raise a mismatch.
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(false);
  });

  it('flags an example that violates its own payload schema', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    // Corrupt the example so it no longer validates: value should be a number.
    const channel = index.channels[0];
    const message = channel.messages.find((m) => m.hasExample)!;
    message.sample = { deviceId: 'dev-1', value: 'not-a-number' };
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(true);
  });

  it('fails closed when the built collection drops a message', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    (collection.item as JsonRecord[])[0].children = [];
    expect(() => instrumentAsyncApiCollection(collection, index)).toThrow(/ASYNCAPI_MESSAGE_COVERAGE_FAILED/);
  });

  it('fails closed when a message is duplicated and another dropped (count-stable)', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const children = (collection.item as JsonRecord[])[0].children as JsonRecord[];
    // Same node count as expected (2), but one identity duplicated and one dropped.
    (collection.item as JsonRecord[])[0].children = [children[0], children[0]];
    expect(() => instrumentAsyncApiCollection(collection, index)).toThrow(/ASYNCAPI_MESSAGE_COVERAGE_FAILED/);
  });
});
