import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BRANCH_DECISION_ENV,
  buildBranchSlug,
  channelAssetName,
  parseAssetMarker,
  parseBranchDecision,
  parseChannelRules,
  previewAssetName,
  renderAssetMarker,
  resolveBranchDecision,
  resolveBranchIdentity,
  resolveEffectiveBranchDecision,
  serializeBranchDecision,
  PREVIEW_SLUG_MAX,
  type AssetMarker,
  type BranchIdentity
} from '../src/lib/repo/branch-decision.js';
import { embedSpecBranchMarker } from '../src/index.js';

function githubEventFile(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bd-test-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe('identity-ref resolution table (provider x trigger)', () => {
  describe('github', () => {
    it('push: uses GITHUB_REF, strips refs/heads/', () => {
      const id = resolveBranchIdentity({
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/feature/x',
        GITHUB_SHA: 'abc123'
      });
      expect(id.provider).toBe('github');
      expect(id.headBranch).toBe('feature/x');
      expect(id.refKind).toBe('branch');
      expect(id.isPrContext).toBe(false);
    });

    it('pull_request: GITHUB_HEAD_REF wins over N/merge ref', () => {
      const id = resolveBranchIdentity({
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/pull/42/merge',
        GITHUB_REF_NAME: '42/merge',
        GITHUB_HEAD_REF: 'feature/x'
      });
      expect(id.headBranch).toBe('feature/x');
      expect(id.isPrContext).toBe(true);
      expect(id.refKind).toBe('branch');
    });

    it('pull_request from fork: isForkPr true from event payload', () => {
      const eventPath = githubEventFile({
        repository: { default_branch: 'main', full_name: 'org/base' },
        pull_request: {
          head: { ref: 'feature/x', sha: 'headsha', repo: { full_name: 'stranger/fork' } },
          base: { repo: { full_name: 'org/base' } }
        }
      });
      const id = resolveBranchIdentity({
        GITHUB_ACTIONS: 'true',
        GITHUB_HEAD_REF: 'feature/x',
        GITHUB_EVENT_PATH: eventPath
      });
      expect(id.isForkPr).toBe(true);
      expect(id.defaultBranch).toBe('main');
      expect(id.headSha).toBe('headsha');
    });

    it('tag push: refKind tag, no headBranch', () => {
      const id = resolveBranchIdentity({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/tags/v1.2.3' });
      expect(id.refKind).toBe('tag');
      expect(id.headBranch).toBeUndefined();
    });

    it('default branch push: refKind default-branch via event payload', () => {
      const eventPath = githubEventFile({ repository: { default_branch: 'main' } });
      const id = resolveBranchIdentity({
        GITHUB_ACTIONS: 'true',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_PATH: eventPath
      });
      expect(id.refKind).toBe('default-branch');
      expect(id.defaultBranch).toBe('main');
    });
  });

  describe('gitlab', () => {
    it('branch pipeline: CI_COMMIT_BRANCH', () => {
      const id = resolveBranchIdentity({
        GITLAB_CI: 'true',
        CI_COMMIT_BRANCH: 'feature/x',
        CI_DEFAULT_BRANCH: 'main'
      });
      expect(id.provider).toBe('gitlab');
      expect(id.headBranch).toBe('feature/x');
      expect(id.defaultBranch).toBe('main');
    });

    it('MR pipeline: CI_MERGE_REQUEST_SOURCE_BRANCH_NAME wins', () => {
      const id = resolveBranchIdentity({
        GITLAB_CI: 'true',
        CI_COMMIT_REF_NAME: 'refs/merge-requests/7/head',
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feature/x',
        CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '1',
        CI_MERGE_REQUEST_PROJECT_ID: '1'
      });
      expect(id.headBranch).toBe('feature/x');
      expect(id.isPrContext).toBe(true);
      expect(id.isForkPr).toBe(false);
    });

    it('cross-project MR: isForkPr', () => {
      const id = resolveBranchIdentity({
        GITLAB_CI: 'true',
        CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: 'feature/x',
        CI_MERGE_REQUEST_SOURCE_PROJECT_ID: '2',
        CI_MERGE_REQUEST_PROJECT_ID: '1'
      });
      expect(id.isForkPr).toBe(true);
    });

    it('tag pipeline: CI_COMMIT_TAG', () => {
      const id = resolveBranchIdentity({ GITLAB_CI: 'true', CI_COMMIT_TAG: 'v1.0.0' });
      expect(id.refKind).toBe('tag');
    });
  });

  describe('bitbucket', () => {
    it('branch build: BITBUCKET_BRANCH', () => {
      const id = resolveBranchIdentity({ BITBUCKET_REPO_SLUG: 'r', BITBUCKET_BRANCH: 'feature/x' });
      expect(id.provider).toBe('bitbucket');
      expect(id.headBranch).toBe('feature/x');
      expect(id.defaultBranch).toBeUndefined();
    });

    it('PR build: BITBUCKET_PR_ID marks PR context, branch is the source', () => {
      const id = resolveBranchIdentity({
        BITBUCKET_REPO_SLUG: 'r',
        BITBUCKET_BRANCH: 'feature/x',
        BITBUCKET_PR_ID: '9'
      });
      expect(id.isPrContext).toBe(true);
      expect(id.headBranch).toBe('feature/x');
    });

    it('tag build: BITBUCKET_TAG', () => {
      const id = resolveBranchIdentity({ BITBUCKET_REPO_SLUG: 'r', BITBUCKET_TAG: 'v2' });
      expect(id.refKind).toBe('tag');
    });
  });

  describe('azure-devops', () => {
    it('branch build: full BUILD_SOURCEBRANCH, never the last-segment name', () => {
      const id = resolveBranchIdentity({
        TF_BUILD: 'True',
        BUILD_SOURCEBRANCH: 'refs/heads/feature/x',
        BUILD_SOURCEBRANCHNAME: 'x'
      });
      expect(id.provider).toBe('azure-devops');
      expect(id.headBranch).toBe('feature/x');
    });

    it('PR build: SYSTEM_PULLREQUEST_SOURCEBRANCH stripped; fork flag honored', () => {
      const id = resolveBranchIdentity({
        TF_BUILD: 'True',
        BUILD_SOURCEBRANCH: 'refs/pull/12/merge',
        SYSTEM_PULLREQUEST_SOURCEBRANCH: 'refs/heads/feature/x',
        SYSTEM_PULLREQUEST_ISFORK: 'True'
      });
      expect(id.headBranch).toBe('feature/x');
      expect(id.isPrContext).toBe(true);
      expect(id.isForkPr).toBe(true);
    });

    it('tag build: refs/tags parsed as tag', () => {
      const id = resolveBranchIdentity({ TF_BUILD: 'True', BUILD_SOURCEBRANCH: 'refs/tags/v3' });
      expect(id.refKind).toBe('tag');
    });
  });

  it('unknown provider: refKind unknown, nothing resolved', () => {
    const id = resolveBranchIdentity({});
    expect(id.provider).toBe('unknown');
    expect(id.refKind).toBe('unknown');
  });
});

function identity(overrides: Partial<BranchIdentity>): BranchIdentity {
  return {
    provider: 'github',
    refKind: 'branch',
    isPrContext: false,
    isForkPr: false,
    ...overrides
  };
}

describe('resolveBranchDecision', () => {
  it('legacy: always legacy tier, never throws on unresolved default', () => {
    const d = resolveBranchDecision({
      strategy: 'legacy',
      identity: identity({ headBranch: 'anything' })
    });
    expect(d.tier).toBe('legacy');
  });

  it('non-legacy without canonical branch: fail loud, never guess main', () => {
    expect(() =>
      resolveBranchDecision({
        strategy: 'publish-gate',
        identity: identity({ headBranch: 'feature/x', provider: 'bitbucket' })
      })
    ).toThrowError(/CONTRACT_DEFAULT_BRANCH_UNRESOLVED/);
  });

  it('canonical: head branch equals canonical branch', () => {
    const d = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'main', defaultBranch: 'main', refKind: 'default-branch' })
    });
    expect(d.tier).toBe('canonical');
  });

  it('explicit canonical-branch input overrides provider default', () => {
    const d = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'trunk', defaultBranch: 'main' }),
      canonicalBranch: 'trunk'
    });
    expect(d.tier).toBe('canonical');
  });

  it('channel: explicit mapping wins over preview/gate', () => {
    const d = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ headBranch: 'develop', defaultBranch: 'main' }),
      channels: parseChannelRules('develop=DEV, staging=STAGE')
    });
    expect(d.tier).toBe('channel');
    expect(d.channel?.code).toBe('DEV');
  });

  it('channel glob: release/* -> RC', () => {
    const d = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'release/1.4', defaultBranch: 'main' }),
      channels: parseChannelRules('release/*=RC')
    });
    expect(d.tier).toBe('channel');
    expect(d.channel?.code).toBe('RC');
  });

  it('preview: non-matching branch under preview strategy', () => {
    const d = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ headBranch: 'feature/x', defaultBranch: 'main' })
    });
    expect(d.tier).toBe('preview');
  });

  it('fork PR under preview: gated (same-repo rule)', () => {
    const d = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ headBranch: 'feature/x', defaultBranch: 'main', isForkPr: true, isPrContext: true })
    });
    expect(d.tier).toBe('gated');
  });

  it('publish-gate: non-canonical branch gated', () => {
    const d = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'feature/x', defaultBranch: 'main' })
    });
    expect(d.tier).toBe('gated');
  });

  it('tag ref: gated no-op under any non-legacy strategy', () => {
    const d = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ refKind: 'tag', headBranch: undefined, defaultBranch: 'main' })
    });
    expect(d.tier).toBe('gated');
  });
});

describe('channels input parsing', () => {
  it('parses map entries and uppercases codes', () => {
    const rules = parseChannelRules('develop=dev, release/*=rc');
    expect(rules).toEqual([
      { pattern: 'develop', code: 'DEV' },
      { pattern: 'release/*', code: 'RC' }
    ]);
  });

  it('rejects malformed entries loud', () => {
    expect(() => parseChannelRules('develop')).toThrowError(/CONTRACT_CHANNELS_INPUT_INVALID/);
    expect(() => parseChannelRules('=DEV')).toThrowError(/CONTRACT_CHANNELS_INPUT_INVALID/);
    expect(() => parseChannelRules('develop=d!v')).toThrowError(/CONTRACT_CHANNELS_INPUT_INVALID/);
  });

  it('empty/undefined -> no rules', () => {
    expect(parseChannelRules(undefined)).toEqual([]);
    expect(parseChannelRules('')).toEqual([]);
  });
});

describe('serialized decision hand-off', () => {
  it('round-trips through env', () => {
    const d = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ headBranch: 'feature/x', defaultBranch: 'main' })
    });
    const parsed = parseBranchDecision(serializeBranchDecision(d));
    expect(parsed).toEqual(d);
  });

  it('inherited decision wins over local resolution', () => {
    const inherited = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'feature/x', defaultBranch: 'main' })
    });
    const effective = resolveEffectiveBranchDecision(
      {
        strategy: 'legacy',
        identity: identity({ headBranch: 'other', defaultBranch: 'main' })
      },
      { [BRANCH_DECISION_ENV]: serializeBranchDecision(inherited) }
    );
    expect(effective).toEqual(inherited);
  });

  it('malformed env decision fails loud', () => {
    expect(() => parseBranchDecision('{not json')).toThrowError(/CONTRACT_BRANCH_DECISION_INVALID/);
    expect(() => parseBranchDecision('{"tier":"nope"}')).toThrowError(/CONTRACT_BRANCH_DECISION_INVALID/);
  });
});

describe('preview slug + naming', () => {
  it('clean short branch: no hash', () => {
    const s = buildBranchSlug('feature-x');
    expect(s).toEqual({ suffix: 'feature-x', slug: 'feature-x', lossy: false });
  });

  it('sanitization lossy: a/b vs a-b get distinct hashes', () => {
    const slash = buildBranchSlug('a/b');
    const dash = buildBranchSlug('a-b');
    expect(slash.suffix).not.toBe(dash.suffix);
    expect(slash.lossy).toBe(true);
    expect(dash.lossy).toBe(false);
  });

  it('two refs differing only past the cap get distinct suffixes', () => {
    const base = 'feature/payments-service-refactor-phase';
    const one = buildBranchSlug(`${base}-1`);
    const two = buildBranchSlug(`${base}-2`);
    expect(one.slug).toBe(two.slug);
    expect(one.suffix).not.toBe(two.suffix);
    expect(one.slug.length).toBeLessThanOrEqual(PREVIEW_SLUG_MAX);
  });

  it('refs/heads/ prefix is stripped before slugging', () => {
    expect(buildBranchSlug('refs/heads/feature-x').suffix).toBe('feature-x');
  });

  it('asset name builders', () => {
    expect(previewAssetName('[Smoke] Payments', 'feature-x')).toBe('[Smoke] Payments @feature-x');
    expect(channelAssetName('[Smoke] Payments', 'DEV')).toBe('[DEV] [Smoke] Payments');
  });
});

describe('asset markers', () => {
  const marker: AssetMarker = {
    repo: 'https://github.com/org/repo',
    rawBranch: 'feature/x',
    sanitizedBranch: 'feature-x',
    role: 'preview',
    headSha: 'abc',
    createdAt: '2026-07-14T00:00:00Z',
    lastSyncedAt: '2026-07-14T00:00:00Z',
    expiresAt: '2026-08-13T00:00:00Z'
  };

  it('round-trips through a description with trailing prose', () => {
    const description = `Generated set.\n${renderAssetMarker(marker)}\nDo not edit.`;
    expect(parseAssetMarker(description)).toEqual(marker);
  });

  it('missing marker -> undefined (stranger)', () => {
    expect(parseAssetMarker('just a description')).toBeUndefined();
    expect(parseAssetMarker(undefined)).toBeUndefined();
  });

  it('malformed marker JSON -> undefined (stranger, never guessed)', () => {
    expect(parseAssetMarker('x-pm-onboarding: {broken')).toBeUndefined();
  });

  it('retirement fields survive the round-trip', () => {
    const retired: AssetMarker = {
      ...marker,
      role: 'channel',
      retirementDetectedAt: '2026-07-20T00:00:00Z',
      retirementReason: 'mapping-removed',
      deleteAfter: '2026-08-19T00:00:00Z'
    };
    expect(parseAssetMarker(renderAssetMarker(retired))).toEqual(retired);
  });
});

describe('durable spec marker', () => {
  it('embeds x-postman-onboarding in preview OpenAPI content without changing canonical content', () => {
    const preview = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ headBranch: 'feature/payments', defaultBranch: 'main' })
    });
    const source = 'openapi: 3.0.3\ninfo:\n  title: Payments\n  version: 1.0.0\npaths: {}\n';

    const marked = embedSpecBranchMarker(source, preview, 'https://github.com/org/repo');
    expect(marked).toContain('x-postman-onboarding:');
    expect(marked).toContain('rawBranch: feature/payments');

    const canonical = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'main', defaultBranch: 'main', refKind: 'default-branch' })
    });
    expect(embedSpecBranchMarker(source, canonical, 'https://github.com/org/repo')).toBe(source);
  });
});
