# Obtaining Credentials

Bootstrap needs a [Postman API key](https://learning.postman.com/docs/reference/postman-api/authentication/) for standard Postman API calls. Governance assignment, cloud spec-to-collection sync, and canonical workspace validation also need a Postman access token. The primary path is to mint that token in CI with [`postman-cs/postman-resolve-service-token-action`](https://github.com/postman-cs/postman-resolve-service-token-action). Use Postman's [service accounts documentation](https://learning.postman.com/docs/administration/service-accounts/) to create the automation identity and assign it to the right team or workspace.

## Credential matrix

| Credential | Required | Used for | Recommended source |
| --- | --- | --- | --- |
| `postman-api-key` / `POSTMAN_API_KEY` | yes | Workspace creation, spec upload, collection generation, linting, and most Postman API operations | Service-account PMAK stored as a CI secret |
| `postman-access-token` / `POSTMAN_ACCESS_TOKEN` | no, recommended | Governance group assignment, cloud spec-to-collection sync, and canonical workspace validation on reruns | `postman-resolve-service-token-action` output `token` |
| `workspace-team-id` | only for org-mode workspace creation | Selects the sub-team that owns the created workspace | Repository variable such as `POSTMAN_WORKSPACE_TEAM_ID` |
| `github-token` | only for repository custom property lookup | Reads `postman-governance-group` from GitHub repository properties | `${{ github.token }}` |

`credential-preflight` accepts only `warn` and `enforce`. Use `enforce` when both `postman-api-key` and `postman-access-token` are present and you want mismatched parent orgs to fail before workspace creation.

## Primary path: service-account token minting

Create a [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) PMAK and store it as `POSTMAN_API_KEY`. Use that same PMAK to mint the access token immediately before bootstrap:

```yaml
- id: postman_token
  uses: postman-cs/postman-resolve-service-token-action@v1
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-bootstrap-action@v1
  with:
    project-name: core-payments
    spec-url: https://gist.githubusercontent.com/jaredboynton/a839de57db2c3c90b8f75906c56b00ee/raw/openapi.yaml
    postman-region: us
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman_token.outputs.token }}
    credential-preflight: enforce
```

For [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/) teams, set `postman-region: eu` on both the service-token step and the bootstrap step. The service-token action also emits `team-id`, but bootstrap only needs `workspace-team-id` when your Postman org requires an explicit sub-team for workspace creation.

## Creating `POSTMAN_API_KEY`

1. Open the Postman desktop app or web UI.
2. Go to **Settings** > **Account Settings** > **API Keys**.
3. Generate an API key for the service account that should own onboarding automation.
4. Store it as a CI secret:

```bash
gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
```

The PMAK is long-lived. Rotate it according to your organization's secret policy and update the CI secret when rotated.

Postman's [managing API keys](https://learning.postman.com/docs/administration/managing-your-team/managing-api-keys/) guide covers expiration, revocation, and exposed-key handling.

## Legacy fallback: Postman CLI credential store

Use this only when you cannot use the service-token action yet. Do not copy tokens from browser storage, cookies, or developer tools.

1. Log in with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-auth/) interactive flow:

   ```bash
   postman login
   ```

2. Extract the access token from the CLI credential store:

   ```bash
   jq -r '.login._profiles[].accessToken' ~/.postman/postmanrc
   ```

3. Store it as a GitHub secret:

   ```bash
   gh secret set POSTMAN_ACCESS_TOKEN --repo <owner>/<repo>
   ```

The CLI login token is session-scoped and expires. When it expires, governance and canonical workspace validation degrade to warning-based behavior unless the workflow mints a fresh service-account token. `postman login --with-api-key` stores a PMAK, not the session access token these APIs need.
