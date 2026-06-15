# Support

## Getting help

Open a GitHub issue for usage questions, reproducible failures, or documentation gaps for `postman-bootstrap-action`.

Before opening an issue, check:

- The workflow is pinned to `postman-cs/postman-bootstrap-action@v1` or an immutable `v1.x.y` tag.
- The workflow uses a service-account PMAK for `postman-api-key`.
- `postman-access-token` comes from `postman-cs/postman-resolve-service-token-action@v1` or a current legacy CLI login token.
- EU tenants set `postman-region: eu` on both the service-token step and bootstrap step.
- Org-mode tenants set `workspace-team-id` to the numeric sub-team that should own the workspace.

Include this information in the issue:

- The action version tag.
- The relevant workflow snippet with secrets removed.
- The failing step logs with tokens redacted.
- Whether the run uses `spec-url` or `spec-path`.
- Whether `credential-preflight` is `warn` or `enforce`.

## Security reports

Do not open public issues for vulnerabilities or leaked credentials. Follow [Security Policy](SECURITY.md).
