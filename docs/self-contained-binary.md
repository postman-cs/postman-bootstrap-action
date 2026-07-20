# Self-contained binary (no npm / no Node)

For CI environments that cannot install npm packages or a Node.js runtime — locked-down Jenkins, Bitbucket Pipelines on a bare agent, boxes with no package-registry access — the bootstrap ships as a single self-contained executable. It is a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html): the Node runtime and the entire bundle are baked into one file, so the target needs **no npm, no Node install, and no network access to a package registry**.

"Self-contained" means the *runtime* is bundled — it is not network-isolated. The bootstrap calls Postman API and gateway endpoints throughout the run (see [Network requirements](#network-requirements)).

The binary is built and smoke-tested natively in CI on every release (`.github/workflows/release.yml`) and attached as a GitHub Release asset. It carries the same code as the `action.yml` and npm CLI paths.

- **Current target:** `linux-x64` (glibc). Other targets (linux-arm64, win-x64, darwin-arm64) are not built yet.
- **First release with the binary:** `v2.9.10`.

## Get the binary

Download the release asset and mark it executable. Pin an explicit version:

```bash
VERSION=2.9.10
curl -fsSL -o postman-bootstrap \
  "https://github.com/postman-cs/postman-bootstrap-action/releases/download/v${VERSION}/postman-bootstrap-${VERSION}-linux-x64"
chmod +x postman-bootstrap

./postman-bootstrap --version   # -> 2.9.10
```

If the repository or release is private, the browser-style URL above returns an HTML login page instead of the binary. Fetch it through the GitHub API with a token that has `contents:read`, or — recommended for locked-down environments — **mirror the asset once into your own artifact store** (Artifactory, Nexus, S3) and have CI pull it from there. That keeps the build offline from GitHub entirely and gives you a stable internal URL.

## Prove self-containment

The binary embeds its own runtime and never consults `PATH` for `node`. You can prove that with an empty environment:

```bash
# Reaches the CLI's own input validation with no Node on PATH:
env -i PATH=/nonexistent ./postman-bootstrap
# -> "project-name is required" (expected: it ran, then validated inputs)
```

This is the same assertion the release workflow runs before publishing the asset.

## Credentials

The self-contained binary resolves each credential from three sources, highest precedence first:

1. A CLI flag — `--postman-access-token <token>`, `--postman-api-key <key>`
2. The GitHub Action input env var — `INPUT_POSTMAN_ACCESS_TOKEN`, `INPUT_POSTMAN_API_KEY`
3. A plain environment variable — `POSTMAN_ACCESS_TOKEN`, `POSTMAN_API_KEY`

The plain-env fallback (3) is what makes Jenkins [`withCredentials`](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/) work with no flags: whatever sets `POSTMAN_ACCESS_TOKEN` in the environment, the binary picks it up. Because the access token is short-lived, store the long-lived **PMAK** in Jenkins and mint the access token into `POSTMAN_ACCESS_TOKEN` during the job (see the [Jenkins example](#jenkins-pipeline-example)) rather than storing a token that will expire. See [Obtaining Credentials](credentials.md) for the full credential matrix.

### Access-token-only keeps it self-contained

Run with **only** `postman-access-token` (no `postman-api-key`) and with the two optional download paths off (their defaults) to keep the run free of any runtime tool downloads. Every asset operation — workspace, Spec Hub upload, collection generation, test injection, tagging, linking, sync — runs over the access-token gateway, which needs nothing *on the agent* beyond the binary (it still reaches the Postman gateway over the network — see [Network requirements](#network-requirements)).

Two features pull extra tooling onto the agent at runtime; both are off by default and must stay off (or be pre-provisioned) on a locked-down agent:

- **Spec lint** — enabled by `postman-api-key`. Downloads and installs the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/) via `curl` at runtime. Without a PMAK, lint is cleanly skipped (`{ "status": "skipped", "reason": "no postman-api-key" }`) and the run does not fail.
- **Breaking-change check** — enabled by `breaking-change-mode` with a comparison source. Downloads the pinned `pb33f/openapi-changes` tarball from GitHub and shells out to `tar`. Leave `breaking-change-mode` at its default (`off`) to skip it, or pre-provision/mirror the tool. Access-token-only alone does **not** disable it.

If you need either in a locked-down environment, run it as a separate, explicitly-provisioned step rather than through this binary.

### Minting an access token

Mint a short-lived access token from a service-account PMAK immediately before the run (TTL ~1–1.5h). Mint against the API base for your region — `api.getpostman.com` for US, `api.eu.postman.com` for [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/) — and pass the matching `--postman-region` to the binary:

```bash
POSTMAN_REGION=us                                          # EU data residency: eu
case "$POSTMAN_REGION" in
  eu) POSTMAN_API_BASE="https://api.eu.postman.com" ;;
  *)  POSTMAN_API_BASE="https://api.getpostman.com" ;;
esac

resp="$(curl -fsSL -X POST "$POSTMAN_API_BASE/service-account-tokens" \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$POSTMAN_API_KEY\"}")"

# The endpoint returns the token as either "access_token" or a nested
# session "token" -- accept both, matching the production extractor.
POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$POSTMAN_ACCESS_TOKEN" ] || \
  POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$POSTMAN_ACCESS_TOKEN" ] || { echo "token mint failed" >&2; exit 1; }
export POSTMAN_ACCESS_TOKEN

# Drop the PMAK so it is not in scope when the binary runs: the binary
# reads a plain POSTMAN_API_KEY too, and its presence would enable lint
# (a runtime Postman CLI install), breaking access-token-only isolation.
unset POSTMAN_API_KEY
```

A token minted from the US endpoint is not valid against the EU API (and vice versa), so the mint base and `--postman-region` must match. Store the PMAK in your CI secret store and mint on demand; do not persist the access token.

Minting uses the PMAK only for this token exchange — it is **not** passed to the binary as `--postman-api-key`, so the run stays access-token-only (no lint, no Postman CLI install).

## Network requirements

The binary bundles its runtime, but the bootstrap is an online operation. The agent needs outbound network access (direct or via an HTTP/HTTPS proxy) to Postman for the entire run — token minting is only the first call; every subsequent workspace, Spec Hub, collection, tagging, and linking mutation goes over the network too, and most of them hit the gateway/proxy hosts rather than the public API host.

On agents that enforce an outbound allowlist, allow **all** of the following (prod defaults). The region only changes the API host; the gateway, Bifrost, and iapub hosts are the same for US and EU:

| Host | Purpose |
| --- | --- |
| `api.getpostman.com` (US) / `api.eu.postman.com` (EU) | Public API — token minting, some asset calls |
| `bifrost-premium-https-v4.gw.postman.com` | Bifrost proxy — governance, linking, system envs |
| `gateway.postman.com` | Access-token asset gateway — spec/collection operations |
| `iapub.postman.co` | Session identity / team scope (`/api/sessions/current`) |
| `go.postman.co` | Cold serial fallback for the Bifrost proxy (`/_api`) |

Allowlisting only the API host is **not** enough: credential preflight and asset-gateway calls will fail even though minting succeeds. If you also enable lint or breaking-change checks, add `dl-cli.pstmn.io` and `github.com` / `objects.githubusercontent.com` respectively.

Pre-minting the access token on a connected host and injecting it as `POSTMAN_ACCESS_TOKEN` removes the mint call from the agent, but **not** the requirement — the agent still must reach the gateway hosts above to do the actual work. A host with no route to Postman (direct or proxied) cannot run the bootstrap. Only the package-registry and Node-runtime dependencies are eliminated; Postman connectivity is not.

## Run

Inputs are the same kebab-case names as [`action.yml`](../action.yml), passed as `--<input-name> <value>`:

```bash
export POSTMAN_ACCESS_TOKEN="<minted-token>"

./postman-bootstrap \
  --project-name core-payments \
  --spec-path specs/openapi.yaml \
  --domain payments-platform \
  --domain-code PAY \
  --postman-region us \
  --result-json postman-bootstrap-result.json
```

- `--spec-path` is relative to the working directory. Use `--spec-url` instead to fetch the spec over HTTPS.
- Reuse an existing workspace by passing `--workspace-id` (plus `--spec-id` and the `--*-collection-id` flags) so reruns refresh in place instead of creating new assets.
- For org-mode tenants creating a new workspace, pass `--workspace-team-id <sub-team-id>`. Omit it once and the error output lists the valid sub-team IDs.
- `--result-json <path>` writes the machine-readable result; `--dotenv-path <path>` emits shell-sourceable `POSTMAN_BOOTSTRAP_*` variables.

## Jenkins pipeline example

The binary must run on a **linux-x64 agent** — it is a Linux ELF and cannot execute on a Windows agent. The Jenkins credential stores the long-lived **PMAK**; the pipeline mints a short-lived access token from it in-job and exports it as `POSTMAN_ACCESS_TOKEN`, so the binary picks it up via the plain-env fallback with no flag. Do **not** store the access token itself in Jenkins — it expires in ~1–1.5h and a stored copy will eventually be stale.

```groovy
pipeline {
  // Requires a Linux x64 agent. Swap 'linux' for your instance's label.
  agent { label 'linux' }

  environment {
    BOOTSTRAP_VERSION = '2.9.10'
    POSTMAN_REGION = 'us'   // EU data residency: 'eu'
  }

  stages {
    stage('Fetch binary') {
      steps {
        sh '''
          set -eu
          # Prefer your internal mirror in locked-down environments:
          URL="https://github.com/postman-cs/postman-bootstrap-action/releases/download/v${BOOTSTRAP_VERSION}/postman-bootstrap-${BOOTSTRAP_VERSION}-linux-x64"
          curl -fsSL "$URL" -o postman-bootstrap
          chmod +x postman-bootstrap
          ./postman-bootstrap --version
        '''
      }
    }
    stage('Bootstrap') {
      steps {
        // Bind the PMAK, mint a fresh access token, then run -- all in one shell so the
        // minted token stays in scope. The binary reads it from POSTMAN_ACCESS_TOKEN
        // (no --postman-access-token flag); the PMAK is unset before the binary runs.
        withCredentials([string(credentialsId: 'postman-api-key', variable: 'POSTMAN_API_KEY')]) {
          sh '''
            set +x          # Jenkins runs sh with -x by default; disable it BEFORE touching the PMAK
            set -eu
            case "$POSTMAN_REGION" in
              eu) API_BASE="https://api.eu.postman.com" ;;
              *)  API_BASE="https://api.getpostman.com" ;;
            esac
            resp="$(curl -fsSL -X POST "$API_BASE/service-account-tokens" \
              -H "x-api-key: $POSTMAN_API_KEY" -H "Content-Type: application/json" \
              -d "{\\"apiKey\\":\\"$POSTMAN_API_KEY\\"}")"
            # Accept both response shapes: "access_token" or a nested session "token".
            POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"access_token":"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$POSTMAN_ACCESS_TOKEN" ] || \
              POSTMAN_ACCESS_TOKEN="$(printf '%s' "$resp" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)"
            [ -n "$POSTMAN_ACCESS_TOKEN" ] || { echo "token mint failed" >&2; exit 1; }
            export POSTMAN_ACCESS_TOKEN
            # Drop the PMAK so the binary stays access-token-only: it also reads a plain
            # POSTMAN_API_KEY, whose presence would enable lint (a runtime CLI install).
            unset POSTMAN_API_KEY
            ./postman-bootstrap \
              --project-name core-payments \
              --spec-path specs/openapi.yaml \
              --postman-region "$POSTMAN_REGION" \
              --result-json "$WORKSPACE/postman-bootstrap-result.json"
          '''
        }
      }
    }
  }

  post {
    always {
      archiveArtifacts artifacts: 'postman-bootstrap-result.json', allowEmptyArchive: true
    }
  }
}
```

## Scope and limitations

- **Platform:** linux-x64 (glibc) only. arm64/Windows/macOS targets are not built yet.
- **Network:** not air-gapped — requires outbound access to the Postman API/gateway hosts for the whole run. See [Network requirements](#network-requirements).
- **Lint:** requires the Postman CLI, which the binary installs via `curl` at runtime — not self-contained. Access-token-only runs skip lint cleanly.
- **Breaking-change check:** downloads the `pb33f/openapi-changes` tarball at runtime when enabled. Off by default (`breaking-change-mode: off`); leave it off or pre-provision the tool on locked-down agents.
- **Version:** the embedded `--version` and telemetry version are baked in at build time from the release tag; the versioned filename (`postman-bootstrap-<version>-linux-x64`) also carries it.
