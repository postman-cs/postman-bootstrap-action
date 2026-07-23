# Bootstrap Phase Independence

Bootstrap succeeds independently. It creates or updates the Postman workspace and collections even if a later stage (repo sync, Insights onboarding) fails. This is intentional:

- **Postman side is self-contained:** Workspace creation, spec upload, and local OpenAPI conversion (import/deep-update) do not depend on repository access or merge status.
- **Repository side is async:** Later stages may fail due to repo permissions, branch protection, or pending approval. Bootstrap completion is not blocked by these downstream concerns.
- **Idempotent reruns:** If a later stage fails, subsequent reruns of the action will reuse existing Postman assets (via `workspace-id`, `spec-id`, collection IDs) and focus on the failed stage without recreating everything.

**When bootstrap fails:** The action stops and does not proceed to repo sync. Postman assets are left in the state they reached before the failure (run-owned fresh imports are compensated on link/tag failure before resources persist). Clear error messages identify which required bootstrap step failed (for example, spec lint or local collection import/deep-update). Optional workspace enrichment steps, such as governance assignment and requester invitation, warn and continue so created workspaces and collections remain usable.

This layered design means customers can:

1. Verify Postman workspace health independently.
2. Debug repository issues (branch protection, permissions) separately from Postman provisioning.
3. Reuse existing Postman assets when fixing downstream failures.
