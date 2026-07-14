# postman-bootstrap-action

Creates or reuses Postman workspace, uploads/updates OpenAPI spec to Spec Hub, generates baseline/smoke/contract collections, assigns governance, and persists repo variables. Dual entry: GitHub Action (`dist/index.cjs`) and CLI (`dist/cli.cjs`).

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
npm run verify:dist:assert  # read-only artifact contract (CI parallel dist gate)
npm run verify:dist         # rebuild + git diff + assert
```

## Key Behaviors

- **Workspace selection**: Checks input `workspace-id` -> repo variable `POSTMAN_WORKSPACE_ID` -> creates new. Canonical workspace validation uses access-token via Bifrost.
- **Spec normalization**: Before upload, fixes missing/long `summary` fields in OpenAPI operations to prevent downstream collection generation failures.
- **Collection generation**: Generates baseline/smoke/contract collections from spec through access-token gateway (`specification` service `POST /specifications/{id}/collections` + task poll). Injects generated tests (per-item `PATCH /v3/collections/{cid}/items/{itemId}` `/scripts` afterResponse) and applies tags (`tagging` service `PUT /v1/tags/collections/{id}`).
- **Lint**: PMAK-only. With a `postman-api-key`, installs Postman CLI, runs `postman spec lint` against uploaded spec UID, and hard-fails on lint errors. When `postman-api-key` is absent (access-token-only runs), the CLI install and lint are skipped, `lint-summary-json` is `{ status: "skipped", reason: "no postman-api-key" }`, warning is emitted, and run does not hard-fail. The CLI has no access-token login, so this is one asset-adjacent PMAK use.
- **Team ID**: Resolved from access-token session identity (`GET https://iapub.postman.co/api/sessions/current`); org-mode sub-team (squad) detection uses gateway `ums` service. `POSTMAN_TEAM_ID` env var overrides.
- **Repo variables**: Persists `POSTMAN_WORKSPACE_ID`, `POSTMAN_SPEC_UID`, collection UIDs, lint counts as GitHub repo variables for rerun idempotency.

## Postman Routes Used

All asset operations run through access-token gateway (Bifrost `POST /ws/proxy` envelope, `x-access-token`); see workspace-root `../../docs/REST-to-gateway.md` for verified wire shapes. The PMAK is used only to mint/re-mint access token and for Postman CLI `spec lint` login.

- `workspaces` service: org-mode `POST /workspaces` with `visibilityStatus: team`, `squad`, and group roles (`WORKSPACE_VIEWER_V9`); non-org `POST /workspaces` (personal) + `PUT /workspaces/{id}/visibility` (team) + `GET /workspaces` -- workspace create/visibility/lookup; `PATCH /workspaces/{id}/roles` (string role names) -- workspace admins + requester invite (email->id resolved via `god` `GET /api/organizations/{teamId}/members`)
- `specification` service: `POST /specifications` + `PATCH /specifications/{id}/files/{fileId}` (JSON-patch `/content`) -- spec upload/update; `POST /specifications/{id}/collections` + task poll -- collection generation
- `collection` service: `GET /v3/collections/{cid}/items/` (list) + `PATCH /v3/collections/{cid}/items/{itemId}` (test injection) + `POST /v3/collections/{cid}/items/` (create) -- bare model id
- `tagging` service: `PUT /v1/tags/collections/{id}` -- collection tagging
- iapub REST `GET /api/sessions/current` -- session identity / team scope; `ums` service squads -- org-mode detection
- `POST /service-account-tokens` (PMAK) -- mint/re-mint access token
- Bifrost internal-integration adapter: governance assignment, workspace-to-repo linking

Residual PMAK / `X-Api-Key` uses -- none are asset ops: `POST /service-account-tokens` to mint/re-mint access token; Postman CLI `spec lint` login (`postman login --with-api-key` -- the CLI has no access-token login); and read-only `GET /me` identity preflight diagnostic. Every Postman asset op (workspace, spec, collection generate/mutate/tag, roles, contract-test injection) runs on access-token gateway; contract collection is refreshed in place via gateway spec `sync`/`link` routes + `injectContractTests` (v3 `/scripts`), never a v2.x collection read/PUT. No PMAK collection CRUD and no v2.x collections remain. Enforced by `tests/no-pmak-asset-or-newman.test.ts` + `tests/no-collection-v2.test.ts`.

## Gotchas

- Spec upload re-serializes JSON/YAML; original bytes are preserved only when no normalization is needed
- `@actions/core` is used directly for GitHub Actions; CLI mode uses `ConsoleReporter` (logs to stderr, JSON to stdout)

## CI

`.github/workflows/ci.yml` runs one `gate` job. It bundles once, then queues at
most two checks on one runner. Typecheck runs once. Dist uses read-only
`verify:dist:assert`; no second build or `rm -rf dist`. Every check prints a
`::group::` result even when another check fails.

The `integration` gate needs Postman CLI, installed in step before fan-out.

See workspace-root `../../docs/CI.md` for shared rationale.
