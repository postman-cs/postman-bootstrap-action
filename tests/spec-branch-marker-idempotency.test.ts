import { describe, expect, it } from 'vitest';
import { embedSpecBranchMarker } from '../src/index.js';
import { resolveBranchDecision } from '../src/lib/repo/branch-decision.js';

/**
 * The branch marker is embedded in the bytes uploaded to Spec Hub, so its
 * timestamps decide whether a rerun is digest-equal. Restamping them on every
 * run made the "spec content unchanged" skip unreachable: every rerun wrote a
 * spec whose only diff was the marker clock, and `createdAt` (the branch
 * generation identity preview GC keys off) was reset each time.
 */

const identity = (over: Record<string, unknown> = {}) => ({
  headBranch: 'feature/x',
  defaultBranch: 'main',
  refKind: 'branch' as const,
  headSha: 'abc123',
  ...over
});

const source = 'openapi: 3.0.3\ninfo:\n  title: P\n  version: 1.0.0\npaths: {}\n';
const repo = 'https://github.com/org/repo';
const AGED = '2020-01-02T03:04:05.000Z';

const field = (content: string, key: string): string =>
  new RegExp(`${key}: "?([^"\\s]+)"?`).exec(content)![1];

/** Stored spec whose marker carries a distinctly old generation timestamp. */
const agedStored = (rawBranch: string, markerRepo: string): string =>
  `${source}x-postman-onboarding:\n` +
  `  repo: ${markerRepo}\n` +
  `  rawBranch: ${rawBranch}\n` +
  `  sanitizedBranch: ${rawBranch.replace(/[^A-Za-z0-9._-]+/g, '-')}\n` +
  '  role: preview\n' +
  '  headSha: abc123\n' +
  `  createdAt: "${AGED}"\n` +
  `  lastSyncedAt: "${AGED}"\n`;

describe('spec branch marker rerun idempotency', () => {
  const preview = resolveBranchDecision({
    strategy: 'preview',
    identity: identity() as never
  });

  it('rerun with unchanged source reproduces the stored bytes exactly', async () => {
    const stored = embedSpecBranchMarker(source, preview, repo);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(embedSpecBranchMarker(source, preview, repo, stored)).toBe(stored);
  });

  it('changed source slides lastSyncedAt forward but preserves createdAt', () => {
    const aged = agedStored('feature/x', repo);
    const next = embedSpecBranchMarker(
      source.replace('version: 1.0.0', 'version: 1.0.1'),
      preview,
      repo,
      aged
    );
    expect(field(next, 'createdAt')).toBe(AGED);
    expect(field(next, 'lastSyncedAt')).not.toBe(AGED);
    expect(next).toContain('version: 1.0.1');
  });

  it('a different branch never inherits the stored generation identity', () => {
    const other = resolveBranchDecision({
      strategy: 'preview',
      identity: identity({ headBranch: 'feature/y' }) as never
    });
    const next = embedSpecBranchMarker(source, other, repo, agedStored('feature/x', repo));
    expect(field(next, 'rawBranch')).toBe('feature/y');
    expect(field(next, 'createdAt')).not.toBe(AGED);
  });

  it('a different repo never inherits the stored generation identity', () => {
    const aged = agedStored('feature/x', 'https://github.com/org/other');
    expect(field(embedSpecBranchMarker(source, preview, repo, aged), 'createdAt')).not.toBe(AGED);
  });

  it('unmarked or malformed stored content is treated as a fresh generation', () => {
    expect(embedSpecBranchMarker(source, preview, repo, source)).toContain('x-postman-onboarding:');
    expect(embedSpecBranchMarker(source, preview, repo, ': : not yaml : :')).toContain(
      'x-postman-onboarding:'
    );
  });

  it('canonical tiers stay byte-for-byte source even when prior content is supplied', () => {
    const canonical = resolveBranchDecision({
      strategy: 'publish-gate',
      identity: identity({ headBranch: 'main', refKind: 'default-branch' }) as never
    });
    expect(embedSpecBranchMarker(source, canonical, repo, source)).toBe(source);
  });

  it('JSON specs are equally rerun-stable', async () => {
    const json = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'P', version: '1.0.0' },
      paths: {}
    });
    const stored = embedSpecBranchMarker(json, preview, repo);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(embedSpecBranchMarker(json, preview, repo, stored)).toBe(stored);
  });
});
