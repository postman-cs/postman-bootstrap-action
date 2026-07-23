import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = '@postman-cse/onboarding-bootstrap';
const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const TAR_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(`release artifact verification failed: ${message}`);
}

/**
 * @param {Buffer|string} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {Buffer|string} bytes
 * @returns {string}
 */
export function computeSha512Sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * Pure remote-integrity check: local staged SRI must equal the npm dist.integrity value.
 * @param {string} localSri
 * @param {string} remoteIntegrity
 */
export function assertRemoteIntegrityMatches(localSri, remoteIntegrity) {
  if (String(localSri ?? '').trim() !== String(remoteIntegrity ?? '').trim()) {
    fail('published npm integrity differs from staged tarball');
  }
}

/**
 * @param {string} filePath
 * @param {string} expectedSri
 */
export function verifySha512Sri(filePath, expectedSri) {
  const actual = computeSha512Sri(readFileSync(filePath));
  assertRemoteIntegrityMatches(actual, expectedSri);
  return actual;
}

/** True only for an explicit npm E404; outage/auth/timeout/generic errors return false. */
export function isExplicitNpmE404(output) {
  const text = String(output ?? '');
  return /(?:^|\n)npm (?:error|ERR!) code E404(?:\n|$)/m.test(text) || /(?:^|\n)npm error 404\b/m.test(text);
}

/**
 * @param {string} packageVersion
 * @returns {string}
 */
export function seaBinaryName(packageVersion) {
  return `postman-bootstrap-${packageVersion}-linux-x64`;
}

/**
 * Exact bootstrap allowlist: release.tgz + SEA executable + matching .sha256 sidecar.
 * @param {string} packageVersion
 * @returns {string[]}
 */
export function expectedArtifactNames(packageVersion) {
  const sea = seaBinaryName(packageVersion);
  return ['release.tgz', sea, `${sea}.sha256`];
}

/**
 * Exact `vX.Y.Z` or zero-patch `vX.Y` only.
 * @param {string} tag
 * @param {string} packageVersion
 */
export function assertAcceptedImmutableTag(tag, packageVersion) {
  if (typeof tag !== 'string' || typeof packageVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    fail(`tag ${tag} is not an accepted immutable form for version ${packageVersion}`);
  }
  if (tag === `v${packageVersion}`) return;
  const [major, minor, patch] = packageVersion.split('.');
  if (patch === '0' && tag === `v${major}.${minor}`) return;
  fail(`tag ${tag} is not an accepted immutable form for version ${packageVersion}`);
}

/**
 * @param {string} directory
 * @param {string} name
 */
function assertRegularNonSymlinkFile(directory, name) {
  const fullPath = join(directory, name);
  if (!existsSync(fullPath)) fail(`missing artifact ${name}`);
  const stats = lstatSync(fullPath);
  if (stats.isSymbolicLink()) fail(`artifact must not be a symlink: ${name}`);
  if (!stats.isFile()) fail(`artifact must be a regular file: ${name}`);
  return fullPath;
}

/**
 * @param {string} tarball
 */
function readTarballPackageIdentity(tarball) {
  let packageJsonText;
  try {
    packageJsonText = execFileSync('tar', ['-xOf', tarball, 'package/package.json'], {
      encoding: 'utf8',
      timeout: TAR_TIMEOUT_MS,
      maxBuffer: MAX_PACKAGE_JSON_BYTES,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    fail('unable to read package/package.json from release.tgz');
  }
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch {
    fail('package/package.json from release.tgz is not valid JSON');
  }
  if (!pkg || typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    fail('package/package.json from release.tgz is missing name/version');
  }
  return { name: pkg.name, version: pkg.version };
}

/**
 * @param {string} directory
 * @param {string} packageVersion
 * @param {Array<{ path: string, sha256: string }>} artifacts
 */
export function validateSeaSidecar(directory, packageVersion, artifacts) {
  const sea = seaBinaryName(packageVersion);
  const sidecarName = `${sea}.sha256`;
  const seaEntry = artifacts.find((artifact) => artifact.path === sea);
  const sidecarEntry = artifacts.find((artifact) => artifact.path === sidecarName);
  if (!seaEntry || !sidecarEntry) fail('SEA executable and sidecar are required');
  const sidecarPath = assertRegularNonSymlinkFile(directory, sidecarName);
  const seaPath = assertRegularNonSymlinkFile(directory, sea);
  const sidecarText = readFileSync(sidecarPath, 'utf8').trim();
  const [digest = '', filename = ''] = sidecarText.split(/\s+/);
  if (!SHA256_HEX.test(digest) || filename !== sea) {
    fail(`SEA sidecar text must be "<sha256> ${sea}"`);
  }
  const actual = sha256Hex(readFileSync(seaPath));
  if (digest !== actual || digest !== seaEntry.sha256) {
    fail('SEA sidecar digest does not match executable and manifest');
  }
  if (sidecarEntry.sha256 !== sha256Hex(readFileSync(sidecarPath))) {
    fail(`checksum mismatch for ${sidecarName}`);
  }
}

/**
 * @param {{ directory?: string, repository: string, commitSha: string, tag: string }} input
 */
export function verifyReleaseArtifacts({ directory = '.', repository, commitSha, tag }) {
  const root = resolve(directory);
  const manifestPath = join(root, 'release-manifest.json');
  if (!existsSync(manifestPath)) fail('release-manifest.json is missing');
  assertRegularNonSymlinkFile(root, 'release-manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('release-manifest.json is not valid JSON');
  }
  if (!manifest || typeof manifest !== 'object') fail('invalid manifest schema');
  if (manifest.schema_version !== 1) fail('schema_version must be 1');
  for (const field of ['repository', 'commit_sha', 'tag', 'package_name', 'package_version']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      fail(`manifest ${field} must be a non-empty string`);
    }
  }
  for (const [field, expected] of Object.entries({
    repository,
    commit_sha: commitSha,
    tag
  })) {
    if (manifest[field] !== expected) fail(`${field} mismatch`);
  }
  if (manifest.package_name !== EXPECTED_PACKAGE_NAME) {
    fail(`package_name must be ${EXPECTED_PACKAGE_NAME}`);
  }
  assertAcceptedImmutableTag(tag, manifest.package_version);
  assertAcceptedImmutableTag(manifest.tag, manifest.package_version);

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('artifacts is missing');
  }

  const expectedNames = expectedArtifactNames(manifest.package_version);
  const seen = new Set();
  /** @type {Array<{ path: string, sha256: string }>} */
  const artifacts = [];
  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry !== 'object') fail('invalid artifact manifest entry');
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      fail('invalid artifact manifest entry');
    }
    const path = entry.path;
    const digest = entry.sha256;
    if (path !== basename(path) || path.includes('..') || path.includes('/') || path.includes('\\') || !SAFE_BASENAME.test(path)) {
      fail(`unsafe artifact path ${path}`);
    }
    if (!SHA256_HEX.test(digest)) fail(`invalid checksum for ${path}`);
    if (seen.has(path)) fail(`duplicate artifact path ${path}`);
    seen.add(path);
    artifacts.push({ path, sha256: digest });
  }
  if (artifacts.length !== expectedNames.length || expectedNames.some((name) => !seen.has(name))) {
    fail(`exact artifact allowlist mismatch; expected ${expectedNames.join(', ')}`);
  }

  const onDisk = readdirSync(root);
  for (const name of expectedNames) {
    if (!onDisk.includes(name)) fail(`missing artifact ${name}`);
  }
  for (const name of onDisk) {
    if (name === 'release-manifest.json') continue;
    if (!seen.has(name)) fail(`unexpected artifact ${name}`);
  }
  for (const name of [...expectedNames, 'release-manifest.json']) {
    assertRegularNonSymlinkFile(root, name);
  }

  for (const artifact of artifacts) {
    const fullPath = join(root, artifact.path);
    if (sha256Hex(readFileSync(fullPath)) !== artifact.sha256) {
      fail(`checksum mismatch for ${artifact.path}`);
    }
  }

  const tarballPath = join(root, 'release.tgz');
  const identity = readTarballPackageIdentity(tarballPath);
  if (identity.name !== EXPECTED_PACKAGE_NAME) fail('tarball package name mismatch');
  if (identity.name !== manifest.package_name || identity.version !== manifest.package_version) {
    fail('tarball package identity mismatch');
  }

  validateSeaSidecar(root, manifest.package_version, artifacts);
  return manifest;
}

function main() {
  const directory = process.argv[2] ?? process.env.RELEASE_ARTIFACT_DIR ?? '.';
  verifyReleaseArtifacts({
    directory,
    repository: process.env.GITHUB_REPOSITORY ?? '',
    commitSha: process.env.GITHUB_SHA ?? '',
    tag: process.env.GITHUB_REF_NAME ?? ''
  });
  console.log('release artifacts verified');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
