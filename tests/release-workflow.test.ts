import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');

function job(name: string): string {
  return workflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

function assertOrder(earlier: string, later: string, haystack = workflow): void {
  expect(haystack.indexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(haystack.indexOf(earlier)).toBeLessThan(haystack.indexOf(later));
}

describe('release workflow publishing contract', () => {
  it('classifies npm_publish and release_kind before npm ci with full-history checkout', () => {
    const classify = job('classify');
    expect(classify).toContain('fetch-depth: 0');
    expect(classify).toContain('name: Classify release tag');
    expect(classify).toContain('release_kind: ${{ steps.release_tag.outputs.release_kind }}');
    expect(classify).toContain('npm_publish: ${{ steps.release_tag.outputs.npm_publish }}');
    expect(classify).toContain('release_kind=immutable');
    expect(classify).toContain('npm_publish=true');
    expect(classify).toContain('release_kind=alias');
    expect(classify).toContain('npm_publish=false');
    expect(classify).toContain('accepted immutable tag');
    expect(classify).toContain('elif [ "$PATCH" = 0 ]');
    expect(classify).not.toContain('npm ci');
    assertOrder('name: Classify release tag', '- run: npm ci');
  });

  it('gates every post-classifier job on immutable release_kind', () => {
    expect(job('verify-package')).toContain("if: ${{ needs.classify.outputs.release_kind == 'immutable' }}");
    expect(job('publish')).toContain(
      "if: ${{ needs.classify.outputs.release_kind == 'immutable' && needs.verify-package.result == 'success' }}"
    );
    expect(job('verify-release-e2e')).toContain(
      "if: ${{ !cancelled() && needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' }}"
    );
    expect(job('advance-major-alias')).toContain(
      "if: ${{ !cancelled() && needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' && needs.verify-release-e2e.result == 'success' && needs.verify-release-e2e.outputs.outcome == 'success' }}"
    );
  });

  it('uses unprivileged verify permissions, one bundle, exact gate set, and pinned actionlint', () => {
    const verify = job('verify-package');
    expect(verify).toMatch(/permissions:\n {6}contents: read/);
    expect(verify).toContain('node .github/scripts/prefetch-vendored-deps.mjs');
    expect(verify).toContain('DEPS_REPO: ${{ secrets.DEPS_REPO }}');
    expect(verify).toContain('DEPS_TOKEN: ${{ secrets.DEPS_TOKEN }}');
    expect(verify).not.toContain('NPM_TOKEN');
    expect(verify).not.toContain('id-token: write');
    expect((verify.match(/npm ci/g) ?? []).length).toBe(1);
    expect((verify.match(/npm run bundle/g) ?? []).length).toBe(1);
    assertOrder('- run: npm run bundle', 'name: Run gates', verify);
    expect(verify).toContain('MAX_PARALLEL_GATES=2');
    for (const gate of ['run lint', 'run test', 'run typecheck', 'run dist', 'run integ', 'run actionlint']) {
      expect(verify).toContain(gate);
    }
    expect(verify).toContain('npm run verify:dist:assert');
    expect(verify).not.toMatch(/npm run verify:dist(?:\s|$)/);
    expect(verify).toContain('download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"');
    expect(verify).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(verify).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash',
    );
    expect(workflow).not.toContain('/main/scripts/download-actionlint.bash');
    expect(verify).not.toContain('actions/setup-go');
    expect(verify).not.toContain('go install github.com/rhysd/actionlint');
    assertOrder('node .github/scripts/prefetch-vendored-deps.mjs', '- run: npm ci', verify);
  });

  it('stages deterministic SEA allowlist, verifies before upload, and names artifacts by run identity', () => {
    const verify = job('verify-package');
    expect(verify).toContain("const paths = ['release.tgz', sea, `${sea}.sha256`]");
    expect(verify).toContain('node scripts/verify-release-artifacts.mjs release-artifacts');
    expect(verify).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(verify).toContain('release-artifacts/release.tgz');
    expect(verify).toContain('release-artifacts/release-manifest.json');
    expect(verify).toContain('release-artifacts/postman-bootstrap-*-linux-x64');
    expect(verify).toContain('release-artifacts/postman-bootstrap-*-linux-x64.sha256');
    assertOrder('node scripts/verify-release-artifacts.mjs release-artifacts', 'actions/upload-artifact@v7', verify);
    expect(verify).toContain('bash scripts/build-sea.sh');
    expect(verify).toContain('env -i PATH=/nonexistent');
    expect(verify).toContain('NODE_OPTIONS=--invalid-node-option');
    expect(verify).toContain(
      'node scripts/assert-sea-proxy.mjs "$BIN" bifrost-premium-https-v4.gw.postman.com:443 --project-name sea-proxy-smoke --spec-path tests/fixtures/e2e-spec.yaml --postman-access-token sea-proxy-smoke-token --credential-preflight warn --result-json "$PWD/sea-proxy-result.json"'
    );
    expect(verify).toContain('bifrost-premium-https-v4.gw.postman.com:443');
    expect(verify).toContain('--project-name sea-proxy-smoke');
    expect(verify).toContain('--spec-path tests/fixtures/e2e-spec.yaml');
    expect(verify).toContain('--postman-access-token sea-proxy-smoke-token');
    expect(verify).toContain('--credential-preflight warn');
    expect(verify).toContain('--result-json "$PWD/sea-proxy-result.json"');
    expect(verify).not.toContain('--result-json "$RUNNER_TEMP/sea-proxy-result.json"');
    expect(verify).toContain('cd "$(dirname "$BIN")"');
    expect(verify).toContain('shasum -a 256 "$(basename "$BIN")" > "$(basename "$BIN").sha256"');
    expect(verify).not.toMatch(/shasum -a 256 "\$BIN" > "\$BIN\.sha256"/);
  });

  it('keeps an artifact-only publisher with trusted inline verifier before secrets or mutation', () => {
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write/);
    expect(publish).toContain('actions/download-artifact@v8');
    expect(publish).toContain('name: release-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('npm run bundle');
    expect(publish).not.toMatch(/\bnpm pack\b/);
    expect(publish).not.toContain('npm test');
    expect(publish).not.toContain('node scripts/verify-release-artifacts.mjs');
    expect(publish).toContain("node --input-type=module - <<'TRUSTED_PUBLISHER_VERIFIER'");
    expect(publish).toContain('TRUSTED_PUBLISHER_VERIFIER');
    expect(publish).toContain('/^\\d+\\.\\d+\\.\\d+$/.test(manifest.package_version)');
    expect(publish).toContain('package_version must be strict numeric x.y.z');
    expect(publish).toContain('exact artifact allowlist mismatch');
    expect(publish).toContain('artifact must not be a symlink');
    expect(publish).toContain('SEA sidecar digest does not match executable and manifest');
    expect(publish).toContain('tarball package identity mismatch');
    assertOrder('name: Verify staged release artifacts', 'softprops/action-gh-release', publish);
    assertOrder('softprops/action-gh-release', 'id: npm-publish', publish);
    assertOrder('id: npm-publish', 'name: Verify npm registry identity', publish);
    assertOrder('name: Verify npm registry identity', 'name: Report npm publish skipped', publish);
    expect(publish).toMatch(/files: \|\n\s+release\.tgz\n\s+release-manifest\.json\n\s+postman-bootstrap-\*-linux-x64\n\s+postman-bootstrap-\*-linux-x64\.sha256/);
    expect(publish).not.toContain('release-artifacts/*');
    expect(publish.slice(0, publish.indexOf('id: npm-publish'))).not.toContain('NPM_TOKEN');
    expect(publish).toContain('outputs:\n      published: ${{ steps.npm-publish.outputs.published }}');
    expect(publish).toContain('continue-on-error: true');
    expect(publish).toContain("sed -i '/_authToken/d' \"${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}\"");
    expect(publish).not.toContain('NODE_AUTH_TOKEN');
    expect(publish).toContain('echo "published=false" >> "$GITHUB_OUTPUT"');
    expect(publish).toContain('echo "published=true" >> "$GITHUB_OUTPUT"');
    expect(publish).toContain("if: steps.npm-publish.outputs.published == 'true'");
    expect(publish).toContain("if: steps.npm-publish.outputs.published != 'true'");
  });

  it('soft-fails the npm attempt while hard-failing registry identity verification and keeps non-cancelling concurrency', () => {
    const publish = job('publish');
    expect(publish).toContain('npm view "$PKG_NAME@$PKG_VERSION" dist.integrity');
    expect(publish).toContain("createHash('sha512').update(readFileSync('release.tgz')).digest('base64')");
    expect(publish).toContain("grep -qE '^npm (error|ERR!) code E404'");
    expect(publish).toContain('npm view failed with a non-E404 error; refusing to publish or mutate GitHub');
    expect(publish).toContain('published npm integrity differs from staged tarball');
    assertOrder('softprops/action-gh-release', "createHash('sha512')", publish);
    expect(workflow).toContain('group: release-${{ github.repository }}');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('advances the major alias with fail-closed exact alias discovery, depth-1 fetch, and no immutable rewrite', () => {
    const alias = job('advance-major-alias');
    expect(alias).toContain('fetch-depth: 1');
    expect(alias).not.toContain('fetch-depth: 0');
    expect(alias).toContain('git ls-remote origin "refs/tags/$MAJOR"');
    expect(alias).toContain('REMOTE_MAJOR="$(git ls-remote origin "refs/tags/$MAJOR")"');
    expect(alias).toContain('if [ -n "$REMOTE_MAJOR" ]; then');
    expect(alias).toContain('git fetch --depth=1 origin "refs/tags/$MAJOR:refs/tags/$MAJOR"');
    expect(alias).not.toContain('|| true');
    expect(alias).not.toMatch(/git fetch[^\n]*\|\| true/);
    expect(alias).toContain("CANDIDATE_COMMIT=\"$(git rev-parse 'HEAD^{commit}')\"");
    expect(alias).toContain('git show "${MAJOR}^{commit}:package.json"');
    expect(alias).not.toContain('git show "$MAJOR:package.json"');
    expect(alias).toContain('git tag -fa "$MAJOR" -m "Rolling $MAJOR alias -> $GITHUB_REF_NAME" "$CANDIDATE_COMMIT"');
    expect(alias).not.toMatch(/git tag -fa[^\n]*"\$GITHUB_SHA"/);
    expect(alias).toContain('node scripts/compare-release-versions.mjs');
    expect(alias).toContain('Skipping alias update; candidate');
    expect(alias).toContain('refusing to force-update immutable tag shape');
    assertOrder("git rev-parse 'HEAD^{commit}'", 'git tag -fa "$MAJOR"', alias);
    assertOrder("git rev-parse 'HEAD^{commit}'", 'git push origin "refs/tags/$MAJOR" --force', alias);
    assertOrder('git ls-remote origin "refs/tags/$MAJOR"', 'git fetch --depth=1 origin "refs/tags/$MAJOR:refs/tags/$MAJOR"', alias);
    assertOrder('compare-release-versions.mjs', 'git push origin "refs/tags/$MAJOR" --force', alias);
    expect(alias).not.toContain('git merge-base --is-ancestor');
    expect(alias).toContain(
      'VERIFIED_E2E_MANIFEST_SHA256: ${{ needs.verify-release-e2e.outputs.manifest_sha256 }}'
    );
    expect(alias).toContain(
      'VERIFIED_E2E_PROVIDER_COMMIT: ${{ needs.verify-release-e2e.outputs.provider_commit }}'
    );
    expect(alias).toContain(
      'VERIFIED_E2E_PROVIDER_TAG: ${{ needs.verify-release-e2e.outputs.provider_tag }}'
    );
    expect(alias).toContain('[[ "$VERIFIED_E2E_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]');
    expect(alias).toContain("[ \"$VERIFIED_E2E_PROVIDER_TAG\" = 'e2e-provider-v1.2.0' ]");
    expect(alias).toContain(
      "[ \"$VERIFIED_E2E_PROVIDER_COMMIT\" = '53c5d10093b7dafb165d3caafbe3f1d70dec687d' ]"
    );
    expect(alias).toContain(
      'git ls-remote --exit-code --tags origin "$RELEASE_TAG_REF" "${RELEASE_TAG_REF}^{}"'
    );
    expect(alias).toContain('[ "$REMOTE_RELEASE_COMMIT" = "$GITHUB_SHA" ]');
    for (const validation of [
      '[[ "$VERIFIED_E2E_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]',
      "[ \"$VERIFIED_E2E_PROVIDER_TAG\" = 'e2e-provider-v1.2.0' ]",
      "[ \"$VERIFIED_E2E_PROVIDER_COMMIT\" = '53c5d10093b7dafb165d3caafbe3f1d70dec687d' ]",
      '[ "$REMOTE_RELEASE_COMMIT" = "$GITHUB_SHA" ]'
    ]) {
      assertOrder(validation, 'git tag -fa "$MAJOR"', alias);
      assertOrder(validation, 'git push origin "refs/tags/$MAJOR" --force', alias);
    }
  });

  it('awaits exact closed immutable-provider E2E evidence before the rolling alias', () => {
    const verifier = job('verify-release-e2e');
    expect(verifier).toContain('needs: [classify, verify-package, publish]');
    expect(verifier).not.toContain('continue-on-error');
    expect(verifier).toContain('E2E_GATE_MODE: enforce');
    expect(verifier).toContain('outcome: ${{ steps.verifier.outputs.e2e_outcome }}');
    expect(verifier).toContain('E2E_GATE_ACTION: postman-bootstrap-action');
    expect(verifier).toContain('E2E_GATE_SUITE: full');
    expect(verifier).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(verifier).toContain('E2E_GATE_RELEASE_COMMIT: ${{ github.sha }}');
    expect(verifier).toContain('E2E_GATE_SOURCE_DIGEST: ${{ needs.verify-package.outputs.release_tgz_sha256 }}');
    expect(verifier).toContain('E2E_GATE_PROVIDER_TAG: e2e-provider-v1.2.0');
    expect(verifier).toContain(
      'E2E_GATE_PROVIDER_COMMIT: 53c5d10093b7dafb165d3caafbe3f1d70dec687d'
    );
    expect(verifier).toContain(
      'E2E_GATE_PROVIDER_SOURCE_DIGEST: 8c7ee211fccd2869f3901fcbc5ed154d6dea8e3d0d7d2e5312f6c0b57b4f6b78'
    );
    expect(verifier).not.toContain('__FILL_PROVIDER_');
    expect(verifier).toContain(
      'E2E_GATE_PEER_TAGS: \'{"postman-cs/postman-api-onboarding-action":"v3.5.8","postman-cs/postman-insights-onboarding-action":"v2.5.2","postman-cs/postman-repo-sync-action":"v2.10.7","postman-cs/postman-resolve-service-token-action":"v2.2.4","postman-cs/postman-smoke-flow-action":"v3.7.4"}\''
    );
    expect(verifier).not.toContain('E2E_GATE_REGISTRY_REVISION');
    expect(verifier).not.toContain('E2E_GATE_CONTRACT_SCENARIOS');
    expect(verifier).not.toContain('E2E_GATE_WORKFLOW_REF: main');
    expect(verifier).toContain('manifest_sha256: ${{ steps.verifier.outputs.e2e_manifest_sha256 }}');
    expect(verifier).toContain('provider_commit: ${{ steps.verifier.outputs.e2e_provider_commit }}');
    expect(verifier).toContain('provider_tag: ${{ steps.verifier.outputs.e2e_provider_tag }}');
    expect(verifier).toContain('node .github/scripts/verify-e2e-release.mjs');
    expect(job('advance-major-alias')).toContain(
      'needs: [classify, verify-package, publish, verify-release-e2e]'
    );
    expect(workflow).toContain('workflow_dispatch: {}');
    expect(workflow).not.toContain('e2e_verification_mode');
    expect(workflow).not.toContain('report-only');
    expect(job('advance-major-alias')).toContain(
      "needs.verify-release-e2e.outputs.outcome == 'success'"
    );
  });

  it('dispatches sibling-release from release.yml after alias advance because workflow_run cascades never fire for GITHUB_TOKEN-created Release runs', () => {
    const notify = job('notify-composite');
    expect(notify).toContain(
      'needs: [classify, verify-package, publish, verify-release-e2e, advance-major-alias]'
    );
    expect(notify).toContain(
      "if: ${{ !cancelled() && needs.classify.outputs.release_kind == 'immutable' && needs.publish.result == 'success' && needs.verify-release-e2e.result == 'success' && needs.verify-release-e2e.outputs.outcome == 'success' && needs.advance-major-alias.result == 'success' }}"
    );
    expect(notify).toMatch(/permissions:\s*\{\}/);
    expect(notify).toContain('actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0');
    expect(notify).toContain('continue-on-error: true');
    expect(notify).toContain('app-id: ${{ secrets.SUITE_PIN_BOT_APP_ID }}');
    expect(notify).toContain('private-key: ${{ secrets.SUITE_PIN_BOT_PRIVATE_KEY }}');
    expect(notify).toContain('owner: postman-cs');
    expect(notify).toContain('repositories: postman-api-onboarding-action');
    expect(notify).toContain('event_type=sibling-release');
    expect(notify).toContain('client_payload[repository]=${GITHUB_REPOSITORY}');
    expect(notify).toContain(
      'client_payload[run]=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}'
    );
    expect(notify).toContain(
      "App token unavailable (secrets missing or mint failed); the composite's daily cron will pick this release up."
    );
    expect(notify).toContain('exit 0');
    expect(workflow).not.toContain('github.event.workflow_run');
  });
});

// ---------------------------------------------------------------------------
// Executable harness for the notify-composite "Dispatch sibling-release" shell.
//
// Instead of only text-inspecting the present/absent token branches, this
// extracts the actual `run:` body from release.yml, substitutes the GitHub
// Actions `${{ }}` expression literals with deterministic values that stand in
// for a real current run, and executes the *same* shell verbatim through bash
// with a stub `gh` shim on PATH. This proves observable dispatch / no-dispatch
// behaviour rather than reimplementing the logic in a helper.
// ---------------------------------------------------------------------------

/** Name of the step whose `run` body we extract and execute. */
const DISPATCH_STEP_NAME = 'Dispatch sibling-release to the composite';

/**
 * Extract the literal `run: |` block from a specific step within a job.
 * Mirrors the text-based extraction style used elsewhere in this file.
 */
function extractStepRunBody(jobName: string, stepName: string): string {
  const jobText = job(jobName);
  const lines = jobText.split('\n');
  let inStep = false;
  let inRun = false;
  const runLines: string[] = [];
  const stepRegex = new RegExp(
    `^      - name: ${stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
  );

  for (const line of lines) {
    if (!inStep && stepRegex.test(line)) {
      inStep = true;
      continue;
    }
    if (!inStep) continue;
    if (!inRun && /^ {8}run: \|/.test(line)) {
      inRun = true;
      continue;
    }
    if (inRun) {
      if (line.length === 0) {
        // Blank line could still be part of the run body (e.g. heredoc).
        runLines.push('');
      } else if (line.startsWith('          ')) {
        runLines.push(line.slice(10));
      } else {
        // De-indented line ends the run block.
        break;
      }
    }
  }
  return runLines.join('\n').trimEnd();
}

const ALIAS_STEP_NAME = 'Advance rolling major alias without regression';

interface AliasShellResult {
  exitCode: number;
  output: string;
  mutations: string[];
}

function executeAliasShell(overrides: Record<string, string> = {}): AliasShellResult {
  const tmpDir = mkdtempSync(join(tmpdir(), 'release-alias-'));
  const scriptPath = join(tmpDir, 'alias.sh');
  const mutationPrefix = '__ALIAS_GIT_MUTATION__:';
  const gitShim = `git() {
case "\${1:-}" in
  rev-parse) printf '%s\\n' "$GITHUB_SHA" ;;
  ls-remote)
    if [ "$#" -eq 6 ]; then
      printf '%s\\trefs/tags/%s\\n' "$GIT_STUB_RELEASE_TAG_OBJECT" "$GITHUB_REF_NAME"
      printf '%s\\trefs/tags/%s^{}\\n' "$GIT_STUB_RELEASE_COMMIT" "$GITHUB_REF_NAME"
    elif [[ " $* " == *" --exit-code "* ]]; then
      return 2
    fi
    ;;
  config) ;;
  tag|push) printf '${mutationPrefix}%s\\n' "$*" ;;
  *) printf 'unexpected git call: %s\\n' "$*" >&2; return 90 ;;
esac
}
`;
  // Git Bash prepends its own /mingw64/bin/git ahead of Windows PATH entries,
  // so only a shell function deterministically intercepts every git call.
  writeFileSync(
    scriptPath,
    `${gitShim}\n${extractStepRunBody('advance-major-alias', ALIAS_STEP_NAME)}`
  );
  try {
    const result = spawnSync('bash', ['--noprofile', '--norc', scriptPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BASH_ENV: '',
        ENV: '',
        GITHUB_REF_NAME: 'v9.9.9',
        GITHUB_SHA: 'a'.repeat(40),
        GIT_STUB_RELEASE_COMMIT: 'a'.repeat(40),
        GIT_STUB_RELEASE_TAG_OBJECT: '1'.repeat(40),
        VERIFIED_E2E_MANIFEST_SHA256: 'c'.repeat(64),
        VERIFIED_E2E_PROVIDER_COMMIT: '53c5d10093b7dafb165d3caafbe3f1d70dec687d',
        VERIFIED_E2E_PROVIDER_TAG: 'e2e-provider-v1.2.0',
        ...overrides,
      },
      timeout: 10_000,
    });
    const mutations = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith(mutationPrefix))
      .map((line) => line.slice(mutationPrefix.length).trim());
    return {
      exitCode: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      mutations,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('release alias evidence shell', () => {
  it('executes the exact alias step only after all evidence and tag checks pass', () => {
    const shell = extractStepRunBody('advance-major-alias', ALIAS_STEP_NAME);
    expect(shell).toContain('VERIFIED_E2E_MANIFEST_SHA256');
    const result = executeAliasShell();
    expect(result.exitCode).toBe(0);
    expect(result.mutations).toHaveLength(2);
    expect(result.mutations[0]).toMatch(/^tag -fa v\d+ /);
    expect(result.mutations[1]).toMatch(/^push origin refs\/tags\/v\d+ --force$/);
  });

  it.each([
    ['missing manifest', { VERIFIED_E2E_MANIFEST_SHA256: '' }, 'manifest digest'],
    ['non-lowercase manifest', { VERIFIED_E2E_MANIFEST_SHA256: 'C'.repeat(64) }, 'manifest digest'],
    ['provider tag mismatch', { VERIFIED_E2E_PROVIDER_TAG: 'e2e-provider-v9.9.9' }, 'provider tag mismatch'],
    ['provider commit mismatch', { VERIFIED_E2E_PROVIDER_COMMIT: 'f'.repeat(40) }, 'provider commit mismatch'],
    ['moved release tag', { GIT_STUB_RELEASE_COMMIT: 'e'.repeat(40) }, 'immutable release tag moved'],
  ])('fails closed on %s before any alias mutation', (_name, overrides, message) => {
    const result = executeAliasShell(overrides);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(message);
    expect(result.mutations).toEqual([]);
  });
});

/** Deterministic stand-ins for GitHub Actions context expressions. */
const DETERMINISTIC_REPO = 'postman-cs/postman-bootstrap-action';
const DETERMINISTIC_RUN_ID = '4242424242';
const DETERMINISTIC_SERVER_URL = 'https://github.com';
const EXPECTED_RUN_URL = `${DETERMINISTIC_SERVER_URL}/${DETERMINISTIC_REPO}/actions/runs/${DETERMINISTIC_RUN_ID}`;

/** Replace mutable GitHub expression literals with deterministic values. */
function substituteGithubExpressions(shell: string): string {
  return shell
    .replace(/\$\{\{\s*github\.server_url\s*\}\}/g, DETERMINISTIC_SERVER_URL)
    .replace(/\$\{\{\s*github\.repository\s*\}\}/g, DETERMINISTIC_REPO)
    .replace(/\$\{\{\s*github\.run_id\s*\}\}/g, DETERMINISTIC_RUN_ID);
}

interface DispatchShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  callLog: string;
}

/**
 * Execute the extracted (and expression-substituted) dispatch shell verbatim
 * through bash, with a stub `gh` on PATH that records each invocation.
 *
 * The stub captures `"$*"` (all args space-joined) — one line per call — into
 * the file named by $GH_STUB_CALLS so tests can assert call count and payload.
 */
function executeDispatchShell(ghToken: string): DispatchShellResult {
  const tmpDir = mkdtempSync(join(tmpdir(), 'release-dispatch-'));
  const callsLog = join(tmpDir, 'gh-calls.log');
  const stubPath = join(tmpDir, 'gh');
  const shellPath = join(tmpDir, 'dispatch.sh');

  try {
    // Stub gh: record each invocation, then exit 0.
    writeFileSync(
      stubPath,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$GH_STUB_CALLS"\nexit 0\n`,
    );
    chmodSync(stubPath, 0o755);

    // Write the real dispatch shell (expression-substituted) to a temp script.
    writeFileSync(shellPath, substituteGithubExpressions(extractStepRunBody('notify-composite', DISPATCH_STEP_NAME)));

    const result = spawnSync('bash', [shellPath], {
      env: {
        ...process.env,
        PATH: `${tmpDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
        GH_TOKEN: ghToken,
        GITHUB_REPOSITORY: DETERMINISTIC_REPO,
        GH_STUB_CALLS: callsLog,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });

    const callLog = existsSync(callsLog) ? readFileSync(callsLog, 'utf8').trim() : '';

    return {
      exitCode: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      callLog,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('notify-composite dispatch shell', () => {
  it('exits 0 and dispatches sibling-release when GH_TOKEN is present', () => {
    const { exitCode, callLog } = executeDispatchShell('test-app-token-value');
    expect(exitCode, 'shell must exit 0 when GH_TOKEN is present').toBe(0);

    const calls = callLog === '' ? [] : callLog.split('\n').filter(Boolean);
    expect(calls).toHaveLength(1);

    const call = calls[0]!;
    expect(call).toContain('api repos/postman-cs/postman-api-onboarding-action/dispatches');
    expect(call).toContain('event_type=sibling-release');
    expect(call).toContain(`client_payload[repository]=${DETERMINISTIC_REPO}`);
    expect(call).toContain(`client_payload[run]=${EXPECTED_RUN_URL}`);
  });

  it('exits 0, prints cron-backstop notice, and never calls gh when GH_TOKEN is empty', () => {
    const { exitCode, stdout, stderr, callLog } = executeDispatchShell('');
    expect(exitCode, 'shell must exit 0 when GH_TOKEN is absent').toBe(0);

    const output = stdout + stderr;
    expect(output).toContain('App token unavailable (secrets missing or mint failed)');
    expect(output).toContain("the composite's daily cron will pick this release up");
    expect(callLog).toBe('');
  });
});
