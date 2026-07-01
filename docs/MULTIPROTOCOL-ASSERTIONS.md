# Multi-Protocol Contract Assertions

`postman-bootstrap-action` generates deterministic contract-test assertions from an API spec and
injects them into the generated Postman collections. This document records which Postman v3 request
types are supported, the spec each is derived from, and where that support is grounded.

## Capability matrix

| Postman protocol | Postman item type | Runnable in Postman CLI / Newman | Spec the action ingests | Assertion source |
| --- | --- | --- | --- | --- |
| HTTP / REST | `http` (v2) / `http-request` (v3 EC) | Yes | OpenAPI 3.0 / 3.1 | OpenAPI document |
| GraphQL | `http` body mode `graphql` (v2) | Yes (no feature flag) | GraphQL SDL or introspection JSON | GraphQL schema |
| SOAP | `http` POST, raw XML body (v2) | Yes (plain HTTP) | WSDL 1.1 / 2.0 | WSDL |
| gRPC | `grpc-request` (v3 EC) | Yes, but gated: `grpc_protocol_execution_allowed` feature flag + an authenticated, plan-qualified account | Protocol Buffers `.proto` | `.proto` |
| WebSocket | `ws-raw-request` | No (pruned by the unified runner) | AsyncAPI | not generated (warned) |
| Socket.IO | `ws-socketio-request` | No (pruned) | AsyncAPI | not generated (warned) |
| MQTT / LLM / MCP | `mqtt-request` / `llm-request` / `mcp-request` | No (label-only) | n/a | out of scope |

GraphQL-over-HTTP and SOAP-over-HTTP are emitted as ordinary v2 `http` requests, so they run in the
same legacy Postman CLI / Newman HTTP execution path the action already uses for REST. gRPC requires
the v3 Extensible Collection format and the unified runner; when the gRPC feature flag or a
plan-qualified login is unavailable, gRPC assertions are still generated but cannot execute in CI, so
validation degrades to structural/snapshot checks. This limitation is upstream (Postman CLI), not in
this action.

## Write path: public v2.1.0 vs gateway EC

The protocols split across two different create APIs because they produce two different collection
wire formats:

- **GraphQL and SOAP -> public v2.1.0 collections API.** They build ordinary v2.1.0 `http` collections
  and are created with `POST https://api.getpostman.com/collections` using the `postman-api-key`. No
  access token is required for the create itself.
- **gRPC -> gateway Extensible Collection (EC) API.** gRPC needs the `grpc-request` item type, which
  only exists in the v3/EC schema. The public v2.1.0 endpoint validates the legacy schema and rejects
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

Creating the gRPC collection and executing it in CI are separate gates:

- **Create** requires `postman-access-token` (the EC gateway write above).
- **Execute** additionally requires the `grpc_protocol_execution_allowed` account feature flag plus an
  authenticated, plan-qualified login in Postman CLI. Without the flag the assertions are still
  generated and persisted but cannot run (`runnableInCi: false`), so CI degrades to structural checks.

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
- Feature-flag gating — `run.ts` `FLAG_GATED_TYPES`: `grpc-request` -> `grpc_protocol_execution_allowed`,
  `graphql-request` -> `graphql_v2_protocol_execution_allowed`, resolved server-side against the
  logged-in plan.
- Full protocol-label vocabulary (including the non-executable ones) —
  `postman-cli/lib/run/unified/summary.ts` `ITEM_TYPE_TO_PROTOCOL` maps `http-request, graphql-request,
  grpc-request, ws-raw-request, ws-socketio-request, mqtt-request, llm-request, mcp-request`.

The **fetchable** v2.1.0 published schema
([schema.postman.com/json/collection/v2.1.0/collection.json](https://schema.postman.com/json/collection/v2.1.0/collection.json))
corroborates the HTTP/GraphQL split: it defines a request `body.mode` enum of
`raw | urlencoded | formdata | file | graphql` and no gRPC/WebSocket request type, confirming that
GraphQL-over-HTTP is representable as a v2 HTTP request body mode.

That the Postman CLI cannot currently run gRPC or WebSocket collections is documented upstream in
postmanlabs/postman-app-support issues #10640, #11252, and #12316.
