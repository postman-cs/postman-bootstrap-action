import { describe, expect, it, vi } from 'vitest';

import {
  SAFE_FETCH_LIMITS,
  classifySafeFetchRetryability,
  isBlockedAddress,
  isRetryableSafeFetchError,
  safeFetchText,
  validateSafeHttpsUrl,
  type SafeFetchTransport
} from '../src/lib/spec/safe-spec-fetch.js';

describe('safe OpenAPI spec fetch', () => {
  it('allows only public HTTPS URLs without credentials', () => {
    expect(validateSafeHttpsUrl('https://example.com/openapi.yaml').href).toBe('https://example.com/openapi.yaml');

    [
      'http://example.com/openapi.yaml',
      `https://${['user', 'pass'].join(':')}@example.com/openapi.yaml`,
      'https://localhost/openapi.yaml',
      'https://api.internal/openapi.yaml',
      'https://service.local/openapi.yaml',
      'https://10.0.0.1/openapi.yaml',
      'https://127.0.0.1/openapi.yaml',
      'https://[::1]/openapi.yaml'
    ].forEach((url) => {
      expect(() => validateSafeHttpsUrl(url), url).toThrow(/CONTRACT_SPEC_FETCH_BLOCKED/);
    });
  });

  it('classifies private and reserved IP addresses as blocked', () => {
    [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.1.1',
      '::ffff:127.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      'fec0::1',
      'feff:ffff::1'
    ].forEach((address) => expect(isBlockedAddress(address), address).toBe(true));

    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false);
    expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
  });

  it('pins DNS resolution when fetching the root spec', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockResolvedValue({
      body: 'openapi: 3.1.0\n',
      headers: {},
      remoteAddress: '93.184.216.34',
      statusCode: 200
    });

    const text = await safeFetchText('https://example.com/openapi.yaml', { lookup, transport });

    expect(text).toBe('openapi: 3.1.0\n');
    expect(lookup).toHaveBeenCalledWith('example.com');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, options] = vi.mocked(transport).mock.calls[0]!;
    expect(url.hostname).toBe('example.com');
    expect(options.pinnedAddress).toBe('93.184.216.34');
    expect(options.maxBytes).toBe(SAFE_FETCH_LIMITS.maxBytesPerResource);
    expect(options.headers.Host).toBe('example.com');
  });

  it('blocks DNS resolution to private addresses before transport', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn();

    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, transport })
    ).rejects.toThrow(/CONTRACT_SPEC_FETCH_BLOCKED: DNS for example\.com resolved to blocked address 127\.0\.0\.1/);
    expect(transport).not.toHaveBeenCalled();
  });

  it('revalidates redirects with the same safety policy', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockResolvedValue({
      body: '',
      headers: { location: 'https://localhost/openapi.yaml' },
      remoteAddress: '93.184.216.34',
      statusCode: 302
    });

    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, transport })
    ).rejects.toThrow(/CONTRACT_SPEC_FETCH_BLOCKED: Private hostname is not allowed: localhost/);
  });

  it('rejects responses from non-pinned remote addresses', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockResolvedValue({
      body: 'openapi: 3.1.0\n',
      headers: {},
      remoteAddress: '93.184.216.35',
      statusCode: 200
    });

    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, transport })
    ).rejects.toThrow(/CONTRACT_SPEC_FETCH_BLOCKED: Remote socket address for example\.com was not DNS-pinned/);
  });

  it('rejects responses when the remote socket address cannot be verified', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockResolvedValue({
      body: 'openapi: 3.1.0\n',
      headers: {},
      statusCode: 200
    });

    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, transport })
    ).rejects.toThrow(/CONTRACT_SPEC_FETCH_BLOCKED: Remote socket address for example\.com was not DNS-pinned/);
  });

  it('accepts IPv4-mapped IPv6 socket addresses when they match the pinned DNS record', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockResolvedValue({
      body: 'openapi: 3.1.0\n',
      headers: {},
      remoteAddress: '::ffff:93.184.216.34',
      statusCode: 200
    });

    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, transport })
    ).resolves.toBe('openapi: 3.1.0\n');
  });

  it('redacts query strings and fragments from fetch errors', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockRejectedValue(
      new Error('upstream failure for https://example.com/openapi.yaml?token=secret#frag')
    );

    await expect(
      safeFetchText('https://example.com/openapi.yaml?token=secret#frag', { lookup, transport })
    ).rejects.toThrow(/OpenAPI fetch failed for https:\/\/example\.com\/openapi\.yaml:/);

    try {
      await safeFetchText('https://example.com/openapi.yaml?token=secret#frag', { lookup, transport });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain('token=secret');
      expect(message).not.toContain('#frag');
    }
  });

  it('classifies safe-fetch failures by retryability', () => {
    [
      'CONTRACT_SPEC_FETCH_FAILED: DNS lookup failed for example.com: ENOTFOUND',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI fetch failed for https://example.com/openapi.yaml: socket hang up',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI resource returned HTTP 408',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI resource returned HTTP 429',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI resource returned HTTP 500'
    ].forEach((message) => {
      expect(classifySafeFetchRetryability(new Error(message)), message).toBe('retryable');
      expect(isRetryableSafeFetchError(new Error(message)), message).toBe(true);
    });

    [
      'CONTRACT_SPEC_FETCH_BLOCKED: Private hostname is not allowed: localhost',
      'CONTRACT_REF_LIMIT_EXCEEDED: OpenAPI external ref count exceeded 100',
      'CONTRACT_REF_DEPTH_EXCEEDED: OpenAPI ref depth exceeded 20',
      'CONTRACT_REF_SIZE_EXCEEDED: OpenAPI resource exceeded 25 bytes',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI resource returned HTTP 400',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI resource returned HTTP 404',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI redirect omitted Location header',
      'CONTRACT_SPEC_FETCH_FAILED: OpenAPI fetch exceeded 5 redirects'
    ].forEach((message) => {
      expect(classifySafeFetchRetryability(new Error(message)), message).toBe('permanent');
      expect(isRetryableSafeFetchError(new Error(message)), message).toBe(false);
    });

    expect(classifySafeFetchRetryability(new Error('plain fetch failed'))).toBe('unknown');
  });

  it('enforces ref count, depth, and resource size limits', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 as const }]);
    const transport: SafeFetchTransport = vi.fn().mockResolvedValue({
      body: 'abcdef',
      headers: {},
      remoteAddress: '93.184.216.34',
      statusCode: 200
    });

    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, maxExternalRefs: 0, transport })
    ).rejects.toThrow(/CONTRACT_REF_LIMIT_EXCEEDED/);
    await expect(
      safeFetchText('https://example.com/openapi.yaml', { depth: 1, lookup, maxDepth: 0, transport })
    ).rejects.toThrow(/CONTRACT_REF_DEPTH_EXCEEDED/);
    await expect(
      safeFetchText('https://example.com/openapi.yaml', { lookup, maxBytesPerResource: 5, transport })
    ).rejects.toThrow(/CONTRACT_REF_SIZE_EXCEEDED/);
  });
});
