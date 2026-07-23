import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Strict numeric comparator for immutable `x.y.z` release versions.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 * Rejects any non-`x.y.z` form (no `v` prefix, no prerelease, no two-part).
 */

/**
 * @param {string} value
 * @returns {[number, number, number]}
 */
function parseStrictXyz(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`invalid immutable version: ${value}`);
  }
  const parts = value.split('.').map((part) => Number(part));
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`invalid immutable version: ${value}`);
  }
  return /** @type {[number, number, number]} */ (parts);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareReleaseVersions(a, b) {
  const [aMajor, aMinor, aPatch] = parseStrictXyz(a);
  const [bMajor, bMinor, bPatch] = parseStrictXyz(b);
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1;
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1;
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1;
  return 0;
}

function main() {
  const [, , left, right] = process.argv;
  if (left === undefined || right === undefined) {
    console.error('Usage: node scripts/compare-release-versions.mjs <x.y.z> <x.y.z>');
    process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(`${compareReleaseVersions(left, right)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
