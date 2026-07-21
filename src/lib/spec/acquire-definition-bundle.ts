import { openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { detectSpecType } from './detect-spec-type.js';
import {
  DEFINITION_BUNDLE_LIMITS,
  assertValidBundleRelativePath,
  caseFoldPathKey,
  createDefinitionBundle,
  createDefinitionFile,
  isOpenApiDefinitionFormat,
  parseDefinitionInventoryJson,
  sha256Hex,
  type DefinitionBundle,
  type DefinitionFile,
  type DefinitionFormat,
  type DefinitionInventory,
  type DefinitionProvenance
} from './definition-bundle.js';

export interface AcquireDefinitionBundleOptions {
  workspaceRoot: string;
  specPath: string;
  specFilesJson?: string;
  provenance?: DefinitionProvenance;
  /** Invoked only when a caller-supplied read would escape; acquisition itself never calls this for escapes. */
  onUnsafeReadAttempt?: (attemptedPath: string) => void;
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function resolveWorkspaceRoot(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function toPosixRelative(from: string, to: string): string {
  const rel = path.relative(from, to);
  return rel.split(path.sep).join('/');
}

function normalizeWorkspaceRelativePath(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    fail('CONTRACT_SPEC_PATH_ESCAPE', 'spec-path must not be empty');
  }
  if (raw.includes('\0') || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', 'spec-path must be a relative workspace path');
  }
  const posix = raw.replace(/\\/g, '/').normalize('NFC');
  if (posix.startsWith('/') || posix.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', 'spec-path must not escape via absolute, empty, ".", or ".." segments');
  }
  return posix;
}

function assertInsideDir(parentAbs: string, childAbs: string, code = 'CONTRACT_SPEC_PATH_ESCAPE'): void {
  const rel = path.relative(parentAbs, childAbs);
  // Empty rel means childAbs === parentAbs (valid for bundleBase === workspaceRoot).
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(code, 'Path escapes the allowed directory');
  }
}

/**
 * Open a regular file without following the final path component as a symlink.
 * Every path segment under workspaceRoot is checked with lstat and must stay confined.
 */
function readConfinedFileBytes(
  workspaceRoot: string,
  workspaceRelativePath: string,
  bundleBaseAbs: string | null
): { bytes: Uint8Array; absolutePath: string } {
  const normalized = normalizeWorkspaceRelativePath(workspaceRelativePath);
  const absolutePath = path.resolve(workspaceRoot, ...normalized.split('/'));
  assertInsideDir(workspaceRoot, absolutePath);

  // Walk each segment and reject symlinks (including intermediate directories).
  let cursor = workspaceRoot;
  const segments = normalized.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    cursor = path.join(cursor, segments[i]!);
    assertInsideDir(workspaceRoot, cursor);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      fail('CONTRACT_SPEC_READ_FAILED', `Unable to read spec at ${workspaceRelativePath}`);
    }
    if (st.isSymbolicLink()) {
      fail('CONTRACT_SPEC_PATH_SYMLINK', `Symlinked definition path is not allowed: ${workspaceRelativePath}`);
    }
    if (i < segments.length - 1 && !st.isDirectory()) {
      fail('CONTRACT_SPEC_PATH_NOT_FILE', `Expected directory segment for ${workspaceRelativePath}`);
    }
    if (i === segments.length - 1) {
      if (!st.isFile()) {
        fail('CONTRACT_SPEC_PATH_NOT_FILE', `spec-path must be a regular file: ${workspaceRelativePath}`);
      }
      if (st.size > DEFINITION_BUNDLE_LIMITS.maxBytesPerResource) {
        fail(
          'CONTRACT_REF_SIZE_EXCEEDED',
          `Definition resource exceeded ${DEFINITION_BUNDLE_LIMITS.maxBytesPerResource} bytes`
        );
      }
    }
  }

  if (bundleBaseAbs) {
    assertInsideDir(bundleBaseAbs, absolutePath);
  }

  let fd: number | undefined;
  let result: { bytes: Uint8Array; absolutePath: string } | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    fd = openSync(absolutePath, flags);
    const st = fstatSync(fd);
    if (!st.isFile()) {
      fail('CONTRACT_SPEC_PATH_NOT_FILE', `spec-path must be a regular file: ${workspaceRelativePath}`);
    }
    if (st.size > DEFINITION_BUNDLE_LIMITS.maxBytesPerResource) {
      fail(
        'CONTRACT_REF_SIZE_EXCEEDED',
        `Definition resource exceeded ${DEFINITION_BUNDLE_LIMITS.maxBytesPerResource} bytes`
      );
    }
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    if (offset !== st.size) {
      fail('CONTRACT_SPEC_READ_FAILED', `Unable to read complete file at ${workspaceRelativePath}`);
    }
    result = { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), absolutePath };
  } catch (error) {
    if (error instanceof Error && /^CONTRACT_/.test(error.message)) throw error;
    fail('CONTRACT_SPEC_READ_FAILED', `Unable to read spec at ${workspaceRelativePath}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
  if (!result) {
    fail('CONTRACT_SPEC_READ_FAILED', `Unable to read spec at ${workspaceRelativePath}`);
  }
  return result;
}

function detectDefinitionFormat(content: string, fileName: string): DefinitionFormat {
  const specType = detectSpecType(content, fileName);
  const lower = fileName.toLowerCase();
  switch (specType) {
    case 'openapi':
      return lower.endsWith('.json') ? 'openapi-json' : 'openapi-yaml';
    case 'grpc':
      return 'protobuf';
    case 'soap':
      return 'wsdl';
    case 'graphql': {
      const trimmed = content.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'graphql-introspection-json';
      return 'graphql-sdl';
    }
    case 'asyncapi':
      return lower.endsWith('.json') ? 'asyncapi-json' : 'asyncapi-yaml';
    case 'mcp':
      return 'mcp-json';
    default:
      return 'openapi-yaml';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseDocument(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return parseYaml(content) as unknown;
  }
}

function collectExternalRefTargets(node: unknown, refs: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((entry) => collectExternalRefTargets(entry, refs));
    return;
  }
  const record = asRecord(node);
  if (!record) return;
  const ref = typeof record.$ref === 'string' ? record.$ref : '';
  if (ref && !ref.startsWith('#')) {
    const target = ref.split('#', 1)[0] ?? '';
    if (target) refs.add(target);
  }
  for (const value of Object.values(record)) {
    collectExternalRefTargets(value, refs);
  }
}

/** Well-known protobuf import prefixes that may be absent from a local bundle. */
const WELL_KNOWN_PROTO_PREFIXES = [
  'google/protobuf/',
  'google/rpc/',
  'google/api/',
  'google/type/',
  'google/longrunning/'
] as const;

function isWellKnownProtoImport(importPath: string): boolean {
  const normalized = importPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return WELL_KNOWN_PROTO_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function collectOpenApiOrAsyncApiRefTargets(content: string): string[] {
  const refs = new Set<string>();
  let document: unknown;
  try {
    document = parseDocument(content);
    collectExternalRefTargets(document, refs);
  } catch {
    // YAML/JSON parse failure: fall back to $ref string scan (AsyncAPI YAML path).
    for (const match of content.matchAll(/\$ref\s*:\s*['"]?([^'"\s#]+)/g)) {
      const target = match[1] ?? '';
      if (target && !target.startsWith('#')) refs.add(target);
    }
    for (const match of content.matchAll(/"\$ref"\s*:\s*"([^"#]+)/g)) {
      const target = match[1] ?? '';
      if (target && !target.startsWith('#')) refs.add(target);
    }
  }
  return [...refs];
}

function collectProtobufImportTargets(content: string): string[] {
  const refs = new Set<string>();
  for (const match of content.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']\s*;/gm)) {
    const target = match[1] ?? '';
    if (target) refs.add(target);
  }
  return [...refs];
}

function collectWsdlXsdImportTargets(content: string): string[] {
  const refs = new Set<string>();
  // wsdl:import / wsdl:include / WSDL 2.0 include — not soap:address location.
  for (const match of content.matchAll(
    /<(?:[\w.-]+:)?(?:import|include)\b[^>]*?\blocation\s*=\s*["']([^"']+)["']/gi
  )) {
    const target = match[1] ?? '';
    if (target) refs.add(target);
  }
  for (const match of content.matchAll(/\bschemaLocation\s*=\s*["']([^"']+)["']/gi)) {
    const target = match[1] ?? '';
    if (target) refs.add(target);
  }
  return [...refs];
}

function collectLocalImportTargets(format: DefinitionFormat, content: string): string[] {
  switch (format) {
    case 'openapi-json':
    case 'openapi-yaml':
    case 'asyncapi-json':
    case 'asyncapi-yaml':
      return collectOpenApiOrAsyncApiRefTargets(content);
    case 'protobuf':
      return collectProtobufImportTargets(content);
    case 'wsdl':
      return collectWsdlXsdImportTargets(content);
    case 'graphql-sdl':
    case 'graphql-introspection-json':
    case 'mcp-json':
      return [];
    default:
      return [];
  }
}

function formatAcquiresLocalClosure(format: DefinitionFormat): boolean {
  return (
    isOpenApiDefinitionFormat(format) ||
    format === 'protobuf' ||
    format === 'wsdl' ||
    format === 'asyncapi-json' ||
    format === 'asyncapi-yaml'
  );
}

function assertInventoryLimitsBeforeRead(inventory: DefinitionInventory): void {
  if (inventory.files.length > DEFINITION_BUNDLE_LIMITS.maxFiles) {
    fail(
      'CONTRACT_REF_COUNT_EXCEEDED',
      `Definition file count exceeded ${DEFINITION_BUNDLE_LIMITS.maxFiles}`
    );
  }
  let declaredTotal = 0;
  for (const entry of inventory.files) {
    if (entry.bytes > DEFINITION_BUNDLE_LIMITS.maxBytesPerResource) {
      fail(
        'CONTRACT_REF_SIZE_EXCEEDED',
        `Definition resource exceeded ${DEFINITION_BUNDLE_LIMITS.maxBytesPerResource} bytes`
      );
    }
    declaredTotal += entry.bytes;
    if (declaredTotal > DEFINITION_BUNDLE_LIMITS.maxTotalBytes) {
      fail(
        'CONTRACT_REF_SIZE_EXCEEDED',
        `Definition resources exceeded ${DEFINITION_BUNDLE_LIMITS.maxTotalBytes} total bytes`
      );
    }
  }
}

function resolveRelativeRef(
  fromBundleKey: string,
  refTarget: string,
  bundleBaseAbs: string,
  workspaceRoot: string
): { bundleKey: string; workspaceRelative: string } {
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(refTarget) ||
    refTarget.startsWith('/') ||
    /^[A-Za-z]:/.test(refTarget) ||
    refTarget.includes('\0')
  ) {
    // Absolute URI / absolute filesystem path — not a local relative member.
    if (refTarget.startsWith('https:')) {
      fail('CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', 'HTTPS refs are not acquired into the local definition bundle');
    }
    fail('CONTRACT_SPEC_PATH_ESCAPE', `Local definition ref must be relative: ${refTarget}`);
  }

  const fromDir = path.posix.dirname(fromBundleKey);
  const joined = path.posix.normalize(fromDir === '.' ? refTarget : path.posix.join(fromDir, refTarget));
  if (
    !joined ||
    joined === '.' ||
    joined.startsWith('../') ||
    joined === '..' ||
    joined.startsWith('/') ||
    joined.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', `Local definition ref escapes bundle base: ${refTarget}`);
  }

  const bundleKey = assertValidBundleRelativePath(joined.normalize('NFC'));
  const absoluteMember = path.resolve(bundleBaseAbs, ...bundleKey.split('/'));
  assertInsideDir(bundleBaseAbs, absoluteMember);
  assertInsideDir(workspaceRoot, absoluteMember);
  const workspaceRelative = toPosixRelative(workspaceRoot, absoluteMember);
  if (
    !workspaceRelative ||
    workspaceRelative.startsWith('../') ||
    workspaceRelative.split('/').some((segment) => segment === '..')
  ) {
    fail('CONTRACT_SPEC_PATH_ESCAPE', `Local definition ref escapes workspace: ${refTarget}`);
  }
  return { bundleKey, workspaceRelative };
}

interface AcquiredMember {
  bundleKey: string;
  workspaceRelative: string;
  bytes: Uint8Array;
  role: 'root' | 'dependency';
}

function acquireLocalClosure(options: {
  workspaceRoot: string;
  bundleBaseAbs: string;
  rootBundleKey: string;
  rootWorkspaceRelative: string;
  rootBytes: Uint8Array;
  format: DefinitionFormat;
}): AcquiredMember[] {
  const members = new Map<string, AcquiredMember>();
  let totalBytes = options.rootBytes.byteLength;
  if (totalBytes > DEFINITION_BUNDLE_LIMITS.maxTotalBytes) {
    fail(
      'CONTRACT_REF_SIZE_EXCEEDED',
      `Definition resources exceeded ${DEFINITION_BUNDLE_LIMITS.maxTotalBytes} total bytes`
    );
  }

  const queue: Array<{ bundleKey: string; workspaceRelative: string; bytes: Uint8Array; depth: number }> = [
    {
      bundleKey: options.rootBundleKey,
      workspaceRelative: options.rootWorkspaceRelative,
      bytes: options.rootBytes,
      depth: 0
    }
  ];
  members.set(options.rootBundleKey, {
    bundleKey: options.rootBundleKey,
    workspaceRelative: options.rootWorkspaceRelative,
    bytes: options.rootBytes,
    role: 'root'
  });

  const openApi = isOpenApiDefinitionFormat(options.format);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > DEFINITION_BUNDLE_LIMITS.maxDepth) {
      fail(
        'CONTRACT_REF_DEPTH_EXCEEDED',
        `${openApi ? 'OpenAPI' : 'Definition'} ref depth exceeded ${DEFINITION_BUNDLE_LIMITS.maxDepth}`
      );
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes);
    } catch {
      fail('CONTRACT_DEFINITION_ENCODING_INVALID', `Definition member is not valid UTF-8: ${current.bundleKey}`);
    }

    if (openApi) {
      try {
        parseDocument(content);
      } catch {
        fail(
          'CONTRACT_SPEC_PARSE_FAILED',
          `Referenced OpenAPI document ${current.bundleKey} is not valid JSON or YAML`
        );
      }
    }

    const refs = collectLocalImportTargets(options.format, content);
    for (const refTarget of refs) {
      if (options.format === 'protobuf' && isWellKnownProtoImport(refTarget)) {
        continue;
      }

      // OpenAPI: https:/http: refs continue through the URL loader. Absolute
      // file: (and other non-http(s) schemes) are not local relative members and
      // must not be deferred for suffix-alias resolution against the bundle.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(refTarget)) {
        if (openApi) {
          if (refTarget.startsWith('https:') || refTarget.startsWith('http:')) {
            continue;
          }
          fail(
            'CONTRACT_DEFINITION_CLOSURE_INCOMPLETE',
            `Absolute local OpenAPI ref is not acquired into the definition bundle: ${refTarget}`
          );
        }
        fail(
          'CONTRACT_DEFINITION_CLOSURE_INCOMPLETE',
          `Remote or absolute reference is not acquired into the local definition bundle: ${refTarget}`
        );
      }
      if (refTarget.startsWith('/') || /^[A-Za-z]:/.test(refTarget)) {
        fail('CONTRACT_SPEC_PATH_ESCAPE', `Local definition ref must be relative: ${refTarget}`);
      }

      let resolved;
      try {
        resolved = resolveRelativeRef(current.bundleKey, refTarget, options.bundleBaseAbs, options.workspaceRoot);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('CONTRACT_SPEC_PATH_ESCAPE')) throw error;
        if (error instanceof Error && error.message.startsWith('CONTRACT_DEFINITION_CLOSURE_INCOMPLETE')) {
          throw error;
        }
        fail('CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', `Unable to resolve local ref ${refTarget}`);
      }

      if (members.has(resolved.bundleKey)) continue;
      if (members.size + 1 > DEFINITION_BUNDLE_LIMITS.maxFiles) {
        fail(
          'CONTRACT_REF_COUNT_EXCEEDED',
          `Definition file count exceeded ${DEFINITION_BUNDLE_LIMITS.maxFiles}`
        );
      }

      let bytes: Uint8Array;
      try {
        bytes = readConfinedFileBytes(options.workspaceRoot, resolved.workspaceRelative, options.bundleBaseAbs).bytes;
      } catch (error) {
        if (
          error instanceof Error &&
          /^CONTRACT_SPEC_PATH_ESCAPE|CONTRACT_SPEC_PATH_SYMLINK|CONTRACT_REF_/.test(error.message)
        ) {
          throw error;
        }
        fail(
          'CONTRACT_DEFINITION_CLOSURE_INCOMPLETE',
          `Missing or unreadable local definition ref ${refTarget}`
        );
      }

      totalBytes += bytes.byteLength;
      if (totalBytes > DEFINITION_BUNDLE_LIMITS.maxTotalBytes) {
        fail(
          'CONTRACT_REF_SIZE_EXCEEDED',
          `Definition resources exceeded ${DEFINITION_BUNDLE_LIMITS.maxTotalBytes} total bytes`
        );
      }

      members.set(resolved.bundleKey, {
        bundleKey: resolved.bundleKey,
        workspaceRelative: resolved.workspaceRelative,
        bytes,
        role: 'dependency'
      });
      queue.push({
        bundleKey: resolved.bundleKey,
        workspaceRelative: resolved.workspaceRelative,
        bytes,
        depth: current.depth + 1
      });
    }
  }

  return [...members.values()];
}

function buildFilesFromMembers(members: AcquiredMember[]): DefinitionFile[] {
  let totalBytes = 0;
  const files: DefinitionFile[] = [];
  const folded = new Map<string, string>();
  for (const member of members) {
    const foldedKey = caseFoldPathKey(member.bundleKey);
    const prior = folded.get(foldedKey);
    if (prior !== undefined && prior !== member.bundleKey) {
      fail('CONTRACT_DEFINITION_DUPLICATE_PATH', `Case/NFC-colliding paths ${prior} and ${member.bundleKey}`);
    }
    folded.set(foldedKey, member.bundleKey);
    totalBytes += member.bytes.byteLength;
    if (totalBytes > DEFINITION_BUNDLE_LIMITS.maxTotalBytes) {
      fail(
        'CONTRACT_REF_SIZE_EXCEEDED',
        `Definition resources exceeded ${DEFINITION_BUNDLE_LIMITS.maxTotalBytes} total bytes`
      );
    }
    files.push(
      createDefinitionFile({
        path: member.bundleKey,
        role: member.role,
        bytes: member.bytes
      })
    );
  }
  return files;
}

function verifyInventoryMembers(options: {
  workspaceRoot: string;
  bundleBaseAbs: string;
  inventory: DefinitionInventory;
}): Map<string, AcquiredMember> {
  // Count and declared aggregate limits are enforced before this function runs.
  const byBundleKey = new Map<string, AcquiredMember>();
  let readTotal = 0;
  for (const entry of options.inventory.files) {
    assertInsideDir(
      options.bundleBaseAbs,
      path.resolve(options.workspaceRoot, ...entry.path.split('/'))
    );
    const { bytes } = readConfinedFileBytes(options.workspaceRoot, entry.path, options.bundleBaseAbs);
    readTotal += bytes.byteLength;
    if (readTotal > DEFINITION_BUNDLE_LIMITS.maxTotalBytes) {
      fail(
        'CONTRACT_REF_SIZE_EXCEEDED',
        `Definition resources exceeded ${DEFINITION_BUNDLE_LIMITS.maxTotalBytes} total bytes`
      );
    }
    if (bytes.byteLength !== entry.bytes || sha256Hex(bytes) !== entry.sha256) {
      fail('CONTRACT_DEFINITION_MEMBER_MISMATCH', `Inventory metadata mismatch for ${entry.path}`);
    }
    const bundleKey = toPosixRelative(
      options.bundleBaseAbs,
      path.resolve(options.workspaceRoot, ...entry.path.split('/'))
    );
    const normalizedKey = assertValidBundleRelativePath(bundleKey.normalize('NFC'));
    byBundleKey.set(normalizedKey, {
      bundleKey: normalizedKey,
      workspaceRelative: entry.path,
      bytes,
      role: entry.role
    });
  }
  return byBundleKey;
}

function assertClosureMatchesInventory(options: {
  acquired: AcquiredMember[];
  inventoryKeys: Set<string>;
}): void {
  const acquiredKeys = new Set(options.acquired.map((member) => member.bundleKey));
  for (const key of acquiredKeys) {
    if (!options.inventoryKeys.has(key)) {
      fail(
        'CONTRACT_DEFINITION_CLOSURE_INCOMPLETE',
        `Dependency ${key} reached from root but absent from inventory`
      );
    }
  }
  for (const key of options.inventoryKeys) {
    if (!acquiredKeys.has(key)) {
      fail(
        'CONTRACT_DEFINITION_INVENTORY_INVALID',
        `Inventoried dependency ${key} is not reachable from the root`
      );
    }
  }
}

export async function acquireDefinitionBundle(
  options: AcquireDefinitionBundleOptions
): Promise<DefinitionBundle> {
  const workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  const specPath = normalizeWorkspaceRelativePath(options.specPath.replace(/\\/g, '/'));

  // Reject absolute / escaping roots before any dependency callback can run.
  // onUnsafeReadAttempt is reserved for proving callers never receive an escape
  // path; acquisition itself must not invoke it.
  const absoluteSpec = path.resolve(workspaceRoot, ...specPath.split('/'));
  assertInsideDir(workspaceRoot, absoluteSpec);

  const inventory = options.specFilesJson
    ? parseDefinitionInventoryJson(options.specFilesJson)
    : null;

  if (inventory && inventory.root !== specPath) {
    fail('CONTRACT_DEFINITION_ROOT_MISMATCH', 'inventory root must equal normalized spec-path');
  }

  // Reject oversized inventories before opening any inventoried member (or the root).
  if (inventory) {
    assertInventoryLimitsBeforeRead(inventory);
    if (inventory.format === 'mcp-json' && inventory.files.length > 1) {
      fail('CONTRACT_MCP_MULTIFILE_UNSUPPORTED', 'MCP definitions are single-file only');
    }
  }

  const bundleBaseAbs = path.dirname(absoluteSpec);
  assertInsideDir(workspaceRoot, bundleBaseAbs);

  const rootRead = readConfinedFileBytes(workspaceRoot, specPath, bundleBaseAbs);
  const rootBundleKey = assertValidBundleRelativePath(
    toPosixRelative(bundleBaseAbs, rootRead.absolutePath).normalize('NFC') || path.posix.basename(specPath)
  );

  let rootContent: string;
  try {
    rootContent = new TextDecoder('utf-8', { fatal: true }).decode(rootRead.bytes);
  } catch {
    fail('CONTRACT_DEFINITION_ENCODING_INVALID', 'Root definition member is not valid UTF-8');
  }

  const detectedFormat = inventory?.format ?? detectDefinitionFormat(rootContent, path.posix.basename(specPath));
  const provenance: DefinitionProvenance = options.provenance ??
    (inventory
      ? {
          source: 'discovery-inventory',
          provider: inventory.provenance.provider,
          evidence: [`provider:${inventory.provenance.provider}`]
        }
      : { source: 'spec-path', evidence: ['local-spec-path'] });

  if (inventory) {
    const inventoried = verifyInventoryMembers({
      workspaceRoot,
      bundleBaseAbs,
      inventory
    });
    const inventoryBundleKeys = new Set(inventoried.keys());

    if (formatAcquiresLocalClosure(detectedFormat)) {
      const closed = acquireLocalClosure({
        workspaceRoot,
        bundleBaseAbs,
        rootBundleKey,
        rootWorkspaceRelative: specPath,
        rootBytes: rootRead.bytes,
        format: detectedFormat
      });
      assertClosureMatchesInventory({
        acquired: closed,
        inventoryKeys: inventoryBundleKeys
      });
      // Prefer inventoried bytes (already hash-verified) in declared roles.
      const members = closed.map((member) => {
        const fromInventory = inventoried.get(member.bundleKey);
        if (!fromInventory) {
          fail('CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', `Missing inventory member ${member.bundleKey}`);
        }
        return fromInventory;
      });
      return createDefinitionBundle({
        rootPath: rootBundleKey,
        format: detectedFormat,
        completeness: inventory.completeness,
        provenance,
        files: buildFilesFromMembers(members)
      });
    }

    // GraphQL / MCP: root-only. Inventory membership must match the root-only closure.
    const rootOnly: AcquiredMember[] = [
      {
        bundleKey: rootBundleKey,
        workspaceRelative: specPath,
        bytes: rootRead.bytes,
        role: 'root'
      }
    ];
    assertClosureMatchesInventory({
      acquired: rootOnly,
      inventoryKeys: inventoryBundleKeys
    });
    const rootMember = inventoried.get(rootBundleKey);
    if (!rootMember) {
      fail('CONTRACT_DEFINITION_CLOSURE_INCOMPLETE', `Missing inventory member ${rootBundleKey}`);
    }
    return createDefinitionBundle({
      rootPath: rootBundleKey,
      format: detectedFormat,
      completeness: inventory.completeness,
      provenance,
      files: buildFilesFromMembers([rootMember])
    });
  }

  if (formatAcquiresLocalClosure(detectedFormat)) {
    const members = acquireLocalClosure({
      workspaceRoot,
      bundleBaseAbs,
      rootBundleKey,
      rootWorkspaceRelative: specPath,
      rootBytes: rootRead.bytes,
      format: detectedFormat
    });
    return createDefinitionBundle({
      rootPath: rootBundleKey,
      format: detectedFormat,
      completeness: 'full',
      provenance,
      files: buildFilesFromMembers(members)
    });
  }

  return createDefinitionBundle({
    rootPath: rootBundleKey,
    format: detectedFormat,
    completeness: 'full',
    provenance,
    files: buildFilesFromMembers([
      {
        bundleKey: rootBundleKey,
        workspaceRelative: specPath,
        bytes: rootRead.bytes,
        role: 'root'
      }
    ])
  });
}
