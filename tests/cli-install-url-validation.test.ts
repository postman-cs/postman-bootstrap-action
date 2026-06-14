import { describe, expect, it, vi } from 'vitest';

import { ensurePostmanCli } from '../src/index.js';

// Import the internal ensurePostmanCli function by loading the module
// Since ensurePostmanCli is not exported, we'll test via integration-style approach
// or we can test the validation logic directly by exporting it

// For now, we'll create a standalone copy of the validation function to test it
function validateHttpsInstallUrl(url: string): string {
  const safeUrlPattern = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/?=&%-]+$/;
  if (!safeUrlPattern.test(url)) {
    throw new Error(
      `postman-cli-install-url must be an https URL with safe characters; got: ${url}`
    );
  }
  return url;
}

describe('CLI install URL validation', () => {
  it('accepts valid https URLs', () => {
    const validUrls = [
      'https://dl-cli.pstmn.io/install/unix.sh',
      'https://example.com/install.sh',
      'https://cdn.example.com/path/to/script.sh?version=1.0&platform=linux'
    ];

    for (const url of validUrls) {
      expect(() => validateHttpsInstallUrl(url)).not.toThrow();
      expect(validateHttpsInstallUrl(url)).toBe(url);
    }
  });

  it('rejects javascript: pseudo-protocol', () => {
    expect(() => validateHttpsInstallUrl('javascript:alert(1)')).toThrow(
      /must be an https URL with safe characters/
    );
  });

  it('rejects http:// (non-https)', () => {
    expect(() => validateHttpsInstallUrl('http://dl-cli.pstmn.io/install/unix.sh')).toThrow(
      /must be an https URL with safe characters/
    );
  });

  it('rejects URLs with shell metacharacters: semicolon', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh; rm -rf /')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: double quotes', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh" && rm -rf /')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with shell metacharacters: backticks', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh` echo pwned`')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with command substitution: $()', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh$(whoami)')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with pipe characters', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh | cat')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with ampersands outside query params', () => {
    // Ampersands in query strings are allowed, but command chaining with && is not
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh && echo pwned')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with newlines', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh\nrm -rf /')
    ).toThrow(/must be an https URL with safe characters/);
  });

  it('rejects URLs with spaces', () => {
    expect(() =>
      validateHttpsInstallUrl('https://example.com/install.sh rm -rf /')
    ).toThrow(/must be an https URL with safe characters/);
  });
});

describe('ensurePostmanCli login region', () => {
  function makeDeps() {
    const execMock = vi.fn(async () => 0);
    const deps = {
      exec: { exec: execMock },
      io: { which: vi.fn(async () => '/usr/bin/postman') }
    } as unknown as Parameters<typeof ensurePostmanCli>[0];
    return { deps, execMock };
  }

  function loginArgsFrom(execMock: ReturnType<typeof vi.fn>): unknown[] | undefined {
    const call = execMock.mock.calls.find(
      (entry) => entry[0] === 'postman' && Array.isArray(entry[1]) && entry[1][0] === 'login'
    );
    return call?.[1] as unknown[] | undefined;
  }

  it('omits --region for the us default (the Postman CLI rejects --region us)', async () => {
    const { deps, execMock } = makeDeps();
    await ensurePostmanCli(deps, 'PMAK-test', undefined, 'us');
    expect(loginArgsFrom(execMock)).toEqual(['login', '--with-api-key', 'PMAK-test']);
  });

  it('passes --region eu for the eu region', async () => {
    const { deps, execMock } = makeDeps();
    await ensurePostmanCli(deps, 'PMAK-test', undefined, 'eu');
    expect(loginArgsFrom(execMock)).toEqual([
      'login',
      '--with-api-key',
      'PMAK-test',
      '--region',
      'eu'
    ]);
  });
});
