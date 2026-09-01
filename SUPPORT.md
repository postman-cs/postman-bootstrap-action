# Support

## Getting help

Open a GitHub issue for usage questions, reproducible failures, or documentation gaps in `postman-bootstrap-action`.

Before opening an issue, check:

- The workflow pins the rolling major alias or an immutable tag shown in `README.md`; frozen older majors receive no fixes.
- Credentials are supplied the way `README.md` documents (service-account Postman API key, access token from `postman-cs/postman-resolve-service-token-action`, region set for EU tenants).
- The run reproduces on the latest release.

Include in the issue:

- The release tag in use.
- The workflow snippet with secrets removed.
- The failing step logs with tokens redacted.

## Security reports

Do not open public issues for vulnerabilities or leaked credentials. Follow [Security Policy](SECURITY.md).
