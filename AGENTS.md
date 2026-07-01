# postman-bootstrap-action

Creates or reuses a Postman workspace, uploads/updates an OpenAPI spec to Spec Hub, generates baseline/smoke/contract collections, assigns governance, and persists repo variables. Dual entry: GitHub Action (`dist/index.cjs`) and CLI (`dist/cli.cjs`).

## Structure

```
src/
  index.ts                  # Main orchestration: inputs -> workspace -> spec -> collections -> lint -> outputs
  cli.ts                    # CLI adapter: reads flags/env, wraps runBootstrap(), writes JSON/dotenv
  contracts.ts              # Input/output type definitions
  lib/
    postman/
      postman-assets-client.ts    # Custom Postman API client (workspaces, specs, collections, envs, users)
      internal-integration-adapter.ts  # Bifrost proxy adapter (governance, workspace linking, system envs)
      workspace-selection.ts      # Canonical workspace resolution (new vs existing, fallback to repo vars)
    github/
      github-api-client.ts       # GitHub repo variable read/write, workflow file APIs
    repo/
      context.ts                  # Auto-detect repo URL, provider, branch from CI env vars
    retry.ts                      # Exponential backoff
    secrets.ts                    # Secret masking utility
    http-error.ts                 # Typed HTTP error class
tests/                      # vitest unit tests
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run check:dist   # build + git diff --exit-code (CI integrity)
```

## Key Behaviors

- **Workspace selection**: Checks input `workspace-id` -> repo variable `POSTMAN_WORKSPACE_ID` -> creates new. Canonical workspace validation uses access-token via Bifrost.
- **Spec normalization**: Before upload, fixes missing/long `summary` fields in OpenAPI operations to prevent downstream collection generation failures.
- **Collection generation**: Generates baseline/smoke/contract collections from the spec through the access-token gateway (`specification` service `POST /specifications/{id}/collections` + task poll). Injects generated tests (per-item `PATCH /v3/collections/{cid}/items/{itemId}` `/scripts` afterResponse) and applies tags (`tagging` service `PUT /v1/tags/collections/{id}`).
- **Lint**: PMAK-only. With a `postman-api-key`, installs the Postman CLI, runs `postman spec lint` against the uploaded spec UID, and hard-fails on lint errors. When `postman-api-key` is absent (access-token-only runs), the CLI install and lint are skipped, `lint-summary-json` is `{ status: "skipped", reason: "no postman-api-key" }`, a warning is emitted, and the run does not hard-fail. The CLI has no access-token login, so this is the one asset-adjacent PMAK use.
- **Team ID**: Resolved from the access-token session identity (`GET https://iapub.postman.co/api/sessions/current`); org-mode sub-team (squad) detection uses the gateway `ums` service. `POSTMAN_TEAM_ID` env var overrides.
- **Repo variables**: Persists `POSTMAN_WORKSPACE_ID`, `POSTMAN_SPEC_UID`, collection UIDs, lint counts as GitHub repo variables for rerun idempotency.

## Postman Routes Used

All asset operations run through the access-token gateway (Bifrost `POST /ws/proxy` envelope, `x-access-token`); see `docs/REST-to-gateway.md` for verified wire shapes. The PMAK is used only to mint/re-mint the access token and for the Postman CLI `spec lint` login.

- `workspaces` service: `POST /workspaces` (personal) + `PUT /workspaces/{id}/visibility` (team) + `GET /workspaces` -- workspace create/visibility/lookup; `PATCH /workspaces/{id}/roles` (string role names) -- workspace admins + requester invite (email->id resolved via `god` `GET /api/organizations/{teamId}/members`)
- `specification` service: `POST /specifications` + `PATCH /specifications/{id}/files/{fileId}` (JSON-patch `/content`) -- spec upload/update; `POST /specifications/{id}/collections` + task poll -- collection generation
- `collection` service: `GET /v3/collections/{cid}/items/` (list) + `PATCH /v3/collections/{cid}/items/{itemId}` (test injection) + `POST /v3/collections/{cid}/items/` (create) -- bare model id
- `tagging` service: `PUT /v1/tags/collections/{id}` -- collection tagging
- iapub REST `GET /api/sessions/current` -- session identity / team scope; `ums` service squads -- org-mode detection
- `POST /service-account-tokens` (PMAK) -- mint/re-mint the access token
- Bifrost internal-integration adapter: governance assignment, workspace-to-repo linking

Residual PMAK / `X-Api-Key` uses -- none are asset ops: `POST /service-account-tokens` to mint/re-mint the access token; the Postman CLI `spec lint` login (`postman login --with-api-key` -- the CLI has no access-token login); and a read-only `GET /me` identity preflight diagnostic. Every Postman asset op (workspace, spec, collection generate/mutate/tag, roles, contract-test injection) runs on the access-token gateway; the contract collection is refreshed in place via the gateway spec `sync`/`link` routes + `injectContractTests` (v3 `/scripts`), never a v2.x collection read/PUT. No PMAK collection CRUD and no v2.x collections remain. Enforced by `tests/no-pmak-asset-or-newman.test.ts` + `tests/no-collection-v2.test.ts`.

## Gotchas

- Spec upload re-serializes JSON/YAML; original bytes are preserved only when no normalization is needed
- `@actions/core` is used directly for GitHub Actions; CLI mode uses `ConsoleReporter` (logs to stderr, JSON to stdout)
