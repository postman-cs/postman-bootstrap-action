# Obtaining Credentials

Bootstrap needs a [Postman API key](https://learning.postman.com/docs/reference/postman-api/authentication/) for standard Postman API calls. Governance assignment, collection linking after local import/deep-update, and canonical workspace validation also need a Postman access token. The primary path is to mint that token in CI with [`postman-cs/postman-resolve-service-token-action`](https://github.com/postman-cs/postman-resolve-service-token-action). See the [service accounts documentation](https://learning.postman.com/docs/administration/service-accounts/) to create the automation identity and assign it to the right team or workspace.

## Credential matrix

| Credential | Required | Used for | Recommended source |
| --- | --- | --- | --- |
| `postman-api-key` / `POSTMAN_API_KEY` | yes | Workspace creation, spec upload, local collection conversion/import, linting, and most Postman API operations | Service-account PMAK stored as a CI secret |
| `postman-access-token` / `POSTMAN_ACCESS_TOKEN` | no, recommended | Governance group assignment, collection linking after local import/deep-update, and canonical workspace validation on reruns | `postman-resolve-service-token-action` output `token` |
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
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-bootstrap-action/main/examples/core-payments-openapi.yaml
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
4. In the repository, open **Settings** > **Secrets and variables** > **Actions**, create a repository secret named `POSTMAN_API_KEY`, and paste the key as its value.

The PMAK is long-lived. Rotate it according to your organization's secret policy and update the CI secret when rotated.

The [managing API keys](https://learning.postman.com/docs/administration/managing-your-team/managing-api-keys/) guide covers expiration, revocation, and exposed-key handling.

## Access-token requirement

Mint `POSTMAN_ACCESS_TOKEN` at run time from the service-account PMAK with `postman-resolve-service-token-action`. Interactive Postman CLI sessions, browser storage, cookies, and developer-tools values are not supported CI credential sources.
