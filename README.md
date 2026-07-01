# Postman Onboarding: Workspace Bootstrap

[![CI](https://github.com/postman-cs/postman-bootstrap-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-bootstrap-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-bootstrap-action?sort=semver)](https://github.com/postman-cs/postman-bootstrap-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-bootstrap)](https://www.npmjs.com/package/@postman-cse/onboarding-bootstrap) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Provisions a [Postman workspace](https://learning.postman.com/docs/collaborating-in-postman/using-workspaces/overview/) from an OpenAPI spec, generating baseline, smoke, and contract collections in one step.

Part of the [Postman API Onboarding suite](https://github.com/postman-cs/postman-api-onboarding-action).

## Which action should I use?

| Need | Use |
| --- | --- |
| Full API onboarding pipeline | [`postman-cs/postman-api-onboarding-action`](https://github.com/postman-cs/postman-api-onboarding-action) |
| Mint a service-account access token for the pipeline | [`postman-cs/postman-resolve-service-token-action`](https://github.com/postman-cs/postman-resolve-service-token-action) |
| Create or refresh Postman workspaces, specs, and generated collections | This bootstrap action |
| Discover OpenAPI specs from AWS services | [`postman-cs/postman-aws-spec-discovery-action`](https://github.com/postman-cs/postman-aws-spec-discovery-action) |
| Apply a curated flow.yaml to the Smoke collection | [`postman-cs/postman-smoke-flow-action`](https://github.com/postman-cs/postman-smoke-flow-action) |
| Sync generated Postman artifacts back to the repo | [`postman-cs/postman-repo-sync-action`](https://github.com/postman-cs/postman-repo-sync-action) |
| Link Insights discovered services to the workspace | [`postman-cs/postman-insights-onboarding-action`](https://github.com/postman-cs/postman-insights-onboarding-action) |

## Region

The action defaults to the US production region (`postman-region: us`). [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/) teams should set `postman-region: eu` on this action and on the service-token step that feeds it.

## Usage

```yaml
name: Bootstrap Postman workspace
on:
  push:
    branches: [main]

jobs:
  bootstrap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - id: postman_token
        uses: postman-cs/postman-resolve-service-token-action@v2
        with:
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us
      - uses: postman-cs/postman-bootstrap-action@v2
        with:
          project-name: core-payments
          spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman_token.outputs.token }}
          credential-preflight: enforce
```

Provide either `spec-url` (public HTTPS) or `spec-path` (a file in the checked-out repo) for the [Spec Hub import](https://learning.postman.com/docs/design-apis/specifications/import-a-specification/) path. Mint the `postman-access-token` with the [service-token action](https://github.com/postman-cs/postman-resolve-service-token-action): it is the primary credential and carries every Postman asset operation (workspace, spec, collection generation and mutation, tagging, team scope) over the access-token gateway. A [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) PMAK for `postman-api-key` is optional — it mints and re-mints that access token and logs the Postman CLI in for `spec lint`. See [Obtaining Credentials](docs/credentials.md) for the credential matrix and legacy fallback.

## Common scenarios

### Git-first spec from the repository

For Git-first workflows, read the OpenAPI document directly from the checked-out workspace instead of hosting it over HTTPS:

```yaml
- uses: actions/checkout@v5
- uses: postman-cs/postman-bootstrap-action@v2
  with:
    project-name: core-payments
    spec-path: apis/core-payments/openapi.yaml
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

### Safe rerun for an existing service

Pass `workspace-id`, `spec-id`, and existing collection IDs to rerun without creating duplicate Postman assets. When `.postman/resources.yaml` is committed on the checked-out ref, the action reuses its workspace, spec, and collection mappings automatically.

```yaml
- uses: postman-cs/postman-bootstrap-action@v2
  with:
    project-name: core-payments
    workspace-id: ws-123
    spec-id: spec-123
    baseline-collection-id: col-baseline
    smoke-collection-id: col-smoke
    contract-collection-id: col-contract
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

### Create a versioned release set

Create a release-scoped spec and collection set instead of refreshing the canonical assets in place:

```yaml
- uses: postman-cs/postman-bootstrap-action@v2
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
    collection-sync-mode: version
    spec-sync-mode: version
    release-label: v1.1.1
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

When `release-label` is omitted, the action derives one from the git tag or branch. Details in [Lifecycle Modes](docs/lifecycle-and-operations.md).

### Fail the run on OpenAPI breaking changes

Compare the incoming contract before any Postman mutation. `pr-native` mode diffs the PR target branch version of `spec-path` against the working tree:

```yaml
- uses: actions/checkout@v5
  with:
    fetch-depth: 0
- uses: postman-cs/postman-bootstrap-action@v2
  with:
    project-name: core-payments
    spec-path: apis/core-payments/openapi.yaml
    breaking-change-mode: pr-native
    breaking-target-ref: ${{ github.base_ref }}
    breaking-baseline-spec-path: apis/core-payments/openapi.baseline.yaml
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

Modes `off`, `previous-spec`, `pr-native`, and `baseline-only` are described in [OpenAPI Spec Handling](docs/spec-handling.md).

### Assign the workspace to a governance group

Set the repository custom property `postman-governance-group`, then provide tokens so the action can perform workspace enrichment:

```yaml
- id: postman-token
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-bootstrap-action@v2
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
    postman-region: us
    github-token: ${{ github.token }}
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman-token.outputs.token }}
```

For one-off runs, `governance-group` can be passed directly and overrides the repository custom property. `governance-mapping-json` remains supported as a domain-map fallback for older workflows. If the [governance group](https://learning.postman.com/docs/api-governance/configurable-rules/configuring-api-governance-rules/) configuration is missing, the group is not found, or the access token is expired, bootstrap logs a warning and continues with the created workspace, spec, and collections.

### Create the workspace under an org-mode sub-team

Postman organizations with multiple sub-teams require an explicit `workspace-team-id` for workspace creation:

```yaml
- uses: postman-cs/postman-bootstrap-action@v2
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
    workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

See [Team Identity](docs/team-identity.md) for sub-team discovery and team-ID derivation.

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `workspace-id` | Existing Postman workspace ID | no |  |
| `spec-id` | Existing Postman spec ID | no |  |
| `baseline-collection-id` | Existing baseline collection ID | no |  |
| `smoke-collection-id` | Existing smoke collection ID | no |  |
| `contract-collection-id` | Existing contract collection ID | no |  |
| `additional-collections-dir` | Workspace-relative directory containing curated Postman collection JSON/YAML files to create or update in the workspace. | no |  |
| `sync-examples` | Whether linked spec/collection relations should enable example syncing | no | `true` |
| `collection-sync-mode` | Collection lifecycle policy (refresh or version) | no | `refresh` |
| `spec-sync-mode` | Spec lifecycle policy (update or version) | no | `update` |
| `release-label` | Optional release label used for versioned specs and collections | no |  |
| `project-name` | Service project name | yes |  |
| `domain` | Business domain for the service | no |  |
| `domain-code` | Workspace naming prefix | no |  |
| `governance-group` | Postman governance workspace group name. Overrides the postman-governance-group repository custom property and domain mapping. | no |  |
| `requester-email` | Requester email for audit context | no |  |
| `workspace-admin-user-ids` | Comma-separated workspace admin user ids | no |  |
| `workspace-team-id` | Numeric sub-team ID for org-mode workspace creation. Required when your Postman team is an org with multiple sub-teams. Run the action without this input to see available sub-teams listed in the error output. | no |  |
| `spec-url` | HTTPS URL to the OpenAPI document to bootstrap. Provide either spec-url or spec-path. | no |  |
| `spec-path` | Local filesystem path to the OpenAPI document (relative to the workspace). Provide either spec-url or spec-path. | no |  |
| `protocol` | API spec protocol. auto (default) detects from content/extension. openapi flows through Spec Hub; graphql (SDL/introspection), grpc (.proto), and soap (WSDL) build and instrument a Postman collection directly. | no | `auto` |
| `protocol-endpoint-url` | Endpoint URL/authority used by generated non-OpenAPI requests (e.g. {{baseUrl}}/graphql, grpc://host:port). Supports Postman variable interpolation. Ignored for openapi. | no |  |
| `openapi-version` | OpenAPI specification version override (3.0 or 3.1). When not set, the version is auto-detected from the spec content. | no |  |
| `breaking-change-mode` | OpenAPI breaking-change comparison mode (off, pr-native, baseline-only, or previous-spec) | no | `off` |
| `breaking-baseline-spec-path` | Workspace-relative baseline OpenAPI spec path used by baseline-only mode and pr-native fallback | no |  |
| `breaking-rules-path` | Workspace-relative openapi-changes rules file. Missing files are ignored. | no | `changes-rules.yaml` |
| `breaking-target-ref` | Optional target branch or git ref override for pr-native breaking-change comparisons | no |  |
| `breaking-summary-path` | Optional markdown report output path. Defaults to a runner-temp file. | no |  |
| `breaking-log-path` | Optional raw command log output path. Defaults to a runner-temp file. | no |  |
| `governance-mapping-json` | Legacy JSON map of business domain to governance group name. Prefer governance-group or the postman-governance-group repository custom property. | no | `{}` |
| `github-token` | GitHub token used to read the postman-governance-group repository custom property | no |  |
| `gh-fallback-token` | Fallback GitHub token used to read repository custom properties when github-token cannot | no |  |
| `postman-api-key` | Postman service-account API key (PMAK). With a postman-access-token present, the PMAK is used ONLY to mint/re-mint the access token and to log in the Postman CLI for `spec lint` — never for an asset operation. When the key is absent, the CLI spec lint is skipped (governance errors are not enforced). Optional. | no |  |
| `postman-access-token` | Postman service-account access token (x-access-token). Primary credential — every asset operation (workspace create/visibility, spec upload/update, collection generation/read/mutation, test injection, tagging, team-scope) runs through the access-token gateway. Mint it with postman-resolve-service-token-action. Optional only for legacy PMAK-only runs; supply it for the gateway path. | no |  |
| `credential-preflight` | Credential identity preflight policy. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any workspace is created. | no | `warn` |
| `folder-strategy` | Folder organization strategy for generated collections (Paths or Tags) | no | `Paths` |
| `nested-folder-hierarchy` | When folder-strategy is Tags, enables nested folder hierarchy | no | `false` |
| `request-name-source` | Determines how requests are named in generated collections (Fallback or URL) | no | `Fallback` |
| `postman-region` | Postman data residency region for public API and Postman CLI calls. | no | `us` |
<!-- inputs-table:end -->

## Outputs

<!-- outputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `workspace-id` | Postman workspace ID | n/a | n/a |
| `workspace-url` | Postman workspace URL | n/a | n/a |
| `workspace-name` | Postman workspace name | n/a | n/a |
| `spec-id` | Uploaded Postman spec ID | n/a | n/a |
| `baseline-collection-id` | Baseline collection ID | n/a | n/a |
| `smoke-collection-id` | Smoke collection ID | n/a | n/a |
| `contract-collection-id` | Contract collection ID | n/a | n/a |
| `collections-json` | JSON summary of generated collections | n/a | n/a |
| `lint-summary-json` | JSON summary of lint errors and warnings. When postman-api-key is absent the CLI lint is skipped and this is { status: "skipped", reason: "no postman-api-key" }. | n/a | n/a |
| `breaking-change-status` | OpenAPI breaking-change check status | n/a | n/a |
| `breaking-change-summary-json` | JSON summary of the OpenAPI breaking-change check | n/a | n/a |
<!-- outputs-table:end -->

## CLI usage (non-GitHub CI)

The same bootstrap is available as a CLI for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems. GitHub Actions users should continue using the `action.yml` interface.

```bash
npm install -g @postman-cse/onboarding-bootstrap

postman-bootstrap \
  --project-name core-payments \
  --spec-url https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml \
  --postman-api-key "$POSTMAN_API_KEY" \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --result-json bootstrap-result.json \
  --dotenv-path bootstrap.env
```

The CLI package supports Node.js 24+ to match the GitHub Action runtime. It auto-detects the CI provider from environment variables for GitHub, GitLab, Bitbucket, and Azure DevOps, writes JSON to stdout, and sends all logs to stderr. Use `--result-json` to write the JSON payload to a file and `--dotenv-path` to emit shell-sourceable `KEY=VALUE` output with the `POSTMAN_BOOTSTRAP_` prefix.

Example GitLab CI job:

```yaml
bootstrap:
  image: node:24
  script:
    - npm install -g @postman-cse/onboarding-bootstrap
    - postman-bootstrap --project-name core-payments --spec-url "https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml" --postman-api-key "$POSTMAN_API_KEY" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --result-json bootstrap-result.json --dotenv-path bootstrap.env
  artifacts:
    paths:
      - bootstrap-result.json
      - bootstrap.env
```

Example Bitbucket Pipelines step:

```yaml
pipelines:
  default:
    - step:
        image: node:24
        script:
          - npm install -g @postman-cse/onboarding-bootstrap
          - postman-bootstrap --project-name core-payments --spec-url "https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml" --postman-api-key "$POSTMAN_API_KEY" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --result-json bootstrap-result.json --dotenv-path bootstrap.env
        artifacts:
          - bootstrap-result.json
          - bootstrap.env
```

Example Azure DevOps job:

```yaml
steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '24.x'
  - script: |
      npm install -g @postman-cse/onboarding-bootstrap
      postman-bootstrap --project-name core-payments --spec-url "https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml" --postman-api-key "$(POSTMAN_API_KEY)" --postman-access-token "$(POSTMAN_ACCESS_TOKEN)" --result-json bootstrap-result.json --dotenv-path bootstrap.env
    displayName: Bootstrap Postman assets
  - publish: bootstrap-result.json
  - publish: bootstrap.env
```

## How it works

The action handles the bootstrap slice of the Postman onboarding workflow: create or reuse a Postman workspace, assign governance, invite the requester and workspace admins, upload or update the spec in [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/), lint it with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-governance/), generate or reuse baseline, smoke, and contract collections, inject generated tests, apply tags, and reuse committed `.postman/resources.yaml` state when present. Inputs and outputs use kebab-case.

- **Phase independence:** bootstrap succeeds on its own even when later pipeline stages (repo sync, Insights) fail, and reruns reuse existing assets. See [Bootstrap Phase Independence](docs/bootstrap-phase-independence.md).
- **Team identity:** the team ID is resolved from the access-token session identity; org-mode tenants pass `workspace-team-id` for the sub-team that should own the workspace. See [Team Identity](docs/team-identity.md).
- **Git providers:** workspace-to-repository linking supports GitHub and GitLab, cloud and self-hosted. See [Git Provider Support](docs/git-provider-support.md).
- **Spec handling:** operation summaries are normalized before upload, `spec-url` fetches are SSRF-hardened HTTPS with pinned DNS, and breaking-change comparison runs before any Postman mutation when enabled. See [OpenAPI Spec Handling](docs/spec-handling.md).
- **Lifecycle modes:** `collection-sync-mode` (`refresh`/`version`, legacy `reuse`), `spec-sync-mode` (`update`/`version`), release-label derivation, ref-native state, cloud spec-to-collection syncing, and smoke monitoring. See [Lifecycle Modes and Operational Reference](docs/lifecycle-and-operations.md).
- **Credentials:** `postman-access-token` is the primary credential and carries every asset operation over the gateway; the optional `postman-api-key` powers access-token minting and the Postman CLI `spec lint` login. See [Obtaining Credentials](docs/credentials.md).
- **Protocol write split:** GraphQL and SOAP build v2.1.0 collections created through the public collections API with `postman-api-key`. gRPC builds a v3/Extensible Collection (the only schema with the `grpc-request` item type) and is created through the gateway EC API, which is access-token only — so gRPC **hard-requires** `postman-access-token` and fails fast with `EC_REQUIRES_ACCESS_TOKEN` when it is absent (`resolve-service-token` mints one). Creating the gRPC collection and running it in CI are separate gates: execution additionally needs the `grpc_protocol_execution_allowed` account feature flag in Postman CLI. See [Multi-Protocol Contract Assertions](docs/MULTIPROTOCOL-ASSERTIONS.md).

## Dynamic contract tests

Before any durable contract collection is overwritten, the action hardens the generated `[Contract]` collection against the resolved OpenAPI 3.0/3.1 document: it bundles and validates the spec, requires exactly one generated request per eligible operation, instruments each request with OpenAPI-derived runtime checks (status codes, headers, body presence, `Content-Type`, JSON schemas, security credential presence, request parameter and body values), and enforces script safety and size gates. Spec updates capture the previous content hash so failed runs can roll back, and refresh mode stages generated collections before touching durable ones.

Full pipeline, validation scope, OpenAPI semantics, limits, and rollback behavior are documented in [Dynamic Contract Tests](docs/dynamic-contract-tests.md).

## Errors

Dynamic contract failures and warnings use `CONTRACT_` error codes. Remediation guidance for each code:

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
| `CONTRACT_NO_ELIGIBLE_OPERATIONS` | No eligible `paths` operations with responses were found. | Add path operations with responses. |
| `CONTRACT_OPERATION_NO_RESPONSES` | A `paths` operation had no response definitions. | Add at least one OpenAPI response to each path operation. |
| `CONTRACT_UNRESOLVED_REF` | A ref remained unresolved after secure bundling. | Fix the ref target or make the external ref HTTPS-accessible. |
| `CONTRACT_UNSUPPORTED_SCHEMA_DIALECT` | A schema declared an unsupported JSON Schema dialect. | Use draft-07 or 2020-12-compatible schemas. |
| `CONTRACT_SCHEMA_COMPILE_FAILED` | schemasafe could not compile a response/header schema. | Simplify or correct the unsupported schema. |
| `CONTRACT_STATIC_REQUEST_CHECK_FAILED` | Generated request missed a required non-security parameter or body. | Adjust generation options or the spec so generated requests include required shape. |
| `CONTRACT_STATIC_REQUEST_CHECK_SKIPPED` | A static request-shape check could not be evaluated over the v3 collection surface (the request could not be reconstructed from the item IR). | Non-fatal; the runtime contract script still validates the response. Regenerate the collection if it persists. |
| `CONTRACT_COLLECTION_FORMAT_UNSUPPORTED` | A protocol collection builder returned a non-v3 format; only v3/Extensible Collections are created (access-token EC API). | File a bug; the builder must emit v3-ec. No v2 collection is ever created. |
| `CONTRACT_SECURITY_NOT_VALIDATED` | Security requirements were detected but dynamic tests cannot prove auth at runtime. | Run dedicated auth tests and review generated requests for required credentials. |
| `CONTRACT_WEBHOOKS_NOT_VALIDATED` | OpenAPI webhooks were present but are not included in dynamic contract coverage. | Validate webhook behavior separately or model required behavior under `paths`. |
| `CONTRACT_CALLBACKS_NOT_VALIDATED` | Operation callbacks were present but are not included in dynamic contract coverage. | Validate callback behavior separately or add dedicated tests. |
| `CONTRACT_COOKIE_PARAM_NOT_VALIDATED` | A required cookie parameter cannot be included in generated requests, and the runtime test asserts its presence, so the contract run fails until the cookie is supplied at send time. | Attach the cookie via the cookie jar or a `Cookie` header in the run setup, or move the parameter to a header/query location. |
| `CONTRACT_OPERATION_DEPRECATED` | A covered operation is marked `deprecated: true` in the OpenAPI document. | Plan removal of the deprecated operation or drop it from the spec when retired. |
| `CONTRACT_REQUEST_BODY_INCOMPLETE` | A parseable generated request body is missing top-level required properties. | Fix the spec example or regenerate the collection so generated bodies satisfy the request schema. |
| `CONTRACT_READONLY_PROPERTY_IN_REQUEST` | A generated request body includes properties the schema marks `readOnly`. | Remove readOnly properties from request examples; they belong in responses. |
| `CONTRACT_UNDOCUMENTED_QUERY_PARAM` | A generated request sends a query parameter the operation does not declare. | Declare the parameter in the OpenAPI operation or remove it from the generated request. |
| `CONTRACT_LINKS_NOT_VALIDATED` | Response links were present but link traversal is not part of dynamic contract coverage. | Validate linked operation chains with dedicated workflow tests. |
| `CONTRACT_PARAM_SERIALIZATION_NOT_VALIDATED` | A parameter declares `allowReserved`, `content`, or a style/explode combination the runtime cannot decode. Exploded `form` arrays and non-exploded `form`/`spaceDelimited`/`pipeDelimited` arrays of scalars are decoded and validated, so they no longer warn. | Validate the remaining serialized forms with dedicated tests. |
| `CONTRACT_NONJSON_SCHEMA_NOT_VALIDATED` | A non-JSON response media type declares an object schema that runtime tests cannot validate. | Validate XML or other non-JSON payloads with dedicated tests; Content-Type and body presence are still checked. |
| `CONTRACT_REQUEST_SCHEMA_NOT_VALIDATED` | A JSON request body schema could not be compiled into a runtime request validator. | Simplify the unsupported request schema construct named in the warning. |
| `CONTRACT_SCHEMA_NOT_COMPILED` | One schema could not be compiled by the validator engine, so its runtime check is skipped. | Review the named schema construct; other checks for the operation still run. |
| `CONTRACT_EXAMPLE_SCHEMA_MISMATCH` | A media-type example does not validate against its own schema. | Fix the example or the schema so the spec is self-consistent; generated requests are built from these examples. |
| `CONTRACT_ENCODING_MISMATCH` | A generated form-body field does not match its OpenAPI encoding object: a declared multipart per-part `contentType` is missing or different, a binary-typed field was not generated as a file part, or a field declaring a JSON `contentType` carries an unparseable value. | Regenerate the collection or align the encoding object with the intended part layout. |
| `CONTRACT_ENCODING_HEADERS_NOT_VALIDATED` | A multipart encoding object declares per-part `headers`, which Postman formdata entries cannot carry, so they are not asserted. | Validate per-part headers with dedicated tests if the server depends on them. |
| `CONTRACT_FORM_FIELD_SCHEMA_MISMATCH` | A generated urlencoded or multipart text value does not validate against its scalar property schema. | Fix the spec example feeding the generated body, or correct the property schema. |
| `CONTRACT_DISCRIMINATOR_NOT_VALIDATED` | A `discriminator` has no sibling `oneOf`/`anyOf` of same-spec `$ref` members (typically allOf-parent inheritance), so its dispatch is not validated. | Restructure to the oneOf-plus-discriminator form, or rely on the still-validated composition keywords. |
| `CONTRACT_HEADER_SCHEMA_NOT_VALIDATED` | A response header declares an object or otherwise undecodable schema, so its serialized value is checked for presence only. Arrays of scalars are split on commas and validated. | Use a scalar or array-of-scalars header schema, or validate the serialized header form with dedicated tests. |
| `CONTRACT_PATH_PARAM_NOT_VALIDATED` | A path parameter declares a non-scalar schema or a serialization the runtime cannot decode, so its value is not validated. Scalar path parameters are validated at runtime against the resolved path segment. | Use a scalar path schema, or validate path value semantics with dedicated tests. |
| `CONTRACT_DUPLICATE_OPERATION_MATCH` | Multiple OpenAPI operations share the same canonical request mapping candidate. | Disambiguate paths, server prefixes, or templated routes. |
| `CONTRACT_DUPLICATE_OPERATION_REQUEST` | More than one generated request mapped to the same contract operation. | Disambiguate paths/operations or generated requests. |
| `CONTRACT_OPERATION_COVERAGE_FAILED` | Generated contract collection did not cover every eligible operation. | Regenerate the collection or fix operation paths. |
| `CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT` | Generated script included a forbidden dynamic validation construct. | Report the schema that triggered unsafe generation. |
| `CONTRACT_SCRIPT_SIZE_EXCEEDED` | A generated request test script exceeded the per-script size gate. | Reduce schema complexity or split the API. |
| `CONTRACT_COLLECTION_SIZE_EXCEEDED` | Instrumented contract collection exceeded the size gate. | Reduce schema/operation count or split the API. |
| `CONTRACT_COLLECTION_ID_COLLISION` | Baseline, smoke, and contract IDs were not pairwise distinct. | Pass distinct collection IDs or clear stale IDs. |
| `CONTRACT_PLAN_MISSING` | Contract instrumentation ran without a preflight-generated contract plan. | Rerun with dynamic contract preflight enabled and report the failure if it persists. |
| `CONTRACT_SPEC_ROLLBACK_FAILED` | Best-effort previous spec restoration failed after a later error. | Restore the previous spec content manually using the emitted SHA-256. |

## Resources

### The suite

| Action | Role |
| --- | --- |
| [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) | Entry point: chains workspace bootstrap, repo sync, and optional Insights linking |
| [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) | Mints the service-account access token and team ID |
| [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Discovers and exports API specs from AWS services |
| [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) | Creates the workspace, uploads the spec, generates collections |
| [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) | Applies a curated flow.yaml to the Smoke collection |
| [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) | Exports artifacts into the repo and wires CI, mocks, and monitors |
| [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) | Links Insights discovered services to the workspace |

Sibling actions in the Postman onboarding pipeline:

- [postman-cs/postman-api-onboarding-action](https://github.com/postman-cs/postman-api-onboarding-action): composite action that orchestrates the pipeline
- [postman-cs/postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints a service-account access token and team ID
- [postman-cs/postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action): discovers AWS APIs and specs
- [postman-cs/postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action): applies a curated flow.yaml to the Smoke collection
- [postman-cs/postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action): syncs artifacts, environments, mocks, and monitors
- [postman-cs/postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action): links Insights to the workspace

Package and docs:

- npm package: [@postman-cse/onboarding-bootstrap](https://www.npmjs.com/package/@postman-cse/onboarding-bootstrap)
- [Credential matrix](docs/credentials.md)
- [Support](SUPPORT.md)
- [Security Policy](SECURITY.md)
- [Release Policy](RELEASE_POLICY.md)
- Postman API and auth references: [Postman API](https://learning.postman.com/docs/reference/postman-api/intro-api/), [API authentication](https://learning.postman.com/docs/reference/postman-api/authentication/), [service accounts](https://learning.postman.com/docs/administration/service-accounts/), [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/)
- Postman design resources: [workspaces](https://learning.postman.com/docs/collaborating-in-postman/using-workspaces/overview/), [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/), [import a specification](https://learning.postman.com/docs/design-apis/specifications/import-a-specification/), [generate collections](https://learning.postman.com/docs/design-apis/specifications/generate-collections/), [validate a specification](https://learning.postman.com/docs/design-apis/specifications/validate-a-specification/)
- Postman execution resources: [Postman CLI collection runs](https://learning.postman.com/docs/postman-cli/postman-cli-collections/), [Postman CLI governance](https://learning.postman.com/docs/postman-cli/postman-cli-governance/), [API governance rules](https://learning.postman.com/docs/api-governance/configurable-rules/configuring-api-governance-rules/), [mock servers](https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/), [monitors](https://learning.postman.com/docs/monitoring-your-api/intro-monitors/)
- Local development: `npm install`, `npm test`, `npm run typecheck`, `npm run build` (produces the committed `dist/` bundles used by `action.yml`); regenerate the Inputs and Outputs tables with `npm run docs:tables`

## Telemetry

This action sends a single non-identifying usage event when a run completes, so the
Postman team can measure adoption across CI systems. The event contains the
action name and version, your Postman team ID, the detected CI provider and
runner kind, the run outcome, the CI run identifier, an event timestamp, and a one-way SHA-256 hash of the repository
identifier. Each event also carries a schema version and a constant event marker (always `completion`). The Postman team ID is sent in the clear on a legitimate-interest
basis to measure product adoption.

The `events.pm-cse.dev` endpoint is operated by the Postman Customer Success
Engineering team. Postman, Inc. processes these events only to measure
onboarding adoption in aggregate, retains them only as aggregated counts for
product-adoption trend analysis, and includes no payload field that identifies
an individual person.

It never sends API keys, access tokens, spec content, workspace or repository
names, or any personal data. It is fire-and-forget with a hard
timeout and can never block or fail your pipeline. Corporate HTTP and HTTPS
proxies are honored through the standard `HTTPS_PROXY`, `HTTP_PROXY`, and
`NO_PROXY` environment variables.

Disable it by setting either environment variable in your CI:

```sh
POSTMAN_ACTIONS_TELEMETRY=off
# or the cross-tool standard
DO_NOT_TRACK=1
```

Telemetry is also skipped automatically when no Postman team ID can be resolved.

Events are sent over HTTPS to `https://events.pm-cse.dev/v1/events`. To
allowlist this destination on a restricted network, or to route events to a
collector you operate, set the `POSTMAN_ACTIONS_TELEMETRY_ENDPOINT` environment
variable to your own URL.

## License

[MIT](LICENSE)
