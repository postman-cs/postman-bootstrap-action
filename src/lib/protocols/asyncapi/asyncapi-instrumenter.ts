// Generation-time (static) contract validation for the built AsyncAPI WS /
// Socket.IO EC collection.
//
// WebSocket/Socket.IO EC items carry no test-script slot (their `extensions`
// expose only documentation/auth, never `events`) and the Postman CLI runner
// prunes ws-* item types, so there is no runtime pm.test surface to instrument.
// The contract check is therefore performed here at generation time: each
// message payload example is validated against its packed AsyncAPI message schema
// (the async analogue of the OAS CONTRACT_EXAMPLE_SCHEMA_MISMATCH self-consistency
// check), the acknowledgement / 3.x reply schema is compiled, channel/message
// coverage is enforced, and the collection size gate is applied. Discipline
// mirrors the OAS and gRPC modules: no silent drops - anything not
// deterministically checkable emits an ASYNCAPI_*-prefixed warning.
//
// Non-JSON payloads: an AsyncAPI message example `payload` is a STRUCTURED value
// that MUST validate against the payload schema regardless of the wire content
// type (the content type governs serialization, not the example's structure). So
// the example value is validated for every non-binary content kind (json, xml,
// text, html). The only genuinely uncheckable cases are binary (opaque bytes) and
// a raw wire-string example supplied for a non-string schema; both emit a precise
// warning rather than a false failure.

import { compileSchemaValidator } from '../../spec/schema-validator-code.js';
import { packSchema, isSchemaGraphOverflow } from '../../spec/schema-pack.js';
import { lintAsyncApiDocument } from './asyncapi-doc-lints.js';
import { lintAsyncApiBindingSurfaces } from './asyncapi-binding-lints.js';
import { WS_BINDING_VERSIONS, isAsyncApiRuntimeExpression } from './asyncapi-registries.js';
import type { AsyncApiChannelDescriptor, AsyncApiContractIndex, AsyncApiMessageDescriptor } from './asyncapi-parser.js';

type JsonRecord = Record<string, unknown>;

export interface AsyncApiInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

export const ASYNCAPI_INSTRUMENT_LIMITS = {
  maxCollectionUpdateBytes: 4_000_000
} as const;

const MESSAGE_NODE_TYPES = new Set(['ws-raw-message', 'ws-socketio-message', 'mqtt-message']);

// Base64 well-formedness: canonical base64 (optionally padded), byte-aligned.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Whether a packed schema permits a JSON string primitive at its root. Used to
// decide if a raw wire-string example (contentKind text/html/xml) can be
// structurally validated against the schema, or if it is a wire-encoded string
// for a structured schema (uncheckable). Conservative: only true when the schema
// clearly allows a string and does not require object/array structure.
function schemaAllowsStringInstance(schema: unknown): boolean {
  const record = asRecord(schema);
  if (!record) return false;
  const declared = record.type;
  const types = Array.isArray(declared) ? declared.map(String) : declared !== undefined ? [String(declared)] : [];
  if (types.includes('object') || types.includes('array')) return false;
  if (types.includes('string')) return true;
  // enum / const of strings, or a bare string-constraint schema with no object/array type.
  const enumValues = asArray(record.enum);
  if (enumValues.length > 0 && enumValues.every((v) => typeof v === 'string')) return true;
  if (typeof record.const === 'string') return true;
  if (types.length === 0) {
    const stringKeys = ['pattern', 'minLength', 'maxLength', 'format'];
    if (stringKeys.some((key) => record[key] !== undefined)) return true;
  }
  return false;
}

function validateMessage(
  index: AsyncApiContractIndex,
  channelId: string,
  message: AsyncApiMessageDescriptor,
  warnings: string[]
): void {
  if (message.payloadSchema) {
    const packed = packSchema(index.documentJson, message.payloadSchema, '3.0', 'response');
    if (packed.unsupported) {
      const code = isSchemaGraphOverflow(packed) ? 'ASYNCAPI_SCHEMA_NOT_COMPILED' : 'ASYNCAPI_MESSAGE_SCHEMA_NOT_VALIDATED';
      warnings.push(`${code}: message ${message.id} on channel ${channelId} payload schema is not validated (${packed.unsupported})`);
    } else {
      const validate = compileSchemaValidator(packed.schema);
      if (!validate) {
        warnings.push(`ASYNCAPI_MESSAGE_SCHEMA_NOT_VALIDATED: message ${message.id} on channel ${channelId} payload schema could not be compiled to a validator`);
      } else if (!message.hasExample) {
        warnings.push(`ASYNCAPI_MESSAGE_NO_EXAMPLE: message ${message.id} on channel ${channelId} declares no example; its generated content is synthesized from the schema and is not asserted for spec self-consistency`);
      } else if (message.contentKind === 'binary') {
        // Binary example content is opaque bytes; JSON-schema structural
        // validation does not apply. Verify the emitted base64 is well-formed
        // when the example is a string, else surface the limitation honestly.
        if (typeof message.sample === 'string' && !BASE64_RE.test(message.sample)) {
          warnings.push(`ASYNCAPI_BINARY_EXAMPLE_MALFORMED: message ${message.id} on channel ${channelId} binary example is not valid base64`);
        } else {
          warnings.push(`ASYNCAPI_BINARY_PAYLOAD_NOT_VALIDATED: message ${message.id} on channel ${channelId} has binary content; its opaque example is not structurally validated against the payload schema`);
        }
      } else if (typeof message.sample === 'string' && message.contentKind !== 'json' && !schemaAllowsStringInstance(packed.schema)) {
        // A raw wire-string example supplied for a structured (object/array)
        // schema: the string is the serialized wire form, not the structural
        // value, so it cannot be validated against the schema without a
        // content-type-specific decoder. Warn rather than false-fail.
        warnings.push(`ASYNCAPI_NON_JSON_PAYLOAD_NOT_VALIDATED: message ${message.id} on channel ${channelId} has a raw ${message.contentKind} string example for a structured schema; it is not structurally validated against the payload schema`);
      } else if (!validate(message.sample)) {
        // json, xml, text, html: the example value is validated structurally
        // against the packed payload schema.
        warnings.push(`ASYNCAPI_MESSAGE_SCHEMA_MISMATCH: message ${message.id} on channel ${channelId} example payload does not validate against its own AsyncAPI payload schema; the generated request content will not satisfy the contract`);
      }
    }
  }

  if (message.ackSchema) {
    const source = message.ackSource === 'reply' ? 'reply (request/reply)' : 'acknowledgement (x-ack)';
    const packedAck = packSchema(index.documentJson, message.ackSchema, '3.0', 'request');
    if (packedAck.unsupported) {
      warnings.push(`ASYNCAPI_ACK_SCHEMA_NOT_VALIDATED: message ${message.id} on channel ${channelId} ${source} schema is not validated (${packedAck.unsupported})`);
    } else if (!compileSchemaValidator(packedAck.schema)) {
      warnings.push(`ASYNCAPI_ACK_SCHEMA_NOT_VALIDATED: message ${message.id} on channel ${channelId} ${source} schema could not be compiled to a validator`);
    }
  }
}

// Unpaired UTF-16 surrogate half: never encodable as well-formed UTF-8, which
// MQTT requires for topics and client identifiers ([MQTT-1.5.4-1]).
const UNPAIRED_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// MQTT topic-name grammar (MQTT 3.1.1 §4.7 / MQTT 5.0 §4.7): at least one
// character, no U+0000, well-formed UTF-8 ([MQTT-1.5.4-1/2]), at most 65535
// UTF-8 bytes. Wildcards make it a topic FILTER: '+' must occupy an entire
// level; '#' must be the last character and occupy an entire level. Returns a
// violation description, or null when valid.
function mqttTopicViolation(topic: string, allowWildcards: boolean): string | null {
  if (topic.length === 0) return 'is empty (a topic must contain at least one character)';
  if (topic.includes('\u0000')) return 'contains U+0000, forbidden in MQTT topics ([MQTT-1.5.4-2])';
  if (UNPAIRED_SURROGATE_RE.test(topic)) return 'contains an unpaired UTF-16 surrogate half, so it cannot be encoded as the well-formed UTF-8 MQTT requires ([MQTT-1.5.4-1])';
  if (Buffer.byteLength(topic, 'utf8') > 65535) return 'exceeds 65535 UTF-8 bytes';
  const hasWildcard = /[+#]/.test(topic);
  if (!hasWildcard) return null;
  if (!allowWildcards) return 'contains wildcard characters (+/#), which are forbidden in a concrete topic name';
  const levels = topic.split('/');
  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i];
    if (level.includes('+') && level !== '+') return `level "${level}" mixes '+' with other characters; '+' must occupy an entire level`;
    if (level.includes('#') && (level !== '#' || i !== levels.length - 1)) {
      return `'#' must be the final level and occupy it entirely`;
    }
  }
  return null;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

// Shared subscription topic filters: $share/{ShareName}/{filter} with a
// non-empty ShareName free of '/', '+', '#' (MQTT 5.0 §4.8.2). Returns a
// violation description, or null when valid.
function mqttSharedSubscriptionViolation(topic: string): string | null {
  const rest = topic.slice('$share/'.length);
  const separator = rest.indexOf('/');
  const shareName = separator === -1 ? rest : rest.slice(0, separator);
  if (shareName.length === 0) return 'has an empty ShareName; a shared subscription is $share/{ShareName}/{filter} with a non-empty ShareName';
  if (/[+#]/.test(shareName)) return `has ShareName "${shareName}" containing a wildcard character; ShareName must not contain '/', '+', or '#'`;
  if (separator === -1 || rest.slice(separator + 1).length === 0) return 'is missing the topic filter after $share/{ShareName}/; a shared subscription is $share/{ShareName}/{filter}';
  return null;
}

function checkMqttBindingValues(
  binding: JsonRecord,
  scope: string,
  channelId: string,
  warnings: string[]
): void {
  const bad = (field: string, expectation: string): void => {
    warnings.push(`ASYNCAPI_MQTT_BINDING_INVALID: channel ${channelId} ${scope} binding ${field} ${expectation} (got ${JSON.stringify(binding[field])})`);
  };
  if (binding.qos !== undefined && ![0, 1, 2].includes(binding.qos as number)) bad('qos', 'must be 0, 1, or 2');
  if (binding.retain !== undefined && typeof binding.retain !== 'boolean') bad('retain', 'must be a boolean');
  if (binding.messageExpiryInterval !== undefined && !isNonNegativeInteger(binding.messageExpiryInterval)) bad('messageExpiryInterval', 'must be a non-negative integer (seconds)');
  if (binding.cleanSession !== undefined && typeof binding.cleanSession !== 'boolean') bad('cleanSession', 'must be a boolean');
  if (binding.keepAlive !== undefined && !isIntegerInRange(binding.keepAlive, 0, 65535)) bad('keepAlive', 'must be an integer in 0-65535 (seconds, MQTT two-byte Keep Alive)');
  if (binding.sessionExpiryInterval !== undefined && !isIntegerInRange(binding.sessionExpiryInterval, 0, 4294967295) && asRecord(binding.sessionExpiryInterval) === null) bad('sessionExpiryInterval', 'must be an integer in 0-4294967295 (seconds, MQTT 5.0 four-byte property) or a schema object');
  if (binding.maximumPacketSize !== undefined && !isIntegerInRange(binding.maximumPacketSize, 1, 268435455) && asRecord(binding.maximumPacketSize) === null) bad('maximumPacketSize', 'must be an integer in 1-268435455 (bytes, MQTT 5.0 packet size limit) or a schema object');
  if (binding.payloadFormatIndicator !== undefined && binding.payloadFormatIndicator !== 0 && binding.payloadFormatIndicator !== 1) bad('payloadFormatIndicator', 'must be 0 (unspecified bytes) or 1 (UTF-8)');
  if (binding.contentType !== undefined && typeof binding.contentType !== 'string') bad('contentType', 'must be a string');
  if (typeof binding.responseTopic === 'string') {
    const violation = mqttTopicViolation(binding.responseTopic, false);
    if (violation) warnings.push(`ASYNCAPI_MQTT_TOPIC_INVALID: channel ${channelId} ${scope} binding responseTopic "${binding.responseTopic}" ${violation}`);
  } else if (binding.responseTopic !== undefined && asRecord(binding.responseTopic) === null) {
    bad('responseTopic', 'must be a string or a schema object');
  }
  if (binding.correlationData !== undefined) {
    // MQTT 5.0 correlation data is binary (§3.3.2.3.6), so the binding schema
    // should describe a base64/binary string.
    const correlationData = asRecord(binding.correlationData);
    if (!correlationData) {
      bad('correlationData', 'must be a Schema Object describing the binary correlation data');
    } else if (correlationData.type !== 'string' || (correlationData.format !== 'byte' && correlationData.format !== 'binary')) {
      warnings.push(
        `ASYNCAPI_MQTT_BINDING_INVALID: channel ${channelId} ${scope} binding correlationData schema should be type string with format byte or binary (MQTT 5.0 correlation data is binary, §3.3.2.3.6); got type ${JSON.stringify(correlationData.type)} format ${JSON.stringify(correlationData.format)}`
      );
    }
  }
  const lastWill = asRecord(binding.lastWill);
  if (lastWill) {
    if (typeof lastWill.topic === 'string') {
      const violation = mqttTopicViolation(lastWill.topic, false);
      if (violation) warnings.push(`ASYNCAPI_MQTT_TOPIC_INVALID: channel ${channelId} ${scope} binding lastWill.topic "${lastWill.topic}" ${violation}`);
    }
    if (lastWill.qos !== undefined && ![0, 1, 2].includes(lastWill.qos as number)) {
      warnings.push(`ASYNCAPI_MQTT_BINDING_INVALID: channel ${channelId} ${scope} binding lastWill.qos must be 0, 1, or 2 (got ${JSON.stringify(lastWill.qos)})`);
    }
    if (lastWill.retain !== undefined && typeof lastWill.retain !== 'boolean') {
      warnings.push(`ASYNCAPI_MQTT_BINDING_INVALID: channel ${channelId} ${scope} binding lastWill.retain must be a boolean (got ${JSON.stringify(lastWill.retain)})`);
    }
  }
}

// Whether a channel carries a publish-direction operation: a 2.x `publish`
// operation, or a 3.0 operation with action `send` bound to the channel. The
// published message must then target a concrete topic NAME ([MQTT-3.3.2-2]);
// subscribe/receive channels may keep wildcard filters.
function channelHasPublishDirection(documentJson: JsonRecord, channelId: string): boolean {
  const channel = asRecord(asRecord(documentJson.channels)?.[channelId]);
  if (channel?.publish !== undefined) return true;
  const unescapePointer = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');
  const operations = asRecord(documentJson.operations) ?? {};
  for (const operationRaw of Object.values(operations)) {
    const operation = asRecord(operationRaw);
    if (!operation || operation.action !== 'send') continue;
    const opChannel = asRecord(operation.channel);
    if (!opChannel) continue;
    // The parser dereferences local $refs, so identity (or the parser's stable
    // object id) matches the operation to its channel; a surviving $ref is
    // matched by its last pointer segment.
    if (channel && opChannel === channel) return true;
    const uid = opChannel['x-parser-unique-object-id'];
    if (uid !== undefined && channel && uid === channel['x-parser-unique-object-id']) return true;
    const ref = typeof opChannel.$ref === 'string' ? opChannel.$ref : '';
    if (ref && unescapePointer(ref.slice(ref.lastIndexOf('/') + 1)) === channelId) return true;
  }
  return false;
}

// Generation-time MQTT contract checks: channel-address topic grammar
// (direction-aware for wildcards), shared-subscription shape, client
// identifier UTF-8/interop rules, and AsyncAPI MQTT binding value ranges.
// Violations are warnings, matching the module's no-silent-drop discipline
// for statically checkable contract facts.
function validateMqttChannel(channel: AsyncApiChannelDescriptor, documentJson: JsonRecord, warnings: string[]): void {
  const addressViolation = mqttTopicViolation(channel.address, true);
  if (addressViolation) {
    warnings.push(`ASYNCAPI_MQTT_TOPIC_INVALID: channel ${channel.id} address "${channel.address}" ${addressViolation}`);
  } else if (channel.address.startsWith('$share/')) {
    const sharedViolation = mqttSharedSubscriptionViolation(channel.address);
    if (sharedViolation) {
      warnings.push(`ASYNCAPI_MQTT_SHARED_SUBSCRIPTION_INVALID: channel ${channel.id} address "${channel.address}" ${sharedViolation} (MQTT 5.0 §4.8.2)`);
    }
  } else if (/[+#]/.test(channel.address)) {
    if (channelHasPublishDirection(documentJson, channel.id)) {
      warnings.push(
        `ASYNCAPI_MQTT_PUBLISH_TOPIC_WILDCARD: channel ${channel.id} address "${channel.address}" contains wildcard characters but the channel carries a publish (2.x) / send (3.0) operation; a published topic name must not contain wildcards ([MQTT-3.3.2-2])`
      );
    } else {
      warnings.push(`ASYNCAPI_MQTT_TOPIC_FILTER: channel ${channel.id} address "${channel.address}" is a wildcard topic filter; it is generated as a subscription and any publish must target a concrete topic`);
    }
  }
  const mqtt = channel.mqtt;
  if (!mqtt) return;
  for (const binding of mqtt.serverBindings) {
    if (typeof binding.clientId !== 'string') continue;
    if (binding.clientId.includes('\u0000') || UNPAIRED_SURROGATE_RE.test(binding.clientId)) {
      warnings.push(
        `ASYNCAPI_MQTT_CLIENTID_INVALID: channel ${channel.id} server binding clientId ${JSON.stringify(binding.clientId)} contains U+0000 or an unpaired surrogate half, forbidden by the MQTT UTF-8 string rules ([MQTT-1.5.4-1], [MQTT-1.5.4-2])`
      );
    } else if (binding.clientId.length > 23 || !/^[0-9a-zA-Z]*$/.test(binding.clientId)) {
      warnings.push(
        `ASYNCAPI_MQTT_CLIENTID_INTEROP: channel ${channel.id} server binding clientId ${JSON.stringify(binding.clientId)} falls outside the baseline server-interoperable set (1-23 characters of [0-9a-zA-Z]); servers MAY accept more but are not required to (MQTT §3.1.3.1)`
      );
    }
  }
  mqtt.operationBindings.forEach((binding) => checkMqttBindingValues(binding, 'operation', channel.id, warnings));
  mqtt.serverBindings.forEach((binding) => checkMqttBindingValues(binding, 'server', channel.id, warnings));
  mqtt.messageBindings.forEach(({ messageId, binding }) => checkMqttBindingValues(binding, `message ${messageId}`, channel.id, warnings));
}

// Collect the identity of every materialized message node. Each node carries a
// deterministic id derived from `msg:<channelId>:<messageId>`, so gathering ids
// lets coverage catch a drop-and-duplicate (which a count-only check misses: the
// total stays equal while a duplicated id collapses the unique set).
function collectMessageNodeIds(node: JsonRecord, ids: string[], path: string): void {
  if (MESSAGE_NODE_TYPES.has(String(node.type))) {
    const id = typeof node.id === 'string' && node.id ? node.id : `${path}#${ids.length}`;
    ids.push(id);
  }
  const children = node.children !== undefined ? asArray(node.children) : asArray(node.item);
  children.forEach((child, i) => {
    const record = asRecord(child);
    if (record) collectMessageNodeIds(record, ids, `${path}/${i}`);
  });
}

// AsyncAPI channel-parameter conformance: every {name} expression in a channel
// address MUST have an entry in the channel's parameters object (AsyncAPI 2.x
// section "Channel Item Object" / 3.x "Channel Object"), and a declared
// parameter that never appears in the address is dead spec. Violations are
// warnings, matching the module's no-silent-drop discipline.
function validateChannelParameters(channel: AsyncApiChannelDescriptor, warnings: string[]): void {
  const declared = new Set(channel.parameterNames ?? []);
  const used = new Set<string>();
  for (const match of channel.address.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1] ?? '';
    if (!name) {
      warnings.push(`ASYNCAPI_CHANNEL_PARAMETER_INVALID: channel ${channel.id} address ${channel.address} contains an empty {} parameter expression`);
      continue;
    }
    used.add(name);
    if (!declared.has(name)) {
      warnings.push(`ASYNCAPI_CHANNEL_PARAMETER_UNDECLARED: channel ${channel.id} address parameter {${name}} has no entry in the channel parameters object; AsyncAPI requires every address parameter to be declared`);
    }
  }
  for (const name of declared) {
    if (!used.has(name)) {
      warnings.push(`ASYNCAPI_CHANNEL_PARAMETER_UNUSED: channel ${channel.id} declares parameter ${name} that never appears in the channel address ${channel.address}`);
    }
  }
}

// AsyncAPI correlationId `location` is a normative runtime expression:
// $message.header#/<json-pointer> or $message.payload#/<json-pointer> (RFC 6901
// fragment). Any other shape can never be resolved by a consumer. The shared
// grammar helper also covers parameter/reply-address locations in the
// document-level lints.
function validateCorrelationLocation(channelId: string, message: AsyncApiMessageDescriptor, warnings: string[]): void {
  if (message.correlationLocation === undefined) return;
  if (!isAsyncApiRuntimeExpression(message.correlationLocation)) {
    warnings.push(
      `ASYNCAPI_CORRELATION_LOCATION_INVALID: message ${message.id} on channel ${channelId} correlationId location ${JSON.stringify(message.correlationLocation)} is not a valid AsyncAPI runtime expression ($message.header#/<pointer> or $message.payload#/<pointer>)`
    );
  }
}

// Socket.IO reserves these event names for its own lifecycle (emit cheatsheet /
// socket-instance docs); an application event carrying one can never be
// emitted or received, so a spec that names one describes an impossible contract.
const SOCKETIO_RESERVED_EVENTS = new Set(['connect', 'connect_error', 'disconnect', 'disconnecting', 'newListener', 'removeListener']);

// AsyncAPI WebSockets channel-binding value ranges (binding spec): method MUST
// be GET or POST, and query/headers MUST be Schema Objects of type object.
function validateWsBinding(channel: AsyncApiChannelDescriptor, warnings: string[]): void {
  const binding = channel.wsBinding;
  if (!binding) return;
  const method = binding.method;
  if (method !== undefined && (typeof method !== 'string' || (method !== 'GET' && method !== 'POST'))) {
    warnings.push(`ASYNCAPI_WS_BINDING_INVALID: channel ${channel.id} ws binding method must be "GET" or "POST" but was ${JSON.stringify(method)}`);
  }
  for (const key of ['query', 'headers'] as const) {
    const schema = binding[key];
    if (schema === undefined) continue;
    const record = asRecord(schema);
    if (!record || (record.type !== undefined && record.type !== 'object')) {
      warnings.push(`ASYNCAPI_WS_BINDING_INVALID: channel ${channel.id} ws binding ${key} must be a Schema Object of type object`);
    }
  }
  const bindingVersion = binding.bindingVersion;
  if (bindingVersion !== undefined && (typeof bindingVersion !== 'string' || !WS_BINDING_VERSIONS.has(bindingVersion))) {
    warnings.push(
      `ASYNCAPI_WS_BINDING_VERSION_UNKNOWN: channel ${channel.id} ws binding bindingVersion ${JSON.stringify(bindingVersion)} is not a published WebSockets binding version (known: 0.1.0, latest; ws binding README, bindingVersion-scoped, non-normative source)`
    );
  }
}

export function instrumentAsyncApiCollection(
  collection: JsonRecord,
  index: AsyncApiContractIndex
): AsyncApiInstrumentationResult {
  const warnings: string[] = [
    ...index.warnings,
    ...index.channels.flatMap((channel) => channel.warnings),
    ...lintAsyncApiDocument(index),
    ...lintAsyncApiBindingSurfaces(index)
  ];

  for (const channel of index.channels) {
    validateChannelParameters(channel, warnings);
    if (channel.transport === 'mqtt') validateMqttChannel(channel, index.documentJson, warnings);
    if (channel.transport === 'ws-raw') validateWsBinding(channel, warnings);
    for (const message of channel.messages) {
      if (channel.transport === 'socketio' && SOCKETIO_RESERVED_EVENTS.has(message.eventName)) {
        warnings.push(
          `ASYNCAPI_SOCKETIO_RESERVED_EVENT: message ${message.id} on channel ${channel.id} uses the reserved Socket.IO event name "${message.eventName}"; reserved lifecycle events cannot be emitted or received as application events`
        );
      }
      validateCorrelationLocation(channel.id, message, warnings);
      validateMessage(index, channel.id, message, warnings);
    }
  }

  // Coverage: every indexed message must be materialized as a message node in the
  // built collection. A mismatch means the builder dropped or duplicated a
  // message, so fail closed rather than ship an incomplete contract collection.
  const expected = index.channels.reduce((sum, channel) => sum + channel.messages.length, 0);
  const ids: string[] = [];
  asArray(collection.item).forEach((entry, i) => {
    const record = asRecord(entry);
    if (record) collectMessageNodeIds(record, ids, `item/${i}`);
  });
  const unique = new Set(ids).size;
  if (ids.length !== expected || unique !== expected) {
    throw new Error(
      `ASYNCAPI_MESSAGE_COVERAGE_FAILED: built collection has ${ids.length} message item(s) (${unique} distinct) but the AsyncAPI index has ${expected}; generated contract collection is incomplete or duplicated`
    );
  }

  const bytes = Buffer.byteLength(JSON.stringify(collection), 'utf8');
  if (bytes > ASYNCAPI_INSTRUMENT_LIMITS.maxCollectionUpdateBytes) {
    throw new Error(`ASYNCAPI_COLLECTION_SIZE_EXCEEDED: built AsyncAPI collection exceeded ${ASYNCAPI_INSTRUMENT_LIMITS.maxCollectionUpdateBytes} bytes`);
  }

  return { collection, warnings: [...new Set(warnings)] };
}
