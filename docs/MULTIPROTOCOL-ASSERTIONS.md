# Multi-Protocol Contract Assertions

`postman-bootstrap-action` generates deterministic contract-test assertions from an API spec and
injects them into the generated Postman collections. This document records which Postman v3 request
types are supported, the spec each is derived from, and where that support is grounded.

## Capability matrix

| Postman protocol | Postman item type | Runnable in Postman CLI / Newman | Spec the action ingests | Assertion source |
| --- | --- | --- | --- | --- |
| HTTP / REST | `http` (v2) / `http-request` (v3 EC) | Yes | OpenAPI 3.0 / 3.1 | OpenAPI document |
| GraphQL | `http` body mode `graphql` (v2) | Yes | GraphQL SDL or introspection JSON | GraphQL schema |
| SOAP | `http` POST, raw XML body (v2) | Yes (plain HTTP) | WSDL 1.1 / 2.0 | WSDL |
| gRPC | `grpc-request` (v3 EC) | Yes | Protocol Buffers `.proto` | `.proto` |
| WebSocket | `ws-raw-request` | No (pruned by the unified runner) | AsyncAPI 2.0-2.6 / 3.0 | AsyncAPI document |
| Socket.IO | `ws-socketio-request` | No (pruned) | AsyncAPI 2.0-2.6 / 3.0 | AsyncAPI document |
| MQTT | `mqtt-request` (v3 EC) | No (pruned) | AsyncAPI 2.0-2.6 / 3.0 with MQTT servers/bindings | AsyncAPI document |
| MCP | `mcp-request` (v3 EC) | No (pruned) | MCP registry `server.json` / `mcpServers` client config | MCP server manifest |
| LLM | `llm-request` | No (label-only) | Required future protocol spec | Required future protocol spec |

GraphQL-over-HTTP and SOAP-over-HTTP are emitted as ordinary v2 `http` requests, so they run in the
same legacy Postman CLI / Newman HTTP execution path the action already uses for REST. gRPC requires
the v3 Extensible Collection format and runs through the unified runner.

WebSocket and Socket.IO are generated from an AsyncAPI 2.0-2.6 / 3.0 document into native EC
`ws-raw-request` / `ws-socketio-request` items (Socket.IO detected conventionally), with per-message
schema/example validation applied statically at generation time. The unified runner prunes both
`ws-*` item types, so they carry `runnableInCi: false`: the assertions are persisted for authoring
and structural validation but are not executed in CI. This runner limitation is upstream, not in this
action.

### AsyncAPI contract coverage

WebSocket and Socket.IO collections are generated from AsyncAPI 2.0-2.6 and 3.0 documents. The
`@postman/asyncapi-parser` intent model normalises both major versions behind one channel/message
interface: 2.x `publish`/`subscribe` and 3.x `send`/`receive` operations both surface as channel
messages, a 3.x server url is synthesised from `protocol` + `host` + `pathname`, and a 3.x operation
`reply` maps to the same acknowledgement slot as the 2.x Socket.IO `x-ack` convention. A version
outside 2.0-2.6 / 3.0 is rejected with `ASYNCAPI_VERSION_UNSUPPORTED`.

Socket.IO has no normative AsyncAPI binding, so it is inferred from convention (a Socket.IO server
protocol, an `x-ack` on a message, or an `x-socketio` extension); every such inference emits an
`ASYNCAPI_SOCKETIO_CONVENTION` warning so the classification is auditable.

Contract validation runs statically at generation time (WS/Socket.IO EC items expose no test-script
slot and the unified runner prunes them, so they carry `runnableInCi: false`). Each message payload
example is validated against its packed AsyncAPI payload schema — the async analogue of the OpenAPI
`CONTRACT_EXAMPLE_SCHEMA_MISMATCH` self-consistency check — the acknowledgement / 3.x reply schema is
compiled, channel-to-message coverage is enforced against the built collection (a drop or a
count-stable duplicate fails closed with `ASYNCAPI_MESSAGE_COVERAGE_FAILED`), and a collection size
gate is applied.

Non-JSON payloads are validated structurally. An AsyncAPI example `payload` is a structured value that
validates against the payload schema independent of the wire content type (content type governs
serialization; the value's structure is validated), so JSON, XML, text, and HTML example values are
validated against their packed schema. The two cases a JSON-schema validator cannot decide are
surfaced as precise warnings rather than a false failure: binary content (opaque bytes, emitted as a
base64 template with a base64 well-formedness check on string examples) raises
`ASYNCAPI_BINARY_PAYLOAD_NOT_VALIDATED`, and a raw wire-string example supplied for a structured schema
raises `ASYNCAPI_NON_JSON_PAYLOAD_NOT_VALIDATED`.

Runtime message-exchange execution in CI remains blocked by the upstream Postman CLI limitation that
prunes `ws-*` item types (issues #10640, #11252, #12316); the generation-time validation above is the
enforceable contract surface until that runner path exists.

### MQTT contract coverage

AsyncAPI documents whose servers declare `mqtt`, `mqtts`, or `secure-mqtt` (or whose channels carry MQTT bindings) generate native `mqtt-request` items through the same AsyncAPI pipeline, with MQTT-specific generation-time checks layered on top of the payload/coverage discipline above:

- Channel addresses must satisfy the MQTT 3.1.1/5.0 topic grammar (non-empty, no U+0000, at most 65535 UTF-8 bytes). A concrete publish topic must not contain `+`/`#`; violations raise `ASYNCAPI_MQTT_TOPIC_INVALID`.
- A wildcard address is treated as a subscription topic filter: `#` only in the final level, `+` occupying a whole level, flagged with `ASYNCAPI_MQTT_TOPIC_FILTER` so the publish/subscribe asymmetry is auditable.
- MQTT binding values are range-checked (`qos` 0-2, `retain` boolean, `keepAlive`/`messageExpiryInterval` non-negative integers, `payloadFormatIndicator` 0 or 1, `responseTopic` and `lastWill.topic` concrete topics, `lastWill.qos`/`lastWill.retain` typed); violations raise `ASYNCAPI_MQTT_BINDING_INVALID`.

The unified runner prunes `mqtt-request` like the `ws-*` types, so these collections are `runnableInCi: false` with the generation-time validation as the enforceable contract surface.

### MCP contract coverage

MCP server manifests are ingested as a first-class spec source: the detector recognizes both the MCP registry `server.json` shape and the `mcpServers` client-configuration shape. The parser builds a contract index of servers (remote `sse`/streamable-HTTP endpoints and `stdio` package commands) and declared tools; secret header and environment values are replaced with `{{variable}}` placeholders and never persisted (`MCP_SECRET_VALUE_PRESENT` guards a concrete value). A streamable-HTTP remote is generated on the `sse` transport payload with `MCP_STREAMABLE_HTTP_AS_SSE` recording the downgrade.

The builder emits deterministic `mcp-request` EC items per server — `initialize`, `tools/list`, and one `tools/call` per tool with arguments synthesized from the tool’s `inputSchema` — grounded in the bundled `@postman/runtime.models` extensible item schema (`mcp-request.payload` is `{ transport: sse | stdio, …, message }` and carries no test-script slot).

Because `mcp-request` has no script slot and the unified runner prunes it, contract enforcement is generation-time/static, mirroring the AsyncAPI discipline: every generated JSON-RPC message must be a well-formed JSON-RPC 2.0 request (a malformed one is a builder bug and fails closed with `MCP_MESSAGE_INVALID`), each tool’s `inputSchema` is compiled through the packed-schema machinery and the synthesized `tools/call` arguments are validated against it (the MCP analogue of `CONTRACT_EXAMPLE_SCHEMA_MISMATCH`; `MCP_TOOL_SAMPLE_MISMATCH` / `MCP_TOOL_SCHEMA_INVALID` / `MCP_TOOL_SCHEMA_NOT_VALIDATED` otherwise), server transport material is checked (`MCP_SERVER_URL_INVALID`/`MCP_SERVER_URL_MISSING`, `MCP_SERVER_COMMAND_MISSING`), tool naming is audited (`MCP_TOOL_NAME_*`), item coverage is enforced against the built collection (`MCP_ITEM_COVERAGE_FAILED` fails closed), and a collection size gate applies (`MCP_COLLECTION_SIZE_EXCEEDED`).

### Remaining protocol surfaces

- **LLM:** the Postman item type (`llm-request`) is label-only. Contract ingestion and assertion
  generation for it require the accepted contract source for the protocol to be defined first.

### gRPC assertion coverage

The generated gRPC test asserts terminal status OK, a terminal response message for unary and
client-streaming RPCs (server/bidi may legitimately return zero messages on an OK stream), and the
response message shape recursively against the `.proto` definition: field JSON types, `repeated`
array elements, `map` value types, enum name/number membership (numeric enum values must be
integers), and `oneof` mutual exclusion. Per proto3 JSON, `float`/`double` fields (and their
wrapper WKTs) additionally accept the `"NaN"`/`"Infinity"`/`"-Infinity"` string encodings and numeric
strings.

Server- and bidi-streaming RPCs additionally shape-check every streamed response message via
`pm.response.messages` (not only the terminal message `pm.response.json()` returns). A separate
wire-conformance test validates response metadata and trailers against the gRPC HTTP/2 protocol
spec: lowercase `[0-9a-z_.-]` keys, printable-ASCII values, base64 payloads for `-bin` keys,
`application/grpc*` `content-type`, and — when a server echoes a `grpc-status` trailer — a
canonical 0–16 code agreeing with the reported status code (grpc-js normally consumes
`grpc-status`/`grpc-message` into the status itself, so trailer presence is never required).

Well-known and scalar ProtoJSON string encodings are lexically validated: `google.protobuf.Timestamp`
requires an RFC 3339 timestamp with `Z` or numeric offset and 0-9 fractional digits,
`google.protobuf.Duration` requires a seconds string with `s` suffix and nanosecond precision,
`google.protobuf.FieldMask` requires comma-separated lowerCamelCase paths, and `bytes` /
`google.protobuf.BytesValue` require standard or URL-safe base64 with correct optional padding.
`google.protobuf.Value` remains present-only because its ProtoJSON mapping is intentionally any JSON
value. `google.rpc.Status`-shaped fields resolved from the `.proto` (for example
`google.longrunning.Operation.error`) get a dedicated semantic check: `code` in the canonical 0-16
range, a string `message`, and `details` entries that are objects with a string `@type`. The
HTTP↔grpc-status mapping and `grpc-message`/trailer metadata are not script-visible in
`grpc-request` items (the sandbox surface is `pm.response.code`/`status`/`json()` only), so they are
out of scope for generated assertions. Shape recursion is bounded (depth 5, cycle-guarded); deeper nesting is asserted object-only
with a `PROTO_NESTED_SHAPE_TRUNCATED` warning.

## Write path: public v2.1.0 vs gateway EC

The protocols split across two different create APIs because they produce two different collection
wire formats:

- **GraphQL and SOAP -> public v2.1.0 collections API.** They build ordinary v2.1.0 `http` collections
  and are created with `POST https://api.getpostman.com/collections` using the `postman-api-key`. No
  access token is required for the create itself.
- **gRPC and AsyncAPI (WebSocket / Socket.IO) -> gateway Extensible Collection (EC) API.** These need
  the `grpc-request` / `ws-raw-request` / `ws-socketio-request` item types, which only exist in the
  v3/EC schema. The public v2.1.0 endpoint validates the legacy schema and rejects
  EC payloads (`malformedRequestError: item must have required property 'request'`), so gRPC contract
  collections are created through the bifrost gateway (`POST {bifrost}/ws/proxy`, `service:'collection'`)
  against the collection service's EC API. On the EC path the v2.1.0 `item.event` test scripts are
  translated onto the EC item model as `extensions.events` (`test` -> `afterResponse`,
  `prerequest` -> `beforeRequest`); without that map the generated assertions would be dropped.

Because the gateway EC API is access-token only, **gRPC hard-requires `postman-access-token`**. When it
is absent the action fails fast with `EC_REQUIRES_ACCESS_TOKEN` rather than silently producing an
empty or v2-shaped collection. `resolve-service-token` mints a suitable service-account access token.
On org-mode accounts the EC client is scoped to the workspace-owning sub-team (`x-entity-team-id`)
resolved during workspace provisioning, not the parent-org team.

Creating the gRPC collection requires `postman-access-token` for the EC gateway write above.

## Why non-HTTP protocols need their own spec

OpenAPI 3.0/3.1 defines "a standard, language-agnostic interface to **HTTP APIs**"
([spec.openapis.org/oas/v3.1.0.html](https://spec.openapis.org/oas/v3.1.0.html)); its Path Item
Object lists only the HTTP methods `get, put, post, delete, options, head, patch, trace`, and it does
not describe gRPC, SOAP, WebSocket, or GraphQL operation contracts. Those are therefore not derivable
from an OpenAPI document and each is ingested from its own canonical format:

- gRPC — Protocol Buffers `.proto` IDL ([grpc.io](https://grpc.io/docs/what-is-grpc/introduction/)).
- SOAP — WSDL, "a model and an XML format for describing Web services"
  ([w3.org/TR/wsdl20](https://www.w3.org/TR/wsdl20/)).
- GraphQL — the schema (type system / SDL) is "the foundational API contract", with `__schema`
  introspection ([graphql/graphql-spec](https://github.com/graphql/graphql-spec)).
- WebSocket / event-driven — AsyncAPI, which complements OpenAPI for asynchronous protocols
  ([asyncapi.com](https://www.asyncapi.com/)).

## Grounding the Postman v3 request-type set (runtime-source fallback)

The published Postman Collection v3.0.0 JSON Schema
(`schema.postman.com/json/draft-2020-12/collection/v3.0.0/`) is not retrievable by automated tooling
(it returns HTTP 403 / is not indexed). The **binding authority** for which request types exist and
which actually execute is therefore taken from the Postman CLI unified runner source, which is what
runs collections in CI:

- Executable item types — `postman-cli/lib/run/unified/run.ts`: `SUPPORTED_ITEM_TYPES = { collection,
  folder, http-request, graphql-request, grpc-request, http-example, graphql-example, grpc-example }`.
  Anything else is pruned by `filterUnsupportedItems` and reported as "skipping N unsupported item(s)".
- Full protocol-label vocabulary (including the non-executable ones) —
  `postman-cli/lib/run/unified/summary.ts` `ITEM_TYPE_TO_PROTOCOL` maps `http-request, graphql-request,
  grpc-request, ws-raw-request, ws-socketio-request, mqtt-request, llm-request, mcp-request`.

The **fetchable** v2.1.0 published schema
([schema.postman.com/json/collection/v2.1.0/collection.json](https://schema.postman.com/json/collection/v2.1.0/collection.json))
corroborates the HTTP/GraphQL split: it defines a request `body.mode` enum of
`raw | urlencoded | formdata | file | graphql` and no gRPC/WebSocket request type, confirming that
GraphQL-over-HTTP is representable as a v2 HTTP request body mode.

That the Postman CLI cannot currently run WebSocket collections is documented upstream in
postmanlabs/postman-app-support issues #10640, #11252, and #12316.
