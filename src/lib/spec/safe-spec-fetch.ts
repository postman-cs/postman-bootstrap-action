import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { URL } from 'node:url';

export const SAFE_FETCH_LIMITS = {
  maxRedirects: 5,
  maxExternalRefs: 100,
  maxDepth: 20,
  maxBytesPerResource: 25 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024
} as const;

export interface SafeFetchBudget {
  refs: number;
  totalBytes: number;
}

export interface SafeFetchTransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
  remoteAddress?: string;
}

export type SafeLookup = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
export type SafeFetchTransport = (
  url: URL,
  options: { pinnedAddress: string; family: 4 | 6; headers: Record<string, string>; maxBytes: number; timeoutMs: number }
) => Promise<SafeFetchTransportResponse>;

export interface SafeFetchOptions {
  budget?: SafeFetchBudget;
  depth?: number;
  lookup?: SafeLookup;
  maxBytesPerResource?: number;
  maxDepth?: number;
  maxRedirects?: number;
  maxTotalBytes?: number;
  maxExternalRefs?: number;
  timeoutMs?: number;
  transport?: SafeFetchTransport;
}

export type SafeFetchRetryability = 'permanent' | 'retryable' | 'unknown';

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function sanitizeUrlForError(input: string | URL): string {
  try {
    const url = new URL(input.toString());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid OpenAPI URL]';
  }
}

function redactUrlsInMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s'"<>]+/g, (match) => sanitizeUrlForError(match));
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets;
}

function dottedIPv4TailToHextets(address: string): string {
  const match = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (!match) return address;
  const octets = parseIPv4(match[2]!);
  if (!octets) return address;
  const high = ((octets[0]! << 8) | octets[1]!).toString(16);
  const low = ((octets[2]! << 8) | octets[3]!).toString(16);
  return `${match[1]}${high}:${low}`;
}

function embeddedIPv4(parts: string[]): string | null {
  const high = Number.parseInt(parts[6] ?? '', 16);
  const low = Number.parseInt(parts[7] ?? '', 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return null;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function normalizeIpAddress(address: string): string {
  const withoutZone = address.trim().toLowerCase().split('%')[0] ?? '';
  const converted = dottedIPv4TailToHextets(withoutZone);
  const kind = isIP(converted);
  if (kind === 4) return converted;
  if (kind !== 6) return converted;
  const parts = expandIPv6(converted);
  if (parts.slice(0, 5).every((part) => part === '0000') && parts[5] === 'ffff') {
    return embeddedIPv4(parts) ?? converted;
  }
  if (parts.slice(0, 6).every((part) => part === '0000')) {
    return embeddedIPv4(parts) ?? converted;
  }
  return parts.join(':');
}

function isBlockedIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) return true;
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIPv6(address: string): string[] {
  const [headRaw, tailRaw] = dottedIPv4TailToHextets(address).toLowerCase().split('::') as [string, string?];
  const head = headRaw ? headRaw.split(':').filter(Boolean) : [];
  const tail = tailRaw ? tailRaw.split(':').filter(Boolean) : [];
  const missing = Math.max(0, 8 - head.length - tail.length);
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
    .map((part) => part.padStart(4, '0'));
}

function isBlockedIPv6(address: string): boolean {
  const normalized = dottedIPv4TailToHextets(address).toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  const parts = expandIPv6(normalized);
  const first = Number.parseInt(parts[0] ?? '0', 16);
  const second = Number.parseInt(parts[1] ?? '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (first === 0x0064 && second === 0xff9b) return true; // 64:ff9b::/32 and 64:ff9b:1::/48 translation ranges
  if (first === 0x0100 && parts.slice(1, 4).every((part) => part === '0000')) return true; // 100::/64 discard-only block
  if (first === 0x2001 && second <= 0x01ff) return true; // IETF special-purpose 2001::/23
  if (first === 0x2001 && second === 0x0db8) return true; // documentation prefix
  if (first === 0x2002) return true; // 6to4
  if (parts.slice(0, 5).every((part) => part === '0000') && parts[5] === 'ffff') {
    const embedded = embeddedIPv4(parts);
    return !embedded || isBlockedIPv4(embedded);
  }
  if (parts.slice(0, 6).every((part) => part === '0000')) {
    const embedded = embeddedIPv4(parts);
    return !embedded || isBlockedIPv4(embedded);
  }
  return false;
}

export function isBlockedAddress(address: string): boolean {
  const normalized = normalizeIpAddress(address);
  const kind = isIP(normalized);
  if (kind === 4) return isBlockedIPv4(normalized);
  if (kind === 6) return isBlockedIPv6(normalized);
  return true;
}

export function validateSafeHttpsUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    fail('CONTRACT_SPEC_FETCH_BLOCKED', 'Invalid OpenAPI URL');
  }
  if (url.protocol !== 'https:') {
    fail('CONTRACT_SPEC_FETCH_BLOCKED', `Only HTTPS OpenAPI URLs and refs are allowed: ${url.protocol}`);
  }
  if (url.username || url.password) {
    fail('CONTRACT_SPEC_FETCH_BLOCKED', 'Credentials in OpenAPI URLs and refs are not allowed');
  }
  const hostname = url.hostname.toLowerCase();
  const addressHost = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    fail('CONTRACT_SPEC_FETCH_BLOCKED', `Private hostname is not allowed: ${hostname}`);
  }
  if (isIP(addressHost) && isBlockedAddress(addressHost)) {
    fail('CONTRACT_SPEC_FETCH_BLOCKED', `Private IP address is not allowed: ${addressHost}`);
  }
  return url;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

export function createPinnedLookup(pinnedAddress: string, family: 4 | 6): NonNullable<RequestOptions['lookup']> {
  return (_hostname: string, options: unknown, callback?: unknown) => {
    if (typeof options === 'function') {
      options(null, pinnedAddress, family);
      return;
    }
    const typedCallback = callback as
      | ((error: NodeJS.ErrnoException | null, address: string, family: number) => void)
      | ((error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void);
    if ((options as { all?: boolean } | undefined)?.all) {
      (typedCallback as (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: 4 | 6 }>) => void)(
        null,
        [{ address: pinnedAddress, family }]
      );
      return;
    }
    (typedCallback as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(
      null,
      pinnedAddress,
      family
    );
  };
}

async function defaultTransport(
  url: URL,
  options: { pinnedAddress: string; family: 4 | 6; headers: Record<string, string>; maxBytes: number; timeoutMs: number }
): Promise<SafeFetchTransportResponse> {
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: options.headers,
      servername: url.hostname,
      timeout: options.timeoutMs,
      lookup: createPinnedLookup(options.pinnedAddress, options.family)
    };
    const req = httpsRequest(requestOptions, (res) => {
      const remoteAddress = res.socket?.remoteAddress;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > options.maxBytes) {
          req.destroy(new Error(`CONTRACT_REF_SIZE_EXCEEDED: OpenAPI resource exceeded ${options.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          remoteAddress
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('Timed out fetching OpenAPI resource'));
    });
    req.on('error', reject);
    req.end();
  });
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return Array.isArray(found) ? found[0] : found;
}

function errorMessage(error: unknown): string {
  return redactUrlsInMessage(error instanceof Error ? error.message : String(error));
}

function contractErrorCode(message: string): string | undefined {
  return /^(CONTRACT_[A-Z0-9_]+):/.exec(message)?.[1];
}

function retryabilityForHttpStatus(status: number): SafeFetchRetryability {
  if (status === 408 || status === 429 || status >= 500) {
    return 'retryable';
  }
  return 'permanent';
}

export function classifySafeFetchRetryability(error: unknown): SafeFetchRetryability {
  const message = errorMessage(error);
  const code = contractErrorCode(message);
  if (!code) return 'unknown';
  if (code !== 'CONTRACT_SPEC_FETCH_FAILED') return 'permanent';

  const status = /(?:^|\s)HTTP\s+(\d{3})(?:\s|$)/.exec(message)?.[1];
  if (status) {
    return retryabilityForHttpStatus(Number.parseInt(status, 10));
  }
  if (
    message.includes('DNS lookup failed') ||
    message.includes('OpenAPI fetch failed for')
  ) {
    return 'retryable';
  }
  return 'permanent';
}

export function isRetryableSafeFetchError(error: unknown): boolean {
  return classifySafeFetchRetryability(error) === 'retryable';
}

function throwIfContractError(error: unknown): void {
  if (/^CONTRACT_[A-Z0-9_]+:/.test(errorMessage(error))) {
    throw error;
  }
}

function normalizeLookupAddresses(addresses: Array<{ address: string; family: 4 | 6 }>): Array<{ address: string; family: 4 | 6 }> {
  return addresses.map((entry) => {
    const address = normalizeIpAddress(entry.address);
    const family = isIP(address);
    if (family !== 4 && family !== 6) {
      fail('CONTRACT_SPEC_FETCH_BLOCKED', `DNS resolved to invalid address ${entry.address}`);
    }
    return { address, family };
  });
}

export async function safeFetchText(input: string, options: SafeFetchOptions = {}): Promise<string> {
  const budget = options.budget ?? { refs: 0, totalBytes: 0 };
  const maxExternalRefs = options.maxExternalRefs ?? SAFE_FETCH_LIMITS.maxExternalRefs;
  const maxDepth = options.maxDepth ?? SAFE_FETCH_LIMITS.maxDepth;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_LIMITS.maxRedirects;
  const maxBytesPerResource = options.maxBytesPerResource ?? SAFE_FETCH_LIMITS.maxBytesPerResource;
  const maxTotalBytes = options.maxTotalBytes ?? SAFE_FETCH_LIMITS.maxTotalBytes;
  const timeoutMs = options.timeoutMs ?? 15000;
  const depth = options.depth ?? 0;
  if (depth > maxDepth) fail('CONTRACT_REF_DEPTH_EXCEEDED', `OpenAPI ref depth exceeded ${maxDepth}`);
  budget.refs += 1;
  if (budget.refs > maxExternalRefs) {
    fail('CONTRACT_REF_LIMIT_EXCEEDED', `OpenAPI external ref count exceeded ${maxExternalRefs}`);
  }

  let url = validateSafeHttpsUrl(input);
  const lookup = options.lookup ?? defaultLookup;
  const transport = options.transport ?? defaultTransport;

  for (let redirectCount = 0; ; redirectCount += 1) {
    let addresses: Array<{ address: string; family: 4 | 6 }>;
    try {
      addresses = normalizeLookupAddresses(await lookup(url.hostname));
    } catch (error) {
      throwIfContractError(error);
      fail('CONTRACT_SPEC_FETCH_FAILED', `DNS lookup failed for ${url.hostname}: ${errorMessage(error)}`);
    }
    if (addresses.length === 0) fail('CONTRACT_SPEC_FETCH_BLOCKED', `No DNS records for ${url.hostname}`);
    for (const entry of addresses) {
      if (isBlockedAddress(entry.address)) {
        fail('CONTRACT_SPEC_FETCH_BLOCKED', `DNS for ${url.hostname} resolved to blocked address ${entry.address}`);
      }
    }
    const pinned = addresses[0]!;
    const headers = {
      Accept: 'application/yaml, application/json, text/yaml, text/plain, */*',
      Host: url.host,
      'User-Agent': 'postman-bootstrap-action'
    };
    let response: SafeFetchTransportResponse;
    try {
      response = await transport(url, {
        pinnedAddress: pinned.address,
        family: pinned.family,
        headers,
        maxBytes: Math.min(maxBytesPerResource, maxTotalBytes - budget.totalBytes),
        timeoutMs
      });
    } catch (error) {
      throwIfContractError(error);
      fail('CONTRACT_SPEC_FETCH_FAILED', `OpenAPI fetch failed for ${sanitizeUrlForError(url)}: ${errorMessage(error)}`);
    }
    const remoteAddress = response.remoteAddress ? normalizeIpAddress(response.remoteAddress) : undefined;
    if (!remoteAddress || isBlockedAddress(remoteAddress) || !addresses.some((entry) => entry.address === remoteAddress)) {
      fail('CONTRACT_SPEC_FETCH_BLOCKED', `Remote socket address for ${url.hostname} was not DNS-pinned`);
    }
    const status = response.statusCode;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirectCount >= maxRedirects) {
        fail('CONTRACT_SPEC_FETCH_FAILED', `OpenAPI fetch exceeded ${maxRedirects} redirects`);
      }
      const location = headerValue(response.headers, 'location');
      if (!location) fail('CONTRACT_SPEC_FETCH_FAILED', 'OpenAPI redirect omitted Location header');
      url = validateSafeHttpsUrl(new URL(location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      fail('CONTRACT_SPEC_FETCH_FAILED', `OpenAPI resource returned HTTP ${status}`);
    }
    const body = typeof response.body === 'string' ? response.body : response.body.toString('utf8');
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > maxBytesPerResource) {
      fail('CONTRACT_REF_SIZE_EXCEEDED', `OpenAPI resource exceeded ${maxBytesPerResource} bytes`);
    }
    budget.totalBytes += bytes;
    if (budget.totalBytes > maxTotalBytes) {
      fail('CONTRACT_REF_SIZE_EXCEEDED', `OpenAPI resources exceeded ${maxTotalBytes} total bytes`);
    }
    return body;
  }
}
