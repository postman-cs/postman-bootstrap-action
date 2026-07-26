/**
 * Automatic release-cut contract.
 *
 * Pins the invariants whose absence burned v2.10.26: a receipt that is not a
 * valid 40-char sha must never reach a tag, a receipt edit that skips the dist
 * rebuild must fail before tagging, and a burnt version number must be skipped
 * rather than reused.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- release tooling is plain ESM, intentionally outside tsconfig source roots
import * as releaseCut from '../scripts/release-cut.mjs';
// @ts-expect-error -- probe script is plain ESM
import * as probeModule from '../scripts/probe-multifile-spec-sync.mjs';

const parseConventionalBump = releaseCut.parseConventionalBump as (m: string[]) => string | null;
const applyBump = releaseCut.applyBump as (v: string, b: string) => string;
const selectNextVersion = releaseCut.selectNextVersion as (input: {
  current: string;
  bump: string;
  takenTags: string[];
}) => { version: string; skipped: string[] };
const latestReleaseTag = releaseCut.latestReleaseTag as (tags: string[]) => string | null;
const validateMultifileSpecSyncReceipt = probeModule.validateMultifileSpecSyncReceipt as (
  receipt: unknown
) => unknown;

const repoRoot = process.cwd();
const autoReleaseWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/auto-release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const releaseCutSource = readFileSync(join(repoRoot, 'scripts/release-cut.mjs'), 'utf8');
const committedReceipt = JSON.parse(
  readFileSync(join(repoRoot, 'validation/evidence/multifile-spec-sync.json'), 'utf8')
) as Record<string, unknown>;

describe('release version selection', () => {
  it('skips a burnt version instead of reusing it', () => {
    // v2.10.26 was tagged then failed its gates. Release tags are immutable,
    // so the next cut must move past it.
    const plan = selectNextVersion({
      current: '2.10.25',
      bump: 'patch',
      takenTags: ['v2.10.25', 'v2.10.26']
    });
    expect(plan.version).toBe('2.10.27');
    expect(plan.skipped).toContain('2.10.26');
  });

  it('never returns a version that is already tagged', () => {
    const taken = ['v3.0.0', 'v3.0.1', 'v3.0.2', 'v3.0.3'];
    const plan = selectNextVersion({ current: '3.0.0', bump: 'patch', takenTags: taken });
    expect(taken).not.toContain(`v${plan.version}`);
    expect(plan.version).toBe('3.0.4');
  });

  it('normalizes accepted zero-patch minor tags', () => {
    expect(latestReleaseTag(['v2.9.9', 'v3.0', 'v3'])).toBe('v3.0');
    expect(
      selectNextVersion({ current: '2.9.9', bump: 'major', takenTags: ['v3.0'] })
    ).toEqual({ version: '3.0.1', skipped: ['3.0.0'] });
  });

  it('maps conventional commits onto semver bumps', () => {
    expect(parseConventionalBump(['feat: add input'])).toBe('minor');
    expect(parseConventionalBump(['fix: correct reconcile'])).toBe('patch');
    expect(parseConventionalBump(['feat!: drop legacy input'])).toBe('major');
    expect(parseConventionalBump(['refactor: x\n\nBREAKING CHANGE: removed'])).toBe('major');
    expect(parseConventionalBump(['feat: a', 'fix: b'])).toBe('minor');
    expect(applyBump('2.10.27', 'minor')).toBe('2.11.0');
  });

  it('does not cut a release for release-plumbing commits alone', () => {
    // Otherwise every cut would immediately trigger another cut.
    expect(parseConventionalBump(['chore(release): v2.10.27'])).toBeNull();
    expect(parseConventionalBump(['chore: rebind multifile receipt to source'])).toBeNull();
    expect(parseConventionalBump(['ci: retune gate queue', 'test: add case'])).toBeNull();
    expect(parseConventionalBump([])).toBeNull();
  });
});

describe('receipt integrity gate', () => {
  it('rejects the undefined bootstrapCommit that burned v2.10.26', () => {
    const broken = { ...committedReceipt, bootstrapCommit: undefined };
    expect(() => validateMultifileSpecSyncReceipt(broken)).toThrow(/bootstrapCommit/);
  });

  it('rejects a bootstrapCommit that is not a 40-char lowercase sha', () => {
    for (const value of ['undefined', '', 'HEAD', 'A'.repeat(40), 'abc123']) {
      expect(() =>
        validateMultifileSpecSyncReceipt({ ...committedReceipt, bootstrapCommit: value })
      ).toThrow(/bootstrapCommit/);
    }
  });

  it('accepts the committed receipt', () => {
    expect(() => validateMultifileSpecSyncReceipt(committedReceipt)).not.toThrow();
  });
});

describe('release-cut ordering contract', () => {
  it('creates the tag only after the committed release bytes are verified', () => {
    const tagIndex = releaseCutSource.indexOf("'tag', '-a'");
    const commitIndex = releaseCutSource.indexOf("'commit', '-m'");
    const verifyAfterCommit = releaseCutSource.indexOf('const releaseCommit');
    expect(tagIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    // Tagging is the final side effect: commit, then re-verify, then tag.
    expect(commitIndex).toBeLessThan(verifyAfterCommit);
    expect(verifyAfterCommit).toBeLessThan(tagIndex);
    expect(releaseCutSource.indexOf('assertReceiptIntegrity({ headCommit: releaseCommit })')).toBeLessThan(
      tagIndex
    );
  });

  it('reads every sha in-process rather than through shell variables', () => {
    // The v2.10.26 receipt was written from an unexported PREPARE_SHA.
    expect(releaseCutSource).not.toContain('PREPARE_SHA');
    expect(releaseCutSource).toContain("git(['rev-parse', 'HEAD'])");
  });

  it('rebuilds dist before committing and verifies committed dist before tagging', () => {
    // verify:dist:assert diffs against committed dist, so it only means
    // anything after the release commit exists.
    expect(releaseCutSource).toContain("run('npm', ['run', 'bundle'])");
    const rebuild = releaseCutSource.indexOf('rebuildDist();');
    const commit = releaseCutSource.indexOf("'commit', '-m'");
    const assertDist = releaseCutSource.indexOf('assertCommittedDistMatchesSource();');
    const tag = releaseCutSource.indexOf("'tag', '-a'");
    expect(rebuild).toBeGreaterThan(-1);
    expect(rebuild).toBeLessThan(commit);
    expect(commit).toBeLessThan(assertDist);
    expect(assertDist).toBeLessThan(tag);
  });
});

describe('receipt auto-heal on the release path', () => {
  const planRebind = releaseCut as unknown as {
    normalizeReceipt: unknown;
  };

  it('normalizes a stale receipt instead of stalling the release train', () => {
    // ci.yml only normalizes on pull requests. Without this the release path
    // would deadlock on any commit that reached main another way.
    expect(typeof planRebind.normalizeReceipt).toBe('function');
    expect(releaseCutSource).toContain('planMultifileReceiptRebind');
  });

  it('normalizes before it asserts, and asserts before it tags', () => {
    const normalize = releaseCutSource.indexOf('normalizeReceipt({ headCommit: sourceCommit })');
    const assertSource = releaseCutSource.indexOf('assertReceiptIntegrity({ headCommit: sourceCommit })');
    const tag = releaseCutSource.indexOf("'tag', '-a'");
    expect(normalize).toBeGreaterThan(-1);
    expect(normalize).toBeLessThan(assertSource);
    expect(assertSource).toBeLessThan(tag);
  });

  it('reuses the audited planner rather than writing the receipt freehand', () => {
    // The planner requires ancestry and refuses to alter live evidence, so
    // the auto-heal can only restate which revision the evidence covers.
    expect(releaseCutSource).toContain("import { planMultifileReceiptRebind }");
    expect(releaseCutSource).not.toMatch(/bootstrapCommit:\s*headCommit/);
  });
});

describe('auto-release workflow', () => {
  it('cuts from main pushes instead of hand-pushed tags', () => {
    expect(autoReleaseWorkflow).toContain('branches: [main]');
    expect(autoReleaseWorkflow).not.toMatch(/on:\n\s+push:\n\s+tags:/);
  });

  it('rejects manually dispatched cuts outside main', () => {
    expect(autoReleaseWorkflow).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('fetches full history and tags so burnt versions are visible', () => {
    expect(autoReleaseWorkflow).toContain('fetch-depth: 0');
    expect(autoReleaseWorkflow).toContain('fetch-tags: true');
  });

  it('plans before it cuts and cuts before it pushes', () => {
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    const cut = autoReleaseWorkflow.indexOf('name: Cut release');
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(cut);
    expect(cut).toBeLessThan(push);
  });

  it('pushes only the tag, never a commit onto protected main', () => {
    // main requires pull requests; the release commit is reachable from the
    // tag, which is the ref release.yml reads.
    expect(autoReleaseWorkflow).toContain('git push origin "refs/tags/v${VERSION}"');
    expect(autoReleaseWorkflow).not.toContain('HEAD:${GITHUB_REF_NAME}');
  });

  it('carries the normalized receipt back to the branch it cut from', () => {
    // The cut normalizes the receipt onto the release commit, which is only
    // reachable from the tag. Without this step the branch keeps the older
    // binding and its own receipt contract test stays red until an unrelated
    // pull request happens to normalize it.
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    const dispatch = autoReleaseWorkflow.indexOf('name: Start or recover release workflow');
    const backport = autoReleaseWorkflow.indexOf('name: Open receipt normalization pull request');
    expect(backport).toBeGreaterThan(push);
    expect(dispatch).toBeGreaterThan(push);
    expect(dispatch).toBeLessThan(backport);
    expect(autoReleaseWorkflow).toContain('gh pr create');
    expect(autoReleaseWorkflow).toContain('--base "${GITHUB_REF_NAME}"');
  });

  it('dispatches checks for the token-created receipt pull request', () => {
    const create = autoReleaseWorkflow.indexOf('gh pr create');
    const ci = autoReleaseWorkflow.indexOf('gh workflow run ci.yml --ref "$BRANCH"');
    const sea = autoReleaseWorkflow.indexOf('gh workflow run sea-binary.yml --ref "$BRANCH"');
    expect(ci).toBeGreaterThan(create);
    expect(sea).toBeGreaterThan(create);
  });

  it('recovers the newest unpublished tag after a dispatch failure', () => {
    expect(autoReleaseWorkflow).toContain('name: Start or recover release workflow');
    expect(autoReleaseWorkflow).toContain('require(process.env.PLAN_FILE).previous');
    expect(autoReleaseWorkflow).toContain('gh release view "$TAG"');
    expect(autoReleaseWorkflow).toContain('gh workflow run release.yml --ref "$TAG"');
  });

  it('reconciles the prior incomplete tag before planning another cut', () => {
    const reconcile = autoReleaseWorkflow.indexOf('name: Reconcile prior release');
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    expect(reconcile).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(plan);
    expect(autoReleaseWorkflow).toContain("git tag --list 'v*'");
    expect(autoReleaseWorkflow).toContain('if ! PACKAGE_VERSION="$(git show');
    expect(autoReleaseWorkflow).toContain('gh run list --workflow release.yml --branch "$TAG"');
    expect(autoReleaseWorkflow).toContain("steps.reconcile.outputs.blocked != 'true'");
    const activeRun = autoReleaseWorkflow.indexOf('gh run list --workflow release.yml');
    expect(autoReleaseWorkflow.indexOf('gh workflow run release.yml', activeRun)).toBeGreaterThan(
      activeRun
    );
  });

  it('recovers alias failures and resumes after a successful release', () => {
    expect(autoReleaseWorkflow).toContain('workflow_run:');
    expect(autoReleaseWorkflow).toContain('workflows: [Release]');
    expect(autoReleaseWorkflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(autoReleaseWorkflow).toContain('git rev-parse --verify "${ALIAS}^{commit}"');
  });

  it('retries the receipt backport from the immutable tag', () => {
    expect(autoReleaseWorkflow).toContain('RELEASE_COMMIT="$(git rev-parse "${TAG}^{commit}")"');
    expect(autoReleaseWorkflow).toContain(
      'git diff --quiet "origin/${GITHUB_REF_NAME}" "$RELEASE_COMMIT" -- validation/evidence/multifile-spec-sync.json'
    );
    expect(autoReleaseWorkflow).toContain(
      'git push origin "${RELEASE_COMMIT}:refs/heads/${BRANCH}"'
    );
  });

  it('grants the cut the write scope its backport pull request needs', () => {
    expect(autoReleaseWorkflow).toContain('pull-requests: write');
  });

  it('skips the backport when the receipt already matches the branch', () => {
    expect(autoReleaseWorkflow).toContain(
      'git diff --quiet "origin/${GITHUB_REF_NAME}" "$RELEASE_COMMIT" -- validation/evidence/multifile-spec-sync.json'
    );
  });

  it('never cancels a cut in flight', () => {
    expect(autoReleaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('writes its plan outside the worktree so the cut sees a clean tree', () => {
    // A plan artifact inside the repo trips the clean-tree guard and blocks
    // every release.
    expect(autoReleaseWorkflow).not.toMatch(/tee plan\.json/);
    expect(autoReleaseWorkflow).toContain('PLAN_FILE: ${{ runner.temp }}/plan.json');
  });
});
