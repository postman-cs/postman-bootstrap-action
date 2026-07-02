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

  it('parses an AsyncAPI 3.0 document (host+pathname server, request/reply)', async () => {
    const index = await parseAsyncApi(read('ws-v3.yaml'));
    expect(index.version).toBe('3.0.0');
    expect(index.channels).toHaveLength(1);
    const channel = index.channels[0];
    expect(channel.transport).toBe('ws-raw');
    // v3 server url is synthesised from protocol+host+pathname, then joined with the channel address.
    expect(channel.url).toBe('wss://stream.example.com/v3/telemetry');
    expect(channel.messages).toHaveLength(2);
    // The 3.x operation reply maps to the request message's acknowledgement schema.
    const command = channel.messages.find((m) => m.eventName === 'telemetryCommand');
    expect(command?.ackSchema).toBeDefined();
    expect(command?.ackSource).toBe('reply');
  });

  it('rejects an out-of-range AsyncAPI version via the version gate', async () => {
    // The bundled parser only recognises 2.0-2.6 and 3.0, so a version outside our
    // supported set that the parser nonetheless yields (here injected as 3.1.0) is
    // rejected by our explicit gate. A version the parser cannot parse at all (e.g.
    // a real 3.1.0 body) is rejected upstream as ASYNCAPI_PARSE_FAILED.
    const stubParser = {
      parse: async () => ({ document: { version: () => '3.1.0' }, diagnostics: [] })
    };
    await expect(parseAsyncApi('asyncapi: 3.1.0', { parser: stubParser })).rejects.toThrow(/ASYNCAPI_VERSION_UNSUPPORTED/);
  });

  it('rejects an unparseable AsyncAPI version body as ASYNCAPI_PARSE_FAILED', async () => {
    const doc = 'asyncapi: 3.1.0\ninfo:\n  title: X\n  version: 1.0.0\nchannels: {}\n';
    await expect(parseAsyncApi(doc)).rejects.toThrow(/ASYNCAPI_PARSE_FAILED|ASYNCAPI_VERSION_UNSUPPORTED/);
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

describe('asyncapi 3.0 collection build', () => {
  it('builds a ws-raw-request per channel with EC-schema-valid children for a 3.0 document', async () => {
    const index = await parseAsyncApi(read('ws-v3.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const request = (collection.item as JsonRecord[])[0];
    expect(request.type).toBe('ws-raw-request');
    expect(ecIssues(request)).toBeFalsy();
    for (const child of request.children as JsonRecord[]) {
      expect(child.type).toBe('ws-raw-message');
      expect(ecIssues(child)).toBeFalsy();
    }
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    // Both messages carry conformant examples -> no schema mismatch.
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(false);
  });
});

describe('asyncapi mqtt', () => {
  it('detects the mqtt transport from the server protocol and captures binding material', async () => {
    const index = await parseAsyncApi(read('mqtt.yaml'));
    expect(index.channels).toHaveLength(2);
    const temperature = index.channels.find((c) => c.id === 'sensors/temperature')!;
    expect(temperature.transport).toBe('mqtt');
    // The channel address is a topic, not a url segment: the request url is the broker endpoint alone.
    expect(temperature.url).toBe('mqtt://broker.example.com:1883');
    expect(temperature.address).toBe('sensors/temperature');
    const mqtt = temperature.mqtt!;
    expect(mqtt.protocolVersion).toBe(5);
    expect(mqtt.operationBindings[0].qos).toBe(1);
    expect(mqtt.serverBindings[0].clientId).toBe('telemetry-publisher');
    expect(mqtt.messageBindings.find((m) => m.messageId === 'temperatureReading')?.binding.responseTopic).toBe('sensors/temperature/ack');
  });

  it('builds an mqtt-request per channel with schema-valid mqtt-message children', async () => {
    const index = await parseAsyncApi(read('mqtt.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const items = collection.item as JsonRecord[];
    const request = items.find((i) => (i.payload as JsonRecord).topics && ((i.payload as JsonRecord).topics as JsonRecord[])[0].name === 'sensors/temperature')!;
    expect(request.type).toBe('mqtt-request');
    const payload = request.payload as JsonRecord;
    expect(payload.url).toBe('mqtt://broker.example.com:1883');
    expect(payload.version).toBe(5);
    expect(payload.clientId).toBe('telemetry-publisher');
    expect((payload.settings as JsonRecord).cleanSession).toBe(true);
    expect((payload.settings as JsonRecord).keepAlive).toBe(60);
    expect((payload.properties as JsonRecord).sessionExpiryInterval).toBe(120);
    expect((payload.lastWill as JsonRecord).topic).toBe('sensors/status');
    expect((payload.lastWill as JsonRecord).payload).toBe('offline');
    expect(((payload.topics as JsonRecord[])[0] as JsonRecord).qos).toBe(1);
    expect(ecIssues(request)).toBeFalsy();
    const children = request.children as JsonRecord[];
    expect(children).toHaveLength(1);
    const message = children[0];
    expect(message.type).toBe('mqtt-message');
    const messagePayload = message.payload as JsonRecord;
    expect(messagePayload.topic).toBe('sensors/temperature');
    expect(messagePayload.type).toBe('json');
    expect(messagePayload.qos).toBe(1);
    expect(messagePayload.retain).toBe(false);
    expect((messagePayload.properties as JsonRecord).payloadFormatIndicator).toBe(true);
    expect((messagePayload.properties as JsonRecord).responseTopic).toBe('sensors/temperature/ack');
    expect(ecIssues(message)).toBeFalsy();
  });

  it('marks a wildcard channel address as a subscription topic and warns it is a filter', async () => {
    const index = await parseAsyncApi(read('mqtt.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const items = collection.item as JsonRecord[];
    const request = items.find((i) => ((i.payload as JsonRecord).topics as JsonRecord[])[0].name === 'sensors/+/events')!;
    expect(((request.payload as JsonRecord).topics as JsonRecord[])[0].subscribe).toBe(true);
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_TOPIC_FILTER'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_TOPIC_INVALID'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_BINDING_INVALID'))).toBe(false);
  });

  it('flags out-of-range binding values and malformed topics', async () => {
    const index = await parseAsyncApi(read('mqtt.yaml'));
    const temperature = index.channels.find((c) => c.id === 'sensors/temperature')!;
    temperature.mqtt!.operationBindings[0].qos = 3;
    temperature.mqtt!.serverBindings[0].keepAlive = -1;
    temperature.mqtt!.messageBindings[0].binding.responseTopic = 'bad/#/topic';
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_BINDING_INVALID') && w.includes('qos'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_BINDING_INVALID') && w.includes('keepAlive'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_TOPIC_INVALID') && w.includes('responseTopic'))).toBe(true);
  });

  it('flags a channel address with a misplaced wildcard', async () => {
    const index = await parseAsyncApi(read('mqtt.yaml'));
    const events = index.channels.find((c) => c.id === 'sensors/+/events')!;
    (events as { address: string }).address = 'sensors/#/events';
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MQTT_TOPIC_INVALID') && w.includes('sensors/#/events'))).toBe(true);
  });

  it('still validates message examples against payload schemas on mqtt channels', async () => {
    const index = await parseAsyncApi(read('mqtt.yaml'));
    const temperature = index.channels.find((c) => c.id === 'sensors/temperature')!;
    temperature.messages[0].sample = { sensorId: 'sensor-1', celsius: 'not-a-number' };
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(true);
  });
});

describe('asyncapi non-JSON payload validation', () => {
  it('validates a text/plain string example against its string schema and an xml object example against its object schema', async () => {
    const index = await parseAsyncApi(read('nonjson.yaml'));
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    // Conformant text + xml examples must not mismatch and must not fall into the
    // blanket "not validated" bucket.
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_NON_JSON_PAYLOAD_NOT_VALIDATED'))).toBe(false);
  });

  it('flags a text/plain example that violates its string schema (pattern)', async () => {
    const index = await parseAsyncApi(read('nonjson.yaml'));
    const line = index.channels[0].messages.find((m) => m.contentKind === 'text')!;
    expect(line).toBeDefined();
    line.sample = 'DEBUG: not a log line';
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(true);
  });

  it('flags an xml object example that violates its object schema', async () => {
    const index = await parseAsyncApi(read('nonjson.yaml'));
    const xml = index.channels[0].messages.find((m) => m.contentKind === 'xml')!;
    expect(xml).toBeDefined();
    xml.sample = { code: 'not-an-integer' };
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(true);
  });

  it('does not false-fail a raw wire-string example supplied for a structured schema', async () => {
    const index = await parseAsyncApi(read('nonjson.yaml'));
    const xml = index.channels[0].messages.find((m) => m.contentKind === 'xml')!;
    // A raw XML wire string for an object schema cannot be structurally validated.
    xml.sample = '<status><code>200</code></status>';
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_MESSAGE_SCHEMA_MISMATCH'))).toBe(false);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_NON_JSON_PAYLOAD_NOT_VALIDATED'))).toBe(true);
  });
});


describe('asyncapi spec-conformance static checks', () => {
  const conformanceDoc = [
    "asyncapi: '2.6.0'",
    'info:',
    '  title: Conformance',
    "  version: '1.0.0'",
    'servers:',
    '  prod:',
    '    url: wss://example.com',
    '    protocol: wss',
    'channels:',
    "  'rooms/{roomId}':",
    '    parameters:',
    '      roomId:',
    '        schema:',
    '          type: string',
    '    subscribe:',
    '      message:',
    '        name: roomEvent',
    '        correlationId:',
    "          location: '$message.payload#/id'",
    '        payload:',
    '          type: object'
  ].join('\n');

  it('captures channel parameters and correlationId location, and passes a conformant document', async () => {
    const index = await parseAsyncApi(conformanceDoc);
    const channel = index.channels[0];
    expect(channel.parameterNames).toEqual(['roomId']);
    expect(channel.messages[0].correlationLocation).toBe('$message.payload#/id');
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_CHANNEL_PARAMETER') || w.startsWith('ASYNCAPI_CORRELATION_LOCATION'))).toBe(false);
  });

  it('flags undeclared, unused, and empty channel address parameters', async () => {
    const index = await parseAsyncApi(conformanceDoc);
    const channel = index.channels[0];
    channel.address = 'rooms/{roomId}/{}';
    channel.parameterNames = ['ghost'];
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_CHANNEL_PARAMETER_UNDECLARED') && w.includes('{roomId}'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_CHANNEL_PARAMETER_UNUSED') && w.includes('ghost'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_CHANNEL_PARAMETER_INVALID'))).toBe(true);
  });

  it('flags a correlationId location that is not a valid runtime expression', async () => {
    const index = await parseAsyncApi(conformanceDoc);
    index.channels[0].messages[0].correlationLocation = '$message.body#/id';
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_CORRELATION_LOCATION_INVALID'))).toBe(true);
  });

  it('captures the raw ws channel binding and flags method/query violations', async () => {
    const index = await parseAsyncApi(read('ws.yaml'));
    const channel = index.channels[0];
    expect(channel.wsBinding).toBeDefined();
    channel.wsBinding = { method: 'PUT', query: { type: 'string' } };
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.filter((w) => w.startsWith('ASYNCAPI_WS_BINDING_INVALID'))).toHaveLength(2);
  });

  it('flags a reserved Socket.IO lifecycle event name', async () => {
    const index = await parseAsyncApi(read('socketio.yaml'));
    index.channels[0].messages[0].eventName = 'disconnect';
    const collection = buildAsyncApiCollection(index, { idSeed: 'test' });
    const { warnings } = instrumentAsyncApiCollection(collection, index);
    expect(warnings.some((w) => w.startsWith('ASYNCAPI_SOCKETIO_RESERVED_EVENT'))).toBe(true);
  });
});

