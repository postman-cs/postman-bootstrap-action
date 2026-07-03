# Generated Assertions

`postman-bootstrap-action` injects deterministic, spec-derived test scripts into the collections it generates. This page is the user-facing reference: the exact test names that appear in Postman and Postman CLI run output, the standard each check enforces, and where to look when one fails.

Engineering-level pipeline detail lives in [Dynamic Contract Tests](dynamic-contract-tests.md); protocol write-path detail lives in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

Every test on this page runs at collection-run time against a live response. A separate warning-only layer of static document lints runs once at bootstrap time against the spec itself; that split is documented in [Contract Enforcement Layers](contract-enforcement-layers.md), and the full `CONTRACT_*` code catalog (which codes fail the run, which are advisory) is in [Contract Error Codes](contract-error-codes.md).

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
| `OpenAPI link expressions resolve against the response` | Declared link `$response.body#/...` pointers resolve in the response body and `$response.header....` references exist and are unambiguous. When a link feeds a target operation parameter or JSON request body with a compilable schema, the resolved value also validates against that target schema; duplicated response header fields named by `$response.header....` fail because the runtime expression cannot select one value. |
| `Response body does not leak writeOnly properties` | No top-level property the OpenAPI response schema marks `writeOnly: true` (write-only across every content-type schema and its `allOf`/`anyOf`/`oneOf` members) appears in the JSON response body (OAS Schema Object `writeOnly`). |
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
| `gRPC response metadata and trailers conform to gRPC wire rules for <method>` | Response metadata and trailer keys are lowercase `[0-9a-z_.-]` tokens, values are printable ASCII, `-bin` keys carry base64 payloads, `content-type` metadata (when present) is `application/grpc*`, and a `grpc-status` trailer (when a server echoes one) is a canonical 0–16 code that agrees with the reported status code. A `grpc-status-details-bin` trailer (when present) must base64-decode to a wire-valid `google.rpc.Status` protobuf: a varint `code` in the canonical 0–16 range consistent with the reported status, a length-delimited `message`, and `details` entries that decode as `google.protobuf.Any` with a non-empty `type_url`. The client normally consumes `grpc-status`/`grpc-message` into the status itself, so trailer presence is never required. |

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

Generation-time `.proto` lints run before instrumentation and surface as `GRPC_*` warnings: field numbers must sit in protoc’s legal range (1–536,870,911, excluding the 19000–19999 implementation-reserved block — `GRPC_FIELD_NUMBER_INVALID`) and must not reuse `reserved` numbers (`GRPC_RESERVED_FIELD_NUMBER_REUSED`); a proto3 enum’s first value must be 0 (`GRPC_ENUM_FIRST_VALUE_NOT_ZERO`) and its zero value is conventionally `*_UNSPECIFIED` (`GRPC_ENUM_ZERO_NAME_CONVENTION`); a missing `package` declaration is flagged per buf’s PACKAGE_DEFINED lint (`GRPC_FILE_PACKAGE_CONVENTION`); `rpc` request/response types must resolve to messages in the parsed set (`GRPC_RPC_TYPE_UNRESOLVED`); deprecated RPCs, messages, fields, and enums are surfaced (`GRPC_DEPRECATED`); and `google.api.http` transcoding annotations are cross-checked against the request message: path template variables must reference request fields (`GRPC_HTTP_PATH_VARIABLE_UNKNOWN`), `body` must be `*` or a request field (`GRPC_HTTP_BODY_FIELD_UNKNOWN`), and `additional_bindings` must not nest (`GRPC_HTTP_NESTED_ADDITIONAL_BINDINGS`).

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
| `SOAP Envelope namespace matches SOAP <version>` | The envelope declares the version-correct namespace: `http://schemas.xmlsoap.org/soap/envelope/` for SOAP 1.1, `http://www.w3.org/2003/05/soap-envelope` for SOAP 1.2 — a mismatch is the SOAP 1.2 `VersionMismatch` fault condition (Part 1 section 5.4.7). |
| `SOAP Fault is well-formed for SOAP <version>` | A returned Fault carries its mandatory children: `faultcode` + `faultstring` for SOAP 1.1 (section 4.4); `env:Code`/`env:Value` + `env:Reason`/`env:Text` for SOAP 1.2 (Part 1 section 5.4), with the top-level `Value` QName restricted to the five defined fault codes. |
| `SOAP request uses HTTP POST` | SOAP operations ride HTTP POST (WS-I Basic Profile 1.1 R1141). |
| `SOAPAction request header is present and quoted` | SOAP 1.1 requests carry a quoted `SOAPAction` value (WS-I Basic Profile 1.1 R2744/R2745). |
| `SOAP 1.2 request media type is application/soap+xml` | SOAP 1.2 requests are sent as `application/soap+xml` (RFC 3902). |
| `SOAP 1.2 request Accept header, when present, admits application/soap+xml` | An Accept header on a SOAP 1.2 request must not exclude the SOAP media type (SOAP 1.2 Part 2 section 7). |
| `HTTP 405 responses advertise POST via the Allow header` | A 405 from a SOAP endpoint must list POST in `Allow` (SOAP 1.2 Part 2 section 7 / RFC 9110). |
| `HTTP 202 responses carry no SOAP envelope` | A 202 acknowledges without a response envelope (SOAP 1.2 Part 2 section 6.3). |
| `SOAP response contains no DTD or processing instruction` | WS-I Basic Profile 1.1 R1008/R1009. |
| `No element trailers follow the SOAP Body` | WS-I Basic Profile 1.1 R1011. |
| `SOAP Body has at most one direct child element` | WS-I Basic Profile 1.1 R2201. |
| `SOAP Body children are namespace-qualified` | WS-I Basic Profile 1.1 R1014. |
| `SOAP Header children are namespace-qualified` | WS-I Basic Profile 1.1 R1027. |
| `env:mustUnderstand and env:relay values are xs:boolean` | SOAP 1.2 Part 1 section 5.2.3. |
| `soap:mustUnderstand values use only 0 or 1` | SOAP 1.1 section 4.2.3 / WS-I Basic Profile 1.1 R1013. |
| `SOAP role attributes are URIs or predefined roles` / `SOAP actor attributes are URIs` | SOAP 1.2 Part 1 section 5.2.2 / SOAP 1.1 section 4.2.2. |
| `Literal response carries no encodingStyle on SOAP structural elements` | WS-I Basic Profile 1.1 R1005 / SOAP 1.2 Part 1 section 5.1.1. |
| `Expected response element is the direct child of soap:Body` | WS-I Basic Profile 1.1 R2201. |
| `Response element namespace matches the WSDL schema declaration` | WS-I Basic Profile 1.1 R2712. |
| `Zero-part document-literal response Body is empty` | WS-I Basic Profile 1.1 R2201. |
| `RPC-literal response wrapper and part accessors follow WS-I Basic Profile 1.1` | The response wrapper and part accessors follow the rpc-literal wire shape (R2729/R2735). |
| `One-way SOAP response body is empty` / `One-way SOAP response status is 200, 202 or 204` | WS-I Basic Profile 1.1 R2714 / SOAP 1.2 Part 2 section 6.3. |
| `MustUnderstand/VersionMismatch fault diagnostics are well-formed` | `NotUnderstood` / `Upgrade` header blocks carry their mandatory attributes (SOAP 1.2 Part 1 section 5.4.8). |
| `WS-Addressing response headers are present` / `wsa:Action matches the WSDL output action` / `wsa:RelatesTo echoes the request wsa:MessageID` | Emitted when the WSDL engages WS-Addressing: the response `wsa:Action` must match the declared or derived output action and `RelatesTo` must echo the request `MessageID` (WS-Addressing 1.0 Core / Metadata). |

On the request side, generated SOAP 1.1 requests always carry the `SOAPAction` HTTP header (required by the WS-I Basic Profile), while SOAP 1.2 requests carry the action as the `action` parameter of the `application/soap+xml` Content-Type (RFC 3902).

A WS-I Basic Profile 1.1 document lint pass also runs at generation time over the WSDL itself, surfacing `SOAP_LINT_*` warnings: bindings must mirror their portType’s operations one-to-one (R2718, `SOAP_LINT_BINDING_PORTTYPE_MISMATCH`) and resolve (`SOAP_LINT_PORTTYPE_UNRESOLVED`); a binding uses a single style (R2705, `SOAP_LINT_MIXED_STYLES`) with `use="literal"` (R2706, `SOAP_LINT_USE_NOT_LITERAL`) over the HTTP transport (`SOAP_LINT_TRANSPORT_NOT_HTTP`); document-literal bodies bind at most one part (`SOAP_LINT_DOC_LITERAL_MULTIPART`) defined as an `element` (`SOAP_LINT_DOC_LITERAL_PART_TYPE`) with no `namespace` attribute on the `soap:body` (`SOAP_LINT_DOC_LITERAL_BODY_NAMESPACE`), while rpc-literal parts use `type` (`SOAP_LINT_RPC_LITERAL_PART_ELEMENT`) and declare an absolute body `namespace` (`SOAP_LINT_RPC_LITERAL_BODY_NAMESPACE`); operations in one binding must not produce identical top-level Body QNames on the wire (`SOAP_LINT_DUPLICATE_WIRE_SIGNATURE`); `soap:fault` names must match the enclosing `wsdl:fault` (`SOAP_LINT_FAULT_NAME_MISMATCH`); part names are unique per message (`SOAP_LINT_DUPLICATE_PART_NAME`); ports should not share a `soap:address` (R2711, `SOAP_LINT_DUPLICATE_ADDRESS`) and addresses must be http(s) URLs (`SOAP_LINT_ADDRESS_NOT_HTTP`); `wsdl:import` must point at a WSDL document, not an XML Schema (`SOAP_LINT_IMPORT_NON_WSDL`); the `targetNamespace` must be present and absolute (`SOAP_LINT_TARGET_NAMESPACE_MISSING` / `_RELATIVE`); one-way operations must not bind an output (`SOAP_LINT_ONE_WAY_OUTPUT_MISMATCH`); and the doc-literal-wrapped convention is detected and recorded (`SOAP_LINT_DOC_LITERAL_WRAPPED`). Parse-level degradations surface as `SOAP_BINDING_STYLE_UNPARSEABLE`, `SOAP_BODY_USE_UNPARSEABLE`, `SOAP_MESSAGE_UNRESOLVED`, `SOAP_OPERATION_ONE_WAY`, `SOAP_ADDRESSING_ACTION_UNDERIVABLE`, and `SOAP_NO_OPERATIONS`.

## GraphQL

Generated from a GraphQL SDL or introspection JSON. Beyond `GraphQL operation mapping exists`, each operation `<label>` gets:

| Test name | What it checks |
| --- | --- |
| `[<label>] HTTP transport is ok` | The HTTP transport succeeded. |
| `[<label>] GraphQL response map follows the spec response format` | The top-level response map contains no entries other than `data`, `errors`, and `extensions`; `extensions` (when present) is a map; a request-error result (no `data` entry) carries a non-empty `errors` list; and `data` (when present) is `null` or a map of root fields (GraphQL spec section 7.1). |
| `[<label>] GraphQL errors are well-formed and not a total failure` | Each `errors` entry is a map with a string `message`; `locations` entries (when present) are maps of positive-integer `line`/`column`; `path` segments are string field names or integer list indices; per-error `extensions` is a map; `errors` (when present) is non-empty; a path-bearing error implies a `data` entry; a `path` begins with the requested root field’s response key; and at most one error targets a given response path (GraphQL spec section 7.1.2). The response must also still carry usable `data`. |
| `[<label>] data.<field> is present` | The selected root field is present in `data`. |
| `[<label>] data.<field> matches schema return type` | The field's value matches the return type declared in the schema. |
| `[<label>] required variables are supplied` | Every non-null operation variable has a value. |
| `[<operation>] GraphQL-over-HTTP media type and status are consistent` | The response media type must be `application/graphql-response+json` or `application/json`; with `application/graphql-response+json` a 2xx response must be a well-formed GraphQL response and a request-error result (no `data` entry) must use a non-2xx status; with `application/json` a response carrying data must be HTTP 200. A response without a `Content-Type` header fails (GraphQL-over-HTTP section 6.4). |

Generated requests send `Accept: application/graphql-response+json, application/json;q=0.9` alongside the JSON `Content-Type` (GraphQL-over-HTTP requires clients to indicate the media types they accept).

Generation-time schema lints run before instrumentation. Full type-system validation (graphql-js `validateSchema`) surfaces every violation — root operation object-ness, interface satisfaction, input-object cycle nullability, reserved `__` names, union member object-ness, directive argument validity — as `GQL_SCHEMA_INVALID` warnings. SDL that explicitly redefines a built-in scalar is flagged (`GQL_BUILT_IN_SCALAR_REDEFINED`); `@specifiedBy` must carry a parseable URL and never sit on a built-in scalar (`GQL_SPECIFIED_BY_URL_INVALID` / `GQL_SPECIFIED_BY_ON_BUILT_IN`); introspection JSON gets raw-shape lints for violations `buildClientSchema` silently tolerates — duplicate type names, unknown `__TypeKind` values, `NON_NULL` directly wrapping `NON_NULL`, non-boolean `isDeprecated` / malformed `deprecationReason`, non-OBJECT `possibleTypes`, unknown directive locations (`GQL_INTROSPECTION_*`). A deprecated root field exercised by a generated operation is called out (`GQL_DEPRECATED_FIELD_SELECTED`), and every generated operation document is re-validated against the schema it was derived from (GraphQL spec section 5), so a generator defect surfaces as `GQL_GENERATED_DOCUMENT_INVALID` instead of shipping silently.

## AsyncAPI (WebSocket / Socket.IO / MQTT)

AsyncAPI 2.0-2.6 and 3.0 documents generate native `ws-raw-request` / `ws-socketio-request` items, and documents with `mqtt`/`mqtts`/`secure-mqtt` servers or MQTT bindings generate native `mqtt-request` items. Contract enforcement here is static, at generation time: every message payload example is validated against its AsyncAPI payload schema, acknowledgement / 3.x reply schemas are compiled, and channel-to-message coverage is enforced against the built collection. For MQTT channels the same generation-time pass checks topic-name grammar, wildcard-filter placement, and MQTT binding value ranges (`ASYNCAPI_MQTT_*` warnings). The same pass also enforces channel-parameter coverage (every `{name}` expression in a channel address must be declared in the channel `parameters` object and vice versa — `ASYNCAPI_CHANNEL_PARAMETER_*`), correlationId `location` runtime-expression grammar (`ASYNCAPI_CORRELATION_LOCATION_INVALID`), AsyncAPI WebSockets channel-binding value ranges (`method` GET/POST and object `query`/`headers` schemas — `ASYNCAPI_WS_BINDING_INVALID`), and reserved Socket.IO lifecycle event names (`ASYNCAPI_SOCKETIO_RESERVED_EVENT`). The Postman CLI runner prunes `ws-*` and `mqtt-request` item types, so these items carry `runnableInCi: false` and their validation happens during generation rather than in a CI run. A document-wide lint pass in the same phase covers servers, security schemes, content types, schema formats, traits, message headers and examples, id/address/tag uniqueness, parameter objects, HTTP/Kafka/AMQP/WS bindings, IANA WebSocket subprotocols, external-docs URLs, and unresolved `$ref`s (`ASYNCAPI_*` warnings). Per-check detail and the warning codes involved are in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

## MCP

MCP server manifests — a registry `server.json` or an `mcpServers` client configuration — generate native `mcp-request` items: per server an `initialize`, `notifications/initialized`, and `tools/list` JSON-RPC 2.0 template, plus one `tools/call` per declared tool with arguments synthesized from the tool’s `inputSchema`. Remote `mcp-request` payloads include `MCP-Protocol-Version` metadata alongside manifest headers. Secret header and environment values are replaced with `{{variable}}` placeholders and never persisted into the collection.

`mcp-request` items expose no test-script slot and the Postman CLI runner prunes them, so their contract enforcement is static, at generation time: every generated JSON-RPC message must be a well-formed JSON-RPC 2.0 request, synthesized `tools/call` arguments are validated against the tool’s compiled `inputSchema`, server transport material is checked (URL scheme, stdio command presence, no concrete secret values), tool `annotations` behavior hints are type-checked (`MCP_TOOL_ANNOTATION_INVALID`), a declared tool `outputSchema` must be a compilable object schema — the MCP 2025-06-18 `structuredContent` commitment (`MCP_TOOL_OUTPUT_SCHEMA_*`) — tool names must be unique with type-checked `title`/`description` metadata and `title`-precedence advisories (`MCP_TOOL_NAME_DUPLICATE`, `MCP_TOOL_BASE_METADATA_INVALID`, `MCP_TOOL_TITLE_PRECEDENCE`, `MCP_TOOL_FIELD_UNKNOWN_2025_06_18`), `_meta` keys must follow the MCP key grammar outside the reserved `modelcontextprotocol`/`mcp` prefixes (`MCP_META_KEY_INVALID` / `MCP_META_KEY_RESERVED_PREFIX`), declared `mimeType` values must be RFC 6838 `type/subtype` (`MCP_MIME_TYPE_INVALID`), and item coverage and a collection size gate are enforced. Findings surface as `MCP_*` warnings; per-check detail is in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md).

Servers that expose a Streamable HTTP endpoint additionally get a runnable `http-request` lane that exercises the MCP 2025-06-18 HTTP transport live in the Postman CLI: `initialize` (HTTP 2xx; JSON or SSE `Content-Type`; a single JSON-RPC response object, never a batch; a negotiated `protocolVersion` from the supported revision set saved for later requests; typed `capabilities` sub-shapes; `serverInfo` shape; visible-ASCII `Mcp-Session-Id`), `notifications/initialized` (HTTP 202 with an empty body), `ping` (string-id echo with an empty result), `tools/list` (result shape, live annotations/outputSchema typing, manifest subset accumulated across cursor pages, cross-page tool-name uniqueness, capability gate, `nextCursor` string capture, and bounded termination), `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, one `tools/call` per tool (JSON-RPC result envelope, required typed content blocks, strict base64/media-type/absolute-URI validation for image/audio/resource content, annotations and `_meta` grammar/reserved-prefix checks, `structuredContent` validated against the tool’s declared `outputSchema`, and a JSON text mirror for `structuredContent` compatibility), resource URI/template grammar checks, progress-stream probes (`total`/`message` typing plus monotonic progress before the terminal response), and negative probes: an unsupported `MCP-Protocol-Version` header must draw HTTP 400, an invalid `tools/list` cursor must draw a JSON-RPC error, session `DELETE` must terminate the session or answer 405, and the terminated session id must be rejected afterwards. A server with no HTTP URL records `MCP_RUNTIME_SURFACE_UNAVAILABLE`; lane coverage fails closed with `MCP_HTTP_ITEM_COVERAGE_FAILED`.

## When something fails

- A failing test in a run names the operation and the clause it enforces. Fix the implementation or the spec, then rerun; the contract collection is regenerated from the current spec on the next bootstrap run.
- Generation-time warnings and hard failures carry coded prefixes (`ASYNCAPI_`, `CONTRACT_`, `GQL_`, `GRPC_`, `MCP_`, `PROTO_`, `SOAP_`). The remediation table for `CONTRACT_` codes is in the [README Errors section](../README.md#errors); protocol-specific codes are explained where each protocol is documented in [Multi-Protocol Contract Assertions](MULTIPROTOCOL-ASSERTIONS.md) and surface in the action log with their context.
