import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error The comparator is intentionally dependency-free ESM.
import { compareReleaseVersions } from '../scripts/compare-release-versions.mjs';

const script = join(process.cwd(), 'scripts/compare-release-versions.mjs');

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
    const older = spawnSync(process.execPath, [script, '2.10.6', '2.10.7'], { encoding: 'utf8' });
    expect(older.status).toBe(0);
    expect(older.stdout.trim()).toBe('-1');

    const equal = spawnSync(process.execPath, [script, '2.10.7', '2.10.7'], { encoding: 'utf8' });
    expect(equal.status).toBe(0);
    expect(equal.stdout.trim()).toBe('0');

    const newer = spawnSync(process.execPath, [script, '2.11.0', '2.10.7'], { encoding: 'utf8' });
    expect(newer.status).toBe(0);
    expect(newer.stdout.trim()).toBe('1');
  });

  it('CLI exits non-zero for malformed values', () => {
    const result = spawnSync(process.execPath, [script, 'v2.10.7', '2.10.7'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/invalid immutable version/);
  });
});
