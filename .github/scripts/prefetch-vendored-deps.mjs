import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function packagesFromLock(lock) {
  const packages = new Map();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const match = path.match(/(?:^|\/)node_modules\/(@postman\/[^/]+)$/);
    if (!match) continue;
    if (typeof entry.version !== 'string' || typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      throw new Error(`${match[1]} has no versioned SHA-512 lockfile entry`);
    }
    const key = `${match[1]}@${entry.version}`;
    const prior = packages.get(key);
    if (prior && prior.integrity !== entry.integrity) throw new Error(`${key} has conflicting lockfile integrity values`);
    packages.set(key, { name: match[1], version: entry.version, integrity: entry.integrity });
  }
  return [...packages.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
}

function assetName({ name, version }) {
  return `${name.slice(1).replace('/', '-')}-${version}.tgz`;
}

async function responseError(response, operation) {
  const detail = (await response.text()).slice(0, 300).replace(/\s+/g, ' ');
  return new Error(`${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
}

async function releaseAssets({ apiUrl, repo, token, fetchImpl }) {
  const assets = new Map();
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(`${apiUrl}/repos/${repo}/releases?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw await responseError(response, 'Vendored release lookup');
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('Vendored release lookup returned an invalid payload');
    for (const release of releases) {
      for (const asset of release.assets ?? []) {
        if (assets.has(asset.name)) throw new Error(`Duplicate vendored release asset: ${asset.name}`);
        assets.set(asset.name, asset);
      }
    }
    if (releases.length < 100) return assets;
  }
}

export async function prefetchVendoredDeps(options = {}) {
  const lockPath = options.lockPath ?? process.argv[2] ?? 'package-lock.json';
  const lock = options.lock ?? JSON.parse(await readFile(lockPath, 'utf8'));
  const packages = packagesFromLock(lock);
  const log = options.log ?? console.log;
  if (packages.length === 0) {
    log('Vendored dependencies: 0 required');
    return 0;
  }

  const repo = options.repo ?? process.env.DEPS_REPO;
  const token = options.token ?? process.env.DEPS_TOKEN;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('DEPS_REPO must be an owner/repository pair');
  if (!token) throw new Error('DEPS_TOKEN is required for vendored dependencies');

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
  const assets = await releaseAssets({ apiUrl, repo, token, fetchImpl });
  const cacheAdd = options.cacheAdd ?? ((file) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['cache', 'add', file], { stdio: 'inherit' });
  });
  const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'postman-vendored-deps-'));

  try {
    for (const entry of packages) {
      const file = assetName(entry);
      const asset = assets.get(file);
      if (!asset?.url) throw new Error(`Vendored release asset not found: ${file}`);
      const response = await fetchImpl(asset.url, {
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok) throw await responseError(response, `Vendored asset download for ${file}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
      if (integrity !== entry.integrity) throw new Error(`Vendored asset integrity mismatch: ${file}`);
      const path = join(directory, basename(file));
      await writeFile(path, bytes, { mode: 0o600 });
      await cacheAdd(path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  log(`Vendored dependencies: ${packages.length}/${packages.length} verified and cached`);
  return packages.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  prefetchVendoredDeps().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
