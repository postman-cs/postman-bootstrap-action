import { readFileSync } from 'node:fs';
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
    expect(job('dispatch-live-monitor')).toContain(
      "if: ${{ needs.verify-package.outputs.release_kind == 'immutable' && needs.publish.result == 'success' }}"
    );
    expect(job('advance-major-alias')).toContain(
      "if: ${{ !cancelled() && needs.verify-package.outputs.release_kind == 'immutable' && needs.publish.result == 'success' }}"
    );
  });

  it('uses unprivileged verify permissions, one bundle, exact gate set, and pinned actionlint', () => {
    const verify = job('verify-package');
    expect(verify).toMatch(/permissions:\n {6}contents: read/);
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
    expect(verify).not.toContain('actions/setup-go');
    expect(verify).not.toContain('go install github.com/rhysd/actionlint');
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
      'node scripts/assert-sea-proxy.mjs "$BIN" bifrost-premium-https-v4.gw.postman.com:443 --project-name sea-proxy-smoke --spec-path tests/fixtures/e2e-spec.yaml --postman-access-token sea-proxy-smoke-token --credential-preflight warn --result-json "$RUNNER_TEMP/sea-proxy-result.json"'
    );
    expect(verify).toContain('bifrost-premium-https-v4.gw.postman.com:443');
    expect(verify).toContain('--project-name sea-proxy-smoke');
    expect(verify).toContain('--spec-path tests/fixtures/e2e-spec.yaml');
    expect(verify).toContain('--postman-access-token sea-proxy-smoke-token');
    expect(verify).toContain('--credential-preflight warn');
    expect(verify).toContain('--result-json "$RUNNER_TEMP/sea-proxy-result.json"');
    expect(verify).toContain('cd "$(dirname "$BIN")"');
    expect(verify).toContain('shasum -a 256 "$(basename "$BIN")" > "$(basename "$BIN").sha256"');
    expect(verify).not.toMatch(/shasum -a 256 "\$BIN" > "\$BIN\.sha256"/);
  });

  it('keeps an artifact-only publisher with trusted inline verifier before secrets or mutation', () => {
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n {6}contents: write\n {6}id-token: write/);
    expect(publish).toContain('actions/download-artifact@v7');
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
    assertOrder('name: Verify staged release artifacts', 'NODE_AUTH_TOKEN', publish);
    assertOrder('name: Verify staged release artifacts', 'npm publish ./release.tgz', publish);
    assertOrder('npm publish ./release.tgz --provenance --access public', 'softprops/action-gh-release', publish);
    expect(publish).toContain('release.tgz\n            release-manifest.json\n            postman-bootstrap-*-linux-x64\n            postman-bootstrap-*-linux-x64.sha256');
    expect(publish).not.toContain('release-artifacts/*');
  });

  it('fail-closes npm lookup on non-E404, computes SRI before GitHub, and keeps non-cancelling concurrency', () => {
    const publish = job('publish');
    expect(publish).toContain('npm view "$PKG_NAME@$PKG_VERSION" dist.integrity');
    expect(publish).toContain("createHash('sha512').update(readFileSync('release.tgz')).digest('base64')");
    expect(publish).toContain("grep -qE '^npm (error|ERR!) code E404'");
    expect(publish).toContain('npm view failed with a non-E404 error; refusing to publish or mutate GitHub');
    expect(publish).toContain('published npm integrity differs from staged tarball');
    assertOrder("createHash('sha512')", 'softprops/action-gh-release', publish);
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
  });

  it('preserves the async monitor ref and smoke suite', () => {
    const monitor = job('dispatch-live-monitor');
    expect(monitor).toContain('continue-on-error: true');
    expect(monitor).toContain('E2E_GATE_SUITE: smoke');
    expect(monitor).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(monitor).toContain('node .github/scripts/dispatch-e2e-monitor.mjs');
  });
});
