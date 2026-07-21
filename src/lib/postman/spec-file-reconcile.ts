import {
  assertNoPathCollisions,
  assertValidBundleRelativePath,
  caseFoldPathKey,
  createDefinitionBundle,
  createDefinitionFile,
  type DefinitionBundle,
  type DefinitionFile,
  type DefinitionFileRole,
  type DefinitionFormat
} from '../spec/definition-bundle.js';
// Committed R5 dual-leg receipt; esbuild inlines this JSON into the production bundle.
import committedR5MultifileSpecSyncReceipt from '../../../validation/evidence/multifile-spec-sync.json' with {
  type: 'json'
};

export type CloudSpecFileRole = 'ROOT' | 'DEFAULT';

export interface CloudSpecFileMeta {
  id: string;
  path: string;
  type: string;
  parentId?: string;
}

export interface SpecBundleFileSnapshot {
  path: string;
  role: DefinitionFileRole;
  content: string;
  byteLength: number;
  sha256: string;
}

/**
 * Prior Spec Hub file-set snapshot for orchestrator rollback. Excludes live
 * cloud UUIDs so restore always re-lists before mutating.
 */
export interface SpecBundleSnapshot {
  schemaVersion: 1;
  rootPath: string;
  format: DefinitionFormat;
  files: SpecBundleFileSnapshot[];
  digest: string;
}

export interface SpecFileReconcilePlan {
  create: Array<{ path: string; content: string; type: 'DEFAULT' }>;
  update: Array<{ id: string; content: string }>;
  delete: Array<{ id: string }>;
}

export type SpecBundleMutationOutcome =
  | {
      status: 'ok';
      changed: boolean;
      priorSnapshot: SpecBundleSnapshot;
      verifiedDigest: string;
    }
  | {
      status: 'verification-needed';
      changed: boolean;
      priorSnapshot: SpecBundleSnapshot;
      targetDigest: string;
      reason: string;
      cause?: unknown;
    };

/**
 * Validated Spec Hub reconcile capability policy. Defaults are derived from the
 * committed R5 receipt via
 * {@link deriveSpecReconcileCapabilityPolicyFromReceipt}; injectable in tests.
 * Never read mutable remote state at runtime.
 */
export interface SpecReconcileCapabilityPolicy {
  bulkModify: boolean;
  atomicBulk: boolean;
  rootPathChange: boolean;
}

/** Dual-leg modes required before production default-on. */
export const R6_REQUIRED_RECEIPT_LEG_MODES = ['nonorg', 'org'] as const;

/** Probe rows that must pass on every required leg (P11 may fail). */
export const R6_REQUIRED_RECEIPT_PROBE_IDS = [
  'P01',
  'P02',
  'P03',
  'P04',
  'P05',
  'P06',
  'P07',
  'P08',
  'P09',
  'P10'
] as const;

/** Capability keys R6 requires before default-on multi-file Spec Hub sync. */
export const R6_REQUIRED_RECEIPT_CAPABILITIES = [
  'multiFileCreate',
  'multiFileRead',
  'perFileCreate',
  'perFilePatch',
  'perFileDelete',
  'bulkModify',
  'openapiGeneration'
] as const;

export type R6RequiredReceiptCapability = (typeof R6_REQUIRED_RECEIPT_CAPABILITIES)[number];

function receiptAsRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Assert the R5 receipt's full production gating shape (schema, both required
 * modes, P01–P10 passed, zero teardown residue, R6-required capabilities true,
 * atomic/root booleans typed). Does not return team IDs or probe results.
 */
export function assertR5ReceiptJustifiesProductionMultiFileSync(receipt: unknown): void {
  const record = receiptAsRecord(receipt);
  if (!record) throw new Error('R5 receipt must be an object');
  if (record.schemaVersion !== 1) throw new Error('R5 receipt.schemaVersion must be 1');

  if (!Array.isArray(record.legs) || record.legs.length === 0) {
    throw new Error('R5 receipt.legs missing leg entries');
  }
  const modes = new Set<string>();
  for (const leg of record.legs) {
    const legRecord = receiptAsRecord(leg);
    if (!legRecord) throw new Error('R5 receipt leg must be an object');
    if (typeof legRecord.mode !== 'string' || !legRecord.mode) {
      throw new Error('R5 receipt leg.mode must be a non-empty string');
    }
    modes.add(legRecord.mode);

    const teardown = receiptAsRecord(legRecord.teardown);
    if (!teardown || teardown.residue !== false) {
      throw new Error(
        `R5 receipt leg ${legRecord.mode} teardown.residue must be false (zero residue)`
      );
    }

    if (!Array.isArray(legRecord.results)) {
      throw new Error(`R5 receipt leg ${legRecord.mode} results must be an array`);
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of legRecord.results) {
      const result = receiptAsRecord(row);
      if (!result) throw new Error(`R5 receipt leg ${legRecord.mode} result row must be an object`);
      if (typeof result.id !== 'string' || !result.id) {
        throw new Error(`R5 receipt leg ${legRecord.mode} result.id must be a non-empty string`);
      }
      if (typeof result.passed !== 'boolean') {
        throw new Error(`R5 receipt leg ${legRecord.mode} ${result.id}.passed must be a boolean`);
      }
      byId.set(result.id, result);
    }
    for (const id of R6_REQUIRED_RECEIPT_PROBE_IDS) {
      const row = byId.get(id);
      if (!row) {
        throw new Error(`R5 receipt leg ${legRecord.mode} missing probe row ${id}`);
      }
      if (row.passed !== true) {
        throw new Error(`R5 receipt leg ${legRecord.mode} ${id} must pass`);
      }
    }
    // P11 is optional for R6; when present it may be false.
    const p11 = byId.get('P11');
    if (p11 !== undefined && typeof p11.passed !== 'boolean') {
      throw new Error(`R5 receipt leg ${legRecord.mode} P11.passed must be a boolean when present`);
    }
  }
  for (const mode of R6_REQUIRED_RECEIPT_LEG_MODES) {
    if (!modes.has(mode)) throw new Error(`R5 receipt missing leg mode ${mode}`);
  }

  const capabilities = receiptAsRecord(record.capabilities);
  if (!capabilities) throw new Error('R5 receipt.capabilities missing');
  for (const key of R6_REQUIRED_RECEIPT_CAPABILITIES) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new Error(`R5 receipt.capabilities.${key} must be a boolean`);
    }
    if (capabilities[key] !== true) {
      throw new Error(`R5 receipt does not justify multi-file sync: capabilities.${key} must be true`);
    }
  }
  for (const key of ['atomicBulk', 'rootPathChange'] as const) {
    if (typeof capabilities[key] !== 'boolean') {
      throw new Error(`R5 receipt.capabilities.${key} must be a boolean`);
    }
  }
}

/**
 * Derive the reconcile policy from a fully gated R5 receipt.
 * Requires both legs, P01–P10 pass, zero teardown residue, and every
 * R6-required capability true; `atomicBulk` and `rootPathChange` are recorded
 * as observed (may be false).
 */
export function deriveSpecReconcileCapabilityPolicyFromReceipt(
  receipt: unknown
): SpecReconcileCapabilityPolicy {
  assertR5ReceiptJustifiesProductionMultiFileSync(receipt);
  const capabilities = receiptAsRecord(receiptAsRecord(receipt)!.capabilities)!;
  return validateSpecReconcileCapabilityPolicy({
    bulkModify: capabilities.bulkModify as boolean,
    atomicBulk: capabilities.atomicBulk as boolean,
    rootPathChange: capabilities.rootPathChange as boolean
  });
}

/**
 * True when the R5 receipt's full gating shape justifies default-on multi-file
 * Spec Hub sync (`POSTMAN_MULTI_FILE_SPEC_SYNC` unset → on). Kill switch `off`
 * still wins.
 */
export function r5ReceiptJustifiesMultiFileSyncDefaultOn(receipt: unknown): boolean {
  try {
    assertR5ReceiptJustifiesProductionMultiFileSync(receipt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the compile-time default for `POSTMAN_MULTI_FILE_SPEC_SYNC` from a
 * receipt. Returns `'on'` only when {@link r5ReceiptJustifiesMultiFileSyncDefaultOn}.
 */
export function resolveMultiFileSpecSyncDefaultFromReceipt(receipt: unknown): 'on' | 'off' {
  return r5ReceiptJustifiesMultiFileSyncDefaultOn(receipt) ? 'on' : 'off';
}

/**
 * Live-proven defaults derived solely from the committed R5 receipt artifact
 * (inlined at build time). Invalid receipts throw at module initialization.
 */
export const DEFAULT_SPEC_RECONCILE_CAPABILITY_POLICY: SpecReconcileCapabilityPolicy =
  deriveSpecReconcileCapabilityPolicyFromReceipt(committedR5MultifileSpecSyncReceipt);

/**
 * Default for unset `POSTMAN_MULTI_FILE_SPEC_SYNC`, derived solely from the
 * committed R5 receipt. Explicit `POSTMAN_MULTI_FILE_SPEC_SYNC=off` still wins.
 */
export const MULTI_FILE_SPEC_SYNC_DEFAULT: 'on' | 'off' =
  resolveMultiFileSpecSyncDefaultFromReceipt(committedR5MultifileSpecSyncReceipt);

export function validateSpecReconcileCapabilityPolicy(
  policy: SpecReconcileCapabilityPolicy
): SpecReconcileCapabilityPolicy {
  if (!policy || typeof policy !== 'object') {
    throw new Error('reconcile capability policy must be an object');
  }
  for (const key of ['bulkModify', 'atomicBulk', 'rootPathChange'] as const) {
    if (typeof policy[key] !== 'boolean') {
      throw new Error(`reconcile capability policy.${key} must be a boolean`);
    }
  }
  return {
    bulkModify: policy.bulkModify,
    atomicBulk: policy.atomicBulk,
    rootPathChange: policy.rootPathChange
  };
}

export type PerFileReconcileOp =
  | { kind: 'create'; path: string; content: string; type: 'DEFAULT' }
  | { kind: 'update'; path: string; id: string; content: string }
  | { kind: 'delete'; path: string; id: string };

/**
 * Order per-file mutations for non-bulk reconcile:
 * 1. sorted non-root creates/updates
 * 2. root update last (content only; root path change is gated by policy)
 * 3. sorted stale non-root deletes
 */
export function orderPerFileReconcileOps(input: {
  plan: SpecFileReconcilePlan;
  cloud: CloudSpecFileMeta[];
}): PerFileReconcileOp[] {
  const cloudById = new Map(input.cloud.map((meta) => [meta.id, meta]));
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  const nonRootUpserts: PerFileReconcileOp[] = [];
  let rootUpdate: PerFileReconcileOp | null = null;

  for (const create of input.plan.create) {
    nonRootUpserts.push({
      kind: 'create',
      path: create.path,
      content: create.content,
      type: 'DEFAULT'
    });
  }
  for (const update of input.plan.update) {
    const meta = cloudById.get(update.id);
    const pathKey = meta ? assertValidBundleRelativePath(meta.path) : update.id;
    const op: PerFileReconcileOp = {
      kind: 'update',
      path: pathKey,
      id: update.id,
      content: update.content
    };
    if (meta?.type === 'ROOT') {
      rootUpdate = op;
    } else {
      nonRootUpserts.push(op);
    }
  }
  nonRootUpserts.sort((a, b) => byPath(a.path, b.path));

  const deletes: PerFileReconcileOp[] = input.plan.delete
    .map((entry) => {
      const meta = cloudById.get(entry.id);
      return {
        kind: 'delete' as const,
        path: meta ? assertValidBundleRelativePath(meta.path) : entry.id,
        id: entry.id
      };
    })
    .sort((a, b) => byPath(a.path, b.path));

  return [...nonRootUpserts, ...(rootUpdate ? [rootUpdate] : []), ...deletes];
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function cloudRoleToDefinitionRole(type: string): DefinitionFileRole | null {
  if (type === 'ROOT') return 'root';
  if (type === 'DEFAULT') return 'dependency';
  return null;
}

export function definitionRoleToCloudType(role: DefinitionFileRole): CloudSpecFileRole {
  return role === 'root' ? 'ROOT' : 'DEFAULT';
}

export function listFilesFromGatewayResponse(json: unknown): CloudSpecFileMeta[] {
  const root = asRecord(json);
  const data = root?.data ?? json;
  const list = Array.isArray(data)
    ? data
    : Array.isArray(asRecord(data)?.files)
      ? (asRecord(data)!.files as unknown[])
      : [];
  const out: CloudSpecFileMeta[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    const type = String(record.type ?? '').trim();
    // Spec Hub may also return folder nodes; only ROOT/DEFAULT are definition members.
    if (type !== 'ROOT' && type !== 'DEFAULT') continue;
    const id = String(record.id ?? '').trim();
    const pathKey = String(record.path ?? record.name ?? '').trim();
    if (!id || !pathKey) continue;
    out.push({
      id,
      path: pathKey,
      type,
      ...(record.parentId != null ? { parentId: String(record.parentId).trim() } : {})
    });
  }
  return out;
}

export function contentFromGatewayFileRead(json: unknown): string | undefined {
  const root = asRecord(json);
  const data = asRecord(root?.data) ?? root;
  const content = data?.content;
  return typeof content === 'string' ? content : undefined;
}

export function utf8Bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

/**
 * Build a DefinitionBundle from Spec Hub list+content rows using the same
 * path/role/digest invariants as local acquisition.
 */
export function cloudMembersToDefinitionBundle(input: {
  format: DefinitionFormat;
  members: Array<{ path: string; type: string; content: string }>;
}): DefinitionBundle {
  const paths = input.members.map((member) => member.path);
  assertNoPathCollisions(paths);

  const files: DefinitionFile[] = [];
  let rootPath = '';
  for (const member of input.members) {
    const role = cloudRoleToDefinitionRole(member.type);
    if (!role) {
      fail(
        'CONTRACT_DEFINITION_INVENTORY_INVALID',
        `Unsupported Spec Hub file type ${member.type} for path ${member.path}`
      );
    }
    const pathKey = assertValidBundleRelativePath(member.path);
    if (role === 'root') rootPath = pathKey;
    files.push(
      createDefinitionFile({
        path: pathKey,
        role,
        bytes: utf8Bytes(member.content)
      })
    );
  }

  if (!rootPath) {
    fail('CONTRACT_DEFINITION_INVENTORY_INVALID', 'Spec Hub file set must contain exactly one ROOT');
  }

  return createDefinitionBundle({
    rootPath,
    format: input.format,
    completeness: 'full',
    provenance: {
      source: 'spec-path',
      evidence: ['spec-hub-readback']
    },
    files
  });
}

export function definitionBundleToSnapshot(bundle: DefinitionBundle): SpecBundleSnapshot {
  const files = [...bundle.files.values()]
    .map((file) => ({
      path: file.path,
      role: file.role,
      content: file.content,
      byteLength: file.byteLength,
      sha256: file.sha256
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    schemaVersion: 1,
    rootPath: bundle.rootPath,
    format: bundle.format,
    files,
    digest: bundle.digest
  };
}

export function snapshotToDefinitionBundle(snapshot: SpecBundleSnapshot): DefinitionBundle {
  return createDefinitionBundle({
    rootPath: snapshot.rootPath,
    format: snapshot.format,
    completeness: 'full',
    provenance: {
      source: 'spec-path',
      evidence: ['spec-hub-snapshot-restore']
    },
    files: snapshot.files.map((file) =>
      createDefinitionFile({
        path: file.path,
        role: file.role,
        bytes: utf8Bytes(file.content)
      })
    )
  });
}

export function assertNoCloudPathCollisions(metas: CloudSpecFileMeta[]): void {
  const seen = new Map<string, string>();
  for (const meta of metas) {
    const normalized = assertValidBundleRelativePath(meta.path);
    const folded = caseFoldPathKey(normalized);
    const prior = seen.get(folded);
    if (prior !== undefined) {
      fail(
        'CONTRACT_DEFINITION_DUPLICATE_PATH',
        prior === normalized
          ? `Duplicate Spec Hub path ${normalized}`
          : `Case/NFC-colliding Spec Hub paths ${prior} and ${normalized}`
      );
    }
    seen.set(folded, normalized);
  }
}

/**
 * Resolve the live per-file create parentId for a nested path from an existing
 * sibling in the same directory (Spec Hub rejects slash-containing path/name on
 * POST /files; nested creates use name + parentId).
 */
export function resolvePerFileCreateParentId(
  cloud: CloudSpecFileMeta[],
  filePath: string
): string | undefined {
  const normalized = assertValidBundleRelativePath(filePath);
  const slash = normalized.lastIndexOf('/');
  if (slash < 0) return undefined;
  const dir = normalized.slice(0, slash);
  for (const meta of cloud) {
    const metaPath = assertValidBundleRelativePath(meta.path);
    const metaSlash = metaPath.lastIndexOf('/');
    if (metaSlash < 0) continue;
    if (metaPath.slice(0, metaSlash) !== dir) continue;
    const parentId = meta.parentId?.trim();
    if (parentId) return parentId;
  }
  return undefined;
}

/** Basename for live per-file create body (name + optional parentId). */
export function perFileCreateName(filePath: string): string {
  const normalized = assertValidBundleRelativePath(filePath);
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

/**
 * Plan create/update/delete by exact normalized path. Caller must reject root
 * path changes before invoking this when rootPathChange is false.
 */
export function planSpecFileReconcile(input: {
  cloud: CloudSpecFileMeta[];
  cloudContentById: Map<string, string>;
  target: DefinitionBundle;
}): SpecFileReconcilePlan {
  assertNoCloudPathCollisions(input.cloud);

  const cloudByPath = new Map<string, CloudSpecFileMeta>();
  for (const meta of input.cloud) {
    cloudByPath.set(assertValidBundleRelativePath(meta.path), meta);
  }

  const create: SpecFileReconcilePlan['create'] = [];
  const update: SpecFileReconcilePlan['update'] = [];
  const targetPaths = new Set<string>();

  for (const file of [...input.target.files.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    targetPaths.add(file.path);
    const existing = cloudByPath.get(file.path);
    if (!existing) {
      if (file.role === 'root') {
        fail(
          'CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED',
          `Root path ${file.path} is absent from Spec Hub; clear spec-id to recreate`
        );
      }
      create.push({
        path: file.path,
        content: file.content,
        type: 'DEFAULT'
      });
      continue;
    }
    const current = input.cloudContentById.get(existing.id);
    if (current === undefined) {
      fail(
        'CONTRACT_DEFINITION_CLOSURE_INCOMPLETE',
        `Missing Spec Hub content for ${file.path}`
      );
    }
    if (current !== file.content) {
      update.push({ id: existing.id, content: file.content });
    }
  }

  const deleteIds: SpecFileReconcilePlan['delete'] = [];
  for (const meta of [...input.cloud].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  )) {
    const pathKey = assertValidBundleRelativePath(meta.path);
    if (targetPaths.has(pathKey)) continue;
    if (meta.type === 'ROOT') {
      fail(
        'CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED',
        `Root path ${pathKey} would be deleted; clear spec-id to recreate`
      );
    }
    deleteIds.push({ id: meta.id });
  }

  return { create, update, delete: deleteIds };
}

export function buildBulkFilesBody(plan: SpecFileReconcilePlan): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (plan.create.length > 0) body.create = plan.create;
  if (plan.update.length > 0) body.update = plan.update;
  if (plan.delete.length > 0) body.delete = plan.delete;
  return body;
}

export function planHasMutations(plan: SpecFileReconcilePlan): boolean {
  return plan.create.length > 0 || plan.update.length > 0 || plan.delete.length > 0;
}

export function assertSameRootPath(cloudRootPath: string, targetRootPath: string): void {
  const cloud = assertValidBundleRelativePath(cloudRootPath, 'cloudRootPath');
  const target = assertValidBundleRelativePath(targetRootPath, 'targetRootPath');
  if (cloud !== target) {
    fail(
      'CONTRACT_SPEC_ROOT_PATH_CHANGE_UNSUPPORTED',
      `Root path change from ${cloud} to ${target} is unsupported; clear spec-id to recreate`
    );
  }
}

export function isOpenApiSpecHubFormat(format: DefinitionFormat): boolean {
  return format === 'openapi-json' || format === 'openapi-yaml';
}

export function openApiSpecType(openapiVersion: '3.0' | '3.1' | string): 'OPENAPI:3.0' | 'OPENAPI:3.1' {
  if (openapiVersion !== '3.0' && openapiVersion !== '3.1') {
    fail(
      'CONTRACT_UNSUPPORTED_OPENAPI_VERSION',
      `unsupported openapiVersion "${openapiVersion}". Expected '3.0' or '3.1'.`
    );
  }
  return openapiVersion === '3.1' ? 'OPENAPI:3.1' : 'OPENAPI:3.0';
}

/** Proven multi-file create body (R5 P01). */
export function buildMultiFileCreateBody(input: {
  name: string;
  openapiVersion: '3.0' | '3.1' | string;
  bundle: DefinitionBundle;
}): {
  name: string;
  type: 'OPENAPI:3.0' | 'OPENAPI:3.1';
  files: Array<{ path: string; content: string; type: CloudSpecFileRole }>;
} {
  if (!isOpenApiSpecHubFormat(input.bundle.format)) {
    fail(
      'CONTRACT_UNSUPPORTED_OPENAPI_VERSION',
      `Spec Hub multi-file sync supports OpenAPI only (got ${input.bundle.format})`
    );
  }
  const files = [...input.bundle.files.values()]
    .map((file) => ({
      path: file.path,
      content: file.content,
      type: definitionRoleToCloudType(file.role)
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    name: input.name,
    type: openApiSpecType(input.openapiVersion),
    files
  };
}
