# Team Identity: Parent Teams and Org-Mode Workspaces

Bootstrap resolves two different team concepts:

- Parent team identity comes from the access-token session (`GET /api/sessions/current` through iapub), whether you supply `postman-access-token` directly or mint it from `postman-api-key`. That session team id is used for telemetry, repository linking, and credential preflight.
- Workspace ownership for org-mode tenants comes from `workspace-team-id`, the numeric sub-team that should own the created workspace.

Most teams only need the first one. Org-mode Postman organizations with multiple sub-teams must also provide `workspace-team-id` when creating a new workspace.

> **`workspace-team-id` is a squad id.** The resolver's `team-id` output (and `POSTMAN_TEAM_ID`) is a **parent/org team id** from the access-token session (`GET /api/sessions/current` through iapub). It is **never** a valid `workspace-team-id` value. Aliasing the parent team id into `--workspace-team-id` produces a different `403 Forbidden` and does not create the workspace.

## Parent team identity

The action derives the parent Postman team ID from the access-token session via iapub (`GET /api/sessions/current`), resolved during credential preflight whether the token was supplied or minted from a service-account PMAK. You normally do not pass this value to bootstrap.

`POSTMAN_TEAM_ID` is an advanced explicit override for parent team context. It does not select the sub-team that owns a new workspace. Use `workspace-team-id` for workspace creation.

## Org-mode workspace ownership

Organizations with multiple sub-teams require a specific sub-team owner for new workspaces. The Postman API does not create a workspace directly at the organization level. The [roles and permissions](https://learning.postman.com/docs/administration/roles-and-permissions/) and [manage roles](https://learning.postman.com/docs/administration/managing-your-team/team-members/manage-roles/) docs are the source of truth for workspace role semantics.

### How it works

1. If `workspace-team-id` is provided, bootstrap uses it when creating the workspace.
2. If it is missing, bootstrap reads the available sub-teams (squads) from UMS before workspace creation.
3. If multiple sub-teams are detected, the action fails fast with their names and numeric IDs.
4. Set `workspace-team-id` to the desired sub-team ID and rerun.

### Squad discovery fails closed

Before creating a workspace, bootstrap must know whether the account is org-mode and, if so, which squad owns it. Squad discovery no longer silently degrades an unreadable or unusable squad list into "not org-mode". The following outcomes on an org account are now **fatal before any workspace is created** when `workspace-team-id` is not supplied:

- UMS returns `401`, `403`, or `404` reading the squad list.
- UMS returns a terminal `5xx`, `408`, or `429` after the gateway's own retries.
- UMS returns `400` with a body that does **not** match `squad feature is not available` (wording drift fails closed).
- UMS returns a malformed body, a non-array `data` field, an empty `data` array, or any successful row missing a usable id, name, or organizationId.

Only a `400` whose body matches `squad feature is not available` is treated as a genuine non-org signal and degrades to "no squads". Successful payloads are validated whole; invalid rows are never filtered out, because filtering could turn a two-squad account into an unsafe single-squad auto-pick.

The failure names `workspace-team-id`, the `POSTMAN_WORKSPACE_TEAM_ID` environment variable, the `--workspace-team-id` CLI flag, and the observed UMS status. No workspace is created and no visibility flip is attempted, so you no longer see the late, misleading `403 Forbidden` on `PUT /workspaces/:id/visibility` that this incident was caused by. Provide `workspace-team-id` explicitly, or reuse an existing workspace with `workspace-id` (reuse skips discovery entirely).

### GitHub Actions example

```yaml
- uses: postman-cs/postman-bootstrap-action@v1
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
    workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

Store the sub-team ID as a repository variable so it can be reused across workflows:

```yaml
workspace-team-id: ${{ vars.POSTMAN_WORKSPACE_TEAM_ID }}
```

### CLI usage

```bash
postman-bootstrap \
  --project-name core-payments \
  --spec-url https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml \
  --workspace-team-id "$POSTMAN_WORKSPACE_TEAM_ID" \
  --postman-api-key "$POSTMAN_API_KEY"
```

Or set the environment variable before running the CLI:

```bash
export POSTMAN_WORKSPACE_TEAM_ID=132319
```

Single-team Postman accounts do not need `workspace-team-id`.
