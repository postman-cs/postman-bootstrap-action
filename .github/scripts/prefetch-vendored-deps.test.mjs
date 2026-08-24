import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { npmCacheInvocation, prefetchVendoredDeps } from './prefetch-vendored-deps.mjs';

const tarball = Buffer.from('exact registry tarball bytes');
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
const lock = (value = integrity) => ({
  packages: {
    'node_modules/@postman/example': { version: '1.2.3', integrity: value },
  },
});

function releaseFetch(assetBytes = tarball, assets = [{ name: 'postman-example-1.2.3.tgz', url: 'https://assets.invalid/example' }]) {
  return async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (url.includes('/releases?')) return new globalThis.Response(JSON.stringify([{ assets }]), { status: 200 });
    assert.equal(url, 'https://assets.invalid/example');
    assert.equal(options.headers.Accept, 'application/octet-stream');
    return new globalThis.Response(assetBytes, { status: 200 });
  };
}

test('verifies and adds the exact release asset to npm cache', async () => {
  const cached = [];
  const count = await prefetchVendoredDeps({
    lock: lock(),
    repo: 'owner/private-repo',
    token: 'test-token',
    fetchImpl: releaseFetch(),
    cacheAdd: async (file) => cached.push(await readFile(file)),
    log: () => {},
  });
  assert.equal(count, 1);
  assert.deepEqual(cached, [tarball]);
});

test('does not require repository credentials when the lockfile has no vendored packages', async () => {
  let fetched = false;
  const count = await prefetchVendoredDeps({
    lock: { packages: {} },
    fetchImpl: async () => { fetched = true; },
    log: () => {},
  });
  assert.equal(count, 0);
  assert.equal(fetched, false);
});

test('rejects a release asset that does not match lockfile integrity', async () => {
  await assert.rejects(
    prefetchVendoredDeps({
      lock: lock(),
      repo: 'owner/private-repo',
      token: 'test-token',
      fetchImpl: releaseFetch(Buffer.from('tampered')),
      cacheAdd: async () => assert.fail('tampered asset must not reach npm cache'),
      log: () => {},
    }),
    /integrity mismatch/,
  );
});

test('fails closed when the required release asset is absent', async () => {
  await assert.rejects(
    prefetchVendoredDeps({
      lock: lock(),
      repo: 'owner/private-repo',
      token: 'test-token',
      fetchImpl: releaseFetch(tarball, []),
      cacheAdd: async () => assert.fail('missing asset must not reach npm cache'),
      log: () => {},
    }),
    /asset not found/,
  );
});

test('uses the command shell for the Windows npm shim', () => {
  assert.deepEqual(npmCacheInvocation('C:\\temp\\asset.tgz', 'win32'), {
    command: 'npm',
    args: ['cache', 'add', 'C:\\temp\\asset.tgz'],
    shell: true,
  });
});
