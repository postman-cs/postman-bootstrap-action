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
| `Request carries credentials required by OpenAPI security` | The request satisfies at least one declared security requirement. `apiKey` schemes assert the named header, query parameter, or cookie; `http` schemes assert the `Authorization` value opens with the declared scheme token, compared case-insensitively per RFC 9110 section 11.1 (`Basic` per RFC 7617, `Bearer` per RFC 6750, and any other registered scheme by its name); `oauth2`/`openIdConnect` accept an `Authorization` header or an `access_token` query parameter (RFC 6750). |
| `Request parameters match OpenAPI schemas` | Declared path, query, and header parameters validate against their schemas. |
| `Request body matches OpenAPI request schema` | The request body validates against the `requestBody` schema. |
| `Content-Length is consistent with OpenAPI body expectations` | The `Content-Length` header agrees with the body the spec allows for the response. |
| `OpenAPI schemas without a compilable runtime validator are documented` | Disclosure: enumerates any schema the generator could not compile into a runtime validator, so coverage gaps are visible inside the run instead of passing silently. |
| `Response satisfies RFC 9110 status-code requirements` | Status-conditional MUSTs: `WWW-Authenticate` on 401 with scheme-appropriate challenges (a Bearer challenge for bearer-secured operations, `realm` on Basic, `realm` and `nonce` on Digest per RFC 6750/7617/7616); registered Bearer `error` codes on 401/403; `Allow` on 405 listing every method the path declares; no content in a 304, and a 304 must carry each of `Cache-Control`, `Content-Location`, `ETag`, `Expires`, and `Vary` that the spec declares on the operation’s 200 response (RFC 9110 section 15.4.5); `Retry-After` delay-seconds or HTTP-date; `Location` URI-reference grammar on 201/3xx. |
| `Error and encoding conventions match RFC 9457 / RFC 8259 / RFC 8288` | `application/problem+json` bodies must be objects with string `type`/`title`/`detail`/`instance` members and a numeric `status` matching the HTTP status code; JSON media types must not declare a non-UTF-8 charset; every `Link` header value carries a `<URI-reference>` and a `rel` parameter. |
| `Response satisfies RFC 9110 message framing requirements` | No `Content-Length` on 1xx/204; `Location` present on 301/302/303/307/308 redirects; `Content-Range` unsatisfied-range form on 416; 206 `Content-Range` arithmetic (first-byte <= last-byte < complete-length, `multipart/byteranges` exclusion); `Proxy-Authenticate` on 407. |
| `Response header fields satisfy RFC 9110 field syntax` | Header names are tokens, values are legal field-content (no bare CR/LF/NUL), and singleton fields (`Content-Type`, `Content-Length`, `ETag`, `Location`, `Date`, `Age`, `Expires`, `Last-Modified`, `Retry-After`) never repeat with differing values. |
| `Response header values satisfy their RFC grammars` | HTTP-date syntax for `Date`/`Last-Modified`/`Sunset` (and `Last-Modified` <= `Date`); `ETag` entity-tag grammar; `Vary` token list with `*` standing alone; `Content-Location` URI-reference; `Accept-Ranges`/`Allow` token lists (`Allow` on OPTIONS 2xx must cover every declared path method); `Content-Language` BCP 47 tags; `Age` delta-seconds; `Cache-Control` directive grammar with delta-seconds arguments and `no-store`+`max-age` contradiction detection (RFC 9111); `Accept-Patch` media-type list (RFC 5789); `Deprecation` structured-date syntax (RFC 9745); `Preference-Applied` echoing a sent preference (RFC 7240). Duplicate `Cache-Control` directive names fail and `immutable` must be valueless (RFC 9111 section 4.2.1 / RFC 8246); `Trailer` is a token list that must not name framing, routing, authentication, or caching fields (RFC 9110 section 6.5); `Alt-Svc` is `clear` or a comma list of `protocol-id=alt-authority` entries with quoted authorities and `ma`/`persist` parameters (RFC 7838). |
| `Set-Cookie response headers satisfy RFC 6265` | Each `Set-Cookie` follows the `cookie-name=cookie-value` grammar (token name, cookie-octet value, optional DQUOTEs); attributes are well-formed and never repeat; `Max-Age` is an integer; `Expires` parses as a cookie-date (legacy non-IMF-fixdate forms downgrade to an advisory); `Secure`/`HttpOnly` take no value; `SameSite` is `Strict`, `Lax`, or `None`, and `SameSite=None` requires `Secure`; `__Host-` cookies require `Secure`, no `Domain`, and `Path=/`; `__Secure-` cookies require `Secure`. A cookie carrying none of `Secure`/`HttpOnly`/`SameSite` is an advisory. |
| `Security response headers satisfy their specifications` | `Strict-Transport-Security` directive grammar with a required integer `max-age`, no repeated directives, and valueless `includeSubDomains`/`preload` (RFC 6797); `X-Content-Type-Options` is exactly `nosniff`; every `Referrer-Policy` member comes from the registered policy set; `Permissions-Policy` parses as a structured-field dictionary. |
| `CORS response headers satisfy the WHATWG Fetch standard` | `Access-Control-Allow-Origin` is `*`, `null`, or a single serialized origin (no path or trailing slash); `*` combined with `Access-Control-Allow-Credentials: true` fails, and `Allow-Credentials` must be exactly `true` when present; `Expose-Headers`/`Allow-Headers`/`Allow-Methods` are token lists (a lone `*` member is allowed); `Access-Control-Max-Age` is an integer. Echoing a concrete origin without `Vary: Origin` is an advisory. |
| `Response media type is acceptable under the request Accept header` | On 2xx responses the media type matches the request's `Accept` ranges (q=0 ranges excluded); a `+json` response against a bare `application/json` Accept downgrades to an advisory. |
| `Response body satisfies its media type RFC conventions` | No BOM in JSON (RFC 8259); NDJSON lines parse; `text/event-stream` framing fields (a single leading BOM is tolerated, `id` field values must not contain NUL, and a final event missing its blank-line terminator — which a consumer would discard — is an advisory); multipart `boundary` presence and RFC 2046 grammar; HAL `_links`/`_embedded` shapes; JSON:API top-level members; `application/problem+xml` status consistency. |
| `Structured field response headers parse per RFC 9651` | `Cache-Status`, `Proxy-Status`, `Priority`, `RateLimit`, `RateLimit-Policy`, `Signature`, and `Signature-Input` parse as their declared structured-field types, including the RFC 9651 Date (`@`) and Display String (`%"…"`) value types. |
| `Proxy-Status members are typed per RFC 9209` | Each `Proxy-Status` list member is typed: `error` parameter values come from the vendored IANA HTTP Proxy Error Types registry snapshot (unknown values downgrade to an advisory), `next-hop` is a token or string, `received-status` is an integer, `details` is a string, and `rcode`/`tls-alert-*` parameters carry their registered types. |
| `RateLimit headers follow the IETF ratelimit-headers draft (advisory)` | Advisory-only: `RateLimit` / `RateLimit-Policy` parse per the draft grammar, `remaining` must not exceed the corresponding policy `limit`, and a coexisting legacy `X-RateLimit-*` triplet that disagrees with the structured headers is flagged. Never a hard failure. |
| `HTTP message signatures are structurally valid (RFC 9421)` | `Signature-Input` and `Signature` parse as structured-field dictionaries with matching label sets; each covered-component list is an inner list of strings naming valid components (`@method`, `@target-uri`, … or lowercase field names); `created`/`expires` are integers with `created <= expires`; `Signature` members are byte sequences. Signatures are not cryptographically verified. |
| `Content-Digest and Repr-Digest match the response body (RFC 9530)` | The headers parse as structured-field dictionaries; `sha-256`/`sha-512` entries are recomputed over textual bodies with CryptoJS and compared byte-for-byte. |
| `Request credentials are well-formed per their authentication scheme RFCs` | `Basic` credentials decode from base64 to `user-id:password` (RFC 7617); `Bearer` tokens match the b64token grammar (RFC 6750); `bearerFormat: JWT` tokens carry three base64url segments with a JSON header (`alg`), a JSON payload, and numeric `exp`/`nbf`/`iat` (RFC 7515/7519); `Digest` auth-params are well-formed with a hex `response` (RFC 7616); `apiKey` header values are trimmed field-content. |
| `Request preconditions, preferences, and patch bodies follow their RFCs` | `If-Match`/`If-None-Match` are `*` or entity-tag lists; `Prefer` names are tokens (RFC 7240); `application/json-patch+json` bodies are RFC 6902 operation arrays with RFC 6901 pointers; `application/merge-patch+json` bodies parse as JSON (RFC 7386). |
| `Request multipart bodies and Idempotency-Key follow their specifications` | A sent or spec-declared `Idempotency-Key` is a non-empty structured-field string; a `multipart/form-data` request `Content-Type` carries an RFC 2046-valid `boundary` (1–70 characters, no trailing space); raw-mode multipart bodies give every part a `Content-Disposition: form-data` with a `name`, cross-checked against the request body schema’s declared fields (RFC 7578; formdata-mode bodies are checked by field name only — Postman generates the boundary). |
| `Deprecated operation signals deprecation in the response` | Operations marked `deprecated: true` advise when the response carries neither `Deprecation` (RFC 9745) nor `Sunset` (RFC 8594). |
| `OpenAPI link expressions resolve against the response` | Declared link `$response.body#/...` pointers resolve in the response body and `$response.header....` references exist. |
| `Request URL conforms to an OpenAPI servers entry` | Advisory: the request URL matches a declared `servers` entry, with server variables constrained to their enum values. |
| `RFC SHOULD-level advisories are documented` | Disclosure channel: always passes and lists SHOULD-level findings (missing `Date`, charset parameters on JSON, the obsolete `Warning` header, a past `Sunset`, tokens in the query string, server mismatches) in the run report. |

Some HTTP layers are not visible to the Postman script sandbox and are out of scope for generated assertions: 1xx interim responses (including 103 Early Hints), RFC 9112 wire-level message framing, and TLS-layer properties.

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
| `gRPC response message matches <Message>` | The response message shape validates field-by-field against the proto3 JSON mapping of the declared response type. `google.rpc.Status`-shaped fields (for example `google.longrunning.Operation.error`) additionally require `code` in the canonical 0–16 range, a string `message`, and `details` entries that are objects with a string `@type`. HTTP↔grpc-status mapping and `grpc-message` trailers are not script-visible in `grpc-request` items and are out of scope. |
| `gRPC streamed response messages each match <Message>` | Server- and bidi-streaming RPCs shape-check every streamed response message via `pm.response.messages`, not only the terminal message `pm.response.json()` returns. |
| `gRPC response metadata and trailers conform to gRPC wire rules for <method>` | Response metadata and trailer keys are lowercase `[0-9a-z_.-]` tokens, values are printable ASCII, `-bin` keys carry base64 payloads, `content-type` metadata (when present) is `application/grpc*`, and a `grpc-status` trailer (when a server echoes one) is a canonical 0–16 code that agrees with the reported status code. The client normally consumes `grpc-status`/`grpc-message` into the status itself, so trailer presence is never required. |

Response validation follows the canonical proto3 JSON mapping (the protobuf.dev JSON specification).

Well-known types and scalars are validated against their canonical JSON encodings:

| Proto type | Enforced encoding |
| --- | --- |
| `google.protobuf.Timestamp` | RFC 3339 timestamp with UTC offset, at most 9 fractional digits, within the proto range 0001-01-01T00:00:00Z to 9999-12-31T23:59:59Z (calendar-validated, leap years included). |
| `google.protobuf.Duration` | Decimal seconds with an `s` suffix, at most 9 fractional digits, magnitude at most 315,576,000,000 seconds. |
| `google.protobuf.FieldMask` | Comma-separated lowerCamelCase field paths. |
| `bytes` | Base64 in the standard (RFC 4648 section 4) or URL-safe (RFC 4648 section 5) alphabet, with padding validated. |
| `float` | Finite values must be representable in IEEE 754 binary32; `NaN`/`Infinity`/`-Infinity` string literals are accepted. |
| integer scalars (`int32` .. `uint64`) | Range- and sign-checked per scalar type; 64-bit values compare as decimal strings so precision is never lost. |

## SOAP

Generated from a WSDL 1.1 / 2.0 document into plain HTTP POST requests with XML bodies:

| Test name | What it checks |
| --- | --- |
| `SOAP operation mapping exists` | The request resolved to a WSDL operation. |
| `SOAP transport returned HTTP 200` | The HTTP transport succeeded. |
| `SOAP response Content-Type matches the SOAP <version> binding` | SOAP 1.1 responses are served as `text/xml` (SOAP 1.1 HTTP binding, WS-I Basic Profile); SOAP 1.2 responses as `application/soap+xml` (RFC 3902). |
| `SOAP Envelope element is present` | The response contains a SOAP `Envelope`. |
| `SOAP Body element is present` | The response contains a SOAP `Body`. |
| `Response is not a SOAP Fault` | The `Body` carries a result rather than a `Fault`. |
| `Expected response element <name>` | The operation's declared response element is present. |
| `SOAP Fault and HTTP status are consistent` | A SOAP 1.1 Fault must ride HTTP 500; a SOAP 1.2 Fault rides HTTP 500, or 400 for `env:Sender` faults; an HTTP 500 from a SOAP endpoint must carry a Fault. |

On the request side, generated SOAP 1.1 requests always carry the `SOAPAction` HTTP header (required by the WS-I Basic Profile), while SOAP 1.2 requests carry the action as the `action` parameter of the `application/soap+xml` Content-Type (RFC 3902).

## GraphQL

Generated from a GraphQL SDL or introspection JSON. Beyond `GraphQL operation mapping exists`, each operation `<label>` gets:

| Test name | What it checks |
| --- | --- |
| `[<label>] HTTP transport is ok` | The HTTP transport succeeded. |
| `[<label>] GraphQL errors are well-formed and not a total failure` | Any `errors` array follows the GraphQL specification's response format, and the response still carries usable `data`. |
| `[<label>] data.<field> is present` | The selected root field is present in `data`. |
| `[<label>] data.<field> matches schema return type` | The field's value matches the return type declared in the schema. |
| `[<label>] required variables are supplied` | Every non-null operation variable has a value. |
| `[<operation>] GraphQL-over-HTTP media type and status are consistent` | The response media type must be `application/graphql-response+json` or `application/json`; with `application/graphql-response+json` a 2xx response must be a well-formed GraphQL response; with `application/json` a response carrying data must be HTTP 200. Skipped when the response carries no `Content-Type`. |

## AsyncAPI (WebSocket / Socket.IO / MQTT)

AsyncAPI 2.0-2.6 and 3.0 documents generate native `ws-raw-request` / `ws-socketio-request` items, and documents with `mqtt`/`mqtts`/`secure-mqtt` servers or MQTT bindings generate native `mqtt-request` items. Contract enforcement here is static, at generation time: every message payload example is validated against its AsyncAPI payload schema, acknowledgement / 3.x reply schemas are compiled, and channel-to-message coverage is enforced against the built collection. For MQTT channels the same generation-time pass checks topic-name grammar, wildcard-filter placement, and MQTT binding value ranges (`ASYNCAPI_MQTT_*` warnings). The Postman CLI runner prunes `ws-*` and `mqtt-request` item types, so these items carry `runnableInCi: false` and their validation happens during generation rather than in a CI run. Per-check detail and the warning codes involved are in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

## MCP

MCP server manifests — a registry `server.json` or an `mcpServers` client configuration — generate native `mcp-request` items: per server an `initialize` and a `tools/list` JSON-RPC 2.0 template, plus one `tools/call` per declared tool with arguments synthesized from the tool’s `inputSchema`. Secret header and environment values are replaced with `{{variable}}` placeholders and never persisted into the collection.

`mcp-request` items expose no test-script slot and the Postman CLI runner prunes them, so contract enforcement is static, at generation time: every generated JSON-RPC message must be a well-formed JSON-RPC 2.0 request, synthesized `tools/call` arguments are validated against the tool’s compiled `inputSchema`, server transport material is checked (URL scheme, stdio command presence, no concrete secret values), and item coverage and a collection size gate are enforced. Findings surface as `MCP_*` warnings; per-check detail is in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

## When something fails

- A failing test in a run names the operation and the clause it enforces. Fix the implementation or the spec, then rerun; the contract collection is regenerated from the current spec on the next bootstrap run.
- Generation-time warnings and hard failures carry coded prefixes (`ASYNCAPI_`, `CONTRACT_`, `GRAPHQL_`, `MCP_`, `PROTO_`, `SOAP_`). The remediation table for `CONTRACT_` codes is in the [README Errors section](../README.md#errors); protocol-specific codes are explained where each protocol is documented in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md) and surface in the action log with their context.
