import type { DefinitionBundle } from '../spec/definition-bundle.js';

/** Well-known protobuf import prefixes that may be absent from a local bundle. */
const WELL_KNOWN_PROTO_PREFIXES = [
  'google/protobuf/',
  'google/rpc/',
  'google/api/',
  'google/type/',
  'google/longrunning/'
] as const;

export function isWellKnownProtoImport(importPath: string): boolean {
  const normalized = importPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return WELL_KNOWN_PROTO_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function closureIncomplete(message: string): never {
  throw new Error(`CONTRACT_DEFINITION_CLOSURE_INCOMPLETE: ${message}`);
}

export function mcpMultifileUnsupported(message: string): never {
  throw new Error(`CONTRACT_MCP_MULTIFILE_UNSUPPORTED: ${message}`);
}

/**
 * Resolve a relative import/ref location against a bundle-relative origin key.
 * Rejects absolute URIs, absolute filesystem paths, and escapes outside the bundle key space.
 */
export function resolveBundleRelativeKey(fromKey: string, location: string): string {
  const target = location.split('#', 1)[0] ?? '';
  if (!target) {
    closureIncomplete(`Empty relative reference from ${fromKey}`);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
    closureIncomplete(`Remote or absolute reference is not allowed in a confined bundle: ${location}`);
  }
  if (target.includes('\0') || target.includes('\\')) {
    closureIncomplete(`Invalid reference path: ${location}`);
  }

  const fromDir = fromKey.includes('/') ? fromKey.slice(0, fromKey.lastIndexOf('/')) : '';
  const joined = normalizePosix(`${fromDir ? `${fromDir}/` : ''}${target}`);
  if (
    !joined ||
    joined === '.' ||
    joined.startsWith('../') ||
    joined === '..' ||
    joined.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    closureIncomplete(`Reference escapes the definition bundle: ${location}`);
  }
  return joined;
}

function normalizePosix(pathKey: string): string {
  const parts: string[] = [];
  for (const segment of pathKey.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return '..';
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

export function readBundleMember(bundle: DefinitionBundle, key: string): string {
  const file = bundle.files.get(key);
  if (!file) {
    closureIncomplete(`Missing definition member ${key}`);
  }
  return file.content;
}

/**
 * Resolve a relative location from an origin key inside the bundle.
 * Returns content when present; throws CONTRACT_DEFINITION_CLOSURE_INCOMPLETE otherwise.
 */
export function resolveBundleMemberContent(
  bundle: DefinitionBundle,
  fromKey: string,
  location: string
): string {
  const key = resolveBundleRelativeKey(fromKey, location);
  return readBundleMember(bundle, key);
}

/**
 * Soft resolver for legacy SOAP lint path: returns undefined when the member is
 * absent. Bundle-strict callers should use resolveBundleMemberContent instead.
 */
export function createBundleImportResolver(
  bundle: DefinitionBundle,
  fromKey: string = bundle.rootPath
): (location: string) => string | undefined {
  return (location: string): string | undefined => {
    try {
      return resolveBundleMemberContent(bundle, fromKey, location);
    } catch {
      return undefined;
    }
  };
}

/**
 * Strict bundle import resolver: missing/remote/escaping locations fail the run.
 * Origin updates when nested imports are resolved from a different member.
 */
export function createStrictBundleImportResolver(bundle: DefinitionBundle): {
  resolveFromRoot: (location: string) => string;
  resolveFrom: (fromKey: string, location: string) => string;
  resolveKeyFrom: (fromKey: string, location: string) => string;
} {
  return {
    resolveFromRoot: (location: string) => resolveBundleMemberContent(bundle, bundle.rootPath, location),
    resolveFrom: (fromKey: string, location: string) => resolveBundleMemberContent(bundle, fromKey, location),
    resolveKeyFrom: (fromKey: string, location: string) => resolveBundleRelativeKey(fromKey, location)
  };
}
