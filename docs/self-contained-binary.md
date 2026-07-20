# Self-contained binary (no npm / no Node)

For CI environments that cannot install npm packages or a Node.js runtime — locked-down Jenkins, Bitbucket Pipelines on a bare agent, air-gapped build boxes — the bootstrap ships as a single self-contained executable. It is a [Node.js Single Executable Application](https://nodejs.org/api/single-executable-applications.html): the Node runtime and the entire bundle are baked into one file, so the target needs **no npm, no Node install, and no network access to a package registry**.

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

The plain-env fallback (3) is what makes Jenkins [`withCredentials`](https://www.jenkins.io/doc/pipeline/steps/credentials-binding/) work with no flags: bind a secret to `POSTMAN_ACCESS_TOKEN` and the binary picks it up. See [Obtaining Credentials](credentials.md) for the full credential matrix.

### Access-token-only keeps it self-contained

Run with **only** `postman-access-token` (no `postman-api-key`) to stay fully offline. Every asset operation — workspace, Spec Hub upload, collection generation, test injection, tagging, linking, sync — runs over the access-token gateway, which needs nothing beyond the binary.

Passing `postman-api-key` additionally enables **spec lint**, which downloads and installs the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/) via `curl` at runtime. That is a network dependency and will fail on a `curl`-less or air-gapped agent. If you need lint in a locked-down environment, run it as a separate, explicitly-provisioned step rather than through this binary. Without a PMAK, lint is cleanly skipped (`{ "status": "skipped", "reason": "no postman-api-key" }`) and the run does not fail.

### Minting an access token

Mint a short-lived access token from a service-account PMAK immediately before the run (TTL ~1–1.5h):

```bash
POSTMAN_ACCESS_TOKEN="$(curl -fsSL -X POST https://api.getpostman.com/service-account-tokens \
  -H "x-api-key: $POSTMAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"apiKey\":\"$POSTMAN_API_KEY\"}" \
  | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)"
export POSTMAN_ACCESS_TOKEN
```

Store the PMAK in your CI secret store and mint on demand; do not persist the access token. For [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/), pass `--postman-region eu`.

## Run

Inputs are the same kebab-case names as [`action.yml`](../action.yml), passed as `--<input-name> <value>`:

```bash
export POSTMAN_ACCESS_TOKEN="<minted-token>"

./postman-bootstrap \
  --project-name claims-processing \
  --spec-path specs/claims-processing-api-openapi.yaml \
  --domain insurance-platform \
  --domain-code CLAIMS \
  --postman-region us \
  --result-json postman-bootstrap-result.json
```

- `--spec-path` is relative to the working directory. Use `--spec-url` instead to fetch the spec over HTTPS.
- Reuse an existing workspace by passing `--workspace-id` (plus `--spec-id` and the `--*-collection-id` flags) so reruns refresh in place instead of creating new assets.
- For org-mode tenants creating a new workspace, pass `--workspace-team-id <sub-team-id>`. Omit it once and the error output lists the valid sub-team IDs.
- `--result-json <path>` writes the machine-readable result; `--dotenv-path <path>` emits shell-sourceable `POSTMAN_BOOTSTRAP_*` variables.

## Jenkins pipeline example

The binary must run on a **linux-x64 agent** — it is a Linux ELF and cannot execute on a Windows agent. Credentials come from `withCredentials` binding a Postman access token to `POSTMAN_ACCESS_TOKEN`, exercising the plain-env fallback with no flag.

```groovy
pipeline {
  // Requires a Linux x64 agent. Swap 'linux' for your instance's label.
  agent { label 'linux' }

  environment {
    POSTMAN_ACCESS_TOKEN = credentials('postman-access-token')
    BOOTSTRAP_VERSION = '2.9.10'
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
        // No --postman-access-token flag: it resolves from the POSTMAN_ACCESS_TOKEN env var.
        sh '''
          set -eu
          ./postman-bootstrap \
            --project-name claims-processing \
            --spec-path specs/claims-processing-api-openapi.yaml \
            --postman-region us \
            --result-json "$WORKSPACE/postman-bootstrap-result.json"
        '''
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
- **Lint:** requires the Postman CLI, which the binary installs via `curl` at runtime — not self-contained. Access-token-only runs skip lint cleanly.
- **Version:** the embedded `--version` and telemetry version are baked in at build time from the release tag; the versioned filename (`postman-bootstrap-<version>-linux-x64`) also carries it.
