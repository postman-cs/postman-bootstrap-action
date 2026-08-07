# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use `v2.x.y` tags for the current major.
- The rolling `v2` alias moves to the latest compatible `v2.x.y` release.
- Existing release tags are never force-pushed or rewritten.
- `v0` and `v1` tags stay frozen at their last releases.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Releases are cut automatically. Merging to `main` runs `.github/workflows/auto-release.yml`,
which derives the next version from the conventional-commit history, then runs
`scripts/release-cut.mjs`: bump, rebuild `dist/`, normalize the multifile
receipt, run the gate set, commit, and tag.

The tag is created only after the exact bytes of the release commit pass every
gate, so a failed cut leaves no tag and burns no version number. The next merge
retries on a fresh version, skipping any already-tagged one.

Before planning another cut, auto-release reconciles the latest immutable tag
when its GitHub release is missing or its rolling alias has not advanced. It
does not duplicate an active release run, and a successful release completion
resumes planning. Receipt normalization retries rebuild the pull request from
the immutable tag rather than transient runner state, but only while `main`'s
receipt binding is older than the source commit covered by that tag. Divergent
receipt bindings stop recovery rather than choosing either side.

The immutable npm package and GitHub release publish after deterministic artifact
verification. The release workflow then dispatches the exact released tag to the
live E2E harness with a digest-bound correlation ID and waits for that exact run
to finish. The rolling major alias advances only after terminal success. Manual
workflow dispatch can select `report-only` as an explicit override; enforcement
is the default and missing tokens, correlation, or verifier availability block
the alias.

Do not push `vX.Y.Z` tags by hand. The pre-push hook refuses them, because a
hand-pushed tag becomes a public identifier before any gate has run against it.

To see what the next merge would cut:

```sh
node scripts/release-cut.mjs --plan
```

The same gates run locally before any push:

1. `npm test`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. `npm run verify:dist`
6. `npm run docs:tables` when `action.yml` changes, then confirm the `README.md` tables still match.
7. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

## npm package

The CLI publishes as `@postman-cse/onboarding-bootstrap` with versions that match the GitHub release tag. The rolling `v2` alias updates the action channel and skips npm publishing.

## Compatibility

Compatible changes ship under the `v2` alias: documentation updates, validation fixes, new optional inputs, and bug fixes that preserve existing workflow syntax. Breaking workflow-syntax changes require a new major alias.

## Security fixes

Security fixes ship on the latest `v2.x.y` tag and move onto the rolling `v2` alias. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).
