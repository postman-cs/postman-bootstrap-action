# Release Policy

## Source of truth

Git tags and GitHub releases are the public release identifiers for this action. `package.json` versions support npm packaging, but consumers should select action versions by Git tag. The committed `dist/` bundle is part of the released artifact because GitHub Actions runs it verbatim from the tag.

## Tag policy

- Immutable releases use `v1.x.y` tags.
- The rolling `v1` alias moves to the latest compatible `v1.x.y` release.
- Existing release tags are never force-pushed or rewritten.
- `v0` tags stay frozen at the last `v0` release.
- Every immutable release tag has a GitHub release with generated notes.

## Release checks

Run the package validators from this directory before pushing an immutable tag:

1. Confirm the working tree is clean.
2. `npm test`
3. `npm run typecheck`
4. `npm run lint`
5. `npm run build`
6. `npm run check:dist`
7. `npm run docs:tables` when `action.yml` changes, then confirm the `README.md` tables still match.
8. Confirm `SECURITY.md`, `SUPPORT.md`, and this file still describe the release surface.

## npm package

The CLI publishes as `@postman-cse/onboarding-bootstrap` with versions that match the GitHub release tag. The rolling `v1` alias updates the action channel and skips npm publishing.

## Compatibility

Compatible changes ship under the `v1` alias: documentation updates, validation fixes, new optional inputs, and bug fixes that preserve existing workflow syntax. Breaking workflow-syntax changes require a new major alias.

## Security fixes

Security fixes ship on the latest `v1.x.y` tag and move onto the rolling `v1` alias. Older immutable tags stay published for reproducibility. See [Security Policy](SECURITY.md).
