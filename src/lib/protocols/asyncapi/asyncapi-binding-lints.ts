// Generation-time binding-surface lints for AsyncAPI (2.0-2.6 / 3.0) documents,
// closing the assertion-catalog lanes asyncapi_generation_bindings_versions,
// asyncapi_generation_core_messages, asyncapi_generation_mqtt_core, and
// asyncapi_generation_ws_socketio. Every check walks the raw (dereferenced)
// document JSON and emits a deterministic ASYNCAPI_*-prefixed warning with its
// normative source named inline - never a hard failure - matching the
// doc-lints module's severity discipline. Binding READMEs are
// bindingVersion-scoped and non-normative; warnings grounded in them say so.

import { compileSchemaValidator } from '../../spec/schema-validator-code.js';
import { packSchema } from '../../spec/schema-pack.js';
import { IANA_WEBSOCKET_SUBPROTOCOLS, MEDIA_TYPE_NAME_RE } from './asyncapi-registries.js';
import type { AsyncApiContractIndex } from './asyncapi-parser.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// RFC 9110 section 5.6.2 token grammar (header field names).
const HTTP_TOKEN_RE = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/;

// Canonical AsyncAPI binding-object keys (bindings table of the AsyncAPI
// spec). Anything else that is not an x- extension is either an alias
// (for example "websockets") or a typo; either way per-protocol checks
// silently miss it, so it is surfaced.
const CANONICAL_BINDING_KEYS: ReadonlySet<string> = new Set([
  'http', 'ws', 'kafka', 'anypointmq', 'amqp', 'amqp1', 'mqtt', 'mqtt5', 'nats',
  'jms', 'sns', 'solace', 'sqs', 'stomp', 'redis', 'mercure', 'ibmmq',
  'googlepubsub', 'pulsar'
]);

// Published bindingVersion values per binding README (non-normative,
// bindingVersion-scoped sources). "latest" is always accepted.
const KNOWN_BINDING_VERSIONS: Record<string, ReadonlySet<string>> = {
  http: new Set(['0.1.0', '0.2.0', '0.3.0']),
  ws: new Set(['0.1.0']),
  mqtt: new Set(['0.1.0', '0.2.0']),
  mqtt5: new Set(['0.1.0', '0.2.0']),
  kafka: new Set(['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0']),
  amqp: new Set(['0.1.0', '0.2.0', '0.3.0'])
};

// Per-protocol scopes whose binding object is reserved-empty in the binding
// README ("This object MUST NOT contain any properties").
const RESERVED_EMPTY_SCOPES: Record<string, ReadonlySet<string>> = {
  ws: new Set(['server', 'operation', 'message']),
  http: new Set(['server', 'channel']),
  mqtt: new Set(['channel']),
  mqtt5: new Set(['channel', 'operation', 'message'])
};

// Known field sets per binding scope (binding READMEs; bindingVersion is
// implicit everywhere).
const KNOWN_BINDING_FIELDS: Record<string, Record<string, ReadonlySet<string>>> = {
  ws: { channel: new Set(['method', 'query', 'headers', 'bindingVersion']) },
  mqtt: {
    server: new Set(['clientId', 'cleanSession', 'lastWill', 'keepAlive', 'sessionExpiryInterval', 'maximumPacketSize', 'bindingVersion']),
    operation: new Set(['qos', 'retain', 'messageExpiryInterval', 'bindingVersion']),
    message: new Set(['payloadFormatIndicator', 'correlationData', 'contentType', 'responseTopic', 'bindingVersion'])
  },
  mqtt5: { server: new Set(['sessionExpiryInterval', 'bindingVersion']) },
  http: {
    operation: new Set(['type', 'method', 'query', 'statusCode', 'bindingVersion']),
    message: new Set(['headers', 'statusCode', 'bindingVersion'])
  }
};

// MQTT 5-only binding fields, per scope (MQTT 5.0 spec sections 3.1.2.11 /
// 3.3.2.3; absent from MQTT 3.1.1).
const MQTT5_ONLY_FIELDS: Record<string, ReadonlySet<string>> = {
  server: new Set(['sessionExpiryInterval', 'maximumPacketSize']),
  operation: new Set(['messageExpiryInterval']),
  message: new Set(['payloadFormatIndicator', 'correlationData', 'contentType', 'responseTopic'])
};

// Handshake headers owned by the WebSocket runtime (RFC 6455 section 4.1
// client MUSTs); an authored value cannot be honored by a conforming client.
const WS_RUNTIME_OWNED_HEADERS: ReadonlySet<string> = new Set([
  'host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-accept'
]);

const SERVER_PROTOCOL_FAMILY: Record<string, 'ws' | 'mqtt' | 'kafka' | 'http' | 'amqp'> = {
  ws: 'ws', wss: 'ws',
  mqtt: 'mqtt', mqtts: 'mqtt', 'secure-mqtt': 'mqtt', mqtt5: 'mqtt',
  kafka: 'kafka', 'kafka-secure': 'kafka',
  http: 'http', https: 'http',
  amqp: 'amqp', amqps: 'amqp'
};

const BINDING_KEY_FAMILY: Record<string, 'ws' | 'mqtt' | 'kafka' | 'http' | 'amqp'> = {
  ws: 'ws', mqtt: 'mqtt', mqtt5: 'mqtt', kafka: 'kafka', http: 'http', amqp: 'amqp'
};

interface BindingSite {
  scope: 'server' | 'channel' | 'operation' | 'message';
  label: string;
  bindings: JsonRecord;
  // v2 publish/subscribe keyword or v3 action, from the generated client's
  // perspective: 'send' when the generated item transmits the message.
  direction?: 'send' | 'receive';
}

interface WalkContext {
  index: AsyncApiContractIndex;
  doc: JsonRecord;
  warnings: string[];
  sites: BindingSite[];
  isV3: boolean;
  mqttVersions: Set<number>;
  socketIo: boolean;
}

function pushSite(ctx: WalkContext, site: BindingSite | null): void {
  if (site) ctx.sites.push(site);
}

function siteOf(scope: BindingSite['scope'], label: string, raw: unknown, direction?: 'send' | 'receive'): BindingSite | null {
  const bindings = asRecord(raw);
  if (!bindings) return null;
  return { scope, label, bindings, direction };
}

function collectSites(ctx: WalkContext): void {
  const { doc } = ctx;
  const servers = asRecord(doc.servers) ?? {};
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw);
    if (server) pushSite(ctx, siteOf('server', 'server ' + name, server.bindings));
  }
  const channels = asRecord(doc.channels) ?? {};
  for (const [chName, rawCh] of Object.entries(channels)) {
    const channel = asRecord(rawCh);
    if (!channel) continue;
    pushSite(ctx, siteOf('channel', 'channel ' + chName, channel.bindings));
    for (const opKeyword of ['publish', 'subscribe'] as const) {
      const op = asRecord(channel[opKeyword]);
      if (!op) continue;
      // v2 keywords, generated-client perspective: publish = the client
      // transmits to the channel; subscribe = the client receives.
      const direction = opKeyword === 'publish' ? 'send' : 'receive';
      pushSite(ctx, siteOf('operation', 'channel ' + chName + ' ' + opKeyword, op.bindings, direction));
      const message = asRecord(op.message);
      if (message) collectMessageSites(ctx, 'channel ' + chName + ' ' + opKeyword + ' message', message, direction);
    }
    const chMessages = asRecord(channel.messages);
    if (chMessages) {
      for (const [msgName, rawMsg] of Object.entries(chMessages)) {
        const message = asRecord(rawMsg);
        if (message) collectMessageSites(ctx, 'channel ' + chName + ' message ' + msgName, message, undefined);
      }
    }
  }
  const operations = asRecord(doc.operations) ?? {};
  for (const [opName, rawOp] of Object.entries(operations)) {
    const op = asRecord(rawOp);
    if (!op) continue;
    const direction = op.action === 'send' ? 'send' : op.action === 'receive' ? 'receive' : undefined;
    pushSite(ctx, siteOf('operation', 'operation ' + opName, op.bindings, direction));
  }
  const components = asRecord(doc.components) ?? {};
  const componentScopes: Array<[string, BindingSite['scope']]> = [
    ['serverBindings', 'server'], ['channelBindings', 'channel'],
    ['operationBindings', 'operation'], ['messageBindings', 'message']
  ];
  for (const [key, scope] of componentScopes) {
    const group = asRecord(components[key]) ?? {};
    for (const [name, raw] of Object.entries(group)) {
      pushSite(ctx, siteOf(scope, 'components.' + key + ' ' + name, raw));
    }
  }
  const compMessages = asRecord(components.messages) ?? {};
  for (const [name, raw] of Object.entries(compMessages)) {
    const message = asRecord(raw);
    if (message) collectMessageSites(ctx, 'components.messages ' + name, message, undefined);
  }
}

function collectMessageSites(ctx: WalkContext, label: string, message: JsonRecord, direction?: 'send' | 'receive'): void {
  pushSite(ctx, siteOf('message', label, message.bindings, direction));
  for (const entry of asArray(message.oneOf)) {
    const alt = asRecord(entry);
    if (alt) pushSite(ctx, siteOf('message', label + ' oneOf alternative', alt.bindings, direction));
  }
}

// ----- generic binding-key / bindingVersion / scope checks -----

function lintBindingSites(ctx: WalkContext): void {
  const { warnings } = ctx;
  const familiesSeen = new Map<string, string>();
  for (const site of ctx.sites) {
    const keys = Object.keys(site.bindings);
    const transportKeys = keys.filter((k) => BINDING_KEY_FAMILY[k] !== undefined);
    if (site.scope === 'channel' && new Set(transportKeys.map((k) => BINDING_KEY_FAMILY[k])).size > 1) {
      warnings.push(
        'ASYNCAPI_BINDING_TRANSPORT_AMBIGUOUS: ' + site.label + ' declares bindings for multiple generated transports (' + transportKeys.join(', ') + '); the generator emits exactly one EC item type per channel, so the losing binding is not exercised'
      );
    }
    for (const key of keys) {
      if (key.startsWith('x-')) continue;
      if (!CANONICAL_BINDING_KEYS.has(key)) {
        warnings.push(
          'ASYNCAPI_BINDING_KEY_UNKNOWN: ' + site.label + ' bindings key ' + JSON.stringify(key) + ' is not a canonical AsyncAPI binding key or x- extension; per-protocol checks cannot see it (AsyncAPI bindings table)'
        );
        continue;
      }
      const family = BINDING_KEY_FAMILY[key];
      if (family) familiesSeen.set(family, site.label + ' bindings.' + key);
      const binding = asRecord(site.bindings[key]);
      if (!binding) continue;
      if (key === 'mqtt5') {
        warnings.push(
          'ASYNCAPI_MQTT5_BINDING_DEPRECATED: ' + site.label + ' uses the deprecated mqtt5 binding key; the mqtt binding with server protocolVersion 5 supersedes it (mqtt binding README)'
        );
      }
      const reserved = RESERVED_EMPTY_SCOPES[key];
      const fieldKeys = Object.keys(binding).filter((k) => !k.startsWith('x-'));
      if (reserved?.has(site.scope) && fieldKeys.length > 0) {
        warnings.push(
          'ASYNCAPI_BINDING_SCOPE_RESERVED: ' + site.label + ' bindings.' + key + ' at ' + site.scope + ' scope must not contain properties; the ' + key + ' binding README reserves this object'
        );
        continue;
      }
      const version = binding.bindingVersion;
      const known = KNOWN_BINDING_VERSIONS[key];
      if (version === undefined) {
        if (known) {
          warnings.push(
            'ASYNCAPI_BINDING_VERSION_OMITTED: ' + site.label + ' bindings.' + key + ' omits bindingVersion, so it is interpreted as "latest"; pin a published version for deterministic interpretation (' + key + ' binding README)'
          );
        }
      } else if (known && typeof version === 'string' && version !== 'latest' && !known.has(version)) {
        // ws channel-scope versions are already covered by the existing
        // ASYNCAPI_WS_BINDING_VERSION_UNKNOWN check; do not double-report.
        if (!(key === 'ws' && site.scope === 'channel')) {
          warnings.push(
            'ASYNCAPI_BINDING_VERSION_UNKNOWN: ' + site.label + ' bindings.' + key + ' bindingVersion ' + JSON.stringify(version) + ' is not a published ' + key + ' binding version (' + key + ' binding README)'
          );
        }
      }
      const knownFields = KNOWN_BINDING_FIELDS[key]?.[site.scope];
      if (knownFields) {
        for (const field of fieldKeys) {
          if (!knownFields.has(field)) {
            warnings.push(
              'ASYNCAPI_BINDING_FIELD_UNKNOWN: ' + site.label + ' bindings.' + key + ' field ' + JSON.stringify(field) + ' is not defined for the ' + site.scope + ' scope (' + key + ' binding README)'
            );
          }
        }
      }
    }
  }
  // binding/server transport compatibility
  const serverFamilies = new Set<string>();
  for (const raw of Object.values(asRecord(ctx.doc.servers) ?? {})) {
    const server = asRecord(raw);
    const protocol = typeof server?.protocol === 'string' ? server.protocol.toLowerCase() : '';
    const family = SERVER_PROTOCOL_FAMILY[protocol];
    if (family) serverFamilies.add(family);
  }
  if (serverFamilies.size > 0) {
    for (const [family, where] of familiesSeen) {
      if (!serverFamilies.has(family)) {
        warnings.push(
          'ASYNCAPI_BINDING_TRANSPORT_MISMATCH: ' + where + ' targets the ' + family + ' transport but no declared server uses a ' + family + '-family protocol; the binding cannot take effect (AsyncAPI Server Object protocol)'
        );
      }
    }
  }
}

// ----- schema-valued binding fields: pack + compile -----

function compileBindingSchema(ctx: WalkContext, label: string, schema: unknown): ReturnType<typeof compileSchemaValidator> {
  const record = asRecord(schema);
  if (!record) return null;
  const packed = packSchema(ctx.doc, record, '3.0', 'response');
  if (packed.unsupported) {
    ctx.warnings.push('ASYNCAPI_BINDING_SCHEMA_NOT_VALIDATED: ' + label + ' schema is not validated (' + packed.unsupported + ')');
    return null;
  }
  const validate = compileSchemaValidator(packed.schema);
  if (!validate) {
    ctx.warnings.push('ASYNCAPI_BINDING_SCHEMA_NOT_VALIDATED: ' + label + ' schema could not be compiled to a validator');
  }
  return validate;
}

function schemaDeclaredValues(schema: JsonRecord): unknown[] {
  const values: unknown[] = [];
  if (schema.const !== undefined) values.push(schema.const);
  for (const v of asArray(schema.enum)) values.push(v);
  if (schema.default !== undefined) values.push(schema.default);
  for (const v of asArray(schema.examples)) values.push(v);
  return values;
}

// ----- ws channel binding + handshake-header checks -----

const WS_EXTENSION_TOKEN_RE = /^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_\x60|~0-9A-Za-z-]+(?:=(?:[!#$%&'*+.^_\x60|~0-9A-Za-z-]+|"[^"]*"))?)*$/;
const ORIGIN_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#\s]+$/;

function lintWsChannelBinding(ctx: WalkContext, label: string, binding: JsonRecord): void {
  const { warnings } = ctx;
  const method = binding.method;
  if (typeof method === 'string' && method.toUpperCase() === 'POST') {
    warnings.push(
      'ASYNCAPI_WS_METHOD_POST_UNSUPPORTED: ' + label + ' ws binding declares method POST; the Postman WebSocket handshake model performs a GET upgrade, so a POST handshake is not exercised (RFC 6455 section 4.1 uses GET)'
    );
  }
  for (const part of ['query', 'headers'] as const) {
    const schemaRaw = binding[part];
    if (schemaRaw === undefined) continue;
    const schema = asRecord(schemaRaw);
    if (!schema) continue;
    const properties = asRecord(schema.properties);
    if (!properties || Object.keys(properties).length === 0) {
      warnings.push(
        'ASYNCAPI_WS_BINDING_SCHEMA_NO_PROPERTIES: ' + label + ' ws binding ' + part + ' schema declares no properties; the generated handshake carries nothing from it (ws binding README: object schema with properties)'
      );
      continue;
    }
    compileBindingSchema(ctx, label + ' ws binding ' + part, schema);
    const required = new Set(asArray(schema.required).map(String).map((s) => s.toLowerCase()));
    for (const [name, rawProp] of Object.entries(properties)) {
      if (!HTTP_TOKEN_RE.test(name)) {
        warnings.push(
          'ASYNCAPI_BINDING_HEADER_NAME_INVALID: ' + label + ' ws binding ' + part + ' property ' + JSON.stringify(name) + ' is not a valid RFC 9110 token'
        );
      }
      if (part !== 'headers') continue;
      const lower = name.toLowerCase();
      const prop = asRecord(rawProp) ?? {};
      if (WS_RUNTIME_OWNED_HEADERS.has(lower)) {
        const detail = required.has(lower) ? 'is required by the binding but' : '';
        warnings.push(
          'ASYNCAPI_WS_HEADER_RUNTIME_OWNED: ' + label + ' ws binding headers property ' + name + ' ' + detail + ' is owned by the WebSocket handshake runtime and cannot be satisfied by an authored value (RFC 6455 section 4.1)'
        );
      }
      const declared = schemaDeclaredValues(prop).filter((v): v is string => typeof v === 'string');
      if (lower === 'sec-websocket-key' && (declared.length > 0 || prop.const !== undefined)) {
        warnings.push(
          'ASYNCAPI_WS_KEY_FIXED_NONCE: ' + label + ' fixes a Sec-WebSocket-Key value; the key MUST be a randomly selected nonce per connection (RFC 6455 section 4.1)'
        );
      }
      if (lower === 'sec-websocket-protocol') {
        for (const value of declared) {
          for (const token of value.split(',').map((t) => t.trim()).filter(Boolean)) {
            if (!IANA_WEBSOCKET_SUBPROTOCOLS.has(token)) {
              warnings.push(
                'ASYNCAPI_WS_SUBPROTOCOL_UNREGISTERED: ' + label + ' Sec-WebSocket-Protocol value ' + JSON.stringify(token) + ' is not in the IANA WebSocket subprotocol registry snapshot'
              );
            }
          }
        }
      }
      if (lower === 'sec-websocket-extensions') {
        for (const value of declared) {
          const ok = value.split(',').map((t) => t.trim()).filter(Boolean).every((ext) => WS_EXTENSION_TOKEN_RE.test(ext));
          if (!ok) {
            warnings.push(
              'ASYNCAPI_WS_EXTENSION_INVALID: ' + label + ' Sec-WebSocket-Extensions value ' + JSON.stringify(value) + ' does not match the RFC 6455 section 9.1 extension-list grammar'
            );
          }
        }
      }
      if (lower === 'origin') {
        for (const value of declared) {
          if (!ORIGIN_RE.test(value) && value !== 'null') {
            warnings.push(
              'ASYNCAPI_WS_ORIGIN_INVALID: ' + label + ' Origin value ' + JSON.stringify(value) + ' is not a serialized origin (scheme://host[:port]) or "null" (RFC 6454 section 6.1)'
            );
          }
        }
      }
    }
  }
}

// ----- channel address / final URL statics -----

function substituteTemplates(value: string): string {
  return value.replace(/\{[^}]*\}/g, 'x');
}

function lintChannelAddresses(ctx: WalkContext): void {
  const { doc, warnings } = ctx;
  const channels = asRecord(doc.channels) ?? {};
  const wsServers: Array<{ name: string; base: string }> = [];
  for (const [name, raw] of Object.entries(asRecord(doc.servers) ?? {})) {
    const server = asRecord(raw);
    if (!server) continue;
    const protocol = typeof server.protocol === 'string' ? server.protocol.toLowerCase() : '';
    if (SERVER_PROTOCOL_FAMILY[protocol] !== 'ws') continue;
    const url = typeof server.url === 'string' ? server.url
      : typeof server.host === 'string' ? protocol + '://' + server.host + (typeof server.pathname === 'string' ? server.pathname : '')
      : '';
    if (url) wsServers.push({ name, base: url });
  }
  for (const [chName, rawCh] of Object.entries(channels)) {
    const channel = asRecord(rawCh);
    if (!channel) continue;
    const address = ctx.isV3 ? channel.address : chName;
    if (typeof address !== 'string' || address.length === 0) continue;
    if (address.includes('?') || address.includes('#')) {
      warnings.push(
        'ASYNCAPI_CHANNEL_ADDRESS_INVALID: channel ' + chName + ' address ' + JSON.stringify(address) + ' embeds a query or fragment delimiter; channel addresses identify the channel, and query/fragment parts belong to bindings (AsyncAPI Channel Object address)'
      );
    }
    for (const server of wsServers) {
      const basePart = substituteTemplates(server.base.replace(/\/+$/, ''));
      const addressPart = substituteTemplates(address.startsWith('/') ? address : '/' + address);
      const joined = (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(basePart) ? basePart : 'ws://' + basePart) + addressPart;
      let parsed: URL | null = null;
      try {
        parsed = new URL(joined);
      } catch {
        warnings.push(
          'ASYNCAPI_WS_URL_INVALID: channel ' + chName + ' joined with server ' + server.name + ' produces ' + JSON.stringify(joined) + ', which does not parse as a URL'
        );
      }
      if (parsed) {
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
          warnings.push(
            'ASYNCAPI_WS_URL_INVALID: channel ' + chName + ' joined with server ' + server.name + ' resolves to scheme ' + parsed.protocol.replace(':', '') + '; ws-raw connections require ws or wss (RFC 6455 section 3)'
          );
        }
        if (parsed.hash) {
          warnings.push(
            'ASYNCAPI_WS_URL_INVALID: channel ' + chName + ' joined with server ' + server.name + ' carries fragment ' + JSON.stringify(parsed.hash) + '; ws URIs MUST NOT contain fragments (RFC 6455 section 3)'
          );
        }
      }
    }
  }
}

// ----- MQTT binding semantics -----

function collectMqttServerVersions(ctx: WalkContext): void {
  for (const raw of Object.values(asRecord(ctx.doc.servers) ?? {})) {
    const server = asRecord(raw);
    if (!server) continue;
    const protocol = typeof server.protocol === 'string' ? server.protocol.toLowerCase() : '';
    if (SERVER_PROTOCOL_FAMILY[protocol] !== 'mqtt') continue;
    if (protocol === 'mqtt5') { ctx.mqttVersions.add(5); continue; }
    const pv = typeof server.protocolVersion === 'string' ? server.protocolVersion : '';
    if (pv.startsWith('5')) ctx.mqttVersions.add(5);
    else if (pv.startsWith('3') || pv === '4') ctx.mqttVersions.add(4);
    else ctx.mqttVersions.add(0); // unknown
  }
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function lintMqttBindings(ctx: WalkContext): void {
  const { warnings } = ctx;
  const only3x = ctx.mqttVersions.size > 0 && !ctx.mqttVersions.has(5) && !ctx.mqttVersions.has(0);
  for (const site of ctx.sites) {
    const binding = asRecord(site.bindings.mqtt);
    if (!binding) continue;
    if (only3x) {
      const gated = MQTT5_ONLY_FIELDS[site.scope];
      if (gated) {
        for (const field of Object.keys(binding)) {
          if (gated.has(field)) {
            warnings.push(
              'ASYNCAPI_MQTT5_FIELD_ON_MQTT3: ' + site.label + ' mqtt binding field ' + field + ' is an MQTT 5 property, but every declared MQTT server is protocolVersion 3.x/4 (MQTT 5.0 vs 3.1.1 property sets)'
            );
          }
        }
      }
    }
    if (site.scope === 'server') {
      const clientId = binding.clientId;
      if (clientId !== undefined && typeof clientId !== 'string' && !asRecord(clientId)) {
        warnings.push('ASYNCAPI_MQTT_CLIENT_ID_INVALID: ' + site.label + ' mqtt binding clientId must be a string or schema object (mqtt binding README)');
      }
      if (typeof clientId === 'string') {
        const bytes = utf8ByteLength(clientId);
        if (bytes > 65535) {
          warnings.push('ASYNCAPI_MQTT_CLIENT_ID_INVALID: ' + site.label + ' mqtt binding clientId exceeds the 65535-byte UTF-8 string ceiling (MQTT 3.1.1/5.0 section 1.5.4)');
        } else if (bytes > 23 && only3x) {
          warnings.push('ASYNCAPI_MQTT_CLIENT_ID_LENGTH_ADVISORY: ' + site.label + ' mqtt binding clientId is ' + bytes + ' UTF-8 bytes; MQTT 3.1.1 servers are only required to accept 1-23 byte [0-9a-zA-Z] ClientIds (MQTT 3.1.1 section 3.1.3.1)');
        }
        if (clientId === '' && only3x && binding.cleanSession !== true) {
          warnings.push('ASYNCAPI_MQTT_CLIENT_ID_EMPTY_REQUIRES_CLEAN_SESSION: ' + site.label + ' mqtt binding declares an empty clientId without cleanSession true; MQTT 3.1.1 requires CleanSession 1 for zero-byte ClientIds (MQTT 3.1.1 section 3.1.3.1)');
        }
      } else if (asRecord(clientId)) {
        compileBindingSchema(ctx, site.label + ' mqtt binding clientId', clientId);
      }
      const lastWill = binding.lastWill;
      if (lastWill !== undefined) {
        const will = asRecord(lastWill);
        if (!will) {
          warnings.push('ASYNCAPI_MQTT_LAST_WILL_INVALID: ' + site.label + ' mqtt binding lastWill must be an object (mqtt binding README)');
        } else {
          if (typeof will.topic !== 'string' || will.topic.length === 0) {
            warnings.push('ASYNCAPI_MQTT_LAST_WILL_INVALID: ' + site.label + ' mqtt binding lastWill omits a topic; a Will requires both Will Topic and Will Message (MQTT 3.1.1 section 3.1.3.2)');
          }
          if (will.message !== undefined && typeof will.message !== 'string') {
            warnings.push('ASYNCAPI_MQTT_LAST_WILL_INVALID: ' + site.label + ' mqtt binding lastWill.message must be a string (mqtt binding README)');
          }
          if (typeof will.message === 'string' && utf8ByteLength(will.message) > 65535) {
            warnings.push('ASYNCAPI_MQTT_LAST_WILL_INVALID: ' + site.label + ' mqtt binding lastWill.message exceeds the 65535-byte binary-data ceiling (MQTT 3.1.1 section 1.5.4)');
          }
        }
      }
      for (const [field, max] of [['sessionExpiryInterval', 4294967295], ['maximumPacketSize', 268435455]] as const) {
        const value = binding[field];
        if (asRecord(value)) compileBindingSchema(ctx, site.label + ' mqtt binding ' + field, value);
        else if (typeof value === 'number' && value > max) {
          warnings.push('ASYNCAPI_MQTT_VALUE_OUT_OF_RANGE: ' + site.label + ' mqtt binding ' + field + ' ' + value + ' exceeds the MQTT wire ceiling ' + max);
        }
      }
    }
    if (site.scope === 'operation') {
      const expiry = binding.messageExpiryInterval;
      if (asRecord(expiry)) compileBindingSchema(ctx, site.label + ' mqtt binding messageExpiryInterval', expiry);
      else if (typeof expiry === 'number' && expiry > 4294967295) {
        warnings.push('ASYNCAPI_MQTT_VALUE_OUT_OF_RANGE: ' + site.label + ' mqtt binding messageExpiryInterval ' + expiry + ' exceeds the four-byte-integer ceiling 4294967295 (MQTT 5.0 section 3.3.2.3.3)');
      }
      if (site.direction === 'receive') {
        for (const field of ['retain', 'messageExpiryInterval']) {
          if (binding[field] !== undefined) {
            warnings.push(
              'ASYNCAPI_MQTT_PUBLISH_FIELD_ON_RECEIVE: ' + site.label + ' mqtt binding field ' + field + ' only applies when the generated client publishes, but this operation receives (MQTT PUBLISH properties)'
            );
          }
        }
      }
    }
    if (site.scope === 'message') {
      const contentType = binding.contentType;
      if (typeof contentType === 'string' && !MEDIA_TYPE_NAME_RE.test(contentType.split(';')[0].trim())) {
        warnings.push('ASYNCAPI_MQTT_CONTENT_TYPE_INVALID: ' + site.label + ' mqtt binding contentType ' + JSON.stringify(contentType) + ' is not RFC 6838 type/subtype syntax (MQTT 5.0 section 3.3.2.3.9)');
      }
      const correlationData = binding.correlationData;
      if (asRecord(correlationData)) {
        compileBindingSchema(ctx, site.label + ' mqtt binding correlationData', correlationData);
        const maxLength = asRecord(correlationData)?.maxLength;
        if (typeof maxLength === 'number' && maxLength > 65535) {
          warnings.push('ASYNCAPI_MQTT_CORRELATION_DATA_TOO_LONG: ' + site.label + ' mqtt binding correlationData maxLength ' + maxLength + ' exceeds the 65535-byte binary-data ceiling (MQTT 5.0 section 1.5.6)');
        }
      }
      const responseTopic = binding.responseTopic;
      if (asRecord(responseTopic)) compileBindingSchema(ctx, site.label + ' mqtt binding responseTopic', responseTopic);
      const pfi = binding.payloadFormatIndicator;
      if (pfi === 1) {
        const message = siteMessageRecord(ctx, site);
        // The payload bytes come from the message serialization, so a binary
        // declaration on either the binding or the message conflicts with
        // PFI 1 regardless of which one the generator prefers.
        const declaredTypes = [binding.contentType, message?.contentType, ctx.doc.defaultContentType]
          .filter((t): t is string => typeof t === 'string');
        const binaryType = declaredTypes.find((t) => /octet-stream|binary|protobuf|avro/i.test(t));
        if (binaryType !== undefined) {
          warnings.push(
            'ASYNCAPI_MQTT_PFI_UTF8_CONFLICT: ' + site.label + ' declares payloadFormatIndicator 1 (UTF-8 payload) but content type ' + JSON.stringify(binaryType) + ' is binary (MQTT 5.0 section 3.3.2.3.2)'
          );
        }
      }
      if (typeof contentType === 'string') {
        const message = siteMessageRecord(ctx, site);
        const messageType = typeof message?.contentType === 'string' ? message.contentType
          : typeof ctx.doc.defaultContentType === 'string' ? ctx.doc.defaultContentType : undefined;
        if (messageType !== undefined && normalizeMediaType(messageType) !== normalizeMediaType(contentType)) {
          warnings.push(
            'ASYNCAPI_MQTT_CONTENT_TYPE_CONFLICT: ' + site.label + ' mqtt binding contentType ' + JSON.stringify(contentType) + ' disagrees with the message content type ' + JSON.stringify(messageType) + '; the generator prefers the binding value (MQTT 5.0 section 3.3.2.3.9)'
          );
        }
      }
    }
  }
}

function normalizeMediaType(value: string): string {
  return value.split(';')[0].trim().toLowerCase();
}

// The message record a message-scope binding site belongs to, recovered from
// the site label being a strict prefix walk; sites carry only the binding
// object, so the owning message is refetched for contentType comparison.
function siteMessageRecord(ctx: WalkContext, site: BindingSite): JsonRecord | null {
  // Walk all messages and match by binding object identity.
  const doc = ctx.doc;
  const matches = (message: JsonRecord | null): boolean => {
    return message !== null && asRecord(message.bindings)?.mqtt === site.bindings.mqtt;
  };
  for (const rawCh of Object.values(asRecord(doc.channels) ?? {})) {
    const channel = asRecord(rawCh);
    if (!channel) continue;
    for (const opKeyword of ['publish', 'subscribe']) {
      const op = asRecord(channel[opKeyword]);
      const message = asRecord(op?.message);
      if (matches(message)) return message;
      for (const entry of asArray(message?.oneOf)) {
        const alt = asRecord(entry);
        if (matches(alt)) return alt;
      }
    }
    for (const rawMsg of Object.values(asRecord(channel.messages) ?? {})) {
      const message = asRecord(rawMsg);
      if (matches(message)) return message;
    }
  }
  for (const rawMsg of Object.values(asRecord(asRecord(doc.components)?.messages) ?? {})) {
    const message = asRecord(rawMsg);
    if (matches(message)) return message;
  }
  return null;
}

// ----- http binding schema checks -----

function lintHttpBindings(ctx: WalkContext): void {
  for (const site of ctx.sites) {
    const binding = asRecord(site.bindings.http);
    if (!binding) continue;
    if (site.scope === 'operation' && binding.query !== undefined) {
      const schema = asRecord(binding.query);
      const properties = asRecord(schema?.properties);
      if (!schema || !properties || Object.keys(properties).length === 0) {
        ctx.warnings.push(
          'ASYNCAPI_HTTP_BINDING_SCHEMA_NO_PROPERTIES: ' + site.label + ' http binding query must be an object schema with properties (http binding README)'
        );
      } else {
        compileBindingSchema(ctx, site.label + ' http binding query', schema);
        for (const name of Object.keys(properties)) {
          if (!HTTP_TOKEN_RE.test(name)) {
            ctx.warnings.push('ASYNCAPI_BINDING_HEADER_NAME_INVALID: ' + site.label + ' http binding query property ' + JSON.stringify(name) + ' is not a valid RFC 9110 token');
          }
        }
      }
    }
    if (site.scope === 'message' && binding.headers !== undefined) {
      const schema = asRecord(binding.headers);
      const properties = asRecord(schema?.properties);
      if (!schema || !properties || Object.keys(properties).length === 0) {
        ctx.warnings.push(
          'ASYNCAPI_HTTP_BINDING_SCHEMA_NO_PROPERTIES: ' + site.label + ' http binding headers must be an object schema with properties (http binding README)'
        );
      } else {
        compileBindingSchema(ctx, site.label + ' http binding headers', schema);
        for (const name of Object.keys(properties)) {
          if (!HTTP_TOKEN_RE.test(name)) {
            ctx.warnings.push('ASYNCAPI_BINDING_HEADER_NAME_INVALID: ' + site.label + ' http binding headers property ' + JSON.stringify(name) + ' is not a valid RFC 9110 token');
          }
        }
      }
    }
  }
}

// ----- message-object lints (core_messages lane) -----

const WS_PROTOCOL_HEADER_DENYLIST: ReadonlySet<string> = new Set([
  'host', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
  'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'
]);
const HTTP_PROTOCOL_HEADER_DENYLIST: ReadonlySet<string> = new Set([
  'content-length', 'transfer-encoding', 'host', 'connection', 'upgrade'
]);

interface MessageEntry {
  label: string;
  message: JsonRecord;
  channelMessages: JsonRecord[] | null;
}

function collectMessages(ctx: WalkContext): MessageEntry[] {
  const out: MessageEntry[] = [];
  const doc = ctx.doc;
  for (const [chName, rawCh] of Object.entries(asRecord(doc.channels) ?? {})) {
    const channel = asRecord(rawCh);
    if (!channel) continue;
    const siblingList: JsonRecord[] = [];
    const push = (label: string, raw: unknown): void => {
      const message = asRecord(raw);
      if (!message) return;
      siblingList.push(message);
      out.push({ label, message, channelMessages: siblingList });
    };
    for (const opKeyword of ['publish', 'subscribe']) {
      const op = asRecord(channel[opKeyword]);
      const message = asRecord(op?.message);
      if (!message) continue;
      const alternatives = asArray(message.oneOf);
      if (alternatives.length > 0) {
        alternatives.forEach((entry, i) => push('channel ' + chName + ' ' + opKeyword + ' message oneOf#' + i, entry));
      } else {
        push('channel ' + chName + ' ' + opKeyword + ' message', message);
      }
    }
    for (const [msgName, rawMsg] of Object.entries(asRecord(channel.messages) ?? {})) {
      push('channel ' + chName + ' message ' + msgName, rawMsg);
    }
  }
  for (const [name, raw] of Object.entries(asRecord(asRecord(doc.components)?.messages) ?? {})) {
    const message = asRecord(raw);
    if (message) out.push({ label: 'components.messages ' + name, message, channelMessages: null });
  }
  return out;
}

function effectiveMessageId(message: JsonRecord): string | undefined {
  if (typeof message.messageId === 'string') return message.messageId;
  let fromTraits: string | undefined;
  for (const entry of asArray(message.traits)) {
    const trait = asRecord(entry);
    if (trait && typeof trait.messageId === 'string') fromTraits = trait.messageId;
  }
  return fromTraits;
}

function lintMessages(ctx: WalkContext): void {
  const { warnings } = ctx;
  const entries = collectMessages(ctx);
  const idOwners = new Map<string, string>();
  const reportedIds = new Set<string>();
  const validatorCache = new Map<JsonRecord, ((value: unknown) => boolean) | null>();

  const validatorFor = (message: JsonRecord): ((value: unknown) => boolean) | null => {
    if (validatorCache.has(message)) return validatorCache.get(message) ?? null;
    let validate: ((value: unknown) => boolean) | null = null;
    const payload = asRecord(message.payload);
    if (payload) {
      const packed = packSchema(ctx.doc, payload, '3.0', 'response');
      if (!packed.unsupported) {
        validate = compileSchemaValidator(packed.schema);
      }
    }
    validatorCache.set(message, validate);
    return validate;
  };

  for (const { label, message, channelMessages } of entries) {
    // messageId uniqueness, traits included (AsyncAPI 2.6 Message Object).
    const id = effectiveMessageId(message);
    if (id !== undefined) {
      const owner = idOwners.get(id);
      if (owner !== undefined && owner !== label && !reportedIds.has(id)) {
        reportedIds.add(id);
        warnings.push('ASYNCAPI_MESSAGE_ID_DUPLICATE: messageId ' + JSON.stringify(id) + ' is declared by both ' + owner + ' and ' + label + '; messageId MUST be unique across the application (AsyncAPI Message Object)');
      }
      if (owner === undefined) idOwners.set(id, label);
    }

    // headers schema: object typing plus unconditional pack/compile.
    const headers = asRecord(message.headers);
    if (headers) {
      compileBindingSchema(ctx, label + ' headers', headers);
      const properties = asRecord(headers.properties) ?? {};
      for (const name of Object.keys(properties)) {
        if (!HTTP_TOKEN_RE.test(name)) {
          warnings.push('ASYNCAPI_BINDING_HEADER_NAME_INVALID: ' + label + ' headers property ' + JSON.stringify(name) + ' is not a valid RFC 9110 token');
        }
        const lower = name.toLowerCase();
        if (ctx.socketIo || hasWsSurface(ctx)) {
          if (WS_PROTOCOL_HEADER_DENYLIST.has(lower)) {
            warnings.push('ASYNCAPI_MESSAGE_HEADER_PROTOCOL_OWNED: ' + label + ' headers property ' + name + ' is a WebSocket handshake header, not an application header; the AsyncAPI Message Object headers carry application data (RFC 6455 section 4.1)');
          }
        }
        if (HTTP_PROTOCOL_HEADER_DENYLIST.has(lower)) {
          warnings.push('ASYNCAPI_MESSAGE_HEADER_PROTOCOL_OWNED: ' + label + ' headers property ' + name + ' is a transport-owned HTTP header, not an application header (RFC 9110 section 7.6.1 lists connection-level fields)');
        }
      }
    }

    // headers-only examples: the parser keeps payload examples, so validate
    // headers examples statically here.
    const headerValidate = headers ? (() => {
      const packed = packSchema(ctx.doc, headers, '3.0', 'response');
      if (packed.unsupported) return null;
      return compileSchemaValidator(packed.schema);
    })() : null;
    asArray(message.examples).forEach((entry, i) => {
      const example = asRecord(entry);
      if (!example) return;
      if (example.payload === undefined && example.headers !== undefined) {
        if (headerValidate) {
          if (!headerValidate(example.headers)) {
            warnings.push('ASYNCAPI_MESSAGE_HEADER_EXAMPLE_MISMATCH: ' + label + ' example #' + i + ' headers do not validate against the message headers schema');
          }
        } else if (headers) {
          warnings.push('ASYNCAPI_MESSAGE_HEADER_EXAMPLE_NOT_VALIDATED: ' + label + ' example #' + i + ' is headers-only and the headers schema could not be compiled');
        }
      }
      // sibling exclusivity: an example that also validates against another
      // message of the same channel is ambiguous for readers and tooling.
      if (example.payload !== undefined && channelMessages && channelMessages.length > 1) {
        const own = validatorFor(message);
        if (own && own(example.payload)) {
          const alsoMatches = channelMessages.filter((sibling) => sibling !== message).filter((sibling) => {
            const sv = validatorFor(sibling);
            return sv ? sv(example.payload) : false;
          });
          if (alsoMatches.length > 0) {
            warnings.push('ASYNCAPI_MESSAGE_EXAMPLE_AMBIGUOUS: ' + label + ' example #' + i + ' payload also validates against ' + alsoMatches.length + ' sibling message schema(s) on the same channel; discriminating fields keep multi-message channels deterministic');
          }
        }
      }
    });

    // trait shape rules.
    const traits = asArray(message.traits);
    const traitKeyValues = new Map<string, unknown>();
    traits.forEach((entry, i) => {
      const trait = asRecord(entry);
      if (!trait) return;
      if (trait.traits !== undefined) {
        warnings.push('ASYNCAPI_TRAIT_FORBIDDEN_FIELD: ' + label + ' trait #' + i + ' declares "traits"; a Message Trait Object cannot itself carry traits (AsyncAPI Message Trait Object)');
      }
      for (const [key, value] of Object.entries(trait)) {
        if (key === 'payload' || key === 'traits') continue;
        if (traitKeyValues.has(key) && JSON.stringify(traitKeyValues.get(key)) !== JSON.stringify(value)) {
          warnings.push('ASYNCAPI_TRAIT_MERGE_ORDER_SENSITIVE: ' + label + ' traits assign conflicting values for ' + JSON.stringify(key) + '; traits are merged in declaration order (JSON Merge Patch, RFC 7386), so the last value wins');
        }
        traitKeyValues.set(key, value);
        if (ctx.isV3 && message[key] !== undefined && JSON.stringify(message[key]) !== JSON.stringify(value)) {
          warnings.push('ASYNCAPI_TRAIT_OVERRIDE: ' + label + ' trait #' + i + ' sets ' + JSON.stringify(key) + ' which the message already defines with a different value; AsyncAPI 3.0 traits MUST NOT override target properties');
        }
      }
    });
  }

  // v2 operation traits: forbidden fields.
  for (const [chName, rawCh] of Object.entries(asRecord(ctx.doc.channels) ?? {})) {
    const channel = asRecord(rawCh);
    if (!channel) continue;
    for (const opKeyword of ['publish', 'subscribe']) {
      const op = asRecord(channel[opKeyword]);
      if (!op) continue;
      asArray(op.traits).forEach((entry, i) => {
        const trait = asRecord(entry);
        if (!trait) return;
        for (const forbidden of ['message', 'traits']) {
          if (trait[forbidden] !== undefined) {
            warnings.push('ASYNCAPI_TRAIT_FORBIDDEN_FIELD: channel ' + chName + ' ' + opKeyword + ' trait #' + i + ' declares ' + JSON.stringify(forbidden) + '; an Operation Trait Object cannot define it (AsyncAPI Operation Trait Object)');
          }
        }
      });
    }
  }
  // v3 operation traits + channel/messages subset + reply rules.
  const channelsRecord = asRecord(ctx.doc.channels) ?? {};
  const channelValues = Object.values(channelsRecord).map(asRecord).filter((c): c is JsonRecord => c !== null);
  for (const [opName, rawOp] of Object.entries(asRecord(ctx.doc.operations) ?? {})) {
    const op = asRecord(rawOp);
    if (!op) continue;
    asArray(op.traits).forEach((entry, i) => {
      const trait = asRecord(entry);
      if (!trait) return;
      for (const forbidden of ['action', 'channel', 'traits']) {
        if (trait[forbidden] !== undefined) {
          warnings.push('ASYNCAPI_TRAIT_FORBIDDEN_FIELD: operation ' + opName + ' trait #' + i + ' declares ' + JSON.stringify(forbidden) + '; an Operation Trait Object cannot define it (AsyncAPI 3.0 Operation Trait Object)');
        }
      }
    });
    const opChannel = asRecord(op.channel);
    if (opChannel && channelValues.length > 0 && !channelValues.includes(opChannel)) {
      warnings.push('ASYNCAPI_OPERATION_CHANNEL_UNRESOLVED: operation ' + opName + ' channel does not resolve to a declared channel of this document (AsyncAPI 3.0 Operation Object channel)');
    }
    if (opChannel) {
      const channelMessages = Object.values(asRecord(opChannel.messages) ?? {}).map(asRecord).filter((m): m is JsonRecord => m !== null);
      const opMessages = asArray(op.messages).map(asRecord).filter((m): m is JsonRecord => m !== null);
      for (const opMessage of opMessages) {
        const inChannel = channelMessages.some((cm) => cm === opMessage || JSON.stringify(cm) === JSON.stringify(opMessage));
        if (!inChannel) {
          warnings.push('ASYNCAPI_OPERATION_MESSAGE_NOT_IN_CHANNEL: operation ' + opName + ' references a message that is not part of its channel; operation messages MUST be a subset of the channel messages (AsyncAPI 3.0 Operation Object messages)');
        }
      }
    }
    const reply = asRecord(op.reply);
    if (reply) {
      const replyChannel = asRecord(reply.channel);
      const replyAddress = asRecord(reply.address);
      if (replyAddress && replyChannel && typeof replyChannel.address === 'string' && replyChannel.address.length > 0) {
        warnings.push('ASYNCAPI_REPLY_ADDRESS_CONFLICT: operation ' + opName + ' reply declares a dynamic reply address while its reply channel pins address ' + JSON.stringify(replyChannel.address) + '; a dynamic reply channel address SHOULD be null (AsyncAPI 3.0 Operation Reply Object)');
      }
      if (replyChannel) {
        const replyChannelMessages = Object.values(asRecord(replyChannel.messages) ?? {}).map(asRecord).filter((m): m is JsonRecord => m !== null);
        const replyMessages = asArray(reply.messages).map(asRecord).filter((m): m is JsonRecord => m !== null);
        for (const replyMessage of replyMessages) {
          const inChannel = replyChannelMessages.some((cm) => cm === replyMessage || JSON.stringify(cm) === JSON.stringify(replyMessage));
          if (!inChannel) {
            warnings.push('ASYNCAPI_REPLY_MESSAGE_NOT_IN_CHANNEL: operation ' + opName + ' reply references a message that is not part of the reply channel (AsyncAPI 3.0 Operation Reply Object messages)');
          }
        }
      }
    }
  }
}

function hasWsSurface(ctx: WalkContext): boolean {
  for (const raw of Object.values(asRecord(ctx.doc.servers) ?? {})) {
    const server = asRecord(raw);
    const protocol = typeof server?.protocol === 'string' ? server.protocol.toLowerCase() : '';
    if (SERVER_PROTOCOL_FAMILY[protocol] === 'ws') return true;
  }
  return false;
}

// ----- security scheme lints (core_messages lane) -----

const HTTP_API_KEY_LOCATIONS = new Set(['query', 'header', 'cookie']);
const API_KEY_LOCATIONS_V2 = new Set(['user', 'password']);
// Scheme types a generated ws/mqtt/http artifact can carry material for.
const SYNTHESIZABLE_SCHEME_TYPES = new Set(['http', 'httpApiKey', 'apiKey', 'userPassword']);

function lintSecuritySchemes(ctx: WalkContext): void {
  const { warnings } = ctx;
  const schemes = asRecord(asRecord(ctx.doc.components)?.securitySchemes) ?? {};
  const oauthLikeNames = new Set<string>();
  const unsatisfiable: string[] = [];
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = asRecord(raw);
    if (!scheme) continue;
    const type = typeof scheme.type === 'string' ? scheme.type : '';
    if (type === 'oauth2' || type === 'openIdConnect') oauthLikeNames.add(name);
    if (type === 'http' && typeof scheme.scheme === 'string' && !HTTP_TOKEN_RE.test(scheme.scheme)) {
      warnings.push('ASYNCAPI_SECURITY_SCHEME_INVALID: security scheme ' + name + ' http scheme ' + JSON.stringify(scheme.scheme) + ' is not a valid RFC 9110 auth-scheme token');
    }
    if (type === 'httpApiKey' && (typeof scheme.in !== 'string' || !HTTP_API_KEY_LOCATIONS.has(scheme.in))) {
      warnings.push('ASYNCAPI_SECURITY_SCHEME_INVALID: security scheme ' + name + ' httpApiKey "in" must be query, header, or cookie (AsyncAPI Security Scheme Object)');
    }
    if (type === 'apiKey' && typeof scheme.in === 'string' && !API_KEY_LOCATIONS_V2.has(scheme.in) && !HTTP_API_KEY_LOCATIONS.has(scheme.in)) {
      warnings.push('ASYNCAPI_SECURITY_SCHEME_INVALID: security scheme ' + name + ' apiKey "in" ' + JSON.stringify(scheme.in) + ' is not a defined location (AsyncAPI Security Scheme Object)');
    }
    if (type === 'openIdConnect') {
      const url = scheme.openIdConnectUrl;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        warnings.push('ASYNCAPI_SECURITY_URL_INVALID: security scheme ' + name + ' openIdConnectUrl must be an absolute URL (AsyncAPI Security Scheme Object)');
      }
    }
    if (type === 'oauth2') {
      const flows = asRecord(scheme.flows) ?? {};
      for (const [flowName, rawFlow] of Object.entries(flows)) {
        const flow = asRecord(rawFlow);
        if (!flow) continue;
        for (const field of ['authorizationUrl', 'tokenUrl', 'refreshUrl']) {
          const url = flow[field];
          if (url !== undefined && (typeof url !== 'string' || !/^https?:\/\//.test(url))) {
            warnings.push('ASYNCAPI_SECURITY_URL_INVALID: security scheme ' + name + ' ' + flowName + ' flow ' + field + ' must be an absolute URL (AsyncAPI OAuth Flow Object)');
          }
        }
      }
    }
    if (type && !SYNTHESIZABLE_SCHEME_TYPES.has(type)) {
      unsatisfiable.push(name + ' (' + type + ')');
    }
  }
  if (unsatisfiable.length > 0) {
    warnings.push('ASYNCAPI_SECURITY_NOT_SYNTHESIZED: generated collection items carry no credential material for security scheme(s) ' + unsatisfiable.join(', ') + '; connections that enforce them must be configured manually');
  }
  // security requirement value shapes (v2 server.security).
  for (const [serverName, raw] of Object.entries(asRecord(ctx.doc.servers) ?? {})) {
    const server = asRecord(raw);
    if (!server) continue;
    asArray(server.security).forEach((entry, i) => {
      const requirement = asRecord(entry);
      if (!requirement) return;
      for (const [schemeName, value] of Object.entries(requirement)) {
        if (!Array.isArray(value)) {
          warnings.push('ASYNCAPI_SECURITY_REQUIREMENT_INVALID: server ' + serverName + ' security requirement #' + i + ' value for ' + schemeName + ' must be an array (AsyncAPI Security Requirement Object)');
          continue;
        }
        if (value.some((scope) => typeof scope !== 'string')) {
          warnings.push('ASYNCAPI_SECURITY_REQUIREMENT_INVALID: server ' + serverName + ' security requirement #' + i + ' scopes for ' + schemeName + ' must be strings (AsyncAPI Security Requirement Object)');
        }
        if (value.length > 0 && !oauthLikeNames.has(schemeName) && asRecord(schemes[schemeName])) {
          warnings.push('ASYNCAPI_SECURITY_REQUIREMENT_INVALID: server ' + serverName + ' security requirement #' + i + ' lists scopes for non-OAuth scheme ' + schemeName + '; the array MUST be empty for such schemes (AsyncAPI Security Requirement Object)');
        }
      }
    });
  }
}

// ----- Socket.IO conventions -----

function lintSocketIo(ctx: WalkContext): void {
  if (!ctx.socketIo) return;
  const { warnings, doc } = ctx;
  const xSocketIo = asRecord(doc['x-socketio']) ?? {};
  const declaredVersion = xSocketIo.version ?? xSocketIo.eio ?? xSocketIo.EIO;
  if (declaredVersion !== undefined && String(declaredVersion) !== '4') {
    warnings.push('ASYNCAPI_SOCKETIO_VERSION_UNSUPPORTED: x-socketio declares version ' + JSON.stringify(declaredVersion) + ' but generated Socket.IO items target Socket.IO v4 / Engine.IO 4');
  }
  const path = xSocketIo.path;
  if (typeof path === 'string' && path !== '/socket.io/' && path !== '/socket.io') {
    warnings.push('ASYNCAPI_SOCKETIO_PATH_UNSUPPORTED: x-socketio declares path ' + JSON.stringify(path) + ' but generated Socket.IO items connect on the default /socket.io/ path');
  }
  for (const [chName, rawCh] of Object.entries(asRecord(doc.channels) ?? {})) {
    const channel = asRecord(rawCh);
    if (!channel) continue;
    const address = ctx.isV3 ? (typeof channel.address === 'string' ? channel.address : '') : chName;
    if (address && address !== '/' && !address.startsWith('/')) {
      warnings.push('ASYNCAPI_SOCKETIO_NAMESPACE_INVALID: channel ' + chName + ' implies Socket.IO namespace ' + JSON.stringify(address) + ', which does not begin with "/" (Socket.IO namespaces are /-rooted)');
    } else if (address && address !== '/') {
      warnings.push('ASYNCAPI_SOCKETIO_NAMESPACE_NOT_ROUTED: channel ' + chName + ' implies Socket.IO namespace ' + JSON.stringify(address) + ' but generated items connect to the root namespace');
    }
    // ws binding query EIO/transport pinning.
    const wsBinding = asRecord(asRecord(channel.bindings)?.ws);
    const queryProps = asRecord(asRecord(wsBinding?.query)?.properties) ?? {};
    for (const [propName, rawProp] of Object.entries(queryProps)) {
      const prop = asRecord(rawProp);
      if (!prop) continue;
      const declared = schemaDeclaredValues(prop).map(String);
      if (propName === 'EIO' && declared.some((v) => v !== '4')) {
        warnings.push('ASYNCAPI_SOCKETIO_QUERY_PINNED: channel ' + chName + ' pins EIO=' + declared.join('/') + '; generated Socket.IO v4 items negotiate EIO=4');
      }
      if (propName === 'transport' && declared.some((v) => v !== 'websocket')) {
        warnings.push('ASYNCAPI_SOCKETIO_QUERY_PINNED: channel ' + chName + ' pins transport=' + declared.join('/') + '; generated Socket.IO items use the websocket transport');
      }
    }
  }
  for (const channel of ctx.index.channels) {
    if (channel.transport !== 'socketio') continue;
    for (const message of channel.messages) {
      if (!message.eventName || message.eventName.trim().length === 0) {
        warnings.push('ASYNCAPI_SOCKETIO_EVENT_NAME_EMPTY: channel ' + channel.id + ' carries a message with an empty event name; Socket.IO events require a non-empty name');
      }
      if (message.contentKind === 'binary') {
        warnings.push('ASYNCAPI_SOCKETIO_BINARY_NOT_SYNTHESIZED: channel ' + channel.id + ' message ' + message.id + ' is binary; generated Socket.IO events carry placeholder text arguments, not binary attachments');
      }
      const ack = asRecord(message.ackSchema);
      if (ack) {
        const declaredType = Array.isArray(ack.type) ? ack.type.map(String) : ack.type !== undefined ? [String(ack.type)] : [];
        if (declaredType.length > 0 && !declaredType.includes('array')) {
          warnings.push('ASYNCAPI_SOCKETIO_ACK_NOT_ARRAY: channel ' + channel.id + ' message ' + message.id + ' declares a non-array acknowledgement schema; Socket.IO acknowledgement callbacks receive an argument array, so a scalar/object schema describes only the first argument');
        }
      }
    }
  }
}

export function lintAsyncApiBindingSurfaces(index: AsyncApiContractIndex): string[] {
  const doc = asRecord(index.documentJson);
  if (!doc) return [];
  const ctx: WalkContext = {
    index,
    doc,
    warnings: [],
    sites: [],
    isV3: typeof doc.asyncapi === 'string' && doc.asyncapi.startsWith('3.'),
    mqttVersions: new Set(),
    socketIo: index.channels.some((channel) => channel.transport === 'socketio')
  };
  collectSites(ctx);
  collectMqttServerVersions(ctx);
  lintBindingSites(ctx);
  lintChannelAddresses(ctx);
  lintMqttBindings(ctx);
  lintHttpBindings(ctx);
  lintMessages(ctx);
  lintSecuritySchemes(ctx);
  lintSocketIo(ctx);
  // ws channel bindings need channel labels; walk them directly.
  for (const site of ctx.sites) {
    if (site.scope !== 'channel') continue;
    const wsBinding = asRecord(site.bindings.ws);
    if (wsBinding) lintWsChannelBinding(ctx, site.label, wsBinding);
  }
  return ctx.warnings;
}
