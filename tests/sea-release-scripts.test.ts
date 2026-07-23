import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const { assertSeaProxyRouting } = await import(
  pathToFileURL(join(process.cwd(), 'scripts/assert-sea-proxy.mjs')).href
);

const HTTPS_PROBE = [
  "require('node:https').get('https://example.com/', (res) => { res.resume(); }).on('error', () => {});",
  'setTimeout(() => {}, 5000);'
].join(' ');

describe('SEA release scripts', () => {
  it('resolves when the exact CONNECT authority is observed', async () => {
    await expect(
      assertSeaProxyRouting(process.execPath, 'example.com:443', ['-e', HTTPS_PROBE], { timeoutMs: 5_000 })
    ).resolves.toBeUndefined();
  });

  it('rejects wrong authority under a short injected timeout', async () => {
    await expect(
      assertSeaProxyRouting(process.execPath, 'wrong.example:443', ['-e', HTTPS_PROBE], { timeoutMs: 500 })
    ).rejects.toThrow(/did not proxy wrong\.example:443/);
  });

  it(
    'rejects early exit before proxying',
    async () => {
      await expect(
        assertSeaProxyRouting(process.execPath, 'example.com:443', ['-e', 'process.exit(0)'], {
          timeoutMs: 10_000
        })
      ).rejects.toThrow(/exited before proxying example\.com:443/);
    },
    15_000
  );

  it('declares SEA hermetic execArgvExtension none and bounds pinned curl downloads', () => {
    const seaConfig = JSON.parse(readFileSync(join(process.cwd(), 'sea-config.json'), 'utf8'));
    expect(seaConfig.execArgvExtension).toBe('none');
    expect(seaConfig.main).toBe('build/sea/cli.cjs');
    expect(seaConfig.output).toBe('build/sea/sea-prep.blob');
    expect(seaConfig.disableExperimentalSEAWarning).toBe(true);

    const seaBuild = readFileSync(join(process.cwd(), 'scripts/build-sea.sh'), 'utf8');
    const curlDownloads =
      seaBuild.match(/curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 --retry-delay 2/g) ?? [];
    expect(curlDownloads).toHaveLength(2);
    expect(seaBuild).toContain('NODE_VERSION="24.18.0"');
    expect(seaBuild).toContain('shasum -a 256 -c');
    expect(seaBuild).not.toMatch(/--retry\s+inf(?:inite)?\b/);
    expect(seaBuild).not.toMatch(/while\s+true/);
  });
});
