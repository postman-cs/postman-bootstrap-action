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
- **Collection generation**: Calls `POST /specs/{id}/generations/collection` to create baseline/smoke/contract collections. Injects generated tests and applies tags.
- **Lint**: Installs Postman CLI, runs `postman spec lint` against uploaded spec UID, parses JSON output for errors/warnings.
- **Team ID**: Auto-derived from `GET /me` using the API key. `POSTMAN_TEAM_ID` env var overrides.
- **Repo variables**: Persists `POSTMAN_WORKSPACE_ID`, `POSTMAN_SPEC_UID`, collection UIDs, lint counts as GitHub repo variables for rerun idempotency.

## Postman API Endpoints Used

- `POST /workspaces`, `GET /workspaces` -- workspace CRUD
- `POST /specs`, `PATCH /specs/{id}/files/{path}` -- spec upload/update
- `POST /specs/{id}/generations/collection` -- collection generation
- `GET /collections/{id}`, `PUT /collections/{id}` -- collection update/test injection
- `PUT /collections/{id}/tags` -- collection tagging
- `GET /me` -- team ID derivation
- Bifrost: governance assignment, workspace-to-repo linking

## Gotchas

- `postman-assets-client.ts` has a DEPRECATED URL normalization alias -- do not extend it
- Spec upload re-serializes JSON/YAML; original bytes are preserved only when no normalization is needed
- `@actions/core` is used directly for GitHub Actions; CLI mode uses `ConsoleReporter` (logs to stderr, JSON to stdout)
