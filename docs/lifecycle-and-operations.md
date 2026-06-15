# Lifecycle Modes and Operations

## Refresh canonical assets

Default bootstrap behavior keeps one current workspace, spec, and generated collection set for the service.

- `collection-sync-mode: refresh` regenerates baseline, smoke, and contract collections from the resolved spec and makes them the current collection pointers.
- `spec-sync-mode: update` updates the current Spec Hub spec from `spec-url` or `spec-path`.
- Legacy `collection-sync-mode: reuse` is accepted as an alias for `refresh`.

Use this mode for main-branch automation where the Postman workspace should track the latest service contract.

## Create versioned release assets

Use versioned mode when each release needs its own spec and collection set:

```yaml
collection-sync-mode: version
spec-sync-mode: version
release-label: v1.1.1
```

When `release-label` is omitted, the action derives one from the git tag, then from branch or ref metadata. If versioned sync is requested and no usable label can be derived, the run fails.

## Ref-native state

Current Postman asset state lives in `.postman/resources.yaml`.

- `update`, `refresh`, and legacy `reuse` modes resolve current-state mappings from the checked-out ref.
- `version` mode reuses only the checked-out ref's mappings.
- Release history lives in git history and tags rather than a separate manifest file or repository variable.

Commit `.postman/resources.yaml` when you want later runs to reuse the same workspace, spec, and collection IDs automatically.

## Cloud spec-to-collection syncing

After collections exist, bootstrap links them to the cloud specification and triggers a spec-side collection sync when `postman-access-token` is available.

- `sync-examples: true` enables example syncing in that relation setup.
- `sync-examples: false` keeps the relation but disables example syncing.
- If `postman-access-token` is missing or expired, bootstrap warns and skips the cloud link/sync step.

Use `credential-preflight: enforce` to fail before workspace creation when the PMAK and access token resolve to different parent orgs. Use `warn` to log the mismatch and continue.

## Region

`postman-region` defaults to `us`. Set `postman-region: eu` for EU data residency tenants.

Set the same region on the service-token step and bootstrap step so the PMAK, access token, and workspace calls resolve against the same Postman environment.

## Release policy

Consumers can pin immutable tags such as `v1.0.0` for reproducibility or use the moving `v1` alias for the latest compatible release. See [Release Policy](../RELEASE_POLICY.md).

## Backend selection

Public inputs and outputs are backend-neutral; backend-specific details are not part of the caller workflow syntax.
