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
  - Validates header values against supported OpenAPI header schemas.
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
  - Allows non-JSON validation only for string schemas; non-string non-JSON schemas fail closed.

- **Static request shape before upload**
  - Confirms generated requests include required non-security query parameters.
  - Confirms generated requests include required non-security headers.
  - Confirms required request bodies exist.
  - Confirms required request body `Content-Type` matches the OpenAPI content type.

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
- Recursive schemas and excessive schema depth are unsupported.
- Webhooks and callbacks are warned as not covered.
- Security requirements are warned as not runtime-proven.

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

- `pm.response.to.have.jsonSchema` is forbidden so validation is not delegated to Postman's bundled schema engine.
- `eval` is forbidden.
- `new Function` is forbidden.
- Scripts above 256 KiB emit a warning.
- Scripts above 900 KiB fail.
- Instrumented collection updates above 4 MiB fail.

## What dynamic contract tests do not prove

Dynamic contract tests are contract checks, not complete end-to-end product tests. They do not prove:

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
| Request matching | `CONTRACT_DUPLICATE_OPERATION_REQUEST`, `CONTRACT_OPERATION_COVERAGE_FAILED`, `CONTRACT_STATIC_REQUEST_CHECK_FAILED` |
| Script safety | `CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT`, `CONTRACT_SCRIPT_SIZE_EXCEEDED`, `CONTRACT_COLLECTION_SIZE_EXCEEDED` |
| Rollback | `CONTRACT_SPEC_ROLLBACK_FAILED` |

For existing spec updates, the action captures the previous normalized spec content and SHA-256 before mutation. If a later required step fails after the update, the action attempts to restore the previous Spec Hub content. If that restore fails, `CONTRACT_SPEC_ROLLBACK_FAILED` includes the previous content SHA-256 for manual restoration.

Refresh mode also tracks temporary generated collections. If refresh fails after temporary collection generation, the action attempts to delete those temporary collections.

Optional workspace enrichment steps such as governance assignment warn and continue; required spec, lint, collection generation, instrumentation, tagging, linking, and sync failures stop the bootstrap path.

## Source map

- `src/index.ts` — bootstrap orchestration, preflight timing, collection lifecycle, rollback, tagging, link/sync.
- `src/lib/spec/openapi-loader.ts` — OpenAPI fetch, parse, bundle, validate, and contract index creation.
- `src/lib/spec/safe-spec-fetch.ts` — HTTPS-only SSRF-safe fetching and ref/resource limits.
- `src/lib/spec/contract-index.ts` — OpenAPI operation indexing, response/header/request requirements, path candidates, warnings.
- `src/lib/spec/collection-contracts.ts` — request matching, static request checks, generated Postman scripts, coverage checks, size gates.
- `src/lib/spec/schema-pack.ts` — schema normalization and supported/unsupported schema decisions.
- `src/lib/spec/schema-validator-code.ts` — standalone schema validator generation.
- `tests/dynamic-contract-hardening.test.ts` — security and contract hardening coverage.
- `tests/bootstrap-action.test.ts` — orchestration, rollback, refresh, link/sync, and governance behavior coverage.
