// Generation-time (static) contract validation for the built AsyncAPI WS /
// Socket.IO EC collection.
//
// WebSocket/Socket.IO EC items carry no test-script slot (their `extensions`
// expose only documentation/auth, never `events`) and the Postman CLI runner
// prunes ws-* item types, so there is no runtime pm.test surface to instrument.
// The contract check is therefore performed here at generation time: each
// message payload is validated against its packed AsyncAPI message schema (the
// async analogue of the OAS CONTRACT_EXAMPLE_SCHEMA_MISMATCH self-consistency
// check), channel/message coverage is enforced, and the collection size gate is
// applied. Discipline mirrors the OAS and gRPC modules: no silent drops -
// anything not deterministically checkable emits an ASYNCAPI_*-prefixed warning.

import { compileSchemaValidator } from '../../spec/schema-validator-code.js';
import { packSchema, isSchemaGraphOverflow } from '../../spec/schema-pack.js';
import type { AsyncApiContractIndex, AsyncApiMessageDescriptor } from './asyncapi-parser.js';

type JsonRecord = Record<string, unknown>;

export interface AsyncApiInstrumentationResult {
  collection: JsonRecord;
  warnings: string[];
}

export const ASYNCAPI_INSTRUMENT_LIMITS = {
  maxCollectionUpdateBytes: 4_000_000
} as const;

const MESSAGE_NODE_TYPES = new Set(['ws-raw-message', 'ws-socketio-message']);

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
      } else if (message.contentKind === 'json') {
        if (!validate(message.sample)) {
          warnings.push(`ASYNCAPI_MESSAGE_SCHEMA_MISMATCH: message ${message.id} on channel ${channelId} example payload does not validate against its own AsyncAPI payload schema; the generated request content will not satisfy the contract`);
        }
      } else {
        // Non-JSON (text/xml/html) example content cannot be checked against a
        // JSON Schema validator; warn rather than silently skip or false-fail.
        warnings.push(`ASYNCAPI_NON_JSON_PAYLOAD_NOT_VALIDATED: message ${message.id} on channel ${channelId} has ${message.contentKind} content; its example is not validated against the payload schema`);
      }
    }
  }

  if (message.ackSchema) {
    const packedAck = packSchema(index.documentJson, message.ackSchema, '3.0', 'request');
    if (packedAck.unsupported) {
      warnings.push(`ASYNCAPI_ACK_SCHEMA_NOT_VALIDATED: message ${message.id} on channel ${channelId} acknowledgement (x-ack) schema is not validated (${packedAck.unsupported})`);
    } else if (!compileSchemaValidator(packedAck.schema)) {
      warnings.push(`ASYNCAPI_ACK_SCHEMA_NOT_VALIDATED: message ${message.id} on channel ${channelId} acknowledgement (x-ack) schema could not be compiled to a validator`);
    }
  }
}

export function instrumentAsyncApiCollection(
  collection: JsonRecord,
  index: AsyncApiContractIndex
): AsyncApiInstrumentationResult {
  const warnings: string[] = [
    ...index.warnings,
    ...index.channels.flatMap((channel) => channel.warnings)
  ];

  for (const channel of index.channels) {
    for (const message of channel.messages) {
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
