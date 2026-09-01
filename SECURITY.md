# Security Policy

## Supported Versions

Security fixes ship on the newest release of the current major; consumers pin the rolling major alias shown in `README.md` to receive them. Older immutable tags stay published for reproducibility and are never modified.

## Reporting a Vulnerability

Do not open a public issue for security reports.

- Preferred: GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and name the repository.

Expect an acknowledgement within five business days. Include reproduction steps, the release tag, and redacted workflow logs.

## Scope Notes

- This component handles credentials you supply (Postman API keys, Postman access tokens, and any CI or cloud credentials). It masks them in its own logs; do not echo them in your own workflow steps.
- Credentials exposed by your own workflow configuration are out of scope; rotate them immediately.
- Never include live keys, tokens, or private workflow logs in a report.
- A hostile process running concurrently as the same OS user with write access to the checked-out repository is outside the supported isolation boundary; use an isolated runner for untrusted workloads.
