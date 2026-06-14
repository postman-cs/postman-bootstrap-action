# Security Policy

## Supported versions

The latest `v1.x.y` release, tracked by the rolling `v1` alias, receives security fixes. Older tags remain published for reproducible workflows and are not modified after release.

## Reporting a vulnerability

Do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository from the Security tab.
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention `postman-bootstrap-action`.

You should receive an acknowledgement within five business days. Include reproduction steps, the action version tag, and relevant workflow logs with secrets redacted.

## Credential handling

- This action accepts Postman API keys and access tokens. The action masks those values in its own logs.
- Do not echo `POSTMAN_API_KEY`, `POSTMAN_ACCESS_TOKEN`, or generated dotenv output in workflow steps.
- If a secret is exposed in workflow logs or repository history, rotate it in Postman and update the CI secret immediately.
- Reports about credentials exposed by a consumer workflow are not vulnerabilities in this action unless the action failed to mask a value it handled.
