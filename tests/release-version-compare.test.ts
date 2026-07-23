import { describe, expect, it } from 'vitest';

// @ts-expect-error The comparator is intentionally dependency-free ESM.
import { compareReleaseVersions, main } from '../scripts/compare-release-versions.mjs';

/**
 * Invoke the injectable CLI with explicit argv and in-memory sinks.
 * No process.argv / process.exitCode / console mutation.
 */
function runCli(argv: string[]): { stdout: string; stderr: string; status: number } {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const status = main(
    argv,
    (chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
    },
    (chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
    },
  );
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), status };
}

describe('compareReleaseVersions', () => {
  it('orders older, equal, and newer immutable x.y.z versions', () => {
    expect(compareReleaseVersions('2.10.6', '2.10.7')).toBe(-1);
    expect(compareReleaseVersions('2.10.7', '2.10.7')).toBe(0);
    expect(compareReleaseVersions('2.11.0', '2.10.7')).toBe(1);
    expect(compareReleaseVersions('3.0.0', '2.99.99')).toBe(1);
  });

  it('rejects malformed values', () => {
    for (const value of ['v2.10.7', '2.10', '2.10.7-beta', '2.10.7.0', '', 'latest', '2.10.x']) {
      expect(() => compareReleaseVersions(value, '2.10.7')).toThrow(/invalid immutable version/);
      expect(() => compareReleaseVersions('2.10.7', value)).toThrow(/invalid immutable version/);
    }
  });

  it('CLI prints -1, 0, or 1 for valid pairs', () => {
    const older = runCli(['node', 'compare-release-versions.mjs', '2.10.6', '2.10.7']);
    expect(older.status).toBe(0);
    expect(older.stdout).toBe('-1\n');
    expect(older.stderr).toBe('');

    const equal = runCli(['node', 'compare-release-versions.mjs', '2.10.7', '2.10.7']);
    expect(equal.status).toBe(0);
    expect(equal.stdout).toBe('0\n');
    expect(equal.stderr).toBe('');

    const newer = runCli(['node', 'compare-release-versions.mjs', '2.11.0', '2.10.7']);
    expect(newer.status).toBe(0);
    expect(newer.stdout).toBe('1\n');
    expect(newer.stderr).toBe('');
  });

  it('CLI exits non-zero for malformed values', () => {
    const result = runCli(['node', 'compare-release-versions.mjs', 'v2.10.7', '2.10.7']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('invalid immutable version: v2.10.7\n');
  });

  it('CLI exits non-zero for missing pairs', () => {
    const missingBoth = runCli(['node', 'compare-release-versions.mjs']);
    expect(missingBoth.status).toBe(1);
    expect(missingBoth.stdout).toBe('');
    expect(missingBoth.stderr).toBe('Usage: node scripts/compare-release-versions.mjs <x.y.z> <x.y.z>\n');

    const missingRight = runCli(['node', 'compare-release-versions.mjs', '2.10.7']);
    expect(missingRight.status).toBe(1);
    expect(missingRight.stdout).toBe('');
    expect(missingRight.stderr).toBe('Usage: node scripts/compare-release-versions.mjs <x.y.z> <x.y.z>\n');
  });
});
