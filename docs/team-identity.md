# Team Identity: Parent Teams and Org-Mode Workspaces

Bootstrap resolves two different team concepts:

- Parent team identity comes from `postman-api-key` and is used for telemetry, repository linking, and credential preflight.
- Workspace ownership for org-mode tenants comes from `workspace-team-id`, the numeric sub-team that should own the created workspace.

Most teams only need the first one. Org-mode Postman organizations with multiple sub-teams must also provide `workspace-team-id` when creating a new workspace.

## Parent team identity

The action derives the parent Postman team ID from the PMAK with the `/me` API. You normally do not pass this value to bootstrap.

`POSTMAN_TEAM_ID` is an advanced explicit override for parent team context. It does not select the sub-team that owns a new workspace. Use `workspace-team-id` for workspace creation.

## Org-mode workspace ownership

Organizations with multiple sub-teams require a specific sub-team owner for new workspaces. The Postman API does not create a workspace directly at the organization level. The [roles and permissions](https://learning.postman.com/docs/administration/roles-and-permissions/) and [manage roles](https://learning.postman.com/docs/administration/managing-your-team/team-members/manage-roles/) docs are the source of truth for workspace role semantics.

### How it works

1. If `workspace-team-id` is provided, bootstrap uses it when creating the workspace.
2. If it is missing, bootstrap checks available teams before workspace creation.
3. If multiple sub-teams are detected, the action fails with their names and numeric IDs.
4. Set `workspace-team-id` to the desired sub-team ID and rerun.

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
