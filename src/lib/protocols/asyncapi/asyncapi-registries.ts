// Vendored value sets and shared grammar helpers for the AsyncAPI
// generation-time lints. Registry contents are vendored locally (snapshot
// dates noted per set) so checks stay deterministic and offline; anything
// outside a set is surfaced as a warning, never a hard failure, because a
// registry snapshot can lag the live registry.

// AsyncAPI Security Scheme Object `type` enum (identical in 2.x and 3.0).
export const ASYNCAPI_SECURITY_SCHEME_TYPES: ReadonlySet<string> = new Set([
  'userPassword',
  'apiKey',
  'X509',
  'symmetricEncryption',
  'asymmetricEncryption',
  'httpApiKey',
  'http',
  'oauth2',
  'openIdConnect',
  'plain',
  'scramSha256',
  'scramSha512',
  'gssapi'
]);

// RFC 6838 registered top-level media types (IANA media-types registry,
// vendored snapshot 2026-07). A top-level type outside this set is legal
// syntax but unregistered, so it warns rather than fails.
export const REGISTERED_TOP_LEVEL_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application',
  'audio',
  'example',
  'font',
  'image',
  'message',
  'model',
  'multipart',
  'text',
  'video'
]);

// RFC 6838 §4.2 restricted-name grammar for the type/subtype part of a media
// type (parameters after ';' are stripped before matching).
export const MEDIA_TYPE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

// Documented AsyncAPI `schemaFormat` values (AsyncAPI 2.x / 3.0 Message Object
// schemaFormat tables). Matched after stripping whitespace; the version
// parameter is shape-checked, not cross-checked against the document version.
export const ASYNCAPI_SCHEMA_FORMAT_PATTERNS: readonly RegExp[] = [
  /^application\/vnd\.aai\.asyncapi(\+json|\+yaml)?;version=\d+\.\d+\.\d+$/,
  /^application\/schema\+(json|yaml);version=draft-07$/,
  /^application\/vnd\.apache\.avro(\+json|\+yaml)?;version=\d+(\.\d+){0,2}$/,
  /^application\/raml\+yaml;version=1\.0$/
];

// IANA WebSocket Subprotocol Name Registry (vendored snapshot, 2026-07).
export const IANA_WEBSOCKET_SUBPROTOCOLS: ReadonlySet<string> = new Set([
  'mqtt',
  'soap',
  'wamp',
  'stomp',
  'v10.stomp',
  'v11.stomp',
  'v12.stomp',
  'ocpp1.6',
  'ocpp2.0.1',
  'graphql-ws',
  'graphql-transport-ws',
  'amqp',
  'xmpp'
]);

// AMQP 0-9-1 exchange types accepted by the AsyncAPI amqp binding
// (amqp binding README, bindingVersion-scoped, non-normative source).
export const AMQP_EXCHANGE_TYPES: ReadonlySet<string> = new Set(['default', 'direct', 'topic', 'fanout', 'headers']);

// HTTP request methods accepted by the AsyncAPI http operation binding
// (http binding README, bindingVersion-scoped, non-normative source).
export const HTTP_BINDING_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'CONNECT',
  'TRACE'
]);

// Kafka broker topic naming: 1-249 chars of [a-zA-Z0-9._-], and never "." or
// ".." (vendor-normative broker rule; kafka binding README is the
// bindingVersion-scoped, non-normative carrier in AsyncAPI).
export const KAFKA_TOPIC_NAME_RE = /^[a-zA-Z0-9._-]{1,249}$/;

// Published AsyncAPI WebSockets channel-binding versions
// (ws binding README, bindingVersion-scoped, non-normative source).
export const WS_BINDING_VERSIONS: ReadonlySet<string> = new Set(['0.1.0', 'latest']);

// AsyncAPI runtime expression grammar, shared by every `location`-bearing
// field (correlationId.location, Parameter Object location, 3.0
// reply.address.location): $message.header#/<pointer> or
// $message.payload#/<pointer>, where the fragment is an RFC 6901 JSON pointer.
export const ASYNCAPI_RUNTIME_EXPRESSION_RE = /^\$message\.(header|payload)#(\/(?:[^~/]|~[01])*)+$/;

export function isAsyncApiRuntimeExpression(value: string): boolean {
  return ASYNCAPI_RUNTIME_EXPRESSION_RE.test(value);
}
