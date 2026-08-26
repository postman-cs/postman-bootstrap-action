import {
  createSecretsResolverItem,
  isSecretsResolverEnabled,
  isSecretsResolverItemName,
  type SecretsResolverProvider
} from '@postman-cs/automation-core';

export {
  createSecretsResolverExec,
  createSecretsResolverItem,
  createSecretsResolverV3Body,
  DEFAULT_SECRETS_RESOLVER_PROVIDER,
  isSecretsResolverEnabled,
  parseSecretsResolverProvider,
  SECRETS_RESOLVER_ITEM_NAME,
  SECRETS_RESOLVER_PROVIDERS,
  secretsResolverEnvironmentKeys,
  type SecretsResolverProvider
} from '@postman-cs/automation-core';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Exact smoke liveness assertions currently injected by the cloud adapter
 * (`injectTests(..., 'smoke')`). Kept here as a pure v2 helper so pre-write
 * role payloads can embed the same script without a post-create PATCH.
 */
export function createSmokeTestExec(): string[] {
  return [
    '// [Smoke] Auto-generated test assertions',
    '',
    "pm.test('Status code is not an error (2xx or 3xx)', function () {",
    '    // Smoke is a generic liveness check, not a contract: a 3xx redirect is a',
    '    // legitimate non-error response, so assert < 400 rather than strict 2xx.',
    '    pm.expect(pm.response.code, "expected a non-error HTTP status (< 400)").to.be.below(400);',
    '});',
    '',
    "pm.test('Response time is acceptable', function () {",
    "    var threshold = parseInt(pm.environment.get('RESPONSE_TIME_THRESHOLD') || '2000', 10);",
    '    pm.expect(pm.response.responseTime).to.be.below(threshold);',
    '});',
    '',
    "pm.test('Response body is not empty', function () {",
    "    var bodyless = pm.response.code === 204 || pm.response.code === 205 || pm.response.code === 304 || pm.request.method === 'HEAD';",
    "    var contentLength = pm.response.headers.get('Content-Length');",
    "    // A legitimate empty-body response (e.g. a 200/201 with Content-Length: 0)",
    '    // must not false-fail this generic smoke check.',
    "    if (contentLength !== null && contentLength !== undefined && String(contentLength).trim() === '0') { return; }",
    '    if (!bodyless) {',
    '        var body = pm.response.text();',
    '        pm.expect(body.length).to.be.above(0);',
    '    }',
    '});'
  ];
}

function isSecretsResolverItem(item: JsonRecord): boolean {
  return isSecretsResolverItemName(item.name);
}

function injectSmokeEvents(item: JsonRecord, exec: string[]): void {
  if (isSecretsResolverItem(item)) return;
  if (item.request) {
    const events = asArray(item.event).filter((entry) => asRecord(entry)?.listen !== 'test');
    item.event = [
      ...events,
      {
        listen: 'test',
        script: { type: 'text/javascript', exec: [...exec] }
      }
    ];
  }
  for (const child of asArray(item.item)) {
    const childRecord = asRecord(child);
    if (childRecord) injectSmokeEvents(childRecord, exec);
  }
}

/**
 * Deep-clone a v2 collection and embed complete smoke `item.event` test scripts.
 * The secrets-resolver helper is prepended only when a provider is selected, so
 * consumers that use no cloud secret store ship no resolver request at all.
 * Does not touch the filesystem or cloud APIs.
 */
export function instrumentSmokeCollection(
  collection: JsonRecord,
  provider: SecretsResolverProvider = 'none'
): JsonRecord {
  const cloned = deepClone(collection);
  const exec = createSmokeTestExec();
  const items = asArray(cloned.item)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .filter((entry) => !isSecretsResolverItem(entry));
  for (const item of items) injectSmokeEvents(item, exec);
  cloned.item = isSecretsResolverEnabled(provider)
    ? [createSecretsResolverItem(provider), ...items]
    : items;
  return cloned;
}
