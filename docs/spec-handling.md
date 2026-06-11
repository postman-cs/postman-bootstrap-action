# OpenAPI Spec Handling

## Operation summary normalization

Before upload to Spec Hub, the action parses JSON or YAML OpenAPI documents and adjusts **path operations** so collection generation is less likely to fail:

1. **Missing `summary`:** Uses `operationId` if present; otherwise falls back to `METHOD /path` (for example `GET /pets`).
2. **Very long `summary`:** Truncates to **200 characters** (with an ellipsis) so downstream limits are not exceeded.

This runs in `src/index.ts` before upload. If nothing under `paths` needs changing, the original document bytes are preserved. When normalization runs, the spec is re-serialized (JSON stays JSON; YAML stays YAML). Each fix emits a **warning** in the Actions log so you can improve the source spec over time. Invalid documents that cannot be parsed are left unchanged and a warning is logged.

## Spec URL fetch safety

The root `spec-url` must be HTTPS and is fetched with pinned DNS resolution. The action blocks credential-bearing URLs, localhost/private/link-local/internal destinations, unsafe redirects, DNS rebinding attempts, and oversized OpenAPI resources before uploading content to Spec Hub. Root fetches are capped at 25 MiB, and fetch errors redact URL credentials, query strings, and fragments before logging.

## Loading the spec from the workspace (`spec-path`)

For Git-first workflows the spec is usually checked into the same repo that runs the action, so an HTTPS URL is redundant (or impossible without making the repo public). Pass `spec-path` instead of `spec-url` to read the document directly from the checked-out workspace.

Only one of `spec-url` or `spec-path` may be set. When `spec-path` is used the action reads the file from disk, skips the URL-safety machinery, and still resolves any external HTTPS `$ref`s through the same hardened fetcher. Local-file `$ref`s are not followed.

## Breaking-change check

Breaking-change detection is disabled by default. Enable it with `breaking-change-mode` when you want bootstrap to compare the incoming OpenAPI contract before creating or updating Postman resources.

Modes:

- `off`: default. No comparison runs and `openapi-changes` is not installed.
- `previous-spec`: compares the incoming Spec Hub upload content with the existing `spec-id` content. If there is no previous spec, the check is marked `skipped`.
- `pr-native`: compares `breaking-target-ref` or the detected PR target branch version of `spec-path` against the checked-out working tree. If no target-branch spec is available, it falls back to `breaking-baseline-spec-path` when configured.
- `baseline-only`: compares `breaking-baseline-spec-path` against the incoming spec. If the baseline file is missing, the check is marked `skipped`.

The action installs a pinned `pb33f/openapi-changes` release into the runner temp directory, verifies the archive checksum, validates archive paths before extraction, and runs the binary by absolute path. It does not require customers to preinstall the tool, and it does not use `npx`, global npm installs, or `curl | sh`.

Summary and log files default to `$RUNNER_TEMP/postman-bootstrap/`, so they are runner files rather than committed repo changes. The markdown summary is also appended to the GitHub job summary when `$GITHUB_STEP_SUMMARY` is available. Pass `breaking-summary-path` or `breaking-log-path` only if your workflow wants explicit file locations for later `actions/upload-artifact` steps.

If breaking changes are detected, bootstrap fails before workspace, spec, or collection mutation. Missing comparison sources are reported as `skipped` and do not fail the run.
