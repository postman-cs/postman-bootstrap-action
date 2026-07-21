import { createHash } from 'node:crypto';

import { SAFE_FETCH_LIMITS } from './safe-spec-fetch.js';

export type DefinitionFormat =
  | 'openapi-json'
  | 'openapi-yaml'
  | 'protobuf'
  | 'wsdl'
  | 'graphql-sdl'
  | 'graphql-introspection-json'
  | 'asyncapi-json'
  | 'asyncapi-yaml'
  | 'mcp-json';

export type DefinitionFileRole = 'root' | 'dependency';
export type DefinitionCompleteness = 'full' | 'partial';

export interface DefinitionFile {
  path: string;
  role: DefinitionFileRole;
  bytes: Uint8Array;
  content: string;
  byteLength: number;
  sha256: string;
}

export interface DefinitionProvenance {
  source: 'spec-path' | 'spec-url' | 'discovery-inventory';
  provider?: 'aws' | 'gcp' | 'azure';
  evidence: string[];
}

export interface DefinitionBundle {
  schemaVersion: 1;
  rootPath: string;
  format: DefinitionFormat;
  completeness: DefinitionCompleteness;
  provenance: DefinitionProvenance;
  files: ReadonlyMap<string, DefinitionFile>;
  digest: string;
}

export interface DefinitionInventoryFile {
  path: string;
  role: DefinitionFileRole;
  bytes: number;
  sha256: string;
}

export interface DefinitionInventory {
  schemaVersion: 1;
  root: string;
  format: DefinitionFormat;
  completeness: DefinitionCompleteness;
  provenance: {
    kind: 'provider';
    provider: 'aws' | 'gcp' | 'azure';
  };
  files: DefinitionInventoryFile[];
}

export const DEFINITION_BUNDLE_LIMITS = {
  maxFiles: 101,
  maxDepth: SAFE_FETCH_LIMITS.maxDepth,
  maxBytesPerResource: SAFE_FETCH_LIMITS.maxBytesPerResource,
  maxTotalBytes: SAFE_FETCH_LIMITS.maxTotalBytes
} as const;

const DEFINITION_FORMATS = new Set<DefinitionFormat>([
  'openapi-json',
  'openapi-yaml',
  'protobuf',
  'wsdl',
  'graphql-sdl',
  'graphql-introspection-json',
  'asyncapi-json',
  'asyncapi-yaml',
  'mcp-json'
]);

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function caseFoldPathKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

export function assertValidBundleRelativePath(rawPath: string, label = 'path'): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', `${label} must be a non-empty string`);
  }
  if (rawPath.includes('\0')) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', `${label} must not contain NUL`);
  }
  if (rawPath.includes('\\')) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', `${label} must use POSIX separators`);
  }
  if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', `${label} must be a relative POSIX path`);
  }

  const nfc = rawPath.normalize('NFC');
  const segments = nfc.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', `${label} must not contain empty, '.', or '..' segments`);
  }
  if (segments.length > DEFINITION_BUNDLE_LIMITS.maxDepth) {
    fail('CONTRACT_REF_DEPTH_EXCEEDED', `${label} depth exceeded ${DEFINITION_BUNDLE_LIMITS.maxDepth}`);
  }
  return nfc;
}

export function assertNoPathCollisions(paths: Iterable<string>): void {
  const seen = new Map<string, string>();
  for (const pathKey of paths) {
    const normalized = assertValidBundleRelativePath(pathKey);
    const folded = caseFoldPathKey(normalized);
    const prior = seen.get(folded);
    if (prior !== undefined && prior !== normalized) {
      fail('CONTRACT_DEFINITION_DUPLICATE_PATH', `Case/NFC-colliding paths ${prior} and ${normalized}`);
    }
    if (prior === normalized) {
      fail('CONTRACT_DEFINITION_DUPLICATE_PATH', `Duplicate path ${normalized}`);
    }
    seen.set(folded, normalized);
  }
}

export function decodeStrictUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    fail(
      'CONTRACT_DEFINITION_ENCODING_INVALID',
      `Definition member is not valid UTF-8 (${error instanceof Error ? error.message : String(error)})`
    );
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Runtime ReadonlyMap facade. Object.freeze(Map) does not block set/delete/clear
 * because those mutate internal slots; this wrapper exposes only ReadonlyMap surface.
 */
function asReadonlyMap<K, V>(map: Map<K, V>): ReadonlyMap<K, V> {
  const readonly: ReadonlyMap<K, V> = {
    get size() {
      return map.size;
    },
    get(key: K) {
      return map.get(key);
    },
    has(key: K) {
      return map.has(key);
    },
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      map.forEach((value, key) => {
        callbackfn.call(thisArg, value, key, readonly);
      });
    },
    keys() {
      return map.keys();
    },
    values() {
      return map.values();
    },
    entries() {
      return map.entries();
    },
    [Symbol.iterator]() {
      return map.entries();
    }
  };
  return Object.freeze(readonly);
}

export function createDefinitionFile(input: {
  path: string;
  role: DefinitionFileRole;
  bytes: Uint8Array;
}): DefinitionFile {
  const pathKey = assertValidBundleRelativePath(input.path);
  const byteLength = input.bytes.byteLength;
  if (byteLength > DEFINITION_BUNDLE_LIMITS.maxBytesPerResource) {
    fail(
      'CONTRACT_REF_SIZE_EXCEEDED',
      `Definition resource exceeded ${DEFINITION_BUNDLE_LIMITS.maxBytesPerResource} bytes`
    );
  }
  const content = decodeStrictUtf8(input.bytes);
  // Retain a private copy; expose a defensive copy via getter so callers cannot
  // mutate stored bytes/content/hash (TypedArrays cannot be Object.freeze'd).
  const storedBytes = Uint8Array.from(input.bytes);
  const digest = sha256Hex(storedBytes);
  const file: DefinitionFile = {
    path: pathKey,
    role: input.role,
    content,
    byteLength,
    sha256: digest,
    get bytes(): Uint8Array {
      return Uint8Array.from(storedBytes);
    }
  };
  return Object.freeze(file);
}

export function computeDefinitionBundleDigest(input: {
  schemaVersion: 1;
  rootPath: string;
  format: DefinitionFormat;
  files: ReadonlyMap<string, DefinitionFile>;
}): string {
  const files = [...input.files.values()]
    .map((file) => ({
      path: file.path,
      role: file.role,
      byteLength: file.byteLength,
      sha256: file.sha256
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const payload = {
    schemaVersion: 1 as const,
    rootPath: input.rootPath,
    format: input.format,
    files
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

export function createDefinitionBundle(input: {
  rootPath: string;
  format: DefinitionFormat;
  completeness: DefinitionCompleteness;
  provenance: DefinitionProvenance;
  files: DefinitionFile[];
}): DefinitionBundle {
  const rootPath = assertValidBundleRelativePath(input.rootPath, 'rootPath');
  if (input.files.length > DEFINITION_BUNDLE_LIMITS.maxFiles) {
    fail(
      'CONTRACT_REF_COUNT_EXCEEDED',
      `Definition file count exceeded ${DEFINITION_BUNDLE_LIMITS.maxFiles}`
    );
  }
  assertNoPathCollisions(input.files.map((file) => file.path));

  const files = new Map<string, DefinitionFile>();
  let rootCount = 0;
  let totalBytes = 0;
  for (const file of input.files) {
    if (files.has(file.path)) {
      fail('CONTRACT_DEFINITION_DUPLICATE_PATH', `Duplicate path ${file.path}`);
    }
    if (file.role === 'root') rootCount += 1;
    totalBytes += file.byteLength;
    if (totalBytes > DEFINITION_BUNDLE_LIMITS.maxTotalBytes) {
      fail(
        'CONTRACT_REF_SIZE_EXCEEDED',
        `Definition resources exceeded ${DEFINITION_BUNDLE_LIMITS.maxTotalBytes} total bytes`
      );
    }
    files.set(file.path, Object.freeze(file));
  }

  if (rootCount !== 1) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'Bundle must contain exactly one root file');
  }
  const root = files.get(rootPath);
  if (!root || root.role !== 'root') {
    fail('CONTRACT_DEFINITION_ROOT_MISMATCH', `rootPath ${rootPath} must identify the sole root file`);
  }

  const provenance = Object.freeze({
    source: input.provenance.source,
    ...(input.provenance.provider ? { provider: input.provenance.provider } : {}),
    evidence: Object.freeze([...input.provenance.evidence]) as string[]
  });

  const readonlyFiles = asReadonlyMap(files);
  const digest = computeDefinitionBundleDigest({
    schemaVersion: 1,
    rootPath,
    format: input.format,
    files: readonlyFiles
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    rootPath,
    format: input.format,
    completeness: input.completeness,
    provenance,
    files: readonlyFiles,
    digest
  });
}

function parseInventoryProvider(value: unknown): 'aws' | 'gcp' | 'azure' {
  if (value === 'aws' || value === 'gcp' || value === 'azure') return value;
  fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'provenance.provider must be aws, gcp, or azure');
}

export function parseDefinitionInventoryJson(raw: string): DefinitionInventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'spec-files-json is not valid JSON');
  }
  if (!isRecord(parsed)) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'spec-files-json must be a JSON object');
  }
  if (parsed.schemaVersion !== 1) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'schemaVersion must be 1');
  }
  if (typeof parsed.root !== 'string') {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'root must be a string');
  }
  const root = assertValidBundleRelativePath(parsed.root, 'root');
  if (typeof parsed.format !== 'string' || !DEFINITION_FORMATS.has(parsed.format as DefinitionFormat)) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'format is missing or unsupported');
  }
  if (parsed.completeness !== 'full' && parsed.completeness !== 'partial') {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'completeness must be full or partial');
  }
  if (!isRecord(parsed.provenance) || parsed.provenance.kind !== 'provider') {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'provenance.kind must be provider');
  }
  const provider = parseInventoryProvider(parsed.provenance.provider);
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files must be a non-empty array');
  }

  const files: DefinitionInventoryFile[] = [];
  for (const entry of parsed.files) {
    if (!isRecord(entry)) {
      fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'each files[] entry must be an object');
    }
    if (typeof entry.path !== 'string') {
      fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files[].path must be a string');
    }
    if (entry.role !== 'root' && entry.role !== 'dependency') {
      fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files[].role must be root or dependency');
    }
    if (!Number.isInteger(entry.bytes) || Number(entry.bytes) < 0) {
      fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files[].bytes must be a non-negative integer');
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files[].sha256 must be lowercase 64-hex');
    }
    files.push({
      path: assertValidBundleRelativePath(entry.path, 'files[].path'),
      role: entry.role,
      bytes: Number(entry.bytes),
      sha256: entry.sha256
    });
  }

  for (let i = 1; i < files.length; i += 1) {
    if (files[i - 1]!.path >= files[i]!.path) {
      fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files must be sorted by path ascending');
    }
  }

  assertNoPathCollisions(files.map((file) => file.path));

  const roots = files.filter((file) => file.role === 'root');
  if (roots.length !== 1) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'files must contain exactly one root');
  }
  if (roots[0]!.path !== root) {
    fail('CONTRACT_DEFINITION_ROOT_MISMATCH', 'inventory root must equal the sole root file path');
  }

  return {
    schemaVersion: 1,
    root,
    format: parsed.format as DefinitionFormat,
    completeness: parsed.completeness,
    provenance: { kind: 'provider', provider },
    files
  };
}

export function isOpenApiDefinitionFormat(format: DefinitionFormat): boolean {
  return format === 'openapi-json' || format === 'openapi-yaml';
}
