# Team Identity: Derivation and Org-Mode Teams

## Team ID derivation

The action automatically derives the Postman Team ID from your `postman-api-key` via the `/me` API. There is no need to supply a separate team ID input. If the environment variable `POSTMAN_TEAM_ID` is set, that value takes precedence.

## Org-mode teams

Postman organizations with multiple sub-teams (squads) require an explicit `workspace-team-id` to create workspaces. The Postman API does not allow workspace creation at the organization level: a specific sub-team must own each workspace.

### How it works

1. The action calls `GET /teams` to check if the API key belongs to an org-mode account.
2. If multiple sub-teams are detected and no `workspace-team-id` is provided, the action fails with a list of available sub-teams and their numeric IDs.
3. Set `workspace-team-id` to the desired sub-team ID to proceed.

### Example (GitHub Actions)

```yaml
- uses: postman-cs/postman-bootstrap-action@v1
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

### CLI usage

```bash
postman-bootstrap --workspace-team-id 132319 ...
```

Or via environment variable: `export POSTMAN_WORKSPACE_TEAM_ID=132319`

Non-org accounts (single team) are unaffected and do not need this input.
