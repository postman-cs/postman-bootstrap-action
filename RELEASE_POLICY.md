# Release Policy

## Version tags

Releases use immutable `v1.x.y` tags and a rolling `v1` alias.

- Pin `postman-cs/postman-bootstrap-action@v1.x.y` for reproducible workflows.
- Use `postman-cs/postman-bootstrap-action@v1` to receive the latest compatible v1 release.
- Existing immutable release tags are not force-pushed.

Git tags are the release source of truth for the GitHub Action. The npm package version follows the published CLI package, but consumers should pin the GitHub Action by tag.

## Release contents

Each release includes the compiled `dist/` bundle used by `action.yml`, the CLI package build, and the documentation for the released inputs and outputs.

## Compatibility

Compatible changes can ship under the `v1` alias. Examples include documentation updates, validation fixes, new optional inputs, and bug fixes that preserve existing workflow syntax.

Breaking workflow syntax changes require a new major alias. Security fixes may be released under the current major when they preserve the public contract.

## Security fixes

Only the latest `v1.x.y` release receives security fixes. See [Security Policy](SECURITY.md).
