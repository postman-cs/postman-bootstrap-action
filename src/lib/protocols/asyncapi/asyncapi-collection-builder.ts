// Build a v3/EC (Extensible Collection) JSON object with one ws-raw-request or
// ws-socketio-request item per AsyncAPI channel, each carrying its messages as
// child items.
//
// Grounding for the node + payload shape is the bundled `@postman/runtime.models`
// extensible item schemas (the published v3.0.0 JSON Schema is not fetchable):
//   - ws-raw-request.payload = { url?, headers?, queryParams?, settings? }, with
//     ws-raw-message / ws-raw-example children.
//   - ws-socketio-request.payload = { url?, headers?, queryParams?, settings{version,path,...}, events? },
//     with ws-socketio-message / ws-socketio-example children.
//   - ws-raw-message.payload = { type:'json'|'text'|'html'|'xml', content } | { type:'binary', subtype, content }.
//   - ws-socketio-message.payload = { eventName, acknowledgement?, args:[{content,type}|binary] }.
// (see node_modules/@postman/runtime.models/dist/extensible/item-types/ws-*.d.ts)
//
// WS/Socket.IO EC items expose no test-script (`extensions.events`) slot and the
// Postman CLI runner prunes them, so no runtime assertions are attached here; the
// contract check is generation-time/static (see asyncapi-instrumenter.ts).
//
// Output ordering is deterministic (channels/messages already sorted upstream) so
// repeated builds and golden snapshots are stable.

import type {
  AsyncApiChannelDescriptor,
  AsyncApiContractIndex,
  AsyncApiKeyValue,
  AsyncApiMessageDescriptor
} from './asyncapi-parser.js';

type JsonRecord = Record<string, unknown>;

export interface AsyncApiCollectionOptions {
  // Collection display name. Defaults to `<title> Contract`.
  name?: string;
  // Deterministic id seed; when set, item ids are derived from it for stable snapshots.
  idSeed?: string;
  // Fixed createdAt for deterministic output.
  createdAt?: string;
  // Default Socket.IO protocol version applied when the spec declares none.
  socketioVersion?: '2' | '3' | '4';
}

const DEFAULT_CREATED_AT = '1970-01-01T00:00:00.000Z';
const DEFAULT_SOCKETIO_VERSION = '4';

// Deterministic, dependency-free id: a stable hash of the seed + key. uuid-shaped
// but derived, matching the gRPC builder's stableId discipline.
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

function serializeSample(sample: unknown): string {
  if (typeof sample === 'string') return sample;
  try {
    return JSON.stringify(sample ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function keyValues(entries: AsyncApiKeyValue[]): Array<{ key: string; value: string }> {
  return entries.map((entry) => ({ key: entry.key, value: entry.value }));
}

// ws-raw-message content-type maps json/text/html/xml directly; binary is
// emitted as a base64 sample so the item validates and is operator-editable.
function rawMessagePayload(message: AsyncApiMessageDescriptor): JsonRecord {
  if (message.contentKind === 'binary') {
    return { type: 'binary', subtype: 'base64', content: Buffer.from(serializeSample(message.sample), 'utf8').toString('base64') };
  }
  return { type: message.contentKind, content: serializeSample(message.sample) };
}

function socketioMessageArg(message: AsyncApiMessageDescriptor): JsonRecord {
  if (message.contentKind === 'binary') {
    return { type: 'binary', subtype: 'base64', content: Buffer.from(serializeSample(message.sample), 'utf8').toString('base64') };
  }
  if (message.contentKind === 'json') {
    return { type: 'json', content: serializeSample(message.sample) };
  }
  return { type: 'text', content: serializeSample(message.sample) };
}

function buildRawMessageChild(
  channel: AsyncApiChannelDescriptor,
  message: AsyncApiMessageDescriptor,
  options: AsyncApiCollectionOptions
): JsonRecord {
  const seed = options.idSeed ?? 'asyncapi';
  return {
    type: 'ws-raw-message',
    id: stableId(seed, `msg:${channel.id}:${message.id}`),
    title: message.title,
    createdAt: options.createdAt ?? DEFAULT_CREATED_AT,
    payload: rawMessagePayload(message),
    extensions: {}
  };
}

function buildSocketioMessageChild(
  channel: AsyncApiChannelDescriptor,
  message: AsyncApiMessageDescriptor,
  options: AsyncApiCollectionOptions
): JsonRecord {
  const seed = options.idSeed ?? 'asyncapi';
  return {
    type: 'ws-socketio-message',
    id: stableId(seed, `msg:${channel.id}:${message.id}`),
    title: message.title,
    createdAt: options.createdAt ?? DEFAULT_CREATED_AT,
    payload: {
      eventName: message.eventName,
      acknowledgement: message.ackSchema !== undefined,
      args: [socketioMessageArg(message)]
    },
    extensions: {}
  };
}

function buildRawRequest(channel: AsyncApiChannelDescriptor, options: AsyncApiCollectionOptions): JsonRecord {
  const seed = options.idSeed ?? 'asyncapi';
  const payload: JsonRecord = { url: channel.url };
  if (channel.headers.length > 0) payload.headers = keyValues(channel.headers);
  if (channel.queryParams.length > 0) {
    payload.queryParams = channel.queryParams.map((entry) => ({ key: entry.key, value: entry.value }));
  }
  return {
    type: 'ws-raw-request',
    id: stableId(seed, `chan:${channel.id}`),
    title: channel.address || channel.id,
    name: channel.address || channel.id,
    createdAt: options.createdAt ?? DEFAULT_CREATED_AT,
    payload,
    children: channel.messages.map((message) => buildRawMessageChild(channel, message, options)),
    extensions: {}
  };
}

function buildSocketioRequest(channel: AsyncApiChannelDescriptor, options: AsyncApiCollectionOptions): JsonRecord {
  const seed = options.idSeed ?? 'asyncapi';
  const payload: JsonRecord = {
    url: channel.url,
    settings: {
      version: options.socketioVersion ?? DEFAULT_SOCKETIO_VERSION,
      path: channel.socketioPath ?? '/socket.io'
    }
  };
  if (channel.messages.length > 0) {
    // Distinct event names, in first-seen order, for the request-level event list.
    const seen = new Set<string>();
    const events: JsonRecord[] = [];
    for (const message of channel.messages) {
      if (seen.has(message.eventName)) continue;
      seen.add(message.eventName);
      events.push({ name: message.eventName });
    }
    payload.events = events;
  }
  return {
    type: 'ws-socketio-request',
    id: stableId(seed, `chan:${channel.id}`),
    title: channel.address || channel.id,
    name: channel.address || channel.id,
    createdAt: options.createdAt ?? DEFAULT_CREATED_AT,
    payload,
    children: channel.messages.map((message) => buildSocketioMessageChild(channel, message, options)),
    extensions: {}
  };
}

export function buildAsyncApiCollection(index: AsyncApiContractIndex, options: AsyncApiCollectionOptions = {}): JsonRecord {
  const name = options.name?.trim() || `${index.title} Contract`;
  const item = index.channels.map((channel) =>
    channel.transport === 'socketio' ? buildSocketioRequest(channel, options) : buildRawRequest(channel, options)
  );
  return {
    $schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/',
    info: {
      name,
      schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/'
    },
    item
  };
}
