// AsyncAPI (2.0-2.6) -> typed WebSocket / Socket.IO contract index.
//
// Parsing uses `@postman/asyncapi-parser`, whose intent-driven model unifies the
// spec versions behind one interface (channels/operations/messages/servers). We
// walk that model into a flat, deterministic contract index consumed by the
// builder (one ws-raw-request / ws-socketio-request per channel) and the
// instrumenter (message payload schema validation vs the AsyncAPI message
// schemas). Nothing here is Postman-specific; it is AsyncAPI reflection -> data.
//
// Scope is AsyncAPI 2.x only (2.0.0-2.6.0), matching our AsyncAPIToCollection
// generator (Spec Hub / cloud-ec); 3.x is rejected with ASYNCAPI_VERSION_UNSUPPORTED.
// Socket.IO has no normative AsyncAPI binding, so it is inferred from convention
// (server protocol, an `x-ack` on messages, or an `x-socketio` extension) and
// every such inference emits an ASYNCAPI_SOCKETIO_CONVENTION warning: no silent
// drops. WebSocket/Socket.IO EC items carry no test-script slot and the Postman
// CLI runner prunes them, so contract checking is generation-time/static and the
// dispatch marks these collections runnableInCi:false.

import { Parser, DiagnosticSeverity } from '@postman/asyncapi-parser';

type JsonRecord = Record<string, unknown>;

export type AsyncApiTransport = 'ws-raw' | 'socketio';

export interface AsyncApiKeyValue {
  key: string;
  value: string;
}

export interface AsyncApiMessageDescriptor {
  // Stable message key used for coverage and correlation.
  id: string;
  // Socket.IO event name (message name/title/id); also the display title.
  eventName: string;
  title: string;
  contentType?: string;
  // Raw JSON Schema object for the payload (from SchemaInterface.json()); undefined when absent.
  payloadSchema?: JsonRecord;
  // Raw JSON Schema object for the acknowledgement (from `x-ack`); undefined when absent.
  ackSchema?: JsonRecord;
  // Concrete sample used as the generated message content. Derived from a spec
  // example when present (hasExample true), otherwise synthesized from the schema.
  sample: unknown;
  hasExample: boolean;
  // json | text | xml | html | binary — the ws message content kind.
  contentKind: 'json' | 'text' | 'xml' | 'html' | 'binary';
  warnings: string[];
}

export interface AsyncApiChannelDescriptor {
  id: string;
  address: string;
  transport: AsyncApiTransport;
  // Fully-resolved endpoint url the request points at (server + channel address).
  url: string;
  headers: AsyncApiKeyValue[];
  queryParams: AsyncApiKeyValue[];
  // Socket.IO namespace (the channel address) and handshake path (default /socket.io).
  socketioNamespace?: string;
  socketioPath?: string;
  messages: AsyncApiMessageDescriptor[];
  warnings: string[];
}

export interface AsyncApiContractIndex {
  title: string;
  version: string;
  channels: AsyncApiChannelDescriptor[];
  // The full document JSON, used as the $ref-resolution root when packing message schemas.
  documentJson: JsonRecord;
  warnings: string[];
}

export interface AsyncApiParseOptions {
  // Endpoint override applied when the document declares no usable server url.
  endpointUrl?: string;
  // Test-only Parser override; production uses the bundled parser.
  parser?: { parse(input: string): Promise<{ document?: unknown; diagnostics?: unknown[] }> };
}

const SOCKETIO_PROTOCOLS = new Set(['socketio', 'socket.io', 'sio']);
const DEFAULT_SOCKETIO_PATH = '/socket.io';
const SAMPLE_MAX_DEPTH = 5;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// The subset of the asyncapi-parser model surface we read. Kept minimal so the
// parser stays decoupled from the concrete dependency version.
interface DocumentModel {
  version(): string;
  info(): { title(): string } | undefined;
  servers(): { all(): ServerModel[] };
  channels(): { all(): ChannelModel[] };
  json(): JsonRecord;
}
interface ServerModel {
  id(): string;
  url(): string;
  protocol(): string;
  json(): JsonRecord;
}
interface ChannelModel {
  id(): string;
  address(): string | null | undefined;
  servers(): { all(): ServerModel[] };
  messages(): { all(): MessageModel[] };
  bindings(): { all(): BindingModel[] };
  json(): JsonRecord;
}
interface MessageModel {
  id(): string;
  name(): string | undefined;
  title(): string | undefined;
  contentType(): string | undefined;
  hasPayload(): boolean;
  payload(): SchemaModel | undefined;
  examples(): { all(): ExampleModel[] };
  json(): JsonRecord;
}
interface SchemaModel {
  json(): JsonRecord;
}
interface ExampleModel {
  hasPayload(): boolean;
  payload(): unknown;
}
interface BindingModel {
  protocol(): string;
  value<T = JsonRecord>(): T;
}

function joinUrl(base: string, address: string): string {
  const trimmedBase = base.replace(/\/+$/, '');
  const path = (address || '').trim();
  if (!path) return trimmedBase;
  if (!trimmedBase) return path;
  return `${trimmedBase}/${path.replace(/^\/+/, '')}`;
}

function contentKindFor(contentType: string | undefined): AsyncApiMessageDescriptor['contentKind'] {
  const ct = (contentType || '').toLowerCase();
  if (!ct || ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  if (ct.includes('text') || ct.includes('plain')) return 'text';
  return 'binary';
}

// Deterministic sample from a JSON Schema: prefers declared example/default/enum,
// otherwise synthesizes a minimal instance by type. Depth-capped and cycle-free
// (recursion is bounded by depth, not by tracking $refs, since parser schemas
// may be circular).
function sampleFromSchema(schema: unknown, depth: number): unknown {
  const record = asRecord(schema);
  if (!record) return record === null ? null : {};
  if (record.example !== undefined) return record.example;
  if (record.default !== undefined) return record.default;
  const examples = asArray<unknown>(record.examples);
  if (examples.length > 0) return examples[0];
  const enumValues = asArray<unknown>(record.enum);
  if (enumValues.length > 0) return enumValues[0];
  if (record.const !== undefined) return record.const;

  if (depth >= SAMPLE_MAX_DEPTH) return {};

  const type = Array.isArray(record.type)
    ? (record.type.find((t) => t !== 'null') as string | undefined)
    : (record.type as string | undefined);

  const composite = asArray<unknown>(record.allOf).concat(asArray<unknown>(record.anyOf), asArray<unknown>(record.oneOf));
  if (!type && composite.length > 0) return sampleFromSchema(composite[0], depth + 1);

  switch (type) {
    case 'object':
    case undefined: {
      const properties = asRecord(record.properties);
      if (!properties) return {};
      const required = new Set(asArray<string>(record.required));
      const out: JsonRecord = {};
      for (const [name, propSchema] of Object.entries(properties)) {
        // Prefer required props; include a bounded number of optionals for a
        // useful, still-deterministic sample.
        if (required.has(name) || Object.keys(out).length < 8) {
          out[name] = sampleFromSchema(propSchema, depth + 1);
        }
      }
      return out;
    }
    case 'array': {
      const items = Array.isArray(record.items) ? record.items[0] : record.items;
      return items === undefined ? [] : [sampleFromSchema(items, depth + 1)];
    }
    case 'string':
      return typeof record.format === 'string' ? `<${record.format}>` : 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return {};
  }
}

// Collect the ws binding's declared header/query property names as placeholder
// key/value pairs so the generated request carries the handshake fields for the
// operator to fill. The ws binding `headers`/`query` are SCHEMAS, not concrete
// values, so only names are recoverable; values are left blank.
function bindingKeyValues(bindingSchema: unknown): AsyncApiKeyValue[] {
  const properties = asRecord(asRecord(bindingSchema)?.properties);
  if (!properties) return [];
  return Object.keys(properties)
    .sort()
    .map((key) => ({ key, value: '' }));
}

function resolveServers(channel: ChannelModel, document: DocumentModel): ServerModel[] {
  const channelServers = channel.servers().all();
  return channelServers.length > 0 ? channelServers : document.servers().all();
}

function detectTransport(
  channel: ChannelModel,
  servers: ServerModel[],
  messagesRaw: MessageModel[],
  documentJson: JsonRecord,
  warnings: string[]
): AsyncApiTransport {
  const protocolSocketio = servers.some((server) => SOCKETIO_PROTOCOLS.has(server.protocol().toLowerCase()));
  if (protocolSocketio) return 'socketio';

  const channelJson = channel.json();
  const hasAck = messagesRaw.some((message) => asRecord(message.json())?.['x-ack'] !== undefined);
  const hasSocketioExt =
    channelJson['x-socketio'] !== undefined ||
    documentJson['x-socketio'] !== undefined ||
    asRecord(channelJson.bindings)?.socketio !== undefined;

  if (hasAck || hasSocketioExt) {
    warnings.push(
      `ASYNCAPI_SOCKETIO_CONVENTION: channel ${channel.id()} is treated as Socket.IO from convention (x-ack / x-socketio / protocol), not a normative AsyncAPI binding; event=message name, namespace=channel address, acknowledgement=x-ack`
    );
    return 'socketio';
  }
  return 'ws-raw';
}

function wsBindingKeyValues(channel: ChannelModel): { headers: AsyncApiKeyValue[]; queryParams: AsyncApiKeyValue[] } {
  const wsBinding = channel.bindings().all().find((binding) => {
    const protocol = binding.protocol().toLowerCase();
    return protocol === 'ws' || protocol === 'wss' || protocol === 'websockets';
  });
  if (!wsBinding) return { headers: [], queryParams: [] };
  const value = asRecord(wsBinding.value()) ?? {};
  return {
    headers: bindingKeyValues(value.headers),
    queryParams: bindingKeyValues(value.query)
  };
}

function messageDescriptor(message: MessageModel, warnings: string[], channelId: string): AsyncApiMessageDescriptor {
  const id = message.id() || message.name() || message.title() || 'message';
  const eventName = message.name() || message.title() || message.id() || channelId;
  const title = message.title() || message.name() || id;
  const contentType = message.contentType();
  const contentKind = contentKindFor(contentType);

  const payloadSchema = message.hasPayload() ? asRecord(message.payload()?.json()) ?? undefined : undefined;
  if (!payloadSchema) {
    warnings.push(`ASYNCAPI_MESSAGE_NO_PAYLOAD: message ${id} on channel ${channelId} declares no payload schema; its content is an empty sample and is not schema-validated`);
  }

  const rawMessage = asRecord(message.json()) ?? {};
  const ackSchema = asRecord(rawMessage['x-ack']) ?? undefined;

  const examples = message.examples().all().filter((example) => example.hasPayload());
  const hasExample = examples.length > 0;
  let sample: unknown;
  if (hasExample) {
    sample = examples[0].payload();
  } else if (payloadSchema) {
    sample = sampleFromSchema(payloadSchema, 0);
  } else {
    sample = {};
  }

  if (contentKind === 'binary') {
    warnings.push(`ASYNCAPI_BINARY_PAYLOAD_NOT_VALIDATED: message ${id} on channel ${channelId} has a binary/non-text content type (${contentType ?? 'unknown'}); its payload is not schema-validated`);
  }

  return {
    id,
    eventName,
    title,
    contentType,
    payloadSchema,
    ackSchema,
    sample,
    hasExample,
    contentKind,
    warnings: []
  };
}

function channelDescriptor(
  channel: ChannelModel,
  document: DocumentModel,
  documentJson: JsonRecord,
  options: AsyncApiParseOptions
): AsyncApiChannelDescriptor {
  const warnings: string[] = [];
  const address = (channel.address() || channel.id() || '').toString();
  const servers = resolveServers(channel, document);
  const messagesRaw = channel.messages().all();

  const transport = detectTransport(channel, servers, messagesRaw, documentJson, warnings);

  const serverUrl = servers.find((server) => server.url())?.url() || options.endpointUrl?.trim() || '';
  if (!serverUrl) {
    warnings.push(`ASYNCAPI_NO_SERVER_URL: channel ${channel.id()} has no resolvable server url; the generated request url is derived from the channel address only and must be completed before use`);
  }

  const messages = messagesRaw.map((message) => messageDescriptor(message, warnings, channel.id()));
  if (messages.length === 0) {
    warnings.push(`ASYNCAPI_CHANNEL_NO_MESSAGES: channel ${channel.id()} declares no messages; the generated request carries no message templates`);
  }

  if (transport === 'socketio') {
    return {
      id: channel.id(),
      address,
      transport,
      url: serverUrl || address,
      headers: [],
      queryParams: [],
      socketioNamespace: address.startsWith('/') ? address : `/${address}`,
      socketioPath: DEFAULT_SOCKETIO_PATH,
      messages,
      warnings
    };
  }

  const { headers, queryParams } = wsBindingKeyValues(channel);
  return {
    id: channel.id(),
    address,
    transport,
    url: joinUrl(serverUrl, address),
    headers,
    queryParams,
    messages,
    warnings
  };
}

function assertAsyncApi2(version: string): void {
  const match = /^2\.(\d+)/.exec(version);
  if (!match || Number(match[1]) > 6) {
    throw new Error(
      `ASYNCAPI_VERSION_UNSUPPORTED: AsyncAPI ${version || '<unknown>'} is not supported; only AsyncAPI 2.0.0-2.6.0 documents are ingested for WebSocket/Socket.IO contract generation`
    );
  }
}

export async function parseAsyncApi(content: string, options: AsyncApiParseOptions = {}): Promise<AsyncApiContractIndex> {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('ASYNCAPI_EMPTY_INPUT: AsyncAPI source is empty');
  }

  const parser = options.parser ?? new Parser();
  let output: { document?: unknown; diagnostics?: unknown[] };
  try {
    output = await parser.parse(content);
  } catch (error) {
    throw new Error(`ASYNCAPI_PARSE_FAILED: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const diagnostics = asArray<JsonRecord>(output.diagnostics);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error);
  if (!output.document) {
    const detail = errors.map((error) => String(error.message ?? '')).filter(Boolean).join('; ');
    throw new Error(`ASYNCAPI_PARSE_FAILED: document could not be parsed${detail ? `: ${detail}` : ''}`);
  }

  const document = output.document as unknown as DocumentModel;
  const version = document.version();
  assertAsyncApi2(version);

  const warnings: string[] = errors
    .map((error) => `ASYNCAPI_DIAGNOSTIC: ${String(error.message ?? '')}`)
    .filter((message) => message !== 'ASYNCAPI_DIAGNOSTIC: ');

  const documentJson = document.json();
  const title = document.info()?.title() || 'AsyncAPI';

  const channels = document
    .channels()
    .all()
    .map((channel) => channelDescriptor(channel, document, documentJson, options))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (channels.length === 0) {
    throw new Error('ASYNCAPI_NO_CHANNELS: AsyncAPI document defines no channels; WebSocket/Socket.IO contract generation requires at least one channel');
  }

  return {
    title,
    version,
    channels,
    documentJson,
    warnings
  };
}
