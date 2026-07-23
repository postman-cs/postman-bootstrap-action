# postman-bootstrap-action

Creates/reuses Postman workspace, uploads OpenAPI spec to Spec Hub, converts baseline/smoke/contract collections locally (whole-collection import / deep-update), assigns governance, persists repo variables. Dual entry: GitHub Action (`dist/index.cjs`) + CLI (`dist/cli.cjs`).

## Structure

```
src/
  index.ts                  # Action entry
  cli.ts                    # CLI adapter
  contracts.ts              # I/O types
  lib/
    postman/
      postman-assets-client.ts    # Postman API client
      internal-integration-adapter.ts  # Bifrost proxy (governance, linking, system envs)
      workspace-selection.ts      # Canonical workspace resolution
    github/github-api-client.ts   # Repo var read/write
    repo/context.ts               # Auto-detect repo URL/provider/branch
    retry.ts, secrets.ts, http-error.ts
tests/
```

## Commands

```bash
npm ci && npm test && npm run typecheck && npm run build
npm run verify:dist:assert  # read-only dist contract (CI)
npm run verify:dist         # rebuild + git diff + assert
```

## Key Behaviors

- **Workspace selection**: `workspace-id` input -> repo var `POSTMAN_WORKSPACE_ID` -> create new. Access-token validates via Bifrost.
- **Spec normalization**: Fixes missing/long `summary` fields pre-upload to prevent collection-gen failures.
- **Collection generation (OpenAPI)**: Converts validated/bundled OpenAPI once locally into complete baseline/smoke/contract v2.1 payloads (scripts embedded), materializes Collection v3 trees + workflows, then whole-collection `sync` import (fresh/versioned) or deep-update (refresh existing). Links with retained generation `options` + `syncOptions`; no Spec Hub collection generation, temp specs, per-item create, or post-create script PATCH on OpenAPI path.
- **Lint**: PMAK-only. Installs Postman CLI, runs `postman spec lint` against spec UID, hard-fails on errors. No PMAK = skip, `{ status: "skipped", reason: "no postman-api-key" }`, warn, no fail. CLI has no access-token login.
- **Team ID**: From access-token session (`GET /api/sessions/current`). Org-mode sub-team via `ums` service. `POSTMAN_TEAM_ID` overrides.
- **Repo variables**: Persists `POSTMAN_WORKSPACE_ID`, `POSTMAN_SPEC_UID`, collection UIDs, lint counts as GitHub repo vars for rerun idempotency.

## Postman Routes

All asset ops via access-token gateway (Bifrost `POST /ws/proxy`, `x-access-token`). PMAK only mints/re-mints access token + Postman CLI `spec lint` login.

- `workspaces`: org `POST /workspaces` w/ `visibilityStatus: team`, `squad`, group roles; non-org `POST` + `PUT /{id}/visibility` + `GET`; `PATCH /{id}/roles` - admins + requester invite (email->id via `god GET /api/organizations/{teamId}/members`)
- `specification`: `POST /specifications` + `PATCH /{id}/files/{fileId}` (JSON-patch `/content`) - upload/update; OpenAPI collection linking via `PUT /{id}/collections`
- `sync`: `POST /collection/import` (fresh OpenAPI roles) + `PUT /collection/deepupdate/:id` (refresh existing OpenAPI roles)
- `collection`: v3 item surfaces for curated additional collections; `tagging` `PUT /v1/tags/collections/{id}`
- iapub `GET /api/sessions/current` - session identity/team scope; `ums` squads - org detection
- `POST /service-account-tokens` (PMAK) - mint/re-mint
- Bifrost adapter: governance assignment, workspace-to-repo linking, specification and collection relation readback

Residual PMAK: `POST /service-account-tokens` mint/re-mint; Postman CLI `login --with-api-key`; read-only `GET /me` preflight. Every asset op on access-token. OpenAPI contract/smoke scripts are embedded in local payloads before import/deep-update (no post-create `/scripts` PATCH). No PMAK collection CRUD. Enforced by `tests/no-pmak-asset-or-newman.test.ts` + `tests/no-collection-v2.test.ts`.

## Gotchas

- Spec upload re-serializes JSON/YAML; original bytes preserved only when no normalization needed
- `@actions/core` used directly for Action; CLI mode uses `ConsoleReporter` (logs stderr, JSON stdout)

## CI

`.github/workflows/ci.yml` runs one `gate` job. Bundles once, queues at most two checks on one runner. Typecheck once. Dist read-only `verify:dist:assert`; no second build. Every check prints `::group::` result even when another fails.

See workspace-root `../../docs/CI.md` for shared rationale.

## Anti-Patterns

- Never hardcode secrets, tokens, or absolute paths in durable memory
- Never modify `postman-reference/` unless explicitly asked
- Never create docs/README edits unless requested
