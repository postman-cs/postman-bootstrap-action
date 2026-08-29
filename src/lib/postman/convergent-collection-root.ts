import { createHash } from 'node:crypto';

interface LogicalAssetMarker {
  repo?: unknown;
  rawBranch?: unknown;
  sanitizedBranch?: unknown;
  role?: unknown;
  headRepoId?: unknown;
}

function logicalAssetMarker(description: string | undefined): LogicalAssetMarker | undefined {
  const text = String(description ?? '');
  const markerIndex = text.indexOf('x-pm-onboarding:');
  const jsonStart = markerIndex < 0 ? -1 : text.indexOf('{', markerIndex);
  if (jsonStart < 0) return undefined;
  let depth = 0;
  for (let index = jsonStart; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    if (text[index] !== '}') continue;
    depth -= 1;
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(text.slice(jsonStart, index + 1)) as LogicalAssetMarker;
      return parsed && typeof parsed === 'object' && parsed.repo && parsed.role
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * One stable collection root for one workspace-local logical asset. Concurrent
 * push/PR triggers for the same branch and role must address the same root;
 * decentralized winner election cannot safely delete a root another process
 * may already have returned. Head SHA is deliberately excluded so later
 * revisions of one branch continue to address the same asset.
 */
export function convergentCollectionRootIdentity(
  workspaceId: string,
  finalName: string,
  description?: string
): string {
  const workspace = String(workspaceId ?? '').trim();
  const name = String(finalName ?? '').trim();
  if (!workspace || !name) {
    throw new Error('LOCAL_OPENAPI_IMPORT_FAILED: convergent root requires workspace and final name');
  }
  const marker = logicalAssetMarker(description);
  const logicalMarker = marker
    ? JSON.stringify([
        marker.repo,
        marker.rawBranch,
        marker.sanitizedBranch,
        marker.role,
        marker.headRepoId ?? ''
      ])
    : 'canonical';
  const bytes = createHash('sha256')
    .update('postman-bootstrap:collection-root:v1\0')
    .update(workspace)
    .update('\0')
    .update(name)
    .update('\0')
    .update(logicalMarker)
    .digest()
    .subarray(0, 16);
  // UUID-shaped deterministic identifier with version-5 and RFC variant bits.
  // This is a domain-separated SHA-256 construction, not RFC UUIDv5; only the
  // accepted identifier shape and stable logical identity matter to Sync.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
