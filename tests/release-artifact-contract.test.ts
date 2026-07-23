import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertRemoteIntegrityMatches,
  computeSha512Sri,
  expectedArtifactNames,
  isExplicitNpmE404,
  verifyReleaseArtifacts,
  verifySha512Sri
  // @ts-expect-error The release verifier is intentionally dependency-free ESM.
} from '../scripts/verify-release-artifacts.mjs';

const PACKAGE_NAME = '@postman-cse/onboarding-bootstrap';
const REPOSITORY = 'postman-cs/postman-bootstrap-action';
const COMMIT_SHA = 'abc123def456';
const VERSION = '2.10.7';
const TAG = 'v2.10.7';
const ZERO_PATCH_VERSION = '2.11.0';
const ZERO_PATCH_TAG = 'v2.11';
const SEA = `postman-bootstrap-${VERSION}-linux-x64`;

const temporaryDirectories: string[] = [];
const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function extractTrustedPublisherVerifier(): string {
  const startMarker = "<<'TRUSTED_PUBLISHER_VERIFIER'";
  const startIndex = releaseWorkflow.indexOf(startMarker);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const bodyStart = releaseWorkflow.indexOf('\n', startIndex) + 1;
  const rest = releaseWorkflow.slice(bodyStart);
  const endMatch = rest.match(/\n([ \t]*)TRUSTED_PUBLISHER_VERIFIER\s*(?:\n|$)/);
  expect(endMatch?.index).toBeGreaterThanOrEqual(0);
  const rawBody = rest.slice(0, endMatch!.index);
  const indent = endMatch![1] ?? '';
  return rawBody
    .split('\n')
    .map((line) => (indent && line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

function writeTarball(directory: string, packageJson: { name: string; version: string }): void {
  const packageDirectory = join(directory, 'package');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify(packageJson));
  writeFileSync(join(packageDirectory, 'index.js'), 'export {};\n');
  execFileSync('tar', ['-czf', join(directory, 'release.tgz'), '-C', directory, 'package']);
  rmSync(packageDirectory, { recursive: true, force: true });
}

function writeSea(directory: string, version = VERSION, contents = 'sea-binary'): string {
  const sea = `postman-bootstrap-${version}-linux-x64`;
  writeFileSync(join(directory, sea), contents);
  writeFileSync(join(directory, `${sea}.sha256`), `${sha256(contents)}  ${sea}\n`);
  return sea;
}

function fixture(options: {
  version?: string;
  tag?: string;
  packageJson?: { name: string; version: string };
  manifestOverrides?: Record<string, unknown>;
  extraFile?: string;
  omitSea?: boolean;
  omitTarball?: boolean;
  symlinkSea?: boolean;
  nonRegularSea?: boolean;
  wrongSidecarDigest?: boolean;
  wrongSidecarName?: boolean;
  malformedTar?: boolean;
  duplicateManifestEntry?: boolean;
} = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'bootstrap-release-'));
  temporaryDirectories.push(directory);
  const version = options.version ?? VERSION;
  const tag = options.tag ?? TAG;
  const packageJson = options.packageJson ?? { name: PACKAGE_NAME, version };
  const sea = `postman-bootstrap-${version}-linux-x64`;

  if (options.malformedTar) {
    writeFileSync(join(directory, 'release.tgz'), 'not-a-tarball');
  } else if (!options.omitTarball) {
    writeTarball(directory, packageJson);
  }

  if (!options.omitSea) {
    writeSea(directory, version);
    if (options.wrongSidecarDigest) {
      writeFileSync(join(directory, `${sea}.sha256`), `${'0'.repeat(64)}  ${sea}\n`);
    }
    if (options.wrongSidecarName) {
      writeFileSync(join(directory, `${sea}.sha256`), `${sha256('sea-binary')}  wrong-name\n`);
    }
    if (options.symlinkSea) {
      rmSync(join(directory, sea));
      const targetDirectory = mkdtempSync(join(tmpdir(), 'sea-target-'));
      temporaryDirectories.push(targetDirectory);
      const target = join(targetDirectory, 'sea-binary');
      writeFileSync(target, 'sea-binary');
      symlinkSync(target, join(directory, sea));
    }
    if (options.nonRegularSea) {
      rmSync(join(directory, sea));
      mkdirSync(join(directory, sea));
    }
  }

  if (options.extraFile) writeFileSync(join(directory, options.extraFile), 'extra');

  const paths = expectedArtifactNames(version);
  let artifacts = paths
    .filter((path: string) => {
      try {
        readFileSync(join(directory, path));
        return true;
      } catch {
        return false;
      }
    })
    .map((path: string) => ({ path, sha256: sha256(readFileSync(join(directory, path))) }));

  if (options.duplicateManifestEntry && artifacts[0]) {
    artifacts = [...artifacts, { ...artifacts[0] }];
  }

  writeFileSync(
    join(directory, 'release-manifest.json'),
    JSON.stringify({
      schema_version: 1,
      repository: REPOSITORY,
      commit_sha: COMMIT_SHA,
      tag,
      package_name: PACKAGE_NAME,
      package_version: version,
      artifacts,
      ...options.manifestOverrides
    })
  );

  return directory;
}

function verify(directory: string, overrides: Partial<{ repository: string; commitSha: string; tag: string }> = {}) {
  return verifyReleaseArtifacts({
    directory,
    repository: REPOSITORY,
    commitSha: COMMIT_SHA,
    tag: TAG,
    ...overrides
  });
}

function runInlineVerifier(
  directory: string,
  env: Partial<{ GITHUB_REPOSITORY: string; GITHUB_SHA: string; GITHUB_REF_NAME: string }> = {}
) {
  const scriptDirectory = mkdtempSync(join(tmpdir(), 'trusted-publisher-'));
  temporaryDirectories.push(scriptDirectory);
  const scriptPath = join(scriptDirectory, 'trusted-publisher-verifier.mjs');
  writeFileSync(scriptPath, extractTrustedPublisherVerifier());
  return spawnSync(process.execPath, [scriptPath], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: env.GITHUB_REPOSITORY ?? REPOSITORY,
      GITHUB_SHA: env.GITHUB_SHA ?? COMMIT_SHA,
      GITHUB_REF_NAME: env.GITHUB_REF_NAME ?? TAG
    }
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release artifact verifier', () => {
  it('accepts a real tar fixture for exact and zero-patch minor tags', () => {
    const exact = fixture();
    expect(verify(exact)).toMatchObject({
      schema_version: 1,
      package_version: VERSION,
      tag: TAG
    });

    const minor = fixture({
      version: ZERO_PATCH_VERSION,
      tag: ZERO_PATCH_TAG,
      packageJson: { name: PACKAGE_NAME, version: ZERO_PATCH_VERSION }
    });
    expect(verify(minor, { tag: ZERO_PATCH_TAG })).toMatchObject({
      package_version: ZERO_PATCH_VERSION,
      tag: ZERO_PATCH_TAG
    });
  });

  it('rejects wrong repository, SHA, tag, package version, and checksum', () => {
    expect(() => verify(fixture({ manifestOverrides: { repository: 'wrong/repository' } }))).toThrow(/repository/);
    expect(() => verify(fixture({ manifestOverrides: { commit_sha: 'deadbeef' } }))).toThrow(/commit_sha/);
    expect(() => verify(fixture({ manifestOverrides: { tag: 'v9.9.9' } }))).toThrow(/tag/);
    expect(() => verify(fixture({ manifestOverrides: { package_version: '9.9.9' } }))).toThrow(
      /allowlist|immutable|identity|version/i
    );

    const wrongChecksum = fixture();
    const manifest = JSON.parse(readFileSync(join(wrongChecksum, 'release-manifest.json'), 'utf8'));
    manifest.artifacts[0].sha256 = '0'.repeat(64);
    writeFileSync(join(wrongChecksum, 'release-manifest.json'), JSON.stringify(manifest));
    expect(() => verify(wrongChecksum)).toThrow(/checksum/);
  });

  it('rejects malformed tar, missing/extra/manifest-approved extra, duplicate, symlink, and non-regular files', () => {
    expect(() => verify(fixture({ malformedTar: true }))).toThrow(/package\/package\.json|tarball|JSON/i);
    expect(() => verify(fixture({ omitSea: true }))).toThrow(/missing|allowlist/i);
    expect(() => verify(fixture({ extraFile: 'evil.bin' }))).toThrow(/unexpected artifact/);

    const manifestExtra = fixture();
    writeFileSync(join(manifestExtra, 'extra.bin'), 'extra');
    const manifest = JSON.parse(readFileSync(join(manifestExtra, 'release-manifest.json'), 'utf8'));
    manifest.artifacts.push({ path: 'extra.bin', sha256: sha256('extra') });
    writeFileSync(join(manifestExtra, 'release-manifest.json'), JSON.stringify(manifest));
    expect(() => verify(manifestExtra)).toThrow(/allowlist/);

    expect(() => verify(fixture({ duplicateManifestEntry: true }))).toThrow(/duplicate/);
    expect(() => verify(fixture({ symlinkSea: true }))).toThrow(/symlink/);
    expect(() => verify(fixture({ nonRegularSea: true }))).toThrow(/regular file|allowlist|missing/i);
  });

  it('rejects mismatched and wrong-name SEA sidecars', () => {
    expect(() => verify(fixture({ wrongSidecarDigest: true }))).toThrow(/sidecar|checksum/i);
    expect(() => verify(fixture({ wrongSidecarName: true }))).toThrow(/sidecar/i);
  });
});

describe('npm SRI helpers', () => {
  it('matches equal SRI and rejects mismatched remote integrity', () => {
    const directory = fixture();
    const tarball = readFileSync(join(directory, 'release.tgz'));
    const sri = computeSha512Sri(tarball);
    expect(sri).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
    expect(() => assertRemoteIntegrityMatches(sri, sri)).not.toThrow();
    expect(() => assertRemoteIntegrityMatches(sri, 'sha512-AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(/integrity/);
    expect(() => verifySha512Sri(join(directory, 'release.tgz'), sri)).not.toThrow();
    expect(() => verifySha512Sri(join(directory, 'release.tgz'), 'sha512-AAAAAAAAAAAAAAAAAAAAAA==')).toThrow(
      /integrity/
    );
  });

  it('distinguishes explicit E404 from outage and auth failures', () => {
    expect(isExplicitNpmE404('npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/pkg')).toBe(
      true
    );
    expect(isExplicitNpmE404('npm ERR! code E404\nnpm ERR! 404 Not Found')).toBe(true);
    expect(isExplicitNpmE404('npm error code ETIMEDOUT')).toBe(false);
    expect(isExplicitNpmE404('npm error code E401\nnpm error 401 Unauthorized')).toBe(false);
    expect(isExplicitNpmE404('network socket hang up')).toBe(false);
  });
});

describe('trusted inline publisher verifier', () => {
  it('accepts the same valid fixture and rejects the same concrete identity failures', { timeout: 30_000 }, () => {
    const valid = fixture();
    const ok = runInlineVerifier(valid);
    expect(ok.status, ok.stderr || ok.stdout).toBe(0);

    expect(runInlineVerifier(fixture({ manifestOverrides: { repository: 'wrong/repository' } })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ manifestOverrides: { commit_sha: 'deadbeef' } })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ manifestOverrides: { tag: 'v9.9.9' } })).status).not.toBe(0);

    const wrongChecksum = fixture();
    const manifest = JSON.parse(readFileSync(join(wrongChecksum, 'release-manifest.json'), 'utf8'));
    manifest.artifacts[0].sha256 = '0'.repeat(64);
    writeFileSync(join(wrongChecksum, 'release-manifest.json'), JSON.stringify(manifest));
    expect(runInlineVerifier(wrongChecksum).status).not.toBe(0);

    expect(runInlineVerifier(fixture({ malformedTar: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ extraFile: 'evil.bin' })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ omitSea: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ duplicateManifestEntry: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ symlinkSea: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ nonRegularSea: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ wrongSidecarDigest: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture({ wrongSidecarName: true })).status).not.toBe(0);
    expect(runInlineVerifier(fixture(), { GITHUB_REPOSITORY: 'wrong/repo' }).status).not.toBe(0);
  });

  it('accepts a valid zero-patch minor fixture and rejects malformed/two-part/prerelease package versions', {
    timeout: 30_000
  }, () => {
    const zeroPatch = fixture({
      version: ZERO_PATCH_VERSION,
      tag: ZERO_PATCH_TAG,
      packageJson: { name: PACKAGE_NAME, version: ZERO_PATCH_VERSION }
    });
    const zeroPatchOk = runInlineVerifier(zeroPatch, { GITHUB_REF_NAME: ZERO_PATCH_TAG });
    expect(zeroPatchOk.status, zeroPatchOk.stderr || zeroPatchOk.stdout).toBe(0);

    for (const badVersion of ['not-a-version', '2.10', '2.10.7-beta.1']) {
      const bad = fixture({
        version: badVersion,
        tag: `v${badVersion}`,
        packageJson: { name: PACKAGE_NAME, version: badVersion }
      });
      const result = runInlineVerifier(bad, { GITHUB_REF_NAME: `v${badVersion}` });
      expect(result.status, result.stderr || result.stdout).not.toBe(0);
      expect(`${result.stderr}\n${result.stdout}`).toMatch(/package_version must be strict numeric x\.y\.z|strict numeric/i);
    }
  });

  it('is extractable from the marked workflow heredoc and does not execute artifact code', () => {
    const body = extractTrustedPublisherVerifier();
    expect(body).toContain('postman-bootstrap-${manifest.package_version}-linux-x64');
    expect(body).toContain('/^\\d+\\.\\d+\\.\\d+$/.test(manifest.package_version)');
    expect(body).toContain('package_version must be strict numeric x.y.z');
    expect(body).toContain('exact artifact allowlist mismatch');
    expect(body).not.toContain('verify-release-artifacts.mjs');
    expect(body).not.toContain("import('");
    expect(SEA).toContain('postman-bootstrap-');
  });
});
