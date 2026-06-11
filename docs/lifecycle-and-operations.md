# Lifecycle Modes and Operational Reference

## Collection sync

- `reuse`: legacy alias for `refresh`; existing collection IDs are reused when available and updated from the resolved spec.
- `refresh`: baseline, smoke, and contract collections are regenerated from the resolved spec and become the current/default collection pointers.
- `version`: a release-scoped collection set is created or reused from the checked-out ref's state when available.

## Spec sync

- `update`: canonical behavior. The current spec in Spec Hub is updated from `spec-url`.
- `version`: the action reuses the checked-out ref's `.postman/resources.yaml` spec mapping when present. If no mapping exists on the current ref, it creates a new release-scoped spec.

## Release label derivation

When versioned sync is requested and `release-label` is omitted, the action derives one using:

1. explicit `release-label`
2. Git tag name
3. branch name or ref metadata

If versioned sync is requested and no usable label can be derived, the run fails.

## Ref-native state

Current Postman asset state lives in `.postman/resources.yaml`.

- `update`, `refresh`, and legacy `reuse` modes resolve current-state mappings from the checked-out ref.
- `version` mode reuses only the checked-out ref's mappings; release history lives in git history and tags rather than in a separate manifest file or repository variables.

## Cloud spec-to-collection syncing

After collections exist, bootstrap links them to the cloud specification and triggers a spec-side collection sync when `postman-access-token` is available.

- `sync-examples: true` (default) enables example syncing in that relation setup.
- `sync-examples: false` keeps the relation but disables example syncing.
- If `postman-access-token` is missing, bootstrap warns and skips the cloud link/sync step.

## Contract smoke monitoring

This repo includes `.github/workflows/contract-smoke.yml`, a scheduled live contract check for the upstream Postman APIs used by bootstrap.

Configure these repository secrets before enabling the workflow:

- `SMOKE_ORG_API_KEY`
- `SMOKE_ORG_ACCESS_TOKEN`
- `SMOKE_NON_ORG_API_KEY`

Configure this repository variable for the org-mode workspace creation check:

- `SMOKE_WORKSPACE_TEAM_ID=132319`

`132319` is the currently derived CSE sub-team ID under org `13347347`. The smoke job uses that value to verify `POST /workspaces` still accepts the explicit `teamId` payload required for org-mode tenants.

## Customer Preview release strategy

- Customer Preview channel tags use `v1.x.y`.
- Consumers can pin immutable tags such as `v1.0.0` for reproducibility.
- Moving tag `v1` is used only as the rolling customer preview channel.

## REST migration seam

Public inputs and outputs are backend-neutral. `integration-backend` currently supports `bifrost`, and backend-specific metadata stays internal so a future REST backend can replace the implementation without changing caller workflow syntax.
