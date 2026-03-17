# postman-bootstrap-action

Public open-alpha GitHub Action for Postman workspace bootstrap from a registry-backed OpenAPI spec.

## Scope

This action preserves the bootstrap slice of the API Catalog demo flow:

- create or reuse a Postman workspace
- assign the workspace to a governance group through the current Bifrost and internal path
- invite the requester and add workspace admins
- upload or update a remote spec in Spec Hub
- lint the uploaded spec by UID with the Postman CLI
- generate missing baseline, smoke, and contract collections or reuse existing ones
- inject generated tests and apply collection tags
- persist bootstrap repo variables needed by downstream sync work

The public open-alpha contract uses kebab-case inputs and outputs and defaults `integration-backend` to `bifrost`.

For existing services, pass `workspace-id`, `spec-id`, and any existing collection IDs to rerun the bootstrap safely without creating duplicate Postman assets. When GitHub repo variable persistence is enabled, the action also falls back to `POSTMAN_WORKSPACE_ID`, `POSTMAN_SPEC_UID`, `POSTMAN_BASELINE_COLLECTION_UID`, `POSTMAN_SMOKE_COLLECTION_UID`, and `POSTMAN_CONTRACT_COLLECTION_UID` on reruns.

### Team ID derivation

The action automatically derives the Postman Team ID from your `postman-api-key` via the `/me` API. There is no need to supply a separate team ID input. If the environment variable `POSTMAN_TEAM_ID` is set, that value takes precedence.

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
          environments-json: '["prod","stage"]'
          system-env-map-json: '{"prod":"uuid-prod","stage":"uuid-stage"}'
          governance-mapping-json: '{"core-banking":"Core Banking"}'
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          gh-fallback-token: ${{ secrets.GH_FALLBACK_TOKEN }}

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

If you want the action to discover prior bootstrap state automatically on reruns, provide a `github-token` so it can read the stored repository variables before creating new Postman assets.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `workspace-id` | | Reuse an existing Postman workspace instead of creating one. |
| `spec-id` | | Update an existing Postman spec instead of uploading a new one. |
| `baseline-collection-id` | | Reuse an existing baseline collection. |
| `smoke-collection-id` | | Reuse an existing smoke collection. |
| `contract-collection-id` | | Reuse an existing contract collection. |
| `project-name` | | Service name used in workspace and asset naming. |
| `domain` | | Business domain used for governance assignment. |
| `domain-code` | | Short prefix used when constructing the workspace name. |
| `requester-email` | | Optional user invited into the workspace. |
| `workspace-admin-user-ids` | | Comma-separated Postman user IDs to grant admin access. |
| `spec-url` | | Required registry-backed OpenAPI document URL. |
| `environments-json` | `["prod"]` | Environment slugs preserved in outputs and repo variables. |
| `system-env-map-json` | `{}` | Map of environment slug to system environment ID. |
| `governance-mapping-json` | `{}` | Map of domain to governance group name. |
| `postman-api-key` | | Required for all Postman asset operations. |
| `postman-access-token` | | Required for governance assignment and canonical workspace validation during reruns. |
| `github-token` | | Enables repository variable persistence and rerun fallback discovery. |
| `gh-fallback-token` | | Optional fallback token for repository variable APIs. |
| `github-auth-mode` | `github_token_first` | Auth mode for repository variable APIs. |
| `integration-backend` | `bifrost` | Current public open-alpha backend. |

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
- **`spec-server-url`** — First server URL from the OpenAPI spec’s `servers` array. The onboarding composite uses this as a fallback for env runtime URLs when `env-runtime-urls-json` is not provided.
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
