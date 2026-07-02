# Generated Assertions

`postman-bootstrap-action` injects deterministic, spec-derived test scripts into the collections it generates. This page is the user-facing reference: the exact test names that appear in Postman and Postman CLI run output, the standard each check enforces, and where to look when one fails.

Engineering-level pipeline detail lives in [Dynamic Contract Tests](dynamic-contract-tests.md); protocol write-path detail lives in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

## OpenAPI (REST) contract tests

Each request in the generated `[Contract]` collection carries a test script built from its OpenAPI 3.0 / 3.1 operation. The assertions appear under these names:

| Test name | What it checks |
| --- | --- |
| `OpenAPI operation mapping exists` | The request resolved to an operation in the spec. When the collection and the spec drift apart, this fails first. |
| `Status code is defined by OpenAPI` | The response status is declared in the operation's `responses`. |
| `Content-Type matches OpenAPI response content` | The response `Content-Type` matches a media type the spec declares for that status. |
| `Response headers match OpenAPI` | Response headers declared in the spec validate against their schemas. |
| `Response body matches OpenAPI body contract` | The presence or absence of a body agrees with the content the spec declares for that status. |
| `Response body matches OpenAPI schema` | The parsed response body validates against the compiled JSON Schema for the matched status and media type. |
| `Request carries credentials required by OpenAPI security` | The request supplies the credential demanded by the operation's `security` requirement. |
| `Request parameters match OpenAPI schemas` | Declared path, query, and header parameters validate against their schemas. |
| `Request body matches OpenAPI request schema` | The request body validates against the `requestBody` schema. |
| `Content-Length is consistent with OpenAPI body expectations` | The `Content-Length` header agrees with the body the spec allows for the response. |
| `OpenAPI schemas without a compilable runtime validator are documented` | Disclosure: enumerates any schema the generator could not compile into a runtime validator, so coverage gaps are visible inside the run instead of passing silently. |

## Standards the schema checks enforce

Request and response schema validation compiles JSON Schema with the `@exodus/schemasafe` validator:

- OpenAPI 3.0 schemas validate under JSON Schema draft-07; OpenAPI 3.1 schemas under JSON Schema 2020-12. A `$schema` declared on a schema, or a root `jsonSchemaDialect`, selects the dialect explicitly.
- Dialect-exclusive keywords are rejected under the other dialect instead of being silently ignored: `prefixItems`, `dependentRequired`, `dependentSchemas`, `minContains`, `maxContains`, `unevaluatedItems`, and `unevaluatedProperties` require the 2020-12 dialect, while `dependencies` and `additionalItems` are draft-07 keywords. A schema that trips this surfaces through `CONTRACT_SCHEMA_NOT_COMPILED` and the disclosure test above, so it never validates as an empty schema.
- `format` is asserted (a mismatch fails the test) for exactly these formats, following JSON Schema's format vocabulary:

| `format` | Standard |
| --- | --- |
| `date-time`, `date`, `time` | RFC 3339 |
| `duration` | ISO 8601 duration, as profiled in RFC 3339 Appendix A |
| `email` | RFC 5321 |
| `hostname` | RFC 1123 |
| `ipv4` | RFC 2673 dotted-quad |
| `ipv6` | RFC 4291 |
| `uri`, `uri-reference` | RFC 3986 |
| `uri-template` | RFC 6570 |
| `uuid` | RFC 4122 |
| `json-pointer` | RFC 6901 |
| `relative-json-pointer` | Relative JSON Pointer draft |
| `regex` | ECMA-262 |

Every other `format` value (`int32`, `int64`, `password`, vendor extensions) is treated as an annotation, matching JSON Schema's default behavior for unknown formats, and never fails a test on its own.

## gRPC

Generated from a Protocol Buffers `.proto` file into v3 `grpc-request` items:

| Test name | What it checks |
| --- | --- |
| `gRPC operation mapping exists` | The request resolved to an RPC in the `.proto`. |
| `gRPC status is OK for <method>` | The call completed with gRPC status `OK`. |
| `gRPC <unary/streaming> RPC returns a terminal response message for <method>` | A terminal response message was received. |
| `gRPC response message matches <Message>` | The response message shape validates field-by-field against the proto3 JSON mapping of the declared response type. |

Response validation follows the canonical proto3 JSON mapping (the protobuf.dev JSON specification).

## SOAP

Generated from a WSDL 1.1 / 2.0 document into plain HTTP POST requests with XML bodies:

| Test name | What it checks |
| --- | --- |
| `SOAP operation mapping exists` | The request resolved to a WSDL operation. |
| `SOAP transport returned HTTP 200` | The HTTP transport succeeded. |
| `SOAP response Content-Type is XML` | The response is served as XML. |
| `SOAP Envelope element is present` | The response contains a SOAP `Envelope`. |
| `SOAP Body element is present` | The response contains a SOAP `Body`. |
| `Response is not a SOAP Fault` | The `Body` carries a result rather than a `Fault`. |
| `Expected response element <name>` | The operation's declared response element is present. |

## GraphQL

Generated from a GraphQL SDL or introspection JSON. Beyond `GraphQL operation mapping exists`, each operation `<label>` gets:

| Test name | What it checks |
| --- | --- |
| `[<label>] HTTP transport is ok` | The HTTP transport succeeded. |
| `[<label>] GraphQL errors are well-formed and not a total failure` | Any `errors` array follows the GraphQL specification's response format, and the response still carries usable `data`. |
| `[<label>] data.<field> is present` | The selected root field is present in `data`. |
| `[<label>] data.<field> matches schema return type` | The field's value matches the return type declared in the schema. |
| `[<label>] required variables are supplied` | Every non-null operation variable has a value. |

## AsyncAPI (WebSocket / Socket.IO)

AsyncAPI 2.0-2.6 and 3.0 documents generate native `ws-raw-request` / `ws-socketio-request` items. Contract enforcement here is static, at generation time: every message payload example is validated against its AsyncAPI payload schema, acknowledgement / 3.x reply schemas are compiled, and channel-to-message coverage is enforced against the built collection. The Postman CLI runner prunes `ws-*` item types, so these items carry `runnableInCi: false` and their validation happens during generation rather than in a CI run. Per-check detail and the warning codes involved are in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

## When something fails

- A failing test in a run names the operation and the clause it enforces. Fix the implementation or the spec, then rerun; the contract collection is regenerated from the current spec on the next bootstrap run.
- Generation-time warnings and hard failures carry coded prefixes (`ASYNCAPI_`, `CONTRACT_`, `GRAPHQL_`, `PROTO_`, `SOAP_`). The remediation table for `CONTRACT_` codes is in the [README Errors section](../README.md#errors); protocol-specific codes are explained where each protocol is documented in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md) and surface in the action log with their context.
