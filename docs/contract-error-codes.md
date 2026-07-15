# Contract Error Codes

Every `CONTRACT_*` code the bootstrap action can emit, grouped by the enforcement layer that detects it and by its effect on the run. The layer model itself -- what runs at bootstrap time versus inside the customer CI collection run -- is documented in [Contract Enforcement Layers](contract-enforcement-layers.md).

Two effects exist:

- **Fails the run.** The bootstrap stops before any durable Postman asset is overwritten. Spec updates roll back to the previously captured content when possible.
- **Warning.** The condition is logged (`core.warning` in GitHub Actions, stderr in CLI mode) and the run continues. Static document lints and runtime-coverage disclosures are always warnings; they never gate collection generation and are never compiled into the generated test scripts.

Codes whose names end in `_NOT_VALIDATED`, `_ADVISORY`, or `_SKIPPED`, plus `CONTRACT_SCHEMA_NOT_COMPILED`, are coverage disclosures: they document exactly which check the runtime layer cannot perform, so a skipped validation is never invisible.


## Spec loading and ref resolution

These codes fail the run.

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_SPEC_FETCH_BLOCKED` | Spec URL, ref URL, DNS result, redirect, or socket destination was not allowed. | Use public HTTPS spec/ref URLs that do not resolve to private or local networks. |
| `CONTRACT_SPEC_FETCH_FAILED` | Allowed HTTPS fetch failed or redirected too many times. | Check availability, status codes, and redirect chains. |
| `CONTRACT_REF_LIMIT_EXCEEDED` | External ref count exceeded the configured limit. | Reduce external ref fan-out or bundle the spec upstream. |
| `CONTRACT_REF_DEPTH_EXCEEDED` | Ref nesting exceeded the configured limit. | Flatten recursive/deep ref chains. |
| `CONTRACT_REF_SIZE_EXCEEDED` | A fetched resource or total fetched bytes exceeded limits. | Reduce spec/ref size or pre-bundle the document. |
| `CONTRACT_SPEC_PARSE_FAILED` | The fetched document was not valid JSON/YAML object content. | Fix the source document syntax. |
| `CONTRACT_SPEC_READ_FAILED` | The `spec-path` file could not be read from the workspace. | Verify the file exists at the configured path and that the workflow checked out the branch that contains it. |
| `CONTRACT_SPEC_VALIDATION_FAILED` | The bundled document failed OpenAPI validation. | Fix [OpenAPI validation](https://learning.postman.com/docs/design-apis/specifications/validate-a-specification/) errors. |
| `CONTRACT_UNSUPPORTED_OPENAPI_VERSION` | The document was not OpenAPI 3.0 or 3.1. | Provide an OpenAPI 3.0/3.1 document. |


## Branch-aware sync

These codes fail the run before any credential is validated or any workspace write is attempted.

| Code | Meaning | Fix |
| --- | --- | --- |
| `CONTRACT_DEFAULT_BRANCH_UNRESOLVED` | A non-legacy branch-strategy could not resolve the canonical branch (no explicit canonical-branch input and the provider exposes no default-branch variable). | Set the `canonical-branch` input. Bitbucket and Azure DevOps always require it under publish-gate/preview. |
| `CONTRACT_CHANNELS_INPUT_INVALID` | A `channels` entry was not `<branch-or-glob>=<CODE>` or the code was not 1-16 chars of A-Z 0-9 _ - starting with a letter. | Fix the malformed entry, e.g. `develop=DEV, release/*=RC`. |
| `CONTRACT_BRANCH_DECISION_INVALID` | The inherited `POSTMAN_BRANCH_DECISION` env value was not a valid serialized BranchDecision. | Let the first action in the run produce it, or unset the variable so this run decides locally. |
| `CONTRACT_STATE_UNREADABLE` | `.postman/resources.yaml` exists but is malformed YAML, not a mapping, or declares an unsupported state version. Malformed state never silently reopens the create path. | Fix or delete the file (restore it from git history if needed), or upgrade the action for newer state versions. |
| `CONTRACT_BRANCH_CANONICAL_WRITE` | A non-canonical branch run attempted to mutate a canonical asset or tracked state. | Run canonical writes from the canonical branch only; preview/channel runs own only their suffixed asset sets. |

## Contract indexing

These codes fail the run.

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_NO_ELIGIBLE_OPERATIONS` | No eligible `paths` operations with responses were found. | Add path operations with responses. |
| `CONTRACT_OPERATION_NO_RESPONSES` | A `paths` operation had no response definitions. | Add at least one OpenAPI response to each path operation. |
| `CONTRACT_UNRESOLVED_REF` | A ref remained unresolved after secure bundling. | Fix the ref target or make the external ref HTTPS-accessible. |
| `CONTRACT_DUPLICATE_OPERATION_MATCH` | Multiple OpenAPI operations share the same canonical request mapping candidate. | Disambiguate paths, server prefixes, or templated routes. |


## Schema compilation

These codes are raised during validator generation and degrade to a `CONTRACT_SCHEMA_NOT_COMPILED` warning plus a runtime disclosure test entry instead of failing the bootstrap; the affected schema check is skipped at runtime.

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_UNSUPPORTED_SCHEMA_DIALECT` | A schema declared an unsupported JSON Schema dialect. | Use draft-07 or 2020-12-compatible schemas. |
| `CONTRACT_SCHEMA_COMPILE_FAILED` | schemasafe could not compile a response/header schema. | Simplify or correct the unsupported schema. |


## Static document lints

These codes are warnings raised while walking the OpenAPI document. They are advisory, logged, and never become runtime tests. Most catch document defects no live response would reveal (a HEAD operation declaring a body, a 304 on a POST, an OAuth token in the query string); the `_NOT_VALIDATED`/`_ADVISORY` codes among them are coverage disclosures for properties the runtime layer cannot check.

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_SECURITY_NOT_VALIDATED` | Security requirements were detected but dynamic tests cannot prove auth at runtime. | Run dedicated auth tests and review generated requests for required credentials. |
| `CONTRACT_WEBHOOKS_NOT_VALIDATED` | OpenAPI webhooks were present but are not included in dynamic contract coverage. | Validate webhook behavior separately or model required behavior under `paths`. |
| `CONTRACT_CALLBACKS_NOT_VALIDATED` | Operation callbacks were present but are not included in dynamic contract coverage. | Validate callback behavior separately or add dedicated tests. |
| `CONTRACT_COOKIE_PARAM_NOT_VALIDATED` | A required cookie parameter cannot be included in generated requests, and the runtime test asserts its presence, so the contract run fails until the cookie is supplied at send time. | Attach the cookie via the cookie jar or a `Cookie` header in the run setup, or move the parameter to a header/query location. |
| `CONTRACT_OPERATION_DEPRECATED` | A covered operation is marked `deprecated: true` in the OpenAPI document. | Plan removal of the deprecated operation or drop it from the spec when retired. |
| `CONTRACT_LINKS_NOT_VALIDATED` | Response links were present but link traversal is not part of dynamic contract coverage. | Validate linked operation chains with dedicated workflow tests. |
| `CONTRACT_LINKS_PARTIALLY_VALIDATED` | Evaluable link expressions (`$response.body#/...`, `$response.header.*`, `$request.body#/...`, `$request.path.*`, `$request.query.*`, `$request.header.*`) are asserted at runtime; `$url` and whole-body expressions are skipped. | Validate the skipped link expressions with dedicated workflow tests. |
| `CONTRACT_LINK_REQUIRED_INPUT_MISSING` | A response link resolves to a target operation but does not supply one or more required target parameters or a required target request body. | Add the missing link `parameters` or `requestBody` entry, or relax the target operation's required input. |
| `CONTRACT_UNKNOWN_HTTP_AUTH_SCHEME` | An `http`-type security scheme names an auth scheme outside the IANA HTTP Authentication Scheme registry. | Use a registered scheme name, or ignore if the scheme is intentionally private. |
| `CONTRACT_CREDENTIALS_IN_QUERY` | An `apiKey` security scheme sends credentials in the query string, which leaks into logs and referrers. | Move the credential to a header or cookie. |
| `CONTRACT_SECURITY_SCHEME_URL` | An OAuth2 flow URL or openIdConnect discovery URL is malformed, not HTTPS, or not a discovery-document path. | Fix the URL in `components.securitySchemes`. |
| `CONTRACT_OAUTH2_UNDECLARED_SCOPE` | An operation requires an OAuth2 scope that no flow of the referenced scheme declares. | Add the scope to the flow's `scopes` map or correct the operation's requirement. |
| `CONTRACT_SECURITY_RESPONSES_INCOMPLETE` | A secured operation documents no 401 (or a scoped operation no 403) and no 4XX/default catch-all. | Document the authentication and authorization failure responses. |
| `CONTRACT_UNSECURED_AUTH_RESPONSES` | An operation documents a 401/403 response but declares no security requirement. | Declare the operation's security or remove the auth error responses. |
| `CONTRACT_INVALID_STATUS_CODE` | A declared response key is outside RFC 9110's 100-599, 1XX-5XX, or `default` forms. | Fix the response key in the OpenAPI document. |
| `CONTRACT_BODYLESS_STATUS_WITH_CONTENT` | The spec declares response content for 204/205/304, which RFC 9110 forbids on the wire. | Remove the content declaration or use a different status code. |
| `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED` | A parameter declares `allowReserved`, `content`, or a style/explode combination the runtime cannot decode. Exploded `form` arrays and non-exploded `form`/`spaceDelimited`/`pipeDelimited` arrays of scalars are decoded and validated, so they no longer warn; `deepObject` query objects of scalars and `label`/`matrix` path scalars are likewise decoded and validated. | Validate the remaining serialized forms with dedicated tests. |
| `CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED` | A non-JSON response media type declares an object schema that runtime tests cannot validate. | Validate XML or other non-JSON payloads with dedicated tests; Content-Type and body presence are still checked. |
| `CONTRACT_REQUEST_SCHEMA_NOT_VALIDATED` | A JSON request body schema could not be compiled into a runtime request validator. | Simplify the unsupported request schema construct named in the warning. |
| `CONTRACT_EXAMPLE_SCHEMA_MISMATCH` | A media-type example does not validate against its own schema. | Fix the example or the schema so the spec is self-consistent; generated requests are built from these examples. |
| `CONTRACT_ENCODING_HEADERS_NOT_VALIDATED` | A multipart encoding object declares per-part `headers`, which Postman formdata entries cannot carry, so they are not asserted. | Validate per-part headers with dedicated tests if the server depends on them. |
| `CONTRACT_MULTIPART_ENCODING_FIELD_UNKNOWN` | A form-body `encoding` map names a field that is not a property of the request body schema, so the encoding entry can never apply. | Rename the encoding key to a declared schema property or remove it. |
| `CONTRACT_WELL_KNOWN_UNREGISTERED` | A path under `/.well-known/` uses a suffix that is not in the vendored IANA Well-Known URIs registry snapshot (RFC 8615). | Register the suffix, use a registered one, or move the resource out of `/.well-known/`. |
| `CONTRACT_DISCRIMINATOR_NOT_VALIDATED` | A `discriminator` has no sibling `oneOf`/`anyOf` of same-spec `$ref` members (typically allOf-parent inheritance), so its dispatch is not validated. | Restructure to the oneOf-plus-discriminator form, or rely on the still-validated composition keywords. |
| `CONTRACT_HEADER_SCHEMA_NOT_VALIDATED` | A response header declares an object or otherwise undecodable schema, so its serialized value is checked for presence only. Arrays of scalars are split on commas and validated. | Use a scalar or array-of-scalars header schema, or validate the serialized header form with dedicated tests. |
| `CONTRACT_PATH_PARAM_NOT_VALIDATED` | A path parameter declares a non-scalar schema or a serialization the runtime cannot decode, so its value is not validated. Scalar path parameters are validated at runtime against the resolved path segment. | Use a scalar path schema, or validate path value semantics with dedicated tests. |
| `CONTRACT_PATH_PARAM_COMPOUND_SEGMENT_NOT_VALIDATED` | A path parameter is embedded in a compound path segment (for example `/files/{name}.{ext}`), so its value cannot be extracted from the sent path and its schema is not validated at runtime. | Split the compound segment into its own path parameter, or validate the value semantics with a dedicated test. |
| `CONTRACT_CALLBACK_EXPRESSION_INVALID` | A callback key is not a valid OpenAPI runtime expression. | Fix the callback key so it follows the runtime expression syntax (for example `{$request.body#/url}`). |
| `CONTRACT_DEPRECATED_HEADERS_ADVISORY` | A deprecated operation declares neither `Deprecation` nor `Sunset` response headers. | Document `Deprecation` and/or `Sunset` headers on deprecated operations so clients learn the timeline. |
| `CONTRACT_DISCRIMINATOR_INVALID` | A discriminator is missing `propertyName`, the property is not declared by every `oneOf`/`anyOf` member (or by the base schema), or a mapping ref does not resolve. | Declare the discriminator property in each member schema, and point every mapping entry at a resolvable schema. |
| `CONTRACT_ENCODING_FIELD_UNKNOWN` | An `encoding` key does not match any property of the body schema. | Rename or remove the encoding entry so every key matches a schema property. |
| `CONTRACT_ENCODING_HEADER_INVALID` | An `encoding` entry lists `Content-Type` in its `headers` map. | Remove `Content-Type` from encoding headers and use the encoding `contentType` field instead. |
| `CONTRACT_FORMAT_UNKNOWN` | A schema uses a `format` value outside the recognized set; it is treated as an annotation only. | Use a registered format or accept that the value is not validated. |
| `CONTRACT_JSON_SCHEMA_DIALECT_UNSUPPORTED` | A schema declares an unsupported or non-absolute `$schema` dialect. | Use an absolute draft-07 or 2020-12 JSON Schema dialect URI, or drop `$schema`. |
| `CONTRACT_LINK_TARGET_INVALID` | A response link references an `operationId` or `operationRef` that does not resolve in the document. | Point the link at an operation defined in the spec. |
| `CONTRACT_MEDIA_RANGE_SHADOWING` | A response declares both `application/json` and `application/*+json` with different schemas, so the concrete type shadows the range ambiguously. | Align the two schemas or remove the overlapping media range. |
| `CONTRACT_OAS_VERSION_UNSUPPORTED_FIELD` | The document uses a field its declared OpenAPI version does not support (for example top-level `webhooks` in 3.0). | Remove the field or raise the `openapi` version accordingly. |
| `CONTRACT_ONEOF_OVERLAP` | Finite `oneOf`/`anyOf` branches share overlapping `const`/`enum` values, so a payload can match more than one branch. | Make the branch value sets disjoint. |
| `CONTRACT_OPERATION_ID_DUPLICATE` | The same `operationId` is used by more than one operation. | Give every operation a unique `operationId`. |
| `CONTRACT_PARAMETER_ALLOW_RESERVED_INVALID` | A parameter sets `allowReserved` outside of `in: query`. | Remove `allowReserved` from non-query parameters. |
| `CONTRACT_PARAMETER_CONTENT_INVALID` | A parameter `content` map does not contain exactly one media type. | Declare exactly one media type in the parameter's `content`. |
| `CONTRACT_PARAMETER_DEEPOBJECT_INVALID` | A parameter uses `style: deepObject` without being a query parameter with an object schema. | Restrict `deepObject` to query parameters whose schema is an object. |
| `CONTRACT_PARAMETER_DEEPOBJECT_NESTED` | A `deepObject` query parameter has nested object properties, which have no interoperable serialization. | Flatten the parameter schema to one level of scalar properties. |
| `CONTRACT_PARAMETER_DUPLICATE` | The same `in`/`name` parameter appears more than once after merging path-item and operation parameters. | Remove or rename the duplicate parameter. |
| `CONTRACT_PARAMETER_SCHEMA_CONTENT_XOR` | A parameter declares both `schema` and `content`. | Keep exactly one of `schema` or `content` per parameter. |
| `CONTRACT_PARAMETER_STYLE_INVALID` | A parameter uses a `style` value that is invalid for its location. | Use a style permitted for the parameter's `in` value (for example `form` for query, `simple` for header). |
| `CONTRACT_PATH_PARAMETER_BIJECTION` | Path template variables and `in: path` parameters do not match one-to-one. | Declare an `in: path` parameter for every template variable and remove parameters without a template counterpart. |
| `CONTRACT_PATH_PARAMETER_INVALID` | An `in: path` parameter does not declare `required: true`. | Mark every path parameter as required. |
| `CONTRACT_REF_SIBLING_INVALID` | A schema places sibling keywords beside `$ref`, which OpenAPI 3.0 ignores. | Move the siblings into an `allOf` wrapper or upgrade the document to OpenAPI 3.1. |
| `CONTRACT_RESPONSES_INVALID` | An operation's `responses` map is empty or uses keys that are not status codes, ranges like `2XX`, or `default`. | Declare at least one response under a valid status key. |
| `CONTRACT_SCHEMA_IMPOSSIBLE_MESSAGE` | A response schema requires properties that are `writeOnly`, so no valid response payload can exist. | Drop the `writeOnly` marker or remove those properties from `required`. |
| `CONTRACT_SCHEMA_VALUE_MISMATCH` | A schema `default` or `const` value is not a member of its `enum`, or `default` contradicts `const`. | Make the declared values consistent with each other. |
| `CONTRACT_SCHEMA_VERSION_MISMATCH` | A schema uses JSON Schema keywords that do not match the document's OpenAPI version (type arrays or numeric exclusives in 3.0, `nullable` or boolean exclusives in 3.1). | Use the keyword form that matches the declared `openapi` version. |
| `CONTRACT_SECURITY_SCHEME_UNDECLARED` | A security requirement references a scheme missing from `components.securitySchemes`. | Declare the scheme or fix the requirement name. |
| `CONTRACT_SERVER_VARIABLE_INVALID` | A server URL uses a `{variable}` with no matching `variables` entry, or a variable's default/enum values are inconsistent. | Declare every server URL variable with a valid default. |
| `CONTRACT_TAG_UNDECLARED` | An operation uses a tag that is not declared in the top-level `tags` list. | Add the tag to the top-level `tags` array or remove it from the operation. |
| `CONTRACT_TAG_UNUSED` | A top-level tag is not used by any operation. | Remove the unused tag or apply it to an operation. |
| `CONTRACT_TEMPLATED_PATH_COLLISION` | Two paths are identical once template variable names are erased (for example `/pets/{id}` and `/pets/{name}`). | Merge or restructure the colliding paths. |
| `CONTRACT_HEAD_RESPONSE_BODY` | A HEAD operation declares response content, but HEAD carries no message body. | Remove the body from HEAD responses or model it on the GET. |
| `CONTRACT_BODYLESS_STATUS_FRAMING_HEADER` | A 1xx or 204 response declares Content-Length or Transfer-Encoding, which RFC 9110 forbids. | Drop framing headers from bodyless statuses. |
| `CONTRACT_304_METHOD` | A 304 response is declared on a method other than GET or HEAD. | Restrict 304 to GET and HEAD operations. |
| `CONTRACT_304_CACHE_HEADER_MISSING` | A 304 omits a validator/cache header that its 200 representation marks required. | Mirror the required validator and cache headers on the 304. |
| `CONTRACT_304_CONTENT_LENGTH` | A 304 declares Content-Length even though it carries no body. | Remove Content-Length or ensure it equals the selected 200 representation. |
| `CONTRACT_RANGE_METHOD` | A Range request header is declared on a non-GET operation. | Only accept the Range header on GET. |
| `CONTRACT_206_METHOD` | A 206 response is declared on a non-GET operation. | Pair 206 responses with GET range requests. |
| `CONTRACT_206_RANGE_AFFORDANCE` | A 206 is declared without a Range request header to trigger it. | Declare the Range request header parameter. |
| `CONTRACT_206_CONTENT_RANGE` | A 206 declares neither a Content-Range header nor a multipart/byteranges body. | Add Content-Range (or a multipart/byteranges body) to the 206. |
| `CONTRACT_206_CACHE_HEADER_MISSING` | A 206 omits a validator/cache header its 200 representation marks required. | Mirror the required validator and cache headers on the 206. |
| `CONTRACT_416_CONTENT_RANGE` | A 416 Range Not Satisfiable response omits the Content-Range header. | Declare the Content-Range header on the 416. |
| `CONTRACT_IF_RANGE_PRECONDITION` | An If-Range request header is declared without a GET Range request. | Only accept If-Range on GET alongside a Range header. |
| `CONTRACT_IF_RANGE_RESPONSES` | An If-Range request header lacks a documented 206 or success response. | Document a 206 and a 200/2XX/default success response. |
| `CONTRACT_IF_MODIFIED_SINCE` | An If-Modified-Since header lacks GET/HEAD scope or a 304 response. | Restrict it to GET/HEAD and document the 304 response. |
| `CONTRACT_IF_NONE_MATCH_STATUS` | An If-None-Match header lacks the matching 304 (safe) or 412 (unsafe) response. | Document the conditional-outcome status for the method. |
| `CONTRACT_PRECONDITION_412` | An If-Match or If-Unmodified-Since header lacks a 412 response. | Document the 412 Precondition Failed response. |
| `CONTRACT_428_AFFORDANCE` | A 428 Precondition Required response accepts no conditional request header. | Accept a conditional header such as If-Match or If-None-Match. |
| `CONTRACT_NONCACHEABLE_STATUS_CACHE_HEADER` | A 428/429/431/511 response declares cache-storage headers though it must not be stored. | Remove cache-storage headers from these statuses. |
| `CONTRACT_401_WWW_AUTHENTICATE` | A secured operation's 401 response omits the WWW-Authenticate header. | Declare the WWW-Authenticate challenge header on the 401. |
| `CONTRACT_BEARER_CHALLENGE_NOT_VALIDATED` | The 401 Bearer challenge error and scope parameters are not statically literal-validated. | Review the WWW-Authenticate Bearer parameters during code review. |
| `CONTRACT_407_PROXY_AUTHENTICATE` | A 407 Proxy Authentication Required response omits the Proxy-Authenticate header. | Declare the Proxy-Authenticate header on the 407. |
| `CONTRACT_405_ALLOW` | A 405 Method Not Allowed response omits the Allow header. | Declare the Allow header listing the supported methods. |
| `CONTRACT_426_UPGRADE` | A 426 Upgrade Required response omits the Upgrade header. | Declare the Upgrade header on the 426. |
| `CONTRACT_REDIRECT_LOCATION` | A 301/302/303/307/308 redirect omits the Location header. | Declare the Location header on the redirect response. |
| `CONTRACT_202_MONITOR` | A 202 Accepted response provides no status-monitor affordance. | Add a Location/Link header or a status body to the 202. |
| `CONTRACT_PROBLEM_JSON_SHAPE_NOT_VALIDATED` | A problem+json response body's RFC 9457 members are not statically validated. | Review the problem members manually or add a strict schema. |
| `CONTRACT_PROBLEM_STATUS_NOT_VALIDATED` | A problem+json status member is not checked against the HTTP status code. | Ensure the problem status member equals the response status. |
| `CONTRACT_PROBLEM_EXTENSION_NOT_VALIDATED` | A problem+json response's extension member names are not statically validated. | Review extension member names for reserved-name collisions. |
| `CONTRACT_PROBLEM_XML_NOT_VALIDATED` | A problem+xml response's schema and examples are not statically validated. | Review the problem+xml representation manually. |
| `CONTRACT_LINK_OPERATION_REF_NOT_VALIDATED` | A Link operationRef's resolution to a single Operation Object is not statically proven. | Verify the operationRef target resolves to one operation. |
| `CONTRACT_LINK_PARAMETERS_NOT_VALIDATED` | A Link object's parameters are not statically matched against the target operation. | Verify link parameter names against the target operation. |
| `CONTRACT_LINK_REQUEST_BODY_SCHEMA_MISMATCH` | A literal Link `requestBody` value does not satisfy the target operation's JSON request-body schema. | Align the literal Link requestBody with the target operation schema, or use a runtime expression. |
| `CONTRACT_LINK_REQUEST_EXPRESSION_NOT_VALIDATED` | A Link $request runtime expression's ABNF and request parameter name are not validated. | Verify the runtime expression and declared request parameter. |
| `CONTRACT_LINK_HEADER_NOT_VALIDATED` | A Link response header's RFC 8288 field grammar is not statically literal-validated. | Review the Link header value grammar manually. |
| `CONTRACT_SERVER_URL_UNBOUND_VARIABLE` | A server URL retains template braces after applying variable defaults. | Give every server variable a default value. |
| `CONTRACT_SERVER_URL_UNPARSEABLE` | A server URL does not parse as a URI reference after default substitution. | Correct the server URL. |
| `CONTRACT_INSECURE_SERVER_FOR_SECURED_OP` | A secured operation lists a cleartext http:// server. | Use https:// servers for secured operations. |
| `CONTRACT_OAUTH_TOKEN_IN_QUERY` | A query parameter carries a bearer/OAuth token in the URI. | Move the token to the Authorization request header. |
| `CONTRACT_STANDARD_HEADER_GRAMMAR_NOT_VALIDATED` | A structured standard header's RFC field grammar is not statically literal-validated. | Review the header value grammar manually. |
| `CONTRACT_451_BLOCKED_BY_LINK` | A 451 Unavailable For Legal Reasons response omits a blocking-authority Link header. | Declare a Link header with rel=blocked-by. |
| `CONTRACT_XML_OBJECT_INVALID` | An XML Object is misused (non-absolute namespace, prefix without namespace, non-NCName name/prefix, wrapped on a non-array, attribute on an object/array, or advisory array item naming). | Correct the XML Object per the OpenAPI XML modeling rules. |
| `CONTRACT_SCHEMA_ID_INVALID` | A schema $id is not a valid URI reference. | Set $id to a valid absolute or relative URI reference. |
| `CONTRACT_CONTENT_MEDIA_TYPE_INVALID` | contentMediaType or contentEncoding is declared on a non-string schema. | Apply contentMediaType/contentEncoding only to string-typed schemas. |
| `CONTRACT_ENCODING_APPLICABILITY_INVALID` | An encoding map is declared outside a request-body multipart or urlencoded media type. | Remove the encoding map or move it to a form/multipart request body. |
| `CONTRACT_ENCODING_CONTENT_TYPE_INVALID` | An encoding contentType is not a valid media type. | Use a valid type/subtype media type in encoding.contentType. |
| `CONTRACT_ENCODING_FIELD_IGNORED` | An encoding style/explode/allowReserved (outside urlencoded) or headers (outside multipart) field is ignored. | Remove the ignored encoding fields for this media type. |
| `CONTRACT_ENCODING_CONTENT_TYPE_PRECEDENCE` | In OpenAPI 3.1 an encoding sets both contentType and style/explode; contentType wins and RFC 6570 serialization is ignored. | Drop style/explode when encoding.contentType is set. |
| `CONTRACT_MULTIPART_SERIALIZATION_ADVISORY` | RFC 6570 serialization on multipart parts is advisory and not runtime-validated. | Verify multipart part serialization manually. |
| `CONTRACT_PARAMETER_STYLE_TYPE_INVALID` | A parameter style does not apply to the parameter's declared type. | Use a style compatible with the parameter type. |
| `CONTRACT_HEADER_STYLE_INVALID` | A header parameter uses a style other than simple. | Set header parameter style to simple. |
| `CONTRACT_PARAMETER_EXAMPLE_NOT_VALIDATED` | A parameter example is a raw value whose serialized form is not statically validated. | Verify the serialized example form manually. |
| `CONTRACT_EXAMPLE_OBJECT_INVALID` | An Example Object sets both value and externalValue, or externalValue is not a valid URI reference. | Set exactly one of value/externalValue and use a valid URI. |
| `CONTRACT_MEDIA_EXAMPLE_ENCODING_NOT_VALIDATED` | A media example is not statically validated against its encoding map. | Verify the example against the encoding map manually. |


## Instrumentation and coverage gates

Failures stop the run before durable collections are overwritten; warnings are logged and the run continues. The per-code effect is stated below.

### Fails the run

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_STATIC_REQUEST_CHECK_FAILED` | Generated request missed a required non-security parameter or body. | Adjust generation options or the spec so generated requests include required shape. |
| `CONTRACT_DUPLICATE_OPERATION_REQUEST` | More than one generated request mapped to the same contract operation. | Disambiguate paths/operations or generated requests. |
| `CONTRACT_OPERATION_COVERAGE_FAILED` | Generated contract collection did not cover every eligible operation. | Regenerate the collection or fix operation paths. |
| `CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT` | Generated script included a forbidden dynamic validation construct. | Report the schema that triggered unsafe generation. |
| `CONTRACT_SCRIPT_SIZE_EXCEEDED` | A generated request test script exceeded the per-script size gate. | Reduce schema complexity or split the API. |
| `CONTRACT_COLLECTION_SIZE_EXCEEDED` | Instrumented contract collection exceeded the size gate. | Reduce schema/operation count or split the API. |

### Warnings

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_STATIC_REQUEST_CHECK_SKIPPED` | A static request-shape check could not be evaluated over the v3 collection surface (the request could not be reconstructed from the item IR). | Non-fatal; the runtime contract script still validates the response. Regenerate the collection if it persists. |
| `CONTRACT_REQUEST_BODY_INCOMPLETE` | A parseable generated request body is missing top-level required properties. | Fix the spec example or regenerate the collection so generated bodies satisfy the request schema. |
| `CONTRACT_READONLY_PROPERTY_IN_REQUEST` | A generated request body includes properties the schema marks `readOnly`. | Remove readOnly properties from request examples; they belong in responses. |
| `CONTRACT_UNDOCUMENTED_QUERY_PARAM` | A generated request sends a query parameter the operation does not declare. | Declare the parameter in the OpenAPI operation or remove it from the generated request. |
| `CONTRACT_METHOD_BODY_SEMANTICS` | A GET/HEAD/DELETE operation declares or sends a request body; RFC 9110 defines no request-body semantics for those methods. | Move the payload to a method with body semantics or drop it. |
| `CONTRACT_SCHEMA_NOT_COMPILED` | One schema could not be compiled by the validator engine, so its runtime check is skipped. | Review the named schema construct; other checks for the operation still run. |
| `CONTRACT_ENCODING_MISMATCH` | A generated form-body field does not match its OpenAPI encoding object: a declared multipart per-part `contentType` is missing or different, a binary-typed field was not generated as a file part, or a field declaring a JSON `contentType` carries an unparseable value. | Regenerate the collection or align the encoding object with the intended part layout. |
| `CONTRACT_FORM_FIELD_SCHEMA_MISMATCH` | A generated urlencoded or multipart text value does not validate against its scalar property schema. | Fix the spec example feeding the generated body, or correct the property schema. |


## Orchestration and rollback

These codes fail the run.

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_COLLECTION_FORMAT_UNSUPPORTED` | A protocol collection builder returned a non-v3 format; only v3/Extensible Collections are created (access-token EC API). | File a bug; the builder must emit v3-ec. No v2 collection is ever created. |
| `CONTRACT_COLLECTION_ID_COLLISION` | Baseline, smoke, and contract IDs were not pairwise distinct. | Pass distinct collection IDs or clear stale IDs. |
| `CONTRACT_PLAN_MISSING` | Contract instrumentation ran without a preflight-generated contract plan. | Rerun with dynamic contract preflight enabled and report the failure if it persists. |
| `CONTRACT_SPEC_ROLLBACK_FAILED` | Best-effort previous spec restoration failed after a later error. | Restore the previous spec content manually using the emitted SHA-256. |
