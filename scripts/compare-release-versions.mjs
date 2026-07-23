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

/**
 * CLI entry for comparing two immutable release versions.
 * @param {string[]} [argv=process.argv]
 * @param {(chunk: string | Uint8Array) => unknown} [writeStdout=process.stdout.write.bind(process.stdout)]
 * @param {(chunk: string | Uint8Array) => unknown} [writeStderr=process.stderr.write.bind(process.stderr)]
 * @returns {0|1}
 */
export function main(
  argv = process.argv,
  writeStdout = process.stdout.write.bind(process.stdout),
  writeStderr = process.stderr.write.bind(process.stderr),
) {
  const [, , left, right] = argv;
  if (left === undefined || right === undefined) {
    writeStderr('Usage: node scripts/compare-release-versions.mjs <x.y.z> <x.y.z>\n');
    return 1;
  }
  try {
    writeStdout(`${compareReleaseVersions(left, right)}\n`);
    return 0;
  } catch (error) {
    writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
