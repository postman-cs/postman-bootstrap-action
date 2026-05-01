# postman-bootstrap-action

Public open-alpha GitHub Action for Postman workspace bootstrap from a registry-backed OpenAPI spec.

## Scope

This action preserves the bootstrap slice of the API Catalog demo flow:

- create or reuse a Postman workspace
- assign the workspace to a governance group through the current Bifrost and internal path
- invite the requester and add workspace admins
- upload or update a remote spec in Spec Hub (after normalizing operation summaries — see below)
- lint the uploaded spec by UID with the Postman CLI
- generate missing baseline, smoke, and contract collections or reuse existing ones
- optionally refresh current collections from the latest spec or create release-scoped spec and collection assets
- inject generated tests and apply collection tags
- reuse committed `.postman/resources.yaml` state from the checked-out ref when present

The public open-alpha contract uses kebab-case inputs and outputs and defaults `integration-backend` to `bifrost`.

### Git provider support

Workspace-to-repository linking via Bifrost supports both **GitHub** and **GitLab** (cloud and self-hosted) repository URLs. The `repo-url` value (or the auto-derived URL from CI environment variables) is stored as-is by Bifrost without provider-specific validation. URL normalization handles HTTPS, SSH (`git@`), and `.git` suffix variants for both providers.
The public open-alpha contract uses kebab-case inputs and outputs and defaults `integration-backend` to `bifrost`.

For existing services, pass `workspace-id`, `spec-id`, and any existing collection IDs to rerun the bootstrap safely without creating duplicate Postman assets. When `.postman/resources.yaml` is present in the checked-out ref, the action also reuses its workspace/spec/collection mappings automatically.

Lifecycle behavior remains backward-compatible except for collection default mode:

- `collection-sync-mode: refresh`
- `spec-sync-mode: update`

If you do not set those inputs, the action refreshes collection pointers from the resolved spec and keeps one canonical spec update path.

### Bootstrap phase independence

**Bootstrap succeeds independently** — it creates or updates Postman workspace and collections even if a later stage (repo sync, Insights onboarding) fails. This is intentional:

- **Postman side is self-contained:** Workspace creation, spec upload, and collection generation do not depend on repository access or merge status.
- **Repository side is async:** Later stages may fail due to repo permissions, branch protection, or pending approval. Bootstrap completion is not blocked by these downstream concerns.
- **Idempotent reruns:** If a later stage fails, subsequent reruns of the action will reuse existing Postman assets (via `workspace-id`, `spec-id`, collection IDs) and focus on the failed stage without recreating everything.

**When bootstrap fails:** The action stops and does not proceed to repo sync. Postman assets are left in the state they reached before the failure. Clear error messages identify which required bootstrap step failed (for example, spec lint or collection generation). Optional workspace enrichment steps, such as governance assignment and requester invitation, warn and continue so created workspaces and collections remain usable.

This layered design means customers can:
1. Verify Postman workspace health independently.
2. Debug repository issues (branch protection, permissions) separately from Postman provisioning.
3. Reuse existing Postman assets when fixing downstream failures.

### Team ID derivation

The action automatically derives the Postman Team ID from your `postman-api-key` via the `/me` API. There is no need to supply a separate team ID input. If the environment variable `POSTMAN_TEAM_ID` is set, that value takes precedence.

### Org-mode teams

Postman organizations with multiple sub-teams (squads) require an explicit `workspace-team-id` to create workspaces. The Postman API does not allow workspace creation at the organization level -- a specific sub-team must own each workspace.

**How it works:**

1. The action calls `GET /teams` to check if the API key belongs to an org-mode account.
2. If multiple sub-teams are detected and no `workspace-team-id` is provided, the action fails with a list of available sub-teams and their numeric IDs.
3. Set `workspace-team-id` to the desired sub-team ID to proceed.

**Example (GitHub Actions):**

```yaml
- uses: postman-cs/postman-bootstrap-action@v0
  with:
    project-name: core-payments
    spec-url: https://example.com/openapi.yaml
    workspace-team-id: '132319'
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

To persist the sub-team ID across runs, store it as a repository variable:

```yaml
workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
```

**CLI usage:**

```bash
postman-bootstrap --workspace-team-id 132319 ...
```

Or via environment variable: `export POSTMAN_WORKSPACE_TEAM_ID=132319`

Non-org accounts (single team) are unaffected and do not need this input.
### OpenAPI operation summaries (normalization)

Before upload to Spec Hub, the action parses JSON or YAML OpenAPI documents and adjusts **path operations** so collection generation is less likely to fail:

1. **Missing `summary`:** Uses `operationId` if present; otherwise falls back to `METHOD /path` (for example `GET /pets`).
2. **Very long `summary`:** Truncates to **200 characters** (with an ellipsis) so downstream limits are not exceeded.

This runs in `src/index.ts` before upload. If nothing under `paths` needs changing, the original document bytes are preserved. When normalization runs, the spec is re-serialized (JSON stays JSON; YAML stays YAML). Each fix emits a **warning** in the Actions log so you can improve the source spec over time. Invalid documents that cannot be parsed are left unchanged and a warning is logged.

### OpenAPI spec URL fetch safety

The root `spec-url` must be HTTPS and is fetched with pinned DNS resolution. The action blocks credential-bearing URLs, localhost/private/link-local/internal destinations, unsafe redirects, DNS rebinding attempts, and oversized OpenAPI resources before uploading content to Spec Hub. Root fetches are capped at 25 MiB, and fetch errors redact URL credentials, query strings, and fragments before logging.

## Usage

```yaml
jobs:
  bootstrap:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-bootstrap-action@v0
        with:
          project-name: core-payments
          domain: core-banking
          domain-code: AF
          requester-email: owner@example.com
          workspace-admin-user-ids: 101,102
          spec-url: https://example.com/openapi.yaml
          governance-mapping-json: '{"core-banking":"Core Banking"}'
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}

  bootstrap-existing:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-bootstrap-action@v0
        with:
          project-name: core-payments
          workspace-id: ws-123
          spec-id: spec-123
          baseline-collection-id: col-baseline
          smoke-collection-id: col-smoke
          contract-collection-id: col-contract
          spec-url: https://example.com/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

If you want the action to discover prior bootstrap state automatically on reruns, commit `.postman/resources.yaml` and run the action on the ref whose state you want to reuse.

## Dynamic contract tests

Dynamic contract tests harden the generated `[Contract]` collection against the resolved OpenAPI 3.0/3.1 document before any durable contract collection is overwritten.

Scope:

- Safely fetch and bundle HTTPS OpenAPI specs and HTTPS external refs.
- Validate the bundled OpenAPI document with external and file resolution disabled during validation.
- Match generated collection requests by method and canonical server/path candidates only; suffix path matching is not used.
- Require one generated request for every eligible `paths` operation.
- Validate response status codes, body presence, `Content-Type`, JSON response schemas, text/string schemas, and simple response header schemas.
- Perform static checks for required non-security query/header parameters and required request bodies.

Non-goals and limitations:

- Swagger 2.0, OAS webhooks, callbacks, and arbitrary user-authored collection requests are not fully validated.
- Security/auth requirements are not proven at runtime. API-key parameters derived from `securitySchemes` are warned as `CONTRACT_SECURITY_NOT_VALIDATED`.
- Complex non-JSON object schemas, header `content`, unsupported schema dialects, unsupported keywords, and discriminator-heavy schemas fail closed instead of generating weak tests.
- Generated scripts target Newman/Postman runtime support for ES2020-compatible JavaScript and use compiled schemasafe IIFE validators. They do not use `pm.response.to.have.jsonSchema`, `eval`, or `new Function`.

OpenAPI semantics:

- OAS 3.0 `$ref` siblings are ignored, `nullable` is converted to JSON Schema unions, boolean exclusive min/max is converted, and response `writeOnly` properties are removed from response validation.
- OAS 3.1 `$ref` siblings are applied, the default dialect is JSON Schema 2020-12, supported `$schema` values are preserved, and unsupported custom dialects fail closed.

Security and size limits:

- Only HTTPS spec URLs and external refs are allowed.
- Localhost, loopback, link-local, RFC1918, RFC6598, IANA special-use IPv4/IPv6 ranges, IPv4-mapped IPv6, `.local`, and `.internal` destinations are blocked.
- DNS results are vetted and pinned into the HTTPS socket; redirects are fully revalidated.
- Limits: 5 redirects, 100 external refs, ref depth 20, 25 MiB per fetched resource, and 25 MiB total fetched bytes.
- Generated request scripts warn above 256 KiB and fail above 900 KiB; instrumented contract collection uploads fail above 4 MiB before upload. The bundled action is also reviewed for dependency-driven size growth.

Rollback behavior:

- Spec preflight runs before Postman mutations.
- For existing spec updates, the previous normalized spec content is fetched and hashed before update.
- If linting, collection generation, instrumentation, tagging, or linking fails after an existing spec update, the action best-effort restores the previous spec content.
- If rollback fails, the action emits `CONTRACT_SPEC_ROLLBACK_FAILED` with the previous content SHA-256 for manual restoration.
- Refresh mode stages generated baseline, smoke, and contract collections and instruments the temporary contract collection before updating any durable tracked collection. If a durable refresh update fails after another durable collection was updated, the action best-effort restores previously updated collection snapshots. Collection mutations after the refresh stage, such as later tagging/linking side effects, are not automatically rolled back; rerun the action after resolving the failure to reconcile generated collections with the restored spec.

| Error code | Meaning | Remediation |
| --- | --- | --- |
| `CONTRACT_SPEC_FETCH_BLOCKED` | Spec URL, ref URL, DNS result, redirect, or socket destination was not allowed. | Use public HTTPS spec/ref URLs that do not resolve to private or local networks. |
| `CONTRACT_SPEC_FETCH_FAILED` | Allowed HTTPS fetch failed or redirected too many times. | Check availability, status codes, and redirect chains. |
| `CONTRACT_REF_LIMIT_EXCEEDED` | External ref count exceeded the configured limit. | Reduce external ref fan-out or bundle the spec upstream. |
| `CONTRACT_REF_DEPTH_EXCEEDED` | Ref nesting exceeded the configured limit. | Flatten recursive/deep ref chains. |
| `CONTRACT_REF_SIZE_EXCEEDED` | A fetched resource or total fetched bytes exceeded limits. | Reduce spec/ref size or pre-bundle the document. |
| `CONTRACT_SPEC_PARSE_FAILED` | The fetched document was not valid JSON/YAML object content. | Fix the source document syntax. |
| `CONTRACT_SPEC_VALIDATION_FAILED` | The bundled document failed OpenAPI validation. | Fix OpenAPI validation errors. |
| `CONTRACT_UNSUPPORTED_OPENAPI_VERSION` | The document was not OpenAPI 3.0 or 3.1. | Provide an OpenAPI 3.0/3.1 document. |
| `CONTRACT_NO_ELIGIBLE_OPERATIONS` | No eligible `paths` operations with responses were found. | Add path operations with responses. |
| `CONTRACT_OPERATION_NO_RESPONSES` | A `paths` operation had no response definitions. | Add at least one OpenAPI response to each path operation. |
| `CONTRACT_UNRESOLVED_REF` | A ref remained unresolved after secure bundling. | Fix the ref target or make the external ref HTTPS-accessible. |
| `CONTRACT_UNSUPPORTED_SCHEMA_DIALECT` | A schema declared an unsupported JSON Schema dialect. | Use draft-07 or 2020-12-compatible schemas. |
| `CONTRACT_SCHEMA_COMPILE_FAILED` | schemasafe could not compile a response/header schema. | Simplify or correct the unsupported schema. |
| `CONTRACT_STATIC_REQUEST_CHECK_FAILED` | Generated request missed a required non-security parameter or body. | Adjust generation options or the spec so generated requests include required shape. |
| `CONTRACT_SECURITY_NOT_VALIDATED` | Security requirements were detected but dynamic tests cannot prove auth at runtime. | Run dedicated auth tests and review generated requests for required credentials. |
| `CONTRACT_WEBHOOKS_NOT_VALIDATED` | OpenAPI webhooks were present but are not included in dynamic contract coverage. | Validate webhook behavior separately or model required behavior under `paths`. |
| `CONTRACT_CALLBACKS_NOT_VALIDATED` | Operation callbacks were present but are not included in dynamic contract coverage. | Validate callback behavior separately or add dedicated tests. |
| `CONTRACT_DUPLICATE_OPERATION_MATCH` | Multiple OpenAPI operations share the same canonical request mapping candidate. | Disambiguate paths, server prefixes, or templated routes. |
| `CONTRACT_DUPLICATE_OPERATION_REQUEST` | More than one generated request mapped to the same contract operation. | Disambiguate paths/operations or generated requests. |
| `CONTRACT_OPERATION_COVERAGE_FAILED` | Generated contract collection did not cover every eligible operation. | Regenerate the collection or fix operation paths. |
| `CONTRACT_FORBIDDEN_SCRIPT_CONSTRUCT` | Generated script included a forbidden dynamic validation construct. | Report the schema that triggered unsafe generation. |
| `CONTRACT_SCRIPT_SIZE_EXCEEDED` | A generated request test script exceeded the per-script size gate. | Reduce schema complexity or split the API. |
| `CONTRACT_COLLECTION_SIZE_EXCEEDED` | Instrumented contract collection exceeded the size gate. | Reduce schema/operation count or split the API. |
| `CONTRACT_COLLECTION_ID_COLLISION` | Baseline, smoke, and contract IDs were not pairwise distinct. | Pass distinct collection IDs or clear stale IDs. |
| `CONTRACT_PLAN_MISSING` | Contract instrumentation ran without a preflight-generated contract plan. | Rerun with dynamic contract preflight enabled and report the failure if it persists. |
| `CONTRACT_SPEC_ROLLBACK_FAILED` | Best-effort previous spec restoration failed after a later error. | Restore the previous spec content manually using the emitted SHA-256. |

## CLI Usage (Non-GitHub CI)

The CLI is available for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.
GitHub Actions users should continue using the `action.yml` interface.

Install globally:

```bash
npm install -g @postman-cse/onboarding-bootstrap
```

The CLI package supports Node.js 20+. The examples below use Node.js 24 to match the GitHub Action runtime.

Basic usage:

```bash
postman-bootstrap \
  --project-name core-payments \
  --spec-url https://example.com/openapi.yaml \
  --postman-api-key "$POSTMAN_API_KEY" \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --result-json bootstrap-result.json \
  --dotenv-path bootstrap.env
```

The CLI auto-detects the CI provider from environment variables for GitHub, GitLab, Bitbucket, and Azure DevOps.
It writes JSON to stdout, with all logs sent to stderr.
Use `--result-json` to write the JSON payload to a file, and `--dotenv-path` to emit shell-sourceable `KEY=VALUE` output with the `POSTMAN_BOOTSTRAP_` prefix.

Example GitLab CI job:

```yaml
bootstrap:
  image: node:24
  script:
    - npm install -g @postman-cse/onboarding-bootstrap
    - postman-bootstrap --project-name core-payments --spec-url "$SPEC_URL" --postman-api-key "$POSTMAN_API_KEY" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --result-json bootstrap-result.json --dotenv-path bootstrap.env
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
          - postman-bootstrap --project-name core-payments --spec-url "$SPEC_URL" --postman-api-key "$POSTMAN_API_KEY" --postman-access-token "$POSTMAN_ACCESS_TOKEN" --result-json bootstrap-result.json --dotenv-path bootstrap.env
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
      postman-bootstrap --project-name core-payments --spec-url "$(SPEC_URL)" --postman-api-key "$(POSTMAN_API_KEY)" --postman-access-token "$(POSTMAN_ACCESS_TOKEN)" --result-json bootstrap-result.json --dotenv-path bootstrap.env
    displayName: Bootstrap Postman assets
  - publish: bootstrap-result.json
  - publish: bootstrap.env
```

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `workspace-id` | | Reuse an existing Postman workspace instead of creating one. |
| `spec-id` | | Update an existing Postman spec instead of uploading a new one. |
| `baseline-collection-id` | | Reuse an existing baseline collection. |
| `smoke-collection-id` | | Reuse an existing smoke collection. |
| `contract-collection-id` | | Reuse an existing contract collection. |
| `sync-examples` | `true` | Whether linked spec/collection relations should enable example syncing during cloud linkage. |
| `collection-sync-mode` | `refresh` | Collection lifecycle policy. `refresh` keeps the tracked collection IDs while updating them from the latest spec, and `version` creates or reuses release-scoped collections. |
| `spec-sync-mode` | `update` | Spec lifecycle policy. `update` keeps one canonical spec current in Spec Hub, while `version` creates or reuses a release-scoped spec asset. |
| `release-label` | | Optional release label used for versioned specs and collections. When omitted for versioned sync, the action derives one from GitHub tag or branch metadata. |
| `project-name` | | Service name used in workspace and asset naming. |
| `domain` | | Business domain used for governance assignment. |
| `domain-code` | | Short prefix used when constructing the workspace name. |
| `requester-email` | | Optional user invited into the workspace. |
| `workspace-admin-user-ids` | | Comma-separated Postman user IDs to grant admin access. |
| `workspace-team-id` | | Numeric sub-team ID for org-mode workspace creation. Required when the API key belongs to an org with multiple sub-teams. |
| `spec-url` | | Required registry-backed OpenAPI document URL. |
| `governance-mapping-json` | `{}` | Map of domain to governance group name. |
| `postman-api-key` | | Required for all Postman asset operations. |
| `postman-access-token` | | Required for governance assignment and canonical workspace validation during reruns. |
| `integration-backend` | `bifrost` | Current public open-alpha backend. |

## Lifecycle Modes

### Collection sync

- `reuse`: legacy alias for `refresh`; existing collection IDs are reused when available and updated from the resolved spec.
- `refresh`: baseline, smoke, and contract collections are regenerated from the resolved spec and become the current/default collection pointers.
- `version`: a release-scoped collection set is created or reused from the checked-out ref's state when available.

### Spec sync

- `update`: canonical behavior. The current spec in Spec Hub is updated from `spec-url`.
- `version`: the action reuses the checked-out ref's `.postman/resources.yaml` spec mapping when present. If no mapping exists on the current ref, it creates a new release-scoped spec.

### Release label derivation

When versioned sync is requested and `release-label` is omitted, the action derives one using:

1. explicit `release-label`
2. Git tag name
3. branch name or ref metadata

If versioned sync is requested and no usable label can be derived, the run fails.

### Ref-native state

Current Postman asset state lives in `.postman/resources.yaml`.

- `update`, `refresh`, and legacy `reuse` modes resolve current-state mappings from the checked-out ref.
- `version` mode reuses only the checked-out ref's mappings; release history lives in git history and tags, not in a separate manifest file or repository variables.

### Cloud spec-to-collection syncing

After collections exist, bootstrap links them to the cloud specification and triggers a spec-side collection sync when `postman-access-token` is available.

- `sync-examples: true` (default) enables example syncing in that relation setup.
- `sync-examples: false` keeps the relation but disables example syncing.
- If `postman-access-token` is missing, bootstrap warns and skips the cloud link/sync step.

### Contract smoke monitoring

This repo includes `.github/workflows/contract-smoke.yml`, a scheduled live contract check for the upstream Postman APIs used by bootstrap.

Configure these repository secrets before enabling the workflow:

- `SMOKE_ORG_API_KEY`
- `SMOKE_ORG_ACCESS_TOKEN`
- `SMOKE_NON_ORG_API_KEY`

Configure this repository variable for the org-mode workspace creation check:

- `SMOKE_WORKSPACE_TEAM_ID=132319`

`132319` is the currently derived CSE sub-team ID under org `13347347`. The smoke job uses that value to verify `POST /workspaces` still accepts the explicit `teamId` payload required for org-mode tenants.

## Versioning Examples

Refresh the current collections in place while keeping one canonical spec:

```yaml
- uses: postman-cs/postman-bootstrap-action@v0
  with:
    project-name: core-payments
    spec-url: https://example.com/openapi.yaml
    collection-sync-mode: refresh
    spec-sync-mode: update
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

Create a versioned spec and collection set on the checked-out ref:

```yaml
- uses: postman-cs/postman-bootstrap-action@v0
  with:
    project-name: core-payments
    spec-url: https://example.com/openapi.yaml
    collection-sync-mode: version
    spec-sync-mode: version
    release-label: v1.1.1
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

### Obtaining `postman-api-key`

The `postman-api-key` is a Postman API key (PMAK) used for all standard Postman API operations — creating workspaces, uploading specs, generating collections, exporting artifacts, and managing environments.

**To generate one:**

1. Open the Postman desktop app or web UI.
2. Go to **Settings** (gear icon) → **Account Settings** → **API Keys**.
3. Click **Generate API Key**, give it a label, and copy the key (starts with `PMAK-`).
4. Set it as a GitHub secret:
   ```bash
   gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
   ```

> **Note:** The PMAK is a long-lived key tied to your Postman account. It does not require periodic renewal like the `postman-access-token`.

### Obtaining `postman-access-token` (Open Alpha)

> **⚠️ Open-alpha limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA.

The `postman-access-token` is a Postman session token (`x-access-token`) required for internal API operations that the standard PMAK API key cannot perform — specifically governance group assignment and canonical workspace validation during reruns in this action. Without it, those steps degrade to warning-based behavior and name-based workspace fallback during provisioning.

**To obtain and configure the token:**

1. **Log in via the Postman CLI** (requires a browser):
   ```bash
   postman login
   ```
   This opens a browser window for Postman's PKCE OAuth flow. Complete the sign-in.

2. **Extract the access token** from the CLI credential store:
   ```bash
   cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
   ```

3. **Set it as a GitHub secret** on your repository or organization:
   ```bash
   # Repository-level secret
   gh secret set POSTMAN_ACCESS_TOKEN --repo <owner>/<repo>

   # Organization-level secret (recommended for multi-repo use)
   gh secret set POSTMAN_ACCESS_TOKEN --org <org> --visibility selected --repos <repo1>,<repo2>
   ```
   Paste the token value when prompted.

> **Important:** This token is session-scoped and will expire. When it does, operations that depend on it (governance and canonical workspace validation) degrade with warnings and fallback behavior. You will need to repeat the login and secret update process. There is no automated refresh mechanism.

> **Note:** `postman login --with-api-key` stores a PMAK — **not** the session token these APIs require. You must use the interactive browser login.

## Outputs

- `workspace-id`
- `workspace-url`
- `workspace-name`
- `spec-id`
- `baseline-collection-id`
- `smoke-collection-id`
- `contract-collection-id`
- `collections-json`
- `lint-summary-json`

## Local development

```bash
npm install
npm test
npm run typecheck
npm run build
```

`npm run build` produces the committed `dist/index.cjs` action bundle used by `action.yml`.

## Open-Alpha Release Strategy

- Open-alpha channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling open-alpha channel.

## REST Migration Seam

Public inputs and outputs are backend-neutral. `integration-backend` currently supports `bifrost`, and backend-specific metadata stays internal so a future REST backend can replace the implementation without changing caller workflow syntax.
