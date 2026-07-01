# Dynamic Contract Tests

Dynamic contract tests turn the generated `[Contract]` Postman collection into executable checks derived from the resolved OpenAPI document. The goal is to catch drift between generated requests, live responses, and the OpenAPI contract before the collection becomes the durable tracked contract collection.

## Pipeline

1. **Fetch and parse the OpenAPI document**
   - `spec-url` is fetched through the safe OpenAPI loader.
   - JSON and YAML specs are supported.
   - Only OpenAPI 3.0 and 3.1 documents are accepted.
   - External `$ref` documents are prefetched and bundled before validation.

2. **Validate and normalize the bundled spec**
   - The bundled OpenAPI document is validated with external and file resolution disabled.
   - External refs are bundled, then operation summaries are normalized before Spec Hub upload.
   - The loader builds a contract index from `paths` operations, responses, request requirements, response headers, schema content, server/path candidates, and warning conditions.

3. **Upload or update the Spec Hub spec**
   - Fresh runs upload the canonical bundled spec.
   - Reruns with `spec-id` update the existing spec with the same canonical bundled document used for validation and contract indexing, after capturing the previous content hash for rollback.

4. **Generate baseline, smoke, and contract collections**
   - Collection generation uses the uploaded Spec Hub UID.
   - `collection-sync-mode: refresh` generates temporary collections, then refreshes existing tracked collections in place when IDs are available.
   - The contract collection is instrumented before an existing tracked contract collection is overwritten.

5. **Instrument the contract collection**
   - Each Postman request is matched to one OpenAPI operation by HTTP method and normalized path.
   - Path matching supports OpenAPI templated path segments, Postman-style variable path segments, and server path prefixes.
   - The generated request receives a `test` event containing the OpenAPI-derived checks.
   - The collection also receives a `00 - Resolve Secrets` helper item for non-CI local runs.

6. **Fail if coverage is incomplete or ambiguous**
   - Every eligible OpenAPI `paths` operation must be covered by exactly one generated request.
   - Duplicate OpenAPI operation candidates, duplicate generated request matches, ambiguous matches, and missing operation coverage fail closed.

7. **Finalize the generated assets**
   - The instrumented contract collection is uploaded back to Postman.
   - Collections are tagged as generated docs, smoke, or contract collections.
   - If a Postman access token is available, the collections are linked and synced to the spec.

## What the generated tests validate

Generated Postman test scripts validate response behavior for the matched OpenAPI operation:

- **Operation mapping**
  - Confirms a generated request mapped to an OpenAPI operation.
  - Adds an explicit failing mapping test when no operation or multiple operations match.

- **Status codes**
  - Accepts exact response status codes, OpenAPI range keys such as `2XX`, or `default`.
  - Fails when the live status code is not defined by the operation.

- **Response headers**
  - Checks required response headers.
  - Validates header values against supported OpenAPI header schemas, coercing numeric and boolean header strings to the schema's declared type before validation so `type: integer` rate-limit headers validate correctly.
  - Ignores a response header named `Content-Type`, which the OAS spec says SHALL be ignored; the Content-Type negotiation test covers it instead.
  - Splits array-of-scalar header values on commas (with whitespace trimmed), coerces each item to the declared item type, and validates the decoded array against the full header schema, including `minItems`/`maxItems`/`uniqueItems`.
  - Downgrades object-valued and otherwise undecodable header schemas to presence-only checks with `CONTRACT_HEADER_SCHEMA_NOT_VALIDATED`, since their serialized string cannot be decoded reliably.
  - Fails when a response header uses unsupported OpenAPI `content`.

- **Response body presence**
  - Requires empty bodies for `204`, `205`, `304`, and `HEAD`.
  - Requires a non-empty body when the selected OpenAPI response defines response content.
  - Requires an empty body when the selected OpenAPI response defines no response content.

- **Response `Content-Type`**
  - Matches the live `Content-Type` against the OpenAPI response media types.
  - Supports exact media matches, JSON subtypes, wildcard JSON subtypes, subtype wildcards, and `*/*`.
  - Fails when no media type matches or multiple media types match equally.

- **Response schema**
  - Compiles supported OpenAPI response schemas into standalone JavaScript validators.
  - Validates JSON responses with `pm.response.json()`.
  - Asserts JSON Schema `format` values that schemasafe supports (`date-time`, `date`, `time`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uri`, `uri-reference`, `uri-template`, `uuid`, `json-pointer`, `relative-json-pointer`, `regex`); other formats are stripped as annotations, and `format: int32` integers gain numeric range bounds.
  - Runs schema validation for non-JSON media only when the schema is a string type; non-JSON media with object schemas skip runtime schema validation with a `CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED` warning while Content-Type and body-presence checks still apply.

- **Security credential presence**
  - When the operation has enforceable security requirements, checks the sent request for matching credentials: API key header/query/cookie names, scheme-token Authorization prefixes for every registered HTTP scheme (RFC 7235 credentials open with the scheme token, so `Basic `, `Bearer `, `Digest `, and any other named scheme check case-insensitively by prefix), and `Authorization` presence or an `access_token` query parameter for OAuth2/OpenID Connect.
  - Requirement alternatives use OR semantics; schemes inside one requirement use AND semantics.
  - Disabled request headers and query parameters do not count as credentials; cookie credentials are looked up through `pm.cookies` first so cookie-jar cookies attached at send time are visible, with the authored `Cookie` header as fallback.
  - Operations with optional security (an empty requirement object) skip the check; `mutualTLS` and unresolvable schemes are treated as not checkable, and the check is omitted entirely when any requirement alternative consists only of uncheckable schemes, since such a test could never fail.

- **Spec example self-consistency**
  - Validates media-type `example` and `examples` values against their own packed schemas at instrumentation time and warns with `CONTRACT_EXAMPLE_SCHEMA_MISMATCH`; generated request bodies are built from these examples, so mismatches predict runtime failures.

- **Request parameter values**
  - Validates concrete scalar query/header parameter values against their OpenAPI schemas at runtime, coercing numeric and boolean strings to the declared type.
  - Covers default-serialization scalar parameters plus single-JSON-media `content` parameters (parsed and schema-validated at runtime).
  - Decodes and validates array-of-scalar query parameters across the decodable styles: exploded `form` arrays are gathered from repeated query keys, and non-exploded `form`, `spaceDelimited`, and `pipeDelimited` arrays are split on their declared delimiter; each item is coerced to the declared item type and the decoded array is validated against the full array schema. Array-of-scalar header parameters with default `simple` serialization are split on commas the same way.
  - Parameters declaring `allowReserved`, an unvalidatable `content` shape, or a style/explode combination the runtime cannot decode carry `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED`; object parameter schemas are skipped because their serialized form is not decodable.
  - Placeholder values such as `<integer>` or `{{variable}}` are skipped; absent required parameters fail; a present-but-empty scalar value is validated as the empty string, and an empty delimited array value decodes to the empty array, where `minItems` can fail it. Decoded query items are percent-decoded before validation; `allowEmptyValue` skips empty scalar and empty array values alike.
  - Header parameters named `Accept`, `Content-Type`, or `Authorization` are ignored everywhere, as the OAS Parameter Object requires.
  - Scalar path parameter values are validated at runtime: the operation path template is aligned against the trailing segments of the sent request path (server path prefixes sit ahead of them), the matched segment is URL-decoded and coerced, and unresolved `:variable`, `{template}`, or placeholder segments are skipped. Path parameters with non-scalar schemas carry `CONTRACT_PATH_PARAM_NOT_VALIDATED`.
  - Required cookie parameters are asserted present at runtime through `pm.cookies` with the authored `Cookie` header as fallback, and scalar cookie values are validated against their schemas; because generated requests cannot include cookies, the test fails until the cookie is supplied at send time.

- **Request body schema**
  - Validates concrete, parseable JSON request bodies against a request-side packed schema where `readOnly` properties are stripped and `writeOnly` properties are kept, the mirror of response packing.
  - Bodies containing placeholder tokens such as `"<string>"` or `{{variables}}` are skipped; a non-placeholder body that fails to parse as JSON fails the test.
  - Request schemas that cannot be packed warn with `CONTRACT_REQUEST_SCHEMA_NOT_VALIDATED`.

- **Content-Length consistency**
  - Requires `Content-Length`, when present, to be a non-negative integer.
  - Requires `Content-Length: 0` when the selected response defines no body, except for `HEAD` requests, `304` responses where a representation length is legitimate, and responses carrying `Content-Encoding` where the encoded length differs from the decoded body.

- **Static request shape before upload**
  - Confirms generated requests include required non-security query parameters.
  - Confirms generated requests include required non-security headers.
  - Confirms required request bodies exist.
  - Confirms required request body `Content-Type` matches the OpenAPI content type.
  - Warns (`CONTRACT_REQUEST_BODY_INCOMPLETE`) when a parseable generated JSON, urlencoded, or multipart body is missing the schema's top-level required properties, merging `allOf` members and excluding `readOnly` properties; bodies with Postman template variables are skipped. Warnings are used because spec examples are legally partial and a hard failure would block bootstrap on spec-legal input.
  - Warns (`CONTRACT_READONLY_PROPERTY_IN_REQUEST`) when a generated body includes `readOnly` properties.
  - Warns (`CONTRACT_UNDOCUMENTED_QUERY_PARAM`) when a generated request sends a query parameter the operation does not declare, with security-scheme query names allowed.

## OpenAPI and schema support

Supported:

- OpenAPI 3.0 and 3.1.
- Internal `$ref` after bundling.
- External HTTPS refs that pass the safe fetch policy.
- Response schemas and header schemas backed by compatible JSON Schema dialects.
- OpenAPI 3.0 `nullable`.
- OpenAPI 3.1 `$ref` siblings, modeled as an `allOf` wrapper.
- `writeOnly` response properties are removed from generated response validators.

Fail-closed or warning behavior:

- Swagger 2.0 and missing/unsupported OpenAPI versions fail.
- Operations without responses fail.
- Specs with no eligible `paths` operations fail.
- Unsupported schema dialects or keywords produce failing generated checks instead of weak validation.
- Recursive `$ref` schemas are supported: referenced schemas pack once into a `#/$defs` registry inside each validator, which also keeps generated scripts near-linear in unique schema count.
- A reference graph larger than 400 unique schemas per media type degrades that schema check to presence-only with a `CONTRACT_SCHEMA_NOT_COMPILED` warning; schema nesting beyond depth 50 is unsupported.
- Schemas the validator engine refuses to compile (structural pedantry on otherwise legal documents) degrade to runtime skips with `CONTRACT_SCHEMA_NOT_COMPILED` warnings instead of failing the bootstrap.
- Webhooks and callbacks are warned as not covered.
- Security requirements are warned as not runtime-proven beyond credential presence.
- Required cookie parameters are warned as not includable in generated requests; the runtime presence assertion fails until the cookie is supplied at send time.
- Deprecated operations are warned with `CONTRACT_OPERATION_DEPRECATED`.
- Response links are warned with `CONTRACT_LINKS_NOT_VALIDATED`.
- Parameters with non-default `style`, `explode`, or `allowReserved` are warned with `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED`. Parameters declared through `content` with a single JSON media type carry literal JSON values, so they are parsed and validated against their schema at runtime (placeholder values skip; unparseable values fail); other `content` shapes warn.
- Query parameters with `allowEmptyValue: true` skip value validation for empty sent values.
- Parameter schemas that fail to pack are warned with `CONTRACT_SCHEMA_NOT_COMPILED`; object parameter schemas and undecodable array forms (tuple schemas, `$ref` or non-scalar items) are a documented skip.
- Media-type `encoding` objects are checked statically against the generated artifact. For `multipart/form-data`, a declared per-part `contentType` must appear on every matching generated formdata entry, duplicates included (comma lists, `type/*` wildcards, and media-type parameters honored), and binary fields must be generated as file parts; a field is binary when its schema declares `format: binary`, or under 3.1 a `contentMediaType` without `contentEncoding` whose media type is not JSON or `text/*`. Fields declaring a JSON `contentType` must carry parseable JSON values in multipart text parts and urlencoded entries (placeholder values skip). Violations warn with `CONTRACT_ENCODING_MISMATCH`. For `application/x-www-form-urlencoded`, fields declaring non-default `style`, `explode`, or `allowReserved` warn with `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED`. Per-part `headers` are unrepresentable on Postman formdata entries and warn with `CONTRACT_ENCODING_HEADERS_NOT_VALIDATED`; the wire-level multipart framing is owned by the Postman runtime and is not reconstructed.
- Parameter and header `example`/`examples` values and parameter-level `deprecated` are annotations with no assertion.
- Map-valued keywords (`patternProperties`, `dependentSchemas`, `dependentRequired`, draft-07 `dependencies`) are packed with their keys preserved; dialect-mismatched keywords (such as `prefixItems` under draft-07) fail closed.
- Non-JSON media types with object schemas skip runtime schema validation and are warned with `CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED`; Content-Type and body-presence checks still apply.
- `contentEncoding`, `contentMediaType`, `contentSchema`, and `$comment` are stripped as annotations (`contentMediaType` still feeds the multipart binary file-part check).
- A `discriminator` beside `oneOf`/`anyOf` whose members are all internal `$ref`s is enforced: each branch gains a dispatch constraint requiring the discriminator property to equal its mapped value (explicit `mapping` entries first, schema-name fallback, multiple aliases become an `enum`). Discriminators in any other placement (allOf-parent inheritance, inline members) cannot be dispatched without creating reference cycles on the same instance, so they are stripped with `CONTRACT_DISCRIMINATOR_NOT_VALIDATED`.
- Generated form bodies validate statically beyond required/readOnly: scalar urlencoded and multipart text values are coerced and checked against their property schemas (`CONTRACT_FORM_FIELD_SCHEMA_MISMATCH`), and an optional request body that the generator chose to send still has its Content-Type checked against the declared media types (warning rather than failure, since omitting the body was legal).
- Dual numeric bound pairs (`minimum` with `exclusiveMinimum`, `maximum` with `exclusiveMaximum`) keep the stricter single assertion per side, since schemasafe refuses the pair.
- Boolean schemas pack as unconstrained (`true`) or fail closed (`false`).
- `readOnly`/`writeOnly` direction flags are read through one internal `$ref` hop, so shared writeOnly components are stripped from response validators.

## Safe spec and ref fetching

OpenAPI documents and external refs are fetched through a constrained HTTPS fetcher. Fetch errors redact URL credentials, query strings, and fragments before logging:

- Only `https:` URLs are allowed.
- Credentials in URLs are blocked.
- `localhost`, `.localhost`, `.local`, and `.internal` hostnames are blocked.
- Private, loopback, link-local, documentation, multicast, carrier-grade NAT, and other reserved IPv4/IPv6 ranges are blocked.
- DNS is resolved before request dispatch, and the request is pinned to the selected address.
- The remote socket address is checked against the DNS-pinned address to reduce DNS rebinding risk.
- Redirects are revalidated with the same URL and address rules.

Default resource limits:

| Limit | Default |
| --- | ---: |
| Redirects | 5 |
| External refs | 100 |
| Ref depth | 20 |
| Bytes per resource | 25 MiB |
| Total bytes | 25 MiB |

## Generated script safety and size gates

Generated scripts are scanned before upload:

- `pm.response.to.have.jsonSchema` is forbidden so validation is not delegated to the bundled schema engine.
- `eval` is forbidden.
- `new Function` is forbidden.
- Scripts above 256 KiB emit a warning.
- Scripts above 900 KiB fail.
- Instrumented collection updates above 4 MiB fail.

## What dynamic contract tests do not prove

Dynamic contract tests are contract checks rather than complete end-to-end product tests. They do not prove:

- The server enforces auth or authorization correctly.
- API keys, bearer tokens, OAuth flows, or other credentials were accepted for the right reason.
- Business workflows spanning multiple requests.
- Data persistence or side effects beyond the checked response.
- Webhook delivery.
- Callback execution.
- Full non-JSON payload semantics beyond string-body checks.
- Consumer-specific environment variables or secrets are configured correctly.

Security schemes are detected and surfaced as `CONTRACT_SECURITY_NOT_VALIDATED` warnings. Dedicated auth and business-flow tests should cover those behaviors separately.

## Failure and rollback behavior

Dynamic contract failures use `CONTRACT_*` error prefixes so callers can distinguish contract failures from generic bootstrap failures.

Common failure categories:

| Category | Example codes |
| --- | --- |
| Fetch safety | `CONTRACT_SPEC_FETCH_BLOCKED`, `CONTRACT_SPEC_FETCH_FAILED` |
| Ref/resource limits | `CONTRACT_REF_LIMIT_EXCEEDED`, `CONTRACT_REF_DEPTH_EXCEEDED`, `CONTRACT_REF_SIZE_EXCEEDED` |
| OpenAPI loading | `CONTRACT_SPEC_PARSE_FAILED`, `CONTRACT_SPEC_VALIDATION_FAILED`, `CONTRACT_UNSUPPORTED_OPENAPI_VERSION` |
| Contract indexing | `CONTRACT_OPERATION_NO_RESPONSES`, `CONTRACT_NO_ELIGIBLE_OPERATIONS`, `CONTRACT_DUPLICATE_OPERATION_MATCH` |
| Indexing warnings | `CONTRACT_SECURITY_NOT_VALIDATED`, `CONTRACT_COOKIE_PARAM_NOT_VALIDATED`, `CONTRACT_OPERATION_DEPRECATED`, `CONTRACT_LINKS_NOT_VALIDATED`, `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED`, `CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED` |
| Instrumentation warnings | `CONTRACT_REQUEST_BODY_INCOMPLETE`, `CONTRACT_READONLY_PROPERTY_IN_REQUEST`, `CONTRACT_UNDOCUMENTED_QUERY_PARAM`, `CONTRACT_REQUEST_SCHEMA_NOT_VALIDATED` |
| Request matching | `CONTRACT_DUPLICATE_OPERATION_REQUEST`, `CONTRACT_OPERATION_COVERAGE_FAILED`, `CONTRACT_STATIC_REQUEST_CHECK_FAILED` |
| Script safety | `CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT`, `CONTRACT_SCRIPT_SIZE_EXCEEDED`, `CONTRACT_COLLECTION_SIZE_EXCEEDED` |
| Rollback | `CONTRACT_SPEC_ROLLBACK_FAILED` |

For existing spec updates, the action captures the previous normalized spec content and SHA-256 before mutation. If a later required step fails after the update, the action attempts to restore the previous Spec Hub content. If that restore fails, `CONTRACT_SPEC_ROLLBACK_FAILED` includes the previous content SHA-256 for manual restoration.

Refresh mode also tracks temporary generated collections. If refresh fails after temporary collection generation, the action attempts to delete those temporary collections.

Optional workspace enrichment steps such as governance assignment warn and continue; required spec, lint, collection generation, instrumentation, tagging, linking, and sync failures stop the bootstrap path.

## Source map

- `src/index.ts`: bootstrap orchestration, preflight timing, collection lifecycle, rollback, tagging, link/sync.
- `src/lib/spec/openapi-loader.ts`: OpenAPI fetch, parse, bundle, validate, and contract index creation.
- `src/lib/spec/safe-spec-fetch.ts`: HTTPS-only SSRF-safe fetching and ref/resource limits.
- `src/lib/spec/contract-index.ts`: OpenAPI operation indexing, response/header/request requirements, path candidates, warnings.
- `src/lib/spec/collection-contracts.ts`: request matching, static request checks, generated Postman scripts, coverage checks, size gates.
- `src/lib/spec/schema-pack.ts`: schema normalization and supported/unsupported schema decisions.
- `src/lib/spec/schema-validator-code.ts`: standalone schema validator generation.
- `tests/dynamic-contract-hardening.test.ts`: security and contract hardening coverage.
- `tests/bootstrap-action.test.ts`: orchestration, rollback, refresh, link/sync, and governance behavior coverage.
