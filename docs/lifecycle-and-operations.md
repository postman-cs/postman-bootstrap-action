# Lifecycle Modes and Operations

## Refresh canonical assets

Default bootstrap behavior keeps one current workspace, spec, and generated collection set for the service.

- `collection-sync-mode: refresh` regenerates baseline, smoke, and contract collections from the resolved spec and makes them the current collection pointers.
- `spec-sync-mode: update` updates the current Spec Hub spec from `spec-url` or `spec-path`.
- Legacy `collection-sync-mode: reuse` is accepted as an alias for `refresh`.
- `collection-update-strategy` defaults to `whole`, which deep-updates each changed reusable collection as one complete tree. `auto` first exports the current tree, skips a semantic no-op, applies only a bounded eligible delta, and falls back to the hardened whole-tree update for unsupported or failed granular changes.
- Invalid strategy values fail during input validation, before any workspace, spec, or collection mutation.

Every successful fresh import, whole update, bounded delta, and semantic no-op is followed by an exact final collection export and digest comparison. Final exports use at most two concurrent reads. A missing, unreadable, or mismatched final export aborts the run: attempted reusable roots are restored from their preflight snapshots and run-owned fresh roots are deleted and absence-verified. Ambiguous delta readback that already proves the desired whole digest stops later ordered mutations; the independent final export is still required.

The local operation ledger is sanitized metadata only. It records per-role desired and observed semantic digests, actual snapshot/write/reconciliation durations, bounded-operation counts, fallback reasons, and aggregate convergence counters. It does not include collection content, names, credentials, or request data; settled relation states may be keyed by the opaque cloud collection ID needed to correlate the linked asset.

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

## Local OpenAPI collection path

OpenAPI collections follow the local sole path: local conversion → repo v3 artifacts → classic sync import/deep-update. Canonical spec upload remains in Spec Hub. When `spec-path` exists, bootstrap writes path-only pre-link pairs; linking uses retained generation `options` + `syncOptions` when `postman-access-token` is available (GET-only relation settle; never specification collection-sync).

- `sync-examples: true` enables example syncing in that relation setup.
- `sync-examples: false` keeps the relation but disables example syncing.
- If `postman-access-token` is missing or expired, bootstrap warns and skips cloud linking.

Use `credential-preflight: enforce` to fail before workspace creation when the PMAK and access token resolve to different parent orgs. Use `warn` to log the mismatch and continue.

## Region

`postman-region` defaults to `us`. Set `postman-region: eu` for EU data residency tenants.

Set the same region on the service-token step and bootstrap step so the PMAK, access token, and workspace calls resolve against the same Postman environment.

## Release policy

Consumers can pin immutable tags such as `v2.0.0` for reproducibility or use the moving `v2` alias for the latest compatible release. See [Release Policy](../RELEASE_POLICY.md).

## Backend selection

Public inputs and outputs are backend-neutral; backend-specific details are not part of the caller workflow syntax.

## Phase independence

Bootstrap succeeds independently. It creates or updates the Postman workspace and collections even if a later stage (repo sync, Insights onboarding) fails. This is intentional:

- **Postman side is self-contained:** workspace creation, spec upload, and local OpenAPI conversion (import/deep-update) do not depend on repository access or merge status.
- **Repository side is async:** later stages may fail due to repo permissions, branch protection, or pending approval. Bootstrap completion is not blocked by these downstream concerns.
- **Idempotent reruns:** if a later stage fails, subsequent reruns reuse existing Postman assets (via `workspace-id`, `spec-id`, collection IDs) and focus on the failed stage without recreating everything.

**When bootstrap fails:** the action stops and does not proceed to repo sync. Postman assets are left in the state they reached before the failure (run-owned fresh imports are compensated on link/tag failure before resources persist). Clear error messages identify which required bootstrap step failed (for example, spec upload or local collection import/deep-update). Optional workspace enrichment steps, such as governance assignment and requester invitation, warn and continue so created workspaces and collections remain usable.

This lets customers verify Postman workspace health independently, debug repository issues (branch protection, permissions) separately from Postman provisioning, and reuse existing Postman assets when fixing downstream failures.
