export const REDACTED = '[REDACTED]';
export type SecretMasker = (input: string) => string;
export type HeaderBag =
  | Array<[string, string]>
  | Headers
  | Record<string, string>;

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-access-token',
  'x-api-key'
]);

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  );
}

function appendSecretValues(value: unknown, results: string[]): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized) {
      results.push(normalized);
    }
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    results.push(String(value));
    return;
  }
  if (Array.isArray(value) || isIterable(value)) {
    for (const entry of value) {
      appendSecretValues(entry, results);
    }
  }
}

export function normalizeSecretValues(secretValues: unknown): string[] {
  const values: string[] = [];
  appendSecretValues(secretValues, values);
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

export function redactSecrets(
  input: string,
  secretValues: unknown,
  replacement = REDACTED
): string {
  const source = String(input ?? '');
  const secrets = normalizeSecretValues(secretValues);
  if (!source || secrets.length === 0) {
    return source;
  }
  return secrets.reduce((sanitized, secret) => {
    if (!secret) {
      return sanitized;
    }
    return sanitized.split(secret).join(replacement);
  }, source);
}

export function createSecretMasker(
  secretValues: unknown,
  replacement = REDACTED
): SecretMasker {
  return (input: string) => redactSecrets(input, secretValues, replacement);
}

export interface MutableSecretMasker {
  mask: SecretMasker;
  add(value: string): void;
}

/**
 * A masker whose secret set can grow at runtime. Required because access tokens
 * may be re-minted mid-run; the new token must be redacted by the same masker
 * instance already threaded into the HTTP clients.
 */
export function createMutableSecretMasker(
  initialSecretValues: unknown = [],
  replacement = REDACTED
): MutableSecretMasker {
  const secrets: string[] = normalizeSecretValues(initialSecretValues);
  return {
    mask: (input: string) => redactSecrets(input, secrets, replacement),
    add(value: string): void {
      const normalized = String(value ?? '').trim();
      if (normalized && !secrets.includes(normalized)) {
        secrets.push(normalized);
      }
    }
  };
}

function headerEntries(headers: HeaderBag): Array<[string, string]> {
  if (headers instanceof Headers) {
    return Array.from(headers.entries());
  }
  if (Array.isArray(headers)) {
    return headers.map(([name, value]) => [name, String(value)]);
  }
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

export function sanitizeHeaders(
  headers: HeaderBag | undefined,
  secretValues: unknown
): Record<string, string> {
  if (!headers) {
    return {};
  }
  const sanitized: Record<string, string> = {};
  for (const [name, value] of headerEntries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = SENSITIVE_HEADER_NAMES.has(normalizedName)
      ? REDACTED
      : redactSecrets(value, secretValues);
  }
  return sanitized;
}
