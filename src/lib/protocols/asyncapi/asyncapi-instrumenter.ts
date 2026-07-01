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
