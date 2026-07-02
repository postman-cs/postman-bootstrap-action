// Document-level AsyncAPI (2.0-2.6 / 3.0) spec-conformance lints, run at
// generation time against the raw document JSON. Every violation is a
// deterministic ASYNCAPI_*-prefixed warning with a spec citation - never a
// hard failure - matching the module's no-silent-drop discipline. Checks whose
// normative source is an informal binding README (kafka/amqp/http/ws bindings)
// say so in the warning text, because those documents are bindingVersion-scoped
// and non-normative.
//
// The parser dereferences local $refs before json() is taken, so walks here
// see resolved objects; a WeakSet guards against the resulting potential
// cycles, and the residual $ref scan only fires if a reference survives
// dereferencing unresolved.

import { compileSchemaValidator } from '../../spec/schema-validator-code.js';
import { packSchema } from '../../spec/schema-pack.js';
import {
  AMQP_EXCHANGE_TYPES,
  ASYNCAPI_SCHEMA_FORMAT_PATTERNS,
  ASYNCAPI_SECURITY_SCHEME_TYPES,
  HTTP_BINDING_METHODS,
  IANA_WEBSOCKET_SUBPROTOCOLS,
  KAFKA_TOPIC_NAME_RE,
  MEDIA_TYPE_NAME_RE,
  REGISTERED_TOP_LEVEL_MEDIA_TYPES,
  isAsyncApiRuntimeExpression
} from './asyncapi-registries.js';
import type { AsyncApiContractIndex } from './asyncapi-parser.js';

type JsonRecord = Record<string, unknown>;

const COMPONENT_KEY_RE = /^[a-zA-Z0-9._-]+$/;
const URL_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;
const MESSAGE_EXAMPLE_KEYS = new Set(['headers', 'payload', 'name', 'summary']);

// Server url-scheme families accepted per declared protocol (AsyncAPI 2.x
// Server Object: url and protocol MUST agree).
const FAMILY_BY_PROTOCOL: Record<string, 'ws' | 'mqtt' | 'kafka' | 'http' | 'amqp'> = {
  ws: 'ws',
  wss: 'ws',
  mqtt: 'mqtt',
  mqtts: 'mqtt',
  'secure-mqtt': 'mqtt',
  mqtt5: 'mqtt',
  kafka: 'kafka',
  'kafka-secure': 'kafka',
  http: 'http',
  https: 'http',
  amqp: 'amqp',
  amqps: 'amqp'
};
const SCHEMES_BY_FAMILY: Record<'ws' | 'mqtt' | 'kafka' | 'http' | 'amqp', ReadonlySet<string>> = {
  ws: new Set(['ws', 'wss']),
  // MQTT brokers are commonly addressed with tcp:// / ssl:// urls, so those
  // schemes are accepted for the mqtt protocol family.
  mqtt: new Set(['mqtt', 'mqtts', 'tcp', 'ssl']),
  kafka: new Set(['kafka']),
  http: new Set(['http', 'https']),
  amqp: new Set(['amqp', 'amqps'])
};

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parsesAsUrl(value: string): boolean {
  try {
     
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ----- G26: tags name uniqueness + externalDocs.url parseability -----

function checkExternalDocs(label: string, raw: unknown, warnings: string[]): void {
  const externalDocs = asRecord(raw);
  if (!externalDocs) return;
  const url = externalDocs.url;
  if (typeof url !== 'string' || !parsesAsUrl(url)) {
    warnings.push(
      `ASYNCAPI_EXTERNAL_DOCS_URL_INVALID: ${label} externalDocs url ${JSON.stringify(url)} does not parse as a URL; the External Documentation Object url is REQUIRED and MUST be a URL`
    );
  }
}

function lintTagsAndExternalDocs(label: string, node: JsonRecord, warnings: string[]): void {
  const tags = asArray(node.tags);
  const seen = new Set<string>();
  const reported = new Set<string>();
  tags.forEach((entry, i) => {
    const tag = asRecord(entry);
    const name = typeof tag?.name === 'string' ? tag.name : undefined;
    if (name !== undefined) {
      if (seen.has(name) && !reported.has(name)) {
        reported.add(name);
        warnings.push(`ASYNCAPI_TAGS_DUPLICATE: ${label} tags contain duplicate tag name ${JSON.stringify(name)}; tag names must be unique within a tags list`);
      }
      seen.add(name);
    }
    if (tag) checkExternalDocs(`${label} tag ${name ?? `#${i}`}`, tag.externalDocs, warnings);
  });
  checkExternalDocs(label, node.externalDocs, warnings);
}

// ----- G10: contentType / defaultContentType -----

function lintContentType(label: string, value: string, warnings: string[]): void {
  const base = value.split(';')[0].trim();
  if (!MEDIA_TYPE_NAME_RE.test(base)) {
    warnings.push(`ASYNCAPI_CONTENT_TYPE_INVALID: ${label} content type ${JSON.stringify(value)} is not valid RFC 6838 type/subtype syntax`);
    return;
  }
  const topLevel = base.slice(0, base.indexOf('/')).toLowerCase();
  if (!REGISTERED_TOP_LEVEL_MEDIA_TYPES.has(topLevel)) {
    warnings.push(
      `ASYNCAPI_CONTENT_TYPE_UNREGISTERED: ${label} content type ${JSON.stringify(value)} uses top-level type "${topLevel}", which is not an IANA-registered top-level media type (vendored RFC 6838 registry snapshot)`
    );
  }
}

// ----- G11: schemaFormat -----

function lintSchemaFormat(label: string, value: string, warnings: string[]): void {
  const normalized = value.replace(/\s+/g, '');
  if (!ASYNCAPI_SCHEMA_FORMAT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    warnings.push(
      `ASYNCAPI_SCHEMA_FORMAT_UNKNOWN: ${label} schemaFormat ${JSON.stringify(value)} is not in the documented AsyncAPI schemaFormat set (vnd.aai.asyncapi[+json|+yaml];version=..., schema+json/yaml;version=draft-07, vnd.apache.avro[+json|+yaml];version=..., raml+yaml;version=1.0)`
    );
  }
}

// ----- G7: message/operation traits must not define payload -----

function lintTraits(label: string, traitsRaw: unknown, warnings: string[]): void {
  asArray(traitsRaw).forEach((entry, i) => {
    const trait = asRecord(entry);
    if (trait && trait.payload !== undefined) {
      warnings.push(
        `ASYNCAPI_TRAIT_PAYLOAD_FORBIDDEN: ${label} trait #${i} defines payload; the Message/Operation Trait Object is the message/operation definition minus payload, so a trait MUST NOT carry one`
      );
    }
  });
}

// ----- G14 (+ 2.x location): Parameter Object -----

function lintParameter(label: string, raw: unknown, warnings: string[]): void {
  const parameter = asRecord(raw);
  if (!parameter) return;
  const enumValues = asArray(parameter.enum);
  if (enumValues.length > 0) {
    if (parameter.default !== undefined && !enumValues.includes(parameter.default)) {
      warnings.push(`ASYNCAPI_PARAMETER_DEFAULT_NOT_IN_ENUM: ${label} default ${JSON.stringify(parameter.default)} is not a member of the parameter enum (AsyncAPI 3.0 Parameter Object)`);
    }
    for (const example of asArray(parameter.examples)) {
      if (!enumValues.includes(example)) {
        warnings.push(`ASYNCAPI_PARAMETER_EXAMPLE_NOT_IN_ENUM: ${label} example ${JSON.stringify(example)} is not a member of the parameter enum (AsyncAPI 3.0 Parameter Object)`);
      }
    }
  }
  if (typeof parameter.location === 'string' && !isAsyncApiRuntimeExpression(parameter.location)) {
    warnings.push(
      `ASYNCAPI_PARAMETER_LOCATION_INVALID: ${label} location ${JSON.stringify(parameter.location)} is not a valid AsyncAPI runtime expression ($message.header#/<pointer> or $message.payload#/<pointer>)`
    );
  }
}

// ----- G6: security requirements vs declared securitySchemes -----

function lintSecurityRequirements(documentJson: JsonRecord, is3: boolean, label: string, securityRaw: unknown, warnings: string[]): void {
  const declared = asRecord(asRecord(documentJson.components)?.securitySchemes) ?? {};
  for (const entry of asArray(securityRaw)) {
    const requirement = asRecord(entry);
    if (!requirement) continue;
    if (is3) {
      // 3.0 security entries are (dereferenced) Security Scheme Objects; the
      // scheme's own `scopes` list is only meaningful for oauth2/openIdConnect.
      const type = String(requirement.type ?? '');
      const scopes = asArray(requirement.scopes);
      if (scopes.length > 0 && type !== 'oauth2' && type !== 'openIdConnect') {
        warnings.push(
          `ASYNCAPI_SECURITY_REQUIREMENT_SCOPES_INVALID: ${label} security entry of type ${JSON.stringify(type)} lists scopes; a non-empty scope list is only valid for oauth2/openIdConnect schemes`
        );
      }
      continue;
    }
    for (const [schemeName, scopesRaw] of Object.entries(requirement)) {
      const scheme = asRecord(declared[schemeName]);
      if (!scheme) {
        warnings.push(
          `ASYNCAPI_SECURITY_REQUIREMENT_UNDECLARED: ${label} security requirement references scheme ${JSON.stringify(schemeName)}, which is not declared in components.securitySchemes`
        );
        continue;
      }
      const type = String(scheme.type ?? '');
      if (asArray(scopesRaw).length > 0 && type !== 'oauth2' && type !== 'openIdConnect') {
        warnings.push(
          `ASYNCAPI_SECURITY_REQUIREMENT_SCOPES_INVALID: ${label} security requirement for scheme ${JSON.stringify(schemeName)} (type ${JSON.stringify(type)}) lists scopes; a non-empty scope array is only valid for oauth2/openIdConnect schemes`
        );
      }
    }
  }
}

// ----- G5: Security Scheme Object -----

function lintSecuritySchemes(documentJson: JsonRecord, warnings: string[]): void {
  const schemes = asRecord(asRecord(documentJson.components)?.securitySchemes) ?? {};
  for (const [name, raw] of Object.entries(schemes)) {
    const scheme = asRecord(raw);
    if (!scheme) continue;
    const type = scheme.type;
    if (typeof type !== 'string' || !ASYNCAPI_SECURITY_SCHEME_TYPES.has(type)) {
      warnings.push(
        `ASYNCAPI_SECURITY_SCHEME_INVALID: components.securitySchemes.${name} type ${JSON.stringify(type)} is not in the AsyncAPI Security Scheme type enum`
      );
      continue;
    }
    if (type === 'httpApiKey' && !['query', 'header', 'cookie'].includes(String(scheme.in))) {
      warnings.push(
        `ASYNCAPI_SECURITY_SCHEME_INVALID: components.securitySchemes.${name} (httpApiKey) "in" ${JSON.stringify(scheme.in)} must be one of query, header, cookie`
      );
    }
    if (type === 'apiKey' && !['user', 'password'].includes(String(scheme.in))) {
      warnings.push(
        `ASYNCAPI_SECURITY_SCHEME_INVALID: components.securitySchemes.${name} (apiKey) "in" ${JSON.stringify(scheme.in)} must be one of user, password`
      );
    }
  }
}

// ----- G12: components section key names -----

function lintComponentKeys(documentJson: JsonRecord, warnings: string[]): void {
  const components = asRecord(documentJson.components) ?? {};
  for (const [sectionName, sectionRaw] of Object.entries(components)) {
    const section = asRecord(sectionRaw);
    if (!section) continue;
    for (const key of Object.keys(section)) {
      if (!COMPONENT_KEY_RE.test(key)) {
        warnings.push(
          `ASYNCAPI_COMPONENT_KEY_INVALID: components.${sectionName} key ${JSON.stringify(key)} MUST match ^[a-zA-Z0-9.\\-_]+$ (AsyncAPI Components Object)`
        );
      }
    }
  }
}

// ----- G13: server variables -----

function lintServerVariables(serverLabel: string, template: string, variablesRaw: unknown, warnings: string[]): void {
  const variables = asRecord(variablesRaw) ?? {};
  const used = new Set<string>();
  for (const match of template.matchAll(/\{([^{}]+)\}/g)) {
    used.add(match[1]);
  }
  for (const name of used) {
    if (!(name in variables)) {
      warnings.push(`ASYNCAPI_SERVER_VARIABLE_UNDECLARED: ${serverLabel} references variable {${name}} that is not declared in the server variables object (AsyncAPI Server Object MUST)`);
    }
  }
  for (const [name, raw] of Object.entries(variables)) {
    if (!used.has(name)) {
      warnings.push(`ASYNCAPI_SERVER_VARIABLE_UNUSED: ${serverLabel} declares variable ${name} that never appears in the server url/host/pathname`);
    }
    const variable = asRecord(raw);
    if (!variable) continue;
    if (variable.default === undefined) {
      warnings.push(
        `ASYNCAPI_SERVER_VARIABLE_NO_DEFAULT: ${serverLabel} variable ${name} declares no default; AsyncAPI recommends (but does not hard-require) a default so the server url is resolvable without operator input`
      );
    }
    const enumValues = asArray(variable.enum);
    if (enumValues.length > 0) {
      if (variable.default !== undefined && !enumValues.includes(variable.default)) {
        warnings.push(`ASYNCAPI_SERVER_VARIABLE_ENUM_MISMATCH: ${serverLabel} variable ${name} default ${JSON.stringify(variable.default)} is not a member of its enum`);
      }
      for (const example of asArray(variable.examples)) {
        if (!enumValues.includes(example)) {
          warnings.push(`ASYNCAPI_SERVER_VARIABLE_ENUM_MISMATCH: ${serverLabel} variable ${name} example ${JSON.stringify(example)} is not a member of its enum`);
        }
      }
    }
  }
}

// ----- G4 / G13 / G21 / G24-info / G6 / G26: servers -----

function lintServers(documentJson: JsonRecord, is3: boolean, warnings: string[]): void {
  const servers = asRecord(documentJson.servers) ?? {};
  let httpProtocolSeen = false;
  for (const [name, raw] of Object.entries(servers)) {
    const server = asRecord(raw);
    if (!server) continue;
    const label = `server ${name}`;
    const protocol = typeof server.protocol === 'string' ? server.protocol.toLowerCase() : undefined;
    if (!protocol) {
      warnings.push(`ASYNCAPI_SERVER_PROTOCOL_MISSING: ${label} declares no protocol; the Server Object protocol field is REQUIRED (AsyncAPI 2.x and 3.0)`);
    }
    if (protocol === 'http' || protocol === 'https') httpProtocolSeen = true;

    if (is3) {
      const host = typeof server.host === 'string' ? server.host : '';
      if (host.includes('://') || host.startsWith('//')) {
        warnings.push(`ASYNCAPI_SERVER_HOST_HAS_SCHEME: ${label} host ${JSON.stringify(host)} must not contain a scheme; AsyncAPI 3.0 Server Object host is scheme-less (the scheme comes from protocol)`);
      }
      lintServerVariables(label, `${host}${typeof server.pathname === 'string' ? server.pathname : ''}`, server.variables, warnings);
    } else {
      const url = typeof server.url === 'string' ? server.url : '';
      const schemeMatch = URL_SCHEME_RE.exec(url);
      if (protocol && schemeMatch) {
        const family = FAMILY_BY_PROTOCOL[protocol];
        const scheme = schemeMatch[1].toLowerCase();
        if (family && !SCHEMES_BY_FAMILY[family].has(scheme)) {
          warnings.push(
            `ASYNCAPI_SERVER_PROTOCOL_MISMATCH: ${label} url scheme "${scheme}" does not match the declared protocol "${protocol}" (${family} family); the Server Object url and protocol MUST agree (AsyncAPI 2.x)`
          );
        }
      }
      lintServerVariables(label, url, server.variables, warnings);
    }

    // Declared WebSocket subprotocol (an explicit field only; protocolVersion
    // is NOT a subprotocol) checked against the vendored IANA registry.
    if ((protocol === 'ws' || protocol === 'wss') && typeof server.subprotocol === 'string' && !IANA_WEBSOCKET_SUBPROTOCOLS.has(server.subprotocol)) {
      warnings.push(
        `ASYNCAPI_WS_SUBPROTOCOL_UNREGISTERED: ${label} declares WebSocket subprotocol ${JSON.stringify(server.subprotocol)}, which is not in the IANA WebSocket Subprotocol Name Registry (vendored snapshot 2026-07)`
      );
    }

    lintSecurityRequirements(documentJson, is3, label, server.security, warnings);
    lintTagsAndExternalDocs(label, server, warnings);
  }
  if (httpProtocolSeen) {
    warnings.push(
      'ASYNCAPI_HTTP_RUNTIME_UNTESTED: document declares an http/https protocol server; http channels are statically checked only at generation time and are not exercised at runtime by the generated collection'
    );
  }
}

// ----- G22 / G23 / G24 / G21: protocol binding value checks -----

function lintBindings(label: string, bindingsRaw: unknown, warnings: string[]): void {
  const bindings = asRecord(bindingsRaw);
  if (!bindings) return;

  const kafka = asRecord(bindings.kafka);
  if (kafka) {
    if (typeof kafka.topic === 'string' && (kafka.topic === '.' || kafka.topic === '..' || !KAFKA_TOPIC_NAME_RE.test(kafka.topic))) {
      warnings.push(
        `ASYNCAPI_KAFKA_TOPIC_INVALID: ${label} kafka binding topic ${JSON.stringify(kafka.topic)} must match ^[a-zA-Z0-9._-]{1,249}$ and must not be "." or ".." (vendor-normative Kafka broker rule; kafka binding README, bindingVersion-scoped, non-normative source)`
      );
    }
    for (const field of ['partitions', 'replicas'] as const) {
      if (kafka[field] !== undefined && !isPositiveInteger(kafka[field])) {
        warnings.push(
          `ASYNCAPI_KAFKA_BINDING_INVALID: ${label} kafka binding ${field} must be a positive integer (vendor-normative Kafka rule; kafka binding README, bindingVersion-scoped, non-normative source) (got ${JSON.stringify(kafka[field])})`
        );
      }
    }
  }

  const amqp = asRecord(bindings.amqp);
  if (amqp) {
    const queue = asRecord(amqp.queue);
    if (queue && typeof queue.name === 'string' && queue.name.length > 255) {
      warnings.push(
        `ASYNCAPI_AMQP_BINDING_INVALID: ${label} amqp binding queue name exceeds 255 characters (AMQP 0-9-1 short-string limit; amqp binding README, bindingVersion-scoped, non-normative source)`
      );
    }
    const exchange = asRecord(amqp.exchange);
    if (exchange && exchange.type !== undefined && !AMQP_EXCHANGE_TYPES.has(String(exchange.type))) {
      warnings.push(
        `ASYNCAPI_AMQP_BINDING_INVALID: ${label} amqp binding exchange type ${JSON.stringify(exchange.type)} must be one of default, direct, topic, fanout, headers (amqp binding README, bindingVersion-scoped, non-normative source)`
      );
    }
    if (amqp.deliveryMode !== undefined && amqp.deliveryMode !== 1 && amqp.deliveryMode !== 2) {
      warnings.push(
        `ASYNCAPI_AMQP_BINDING_INVALID: ${label} amqp binding deliveryMode must be 1 (transient) or 2 (persistent) (amqp binding README, bindingVersion-scoped, non-normative source) (got ${JSON.stringify(amqp.deliveryMode)})`
      );
    }
    if (amqp.expiration !== undefined && !(typeof amqp.expiration === 'number' && Number.isInteger(amqp.expiration) && amqp.expiration >= 0)) {
      warnings.push(
        `ASYNCAPI_AMQP_BINDING_INVALID: ${label} amqp binding expiration must be a non-negative integer (milliseconds) (amqp binding README, bindingVersion-scoped, non-normative source) (got ${JSON.stringify(amqp.expiration)})`
      );
    }
  }

  const http = asRecord(bindings.http);
  if (http) {
    if (http.method !== undefined && (typeof http.method !== 'string' || !HTTP_BINDING_METHODS.has(http.method))) {
      warnings.push(
        `ASYNCAPI_HTTP_BINDING_INVALID: ${label} http binding method ${JSON.stringify(http.method)} is not a valid HTTP request method (http binding README, bindingVersion-scoped, non-normative source)`
      );
    }
    if (http.statusCode !== undefined && !(typeof http.statusCode === 'number' && Number.isInteger(http.statusCode) && http.statusCode >= 100 && http.statusCode <= 599)) {
      warnings.push(
        `ASYNCAPI_HTTP_BINDING_INVALID: ${label} http binding statusCode must be an integer in 100-599 (http binding README, bindingVersion-scoped, non-normative source) (got ${JSON.stringify(http.statusCode)})`
      );
    }
  }

  const ws = asRecord(bindings.ws) ?? asRecord(bindings.websockets);
  if (ws && typeof ws.subprotocol === 'string' && !IANA_WEBSOCKET_SUBPROTOCOLS.has(ws.subprotocol)) {
    warnings.push(
      `ASYNCAPI_WS_SUBPROTOCOL_UNREGISTERED: ${label} ws binding declares subprotocol ${JSON.stringify(ws.subprotocol)}, which is not in the IANA WebSocket Subprotocol Name Registry (vendored snapshot 2026-07)`
    );
  }
}

// ----- G1 / G2 / G3 / G7 / G8 / G10 / G11 / G26: Message Object -----

interface MessageLintState {
  seen: WeakSet<object>;
  messageIds: Map<string, string>;
}

// The 3.0 Multi Format Schema Object wraps the actual schema; unwrap it (and
// surface its schemaFormat for the G11 check) so headers checks see the schema.
function effectiveSchema(label: string, slot: 'payload' | 'headers', raw: unknown, warnings: string[]): JsonRecord | undefined {
  const node = asRecord(raw);
  if (!node) return undefined;
  if (typeof node.schemaFormat === 'string' && node.schema !== undefined) {
    lintSchemaFormat(`${label} ${slot}`, node.schemaFormat, warnings);
    return asRecord(node.schema) ?? undefined;
  }
  return node;
}

function lintMessage(
  documentJson: JsonRecord,
  label: string,
  message: JsonRecord,
  is3: boolean,
  minor: number,
  state: MessageLintState,
  warnings: string[]
): void {
  if (state.seen.has(message)) return;
  state.seen.add(message);

  // messageId uniqueness (field introduced in AsyncAPI 2.4; 3.0 uses map keys).
  if (!is3 && minor >= 4 && typeof message.messageId === 'string') {
    const prior = state.messageIds.get(message.messageId);
    if (prior) {
      warnings.push(`ASYNCAPI_MESSAGE_ID_DUPLICATE: ${label} messageId ${JSON.stringify(message.messageId)} is already used by ${prior}; messageId MUST be unique across the document (AsyncAPI 2.4+)`);
    } else {
      state.messageIds.set(message.messageId, label);
    }
  }

  if (typeof message.contentType === 'string') {
    lintContentType(label, message.contentType, warnings);
  }
  if (typeof message.schemaFormat === 'string') {
    lintSchemaFormat(label, message.schemaFormat, warnings);
  }
  effectiveSchema(label, 'payload', message.payload, warnings);
  const headersSchema = effectiveSchema(label, 'headers', message.headers, warnings);

  // Message Object MUST: headers is a schema of type object.
  if (headersSchema && headersSchema.type !== 'object') {
    warnings.push(
      `ASYNCAPI_MESSAGE_HEADERS_NOT_OBJECT: ${label} headers schema MUST be of type "object" (AsyncAPI Message Object) but declares type ${JSON.stringify(headersSchema.type)}`
    );
  }

  const examples = asArray(message.examples);

  // 2.x Message Example Object allows only headers, payload, name, summary
  // (specification extensions excepted).
  if (!is3) {
    examples.forEach((entry, i) => {
      const example = asRecord(entry);
      if (!example) return;
      for (const key of Object.keys(example)) {
        if (!MESSAGE_EXAMPLE_KEYS.has(key) && !key.startsWith('x-')) {
          warnings.push(
            `ASYNCAPI_MESSAGE_EXAMPLE_UNKNOWN_KEY: ${label} examples[${i}] carries unknown key ${JSON.stringify(key)}; the Message Example Object allows only headers, payload, name, summary (AsyncAPI 2.x)`
          );
        }
      }
    });
  }

  // Headers counterpart of the payload example self-consistency check: each
  // example's headers value is validated against the packed headers schema.
  if (headersSchema && examples.some((entry) => asRecord(entry)?.headers !== undefined)) {
    const packed = packSchema(documentJson, headersSchema, '3.0', 'response');
    const validate = packed.unsupported ? null : compileSchemaValidator(packed.schema);
    if (!validate) {
      warnings.push(
        `ASYNCAPI_MESSAGE_HEADERS_NOT_VALIDATED: ${label} headers schema could not be compiled to a validator${packed.unsupported ? ` (${packed.unsupported})` : ''}; example headers are not asserted for spec self-consistency`
      );
    } else {
      examples.forEach((entry, i) => {
        const example = asRecord(entry);
        if (!example || example.headers === undefined) return;
        if (!validate(example.headers)) {
          warnings.push(
            `ASYNCAPI_MESSAGE_HEADERS_MISMATCH: ${label} examples[${i}].headers does not validate against the message headers schema; the documented example contradicts its own contract`
          );
        }
      });
    }
  }

  lintTraits(label, message.traits, warnings);
  lintBindings(label, message.bindings, warnings);
  lintTagsAndExternalDocs(label, message, warnings);
}

// ----- G8 / G14 / G18-adjacent channel + operation walks -----

function messagesOfOperation2x(op: JsonRecord): JsonRecord[] {
  const root = asRecord(op.message);
  if (!root) return [];
  const oneOf = asArray(root.oneOf)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => entry !== null);
  return oneOf.length > 0 ? oneOf : [root];
}

function lintChannels(documentJson: JsonRecord, is3: boolean, minor: number, warnings: string[]): void {
  const channels = asRecord(documentJson.channels) ?? {};
  const state: MessageLintState = { seen: new WeakSet(), messageIds: new Map() };
  const operationIds = new Map<string, string>();
  const addresses = new Map<string, string>();

  for (const [channelKey, channelRaw] of Object.entries(channels)) {
    const channel = asRecord(channelRaw);
    if (!channel) continue;
    const channelLabel = `channel ${channelKey}`;
    lintBindings(channelLabel, channel.bindings, warnings);
    lintTagsAndExternalDocs(channelLabel, channel, warnings);

    const parameters = asRecord(channel.parameters) ?? {};
    for (const [parameterName, parameterRaw] of Object.entries(parameters)) {
      lintParameter(`${channelLabel} parameter ${parameterName}`, parameterRaw, warnings);
    }

    if (is3) {
      if (typeof channel.address === 'string' && channel.address) {
        const prior = addresses.get(channel.address);
        if (prior) {
          warnings.push(`ASYNCAPI_CHANNEL_ADDRESS_DUPLICATE: channels ${prior} and ${channelKey} both use address ${JSON.stringify(channel.address)}; AsyncAPI 3.0 channel addresses must be unique`);
        } else {
          addresses.set(channel.address, channelKey);
        }
      }
      const messages = asRecord(channel.messages) ?? {};
      for (const [messageKey, messageRaw] of Object.entries(messages)) {
        const message = asRecord(messageRaw);
        if (message) lintMessage(documentJson, `message ${messageKey} on channel ${channelKey}`, message, is3, minor, state, warnings);
      }
      continue;
    }

    for (const opKey of ['publish', 'subscribe'] as const) {
      const op = asRecord(channel[opKey]);
      if (!op) continue;
      const opLabel = `${opKey} operation on channel ${channelKey}`;
      if (typeof op.operationId === 'string') {
        const prior = operationIds.get(op.operationId);
        if (prior) {
          warnings.push(`ASYNCAPI_OPERATION_ID_DUPLICATE: ${opLabel} operationId ${JSON.stringify(op.operationId)} is already used by ${prior}; operationId MUST be unique across the document (AsyncAPI 2.x Operation Object)`);
        } else {
          operationIds.set(op.operationId, opLabel);
        }
      }
      lintTraits(opLabel, op.traits, warnings);
      lintBindings(opLabel, op.bindings, warnings);
      lintSecurityRequirements(documentJson, is3, opLabel, op.security, warnings);
      lintTagsAndExternalDocs(opLabel, op, warnings);
      for (const message of messagesOfOperation2x(op)) {
        const name = typeof message.name === 'string' ? message.name : typeof message.messageId === 'string' ? message.messageId : opKey;
        lintMessage(documentJson, `message ${name} on channel ${channelKey}`, message, is3, minor, state, warnings);
      }
    }
  }
}

function lintOperations3(documentJson: JsonRecord, warnings: string[]): void {
  const operations = asRecord(documentJson.operations) ?? {};
  for (const [operationKey, operationRaw] of Object.entries(operations)) {
    const operation = asRecord(operationRaw);
    if (!operation) continue;
    const label = `operation ${operationKey}`;
    if (operation.action !== 'send' && operation.action !== 'receive') {
      warnings.push(`ASYNCAPI_OPERATION_ACTION_INVALID: ${label} action ${JSON.stringify(operation.action)} must be "send" or "receive" (AsyncAPI 3.0 Operation Object)`);
    }
    const replyAddress = asRecord(asRecord(operation.reply)?.address);
    if (replyAddress && typeof replyAddress.location === 'string' && !isAsyncApiRuntimeExpression(replyAddress.location)) {
      warnings.push(
        `ASYNCAPI_RUNTIME_EXPRESSION_INVALID: ${label} reply.address location ${JSON.stringify(replyAddress.location)} is not a valid AsyncAPI runtime expression ($message.header#/<pointer> or $message.payload#/<pointer>)`
      );
    }
    lintTraits(label, operation.traits, warnings);
    lintBindings(label, operation.bindings, warnings);
    lintSecurityRequirements(documentJson, true, label, operation.security, warnings);
    lintTagsAndExternalDocs(label, operation, warnings);
  }
}

// ----- G25: residual unresolved local $refs -----

function resolveLocalPointer(root: JsonRecord, ref: string): boolean {
  const pointer = ref.slice(1);
  if (pointer === '') return true;
  if (!pointer.startsWith('/')) return false;
  let node: unknown = root;
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return false;
      node = node[idx];
    } else {
      const record = asRecord(node);
      if (!record || !(key in record)) return false;
      node = record[key];
    }
  }
  return true;
}

function lintUnresolvedRefs(documentJson: JsonRecord, warnings: string[]): void {
  const visited = new WeakSet<object>();
  const reported = new Set<string>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as JsonRecord;
    const ref = record.$ref;
    if (typeof ref === 'string' && ref.startsWith('#') && !reported.has(ref) && !resolveLocalPointer(documentJson, ref)) {
      reported.add(ref);
      warnings.push(`ASYNCAPI_REF_UNRESOLVED: local $ref ${JSON.stringify(ref)} does not resolve to a location in the document; the referenced object is missing from the generated contract`);
    }
    Object.values(record).forEach(walk);
  };
  walk(documentJson);
}

// Document-level lint entry point: deterministic walk order (document key
// order), warning-only output, deduplicated by the instrumenter.
export function lintAsyncApiDocument(index: AsyncApiContractIndex): string[] {
  const warnings: string[] = [];
  const documentJson = index.documentJson;
  const is3 = index.version.startsWith('3');
  const minorMatch = /^2\.(\d+)/.exec(index.version);
  const minor = minorMatch ? Number(minorMatch[1]) : 0;

  lintUnresolvedRefs(documentJson, warnings);
  lintServers(documentJson, is3, warnings);
  lintSecuritySchemes(documentJson, warnings);
  lintComponentKeys(documentJson, warnings);
  if (typeof documentJson.defaultContentType === 'string') {
    lintContentType('document defaultContentType', documentJson.defaultContentType, warnings);
  }
  lintChannels(documentJson, is3, minor, warnings);
  if (is3) lintOperations3(documentJson, warnings);
  // 2.x carries tags/externalDocs at the document root; 3.0 under info.
  lintTagsAndExternalDocs('document', documentJson, warnings);
  const info = asRecord(documentJson.info);
  if (info) lintTagsAndExternalDocs('info', info, warnings);
  return warnings;
}
