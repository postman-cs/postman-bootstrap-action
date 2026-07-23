import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';

import * as V2 from '@postman/runtime.models/v2';
import { transform, FormatVersion } from '@postman/runtime.models/transforms';
import { splitCollection } from '@postman/v3.export';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { CollectionRole, JsonRecord } from '../spec/local-openapi-collection-generation.js';

export const LOCAL_COLLECTION_ARTIFACTS_FAILED = 'LOCAL_COLLECTION_ARTIFACTS_FAILED' as const;

export class LocalCollectionArtifactsError extends Error {
  readonly code = LOCAL_COLLECTION_ARTIFACTS_FAILED;

  constructor(detail: string, cause?: unknown) {
    super(`${LOCAL_COLLECTION_ARTIFACTS_FAILED}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = 'LocalCollectionArtifactsError';
  }
}

export type SplitCollectionFile = { relative: string; content: string };
export type CollectionSplitter = (collection: JsonRecord) => Promise<SplitCollectionFile[]>;
export type RenameFn = (oldPath: string, newPath: string) => Promise<void>;

export interface LocalArtifactSyncOptions {
  syncExamples: boolean;
  [key: string]: unknown;
}

export interface LocalArtifactRoleInput {
  role: CollectionRole;
  /** Single safe segment under `postman/collections/` (may include `[Smoke]`/`[Contract]`). */
  collectionName: string;
  /** Complete pre-write Collection v2.1 payload. */
  collection: JsonRecord;
  payloadDigest: string;
  cloudId?: string;
}

export interface MaterializeLocalCollectionArtifactsInput {
  repoRoot: string;
  /** Caller-supplied run temp directory used for staging and snapshots. */
  runTempDir: string;
  roles: LocalArtifactRoleInput[];
  /**
   * Repo-root-relative local OpenAPI path. When absent (URL-only bootstrap),
   * collection trees are still written but no syncSpecToCollection pair is
   * synthesized.
   */
  specPath?: string;
  /**
   * Exact local conversion generation options written onto new/upserted
   * syncSpecToCollection pairs (e.g. parametersResolution/requestNameSource/...).
   * Required when `specPath` is present.
   */
  options?: JsonRecord;
  /** Defaults to `{ syncExamples: true }` when writing pairs. */
  syncOptions?: LocalArtifactSyncOptions;
  /** Test-only seam; production default is exact `@postman/v3.export` split. */
  splitter?: CollectionSplitter;
  /** Test-only seam to force EXDEV / cross-device rename behavior. */
  rename?: RenameFn;
}

export interface LocalArtifactManifestEntry {
  role: CollectionRole;
  collectionPath: string;
  cloudId?: string;
  payloadDigest: string;
  artifactDigest: string;
}

export interface LocalArtifactRestoreHandle {
  restore: () => Promise<void>;
}

export interface MaterializeLocalCollectionArtifactsResult {
  manifest: LocalArtifactManifestEntry[];
  restore: () => Promise<void>;
}

export interface FinalizedLocalOpenApiArtifactManifest {
  schemaVersion: 1;
  collections: Array<{
    role: CollectionRole;
    collectionPath: string;
    cloudId: string;
    payloadDigest: string;
    artifactDigest: string;
  }>;
}

/**
 * Bind known cloud IDs onto a materialize-time digest manifest. The finished
 * document is written outside role trees so it cannot invalidate artifactDigest.
 */
export function finalizeLocalOpenApiArtifactManifest(
  manifest: LocalArtifactManifestEntry[],
  cloudIds: Partial<Record<CollectionRole, string>>
): FinalizedLocalOpenApiArtifactManifest {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new LocalCollectionArtifactsError('manifest entries are required for finalization');
  }
  const collections: FinalizedLocalOpenApiArtifactManifest['collections'] = [];
  for (const entry of manifest) {
    const cloudId = String(cloudIds[entry.role] ?? entry.cloudId ?? '').trim();
    if (!cloudId) {
      throw new LocalCollectionArtifactsError(`cloudId is required for role ${entry.role}`);
    }
    collections.push({
      role: entry.role,
      collectionPath: entry.collectionPath,
      cloudId,
      payloadDigest: entry.payloadDigest,
      artifactDigest: entry.artifactDigest
    });
  }
  return { schemaVersion: 1, collections };
}

/** Persist the digest-bound manifest at `.postman/local-openapi-artifact-manifest.json`. */
export async function persistLocalOpenApiArtifactManifest(
  repoRoot: string,
  finalized: FinalizedLocalOpenApiArtifactManifest,
  dependencies: { rename?: RenameFn } = {}
): Promise<string> {
  if (!finalized || finalized.schemaVersion !== 1 || !Array.isArray(finalized.collections)) {
    throw new LocalCollectionArtifactsError('finalized manifest must be schemaVersion 1 with collections[]');
  }
  const root = realpathSync(repoRoot);
  const relative = confineRepoRelativePath(
    root,
    '.postman/local-openapi-artifact-manifest.json',
    'local OpenAPI artifact manifest path'
  );
  const abs = path.join(root, relative);
  const parent = path.dirname(abs);
  await assertNoSymlinksInTree(parent, '.postman');
  await assertNoSymlinksInTree(abs, relative);
  await fs.mkdir(parent, { recursive: true });
  const temp = path.join(parent, `.${path.basename(abs)}.${randomUUID()}.tmp`);
  const rename = dependencies.rename ?? ((oldPath, newPath) => fs.rename(oldPath, newPath));
  try {
    const handle = await fs.open(temp, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(finalized, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, abs);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (error instanceof LocalCollectionArtifactsError) throw error;
    throw new LocalCollectionArtifactsError('failed to atomically persist local OpenAPI artifact manifest', error);
  }
  return relative;
}

type SnapshotEntry =
  | { kind: 'missing'; path: string }
  | { kind: 'file'; path: string; snapshotFile: string }
  | { kind: 'directory'; path: string; snapshotDir: string };

type WorkflowPair = {
  spec: string;
  collection: string;
  options: JsonRecord;
  syncOptions: LocalArtifactSyncOptions;
};

// Preview asset names use `@branch` suffixes (e.g. `Payments @feature-x`).
const SAFE_COLLECTION_NAME = /^[A-Za-z0-9._@[\] -]+$/;

/**
 * Derive a stable filesystem/resource-key segment without changing the Postman
 * display name. Already-safe names are identity-preserving at any length; path-
 * unsafe or otherwise degenerate names map to a fixed `collection-<sha256>`
 * segment so arbitrary input length is supported without a truncation/rejection
 * cap. Distinct originals remain distinct via the full digest.
 */
export function deriveArtifactSafeCollectionName(displayName: string): string {
  const original = String(displayName ?? '');
  const trimmed = original.trim();
  if (trimmed && SAFE_COLLECTION_NAME.test(trimmed)) {
    return trimmed;
  }
  const digest = createHash('sha256').update(original).digest('hex');
  return `collection-${digest}`;
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isExdev(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EXDEV');
}

/**
 * Validate and normalize a repo-relative path. Rejects absolute paths,
 * traversal, control characters, and symlink escapes outside repoRoot.
 */
export function confineRepoRelativePath(repoRoot: string, targetPath: string, fieldName: string): string {
  const originalPath = String(targetPath || '');
  const rawPath = originalPath.trim();
  const segments = rawPath.split(/[\\/]+/).filter(Boolean);
  if (
    !rawPath ||
    hasControlCharacter(originalPath) ||
    path.isAbsolute(rawPath) ||
    path.win32.isAbsolute(rawPath) ||
    segments.includes('..') ||
    rawPath.startsWith(':') ||
    hasControlCharacter(rawPath)
  ) {
    throw new LocalCollectionArtifactsError(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }

  const base = realpathSync(repoRoot);
  const resolved = path.resolve(base, rawPath);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new LocalCollectionArtifactsError(`${fieldName} must stay within the repository root; received ${targetPath}`);
  }

  let existingPath = resolved;
  while (!existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) break;
    existingPath = parent;
  }
  const realExistingPath = realpathSync(existingPath);
  const realRelative = path.relative(base, realExistingPath);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new LocalCollectionArtifactsError(
      `${fieldName} resolves outside the repository root via symlink; received ${targetPath}`
    );
  }

  return toPosix(relative);
}

/**
 * Validate a single collection directory segment. Allows `[Smoke] name` /
 * `[Contract] name` characters but rejects nested/absolute/traversal names.
 */
export function assertSafeCollectionName(collectionName: string, fieldName = 'collectionName'): string {
  const trimmed = String(collectionName || '').trim();
  if (
    !trimmed ||
    hasControlCharacter(collectionName) ||
    hasControlCharacter(trimmed) ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..' ||
    !SAFE_COLLECTION_NAME.test(trimmed)
  ) {
    throw new LocalCollectionArtifactsError(
      `${fieldName} must be a single safe collection segment; received ${collectionName}`
    );
  }
  return trimmed;
}

/**
 * Validate an exporter-emitted relative path before any stage write.
 * Returns the confined POSIX-relative form.
 */
export function confineEmittedRelativePath(emittedPath: string, fieldName = 'emitted path'): string {
  const raw = String(emittedPath ?? '');
  if (!raw || hasControlCharacter(raw) || raw.includes('\0')) {
    throw new LocalCollectionArtifactsError(`${fieldName} must be a non-empty confined POSIX-relative path`);
  }
  if (
    path.posix.isAbsolute(raw) ||
    path.win32.isAbsolute(raw) ||
    path.isAbsolute(raw) ||
    /^[A-Za-z]:/.test(raw) ||
    raw.includes('\\') ||
    raw.includes('\0')
  ) {
    throw new LocalCollectionArtifactsError(`${fieldName} must not be absolute; received ${emittedPath}`);
  }
  if (raw.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new LocalCollectionArtifactsError(`${fieldName} must not contain empty/traversal segments; received ${emittedPath}`);
  }
  const normalized = path.posix.normalize(raw);
  if (
    normalized !== raw ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new LocalCollectionArtifactsError(`${fieldName} failed POSIX normalization confinement; received ${emittedPath}`);
  }
  return normalized;
}

export function assertEmittedPathSetConfined(paths: string[]): string[] {
  const confined = paths.map((entry) => confineEmittedRelativePath(entry));
  const seen = new Set<string>();
  const seenLower = new Set<string>();
  const files = new Set<string>();
  for (const relative of confined) {
    const lower = relative.toLowerCase();
    if (seen.has(relative)) {
      throw new LocalCollectionArtifactsError(`duplicate emitted path ${relative}`);
    }
    if (seenLower.has(lower)) {
      throw new LocalCollectionArtifactsError(`case-colliding emitted path ${relative}`);
    }
    seen.add(relative);
    seenLower.add(lower);
    files.add(relative);
  }
  for (const relative of confined) {
    const parts = relative.split('/');
    let prefix = '';
    for (let index = 0; index < parts.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]!;
      if (files.has(prefix) || [...files].some((file) => file.toLowerCase() === prefix.toLowerCase())) {
        throw new LocalCollectionArtifactsError(`directory/file prefix collision for emitted path ${relative}`);
      }
    }
  }
  return confined;
}

function postmanRelative(repoRelativePath: string): string {
  return toPosix(path.posix.relative('.postman', repoRelativePath));
}

function inodeKey(stat: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

async function assertNoSymlinksInTree(absPath: string, fieldName: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new LocalCollectionArtifactsError(`${fieldName} must not be a symlink; refusing to read or write through links`);
  }
  if (!stat.isDirectory()) return;

  const stack: string[] = [absPath];
  const seen = new Set<string>([inodeKey(stat)]);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new LocalCollectionArtifactsError(
          `${fieldName} contains symlink ${toPosix(path.relative(absPath, child)) || entry.name}; refusing to read or write through links`
        );
      }
      if (entry.isDirectory()) {
        const childStat = await fs.lstat(child);
        const key = inodeKey(childStat);
        if (seen.has(key)) {
          throw new LocalCollectionArtifactsError(
            `${fieldName} contains a directory cycle at ${toPosix(path.relative(absPath, child)) || entry.name}`
          );
        }
        seen.add(key);
        stack.push(child);
      }
    }
  }
}

async function listRegularFilesRelative(dir: string, base: string): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await fs.lstat(dir);
  } catch {
    return [];
  }
  if (rootStat.isSymbolicLink()) {
    throw new LocalCollectionArtifactsError(
      `owned tree contains symlink ${toPosix(path.relative(base, dir)) || '.'}; refusing to read or write through links`
    );
  }
  if (!rootStat.isDirectory()) return [];

  const out: string[] = [];
  const stack: string[] = [dir];
  const seen = new Set<string>([inodeKey(rootStat)]);
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new LocalCollectionArtifactsError(
          `owned tree contains symlink ${toPosix(path.relative(base, abs))}; refusing to read or write through links`
        );
      }
      if (entry.isDirectory()) {
        const childStat = await fs.lstat(abs);
        const key = inodeKey(childStat);
        if (seen.has(key)) {
          throw new LocalCollectionArtifactsError(
            `owned tree contains a directory cycle at ${toPosix(path.relative(base, abs))}`
          );
        }
        seen.add(key);
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(base, abs)));
      }
    }
  }
  return out;
}

export function computeArtifactDigest(files: Array<{ relative: string; bytes: Buffer | string }>): string {
  const hash = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.relative.localeCompare(b.relative));
  for (const file of sorted) {
    hash.update(file.relative);
    hash.update('\0');
    hash.update(typeof file.bytes === 'string' ? Buffer.from(file.bytes, 'utf8') : file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Sequential streaming digest of an on-disk tree (path+NUL+bytes+NUL), matching `computeArtifactDigest`. */
export async function computeArtifactDigestFromTree(absDir: string): Promise<string> {
  const relatives = (await listRegularFilesRelative(absDir, absDir)).sort((a, b) => a.localeCompare(b));
  const hash = createHash('sha256');
  for (const relative of relatives) {
    hash.update(relative);
    hash.update('\0');
    const handle = await fs.open(path.join(absDir, relative), 'r');
    try {
      const stream = handle.createReadStream();
      for await (const chunk of stream) {
        hash.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function convertV2CollectionToV3(v2Collection: JsonRecord): JsonRecord {
  const model = (V2 as unknown as { Collection: { parse: (v: unknown) => unknown } }).Collection;
  const parsed = model.parse(v2Collection ?? {});
  return transform(model as never, FormatVersion.V3, parsed as never) as unknown as JsonRecord;
}

async function defaultSplitCollection(v2Collection: JsonRecord): Promise<SplitCollectionFile[]> {
  const v3 = convertV2CollectionToV3(v2Collection);
  const { files, rootPath } = await splitCollection(v3 as never, { stripId: true });
  const out: SplitCollectionFile[] = [];
  for (const file of files) {
    let rel = file.path;
    if (rootPath && rel.startsWith(rootPath)) {
      rel = rel.slice(rootPath.length);
    }
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    out.push({ relative: toPosix(rel), content: file.content });
  }
  return out;
}

function validateSplitFiles(files: SplitCollectionFile[], stageRoot: string): SplitCollectionFile[] {
  const confinedPaths = assertEmittedPathSetConfined(files.map((file) => file.relative));
  const stageBase = path.resolve(stageRoot);
  return files.map((file, index) => {
    const relative = confinedPaths[index]!;
    const destination = path.resolve(stageBase, relative);
    const bounded = path.relative(stageBase, destination);
    if (!bounded || bounded.startsWith('..') || path.isAbsolute(bounded)) {
      throw new LocalCollectionArtifactsError(`emitted path escapes staging root; received ${file.relative}`);
    }
    return { relative, content: file.content };
  });
}

async function snapshotPath(
  absPath: string,
  snapshotStoreDir: string,
  label: string
): Promise<SnapshotEntry> {
  await assertNoSymlinksInTree(absPath, absPath);
  const store = path.join(snapshotStoreDir, label);
  try {
    const stat = await fs.lstat(absPath);
    if (stat.isDirectory()) {
      await fs.rm(store, { recursive: true, force: true });
      await copyDir(absPath, store);
      return { kind: 'directory', path: absPath, snapshotDir: store };
    }
    if (stat.isFile()) {
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.copyFile(absPath, store);
      return { kind: 'file', path: absPath, snapshotFile: store };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { kind: 'missing', path: absPath };
    }
    throw error;
  }
  return { kind: 'missing', path: absPath };
}

async function restoreSnapshot(entry: SnapshotEntry): Promise<void> {
  if (entry.kind === 'missing') {
    await fs.rm(entry.path, { recursive: true, force: true });
    return;
  }
  if (entry.kind === 'file') {
    await fs.mkdir(path.dirname(entry.path), { recursive: true });
    await fs.copyFile(entry.snapshotFile, entry.path);
    return;
  }
  await fs.rm(entry.path, { recursive: true, force: true });
  await copyDir(entry.snapshotDir, entry.path);
}

async function copyDir(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  const stack: Array<{ from: string; to: string }> = [{ from: source, to: destination }];
  const seen = new Set<string>();
  const sourceStat = await fs.lstat(source);
  seen.add(inodeKey(sourceStat));

  while (stack.length > 0) {
    const { from, to } = stack.pop()!;
    const entries = await fs.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const childFrom = path.join(from, entry.name);
      const childTo = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        throw new LocalCollectionArtifactsError('refusing to copy symlink while staging collection artifacts');
      }
      if (entry.isDirectory()) {
        const childStat = await fs.lstat(childFrom);
        const key = inodeKey(childStat);
        if (seen.has(key)) {
          throw new LocalCollectionArtifactsError('refusing to copy a directory cycle while staging collection artifacts');
        }
        seen.add(key);
        await fs.mkdir(childTo, { recursive: true });
        stack.push({ from: childFrom, to: childTo });
      } else if (entry.isFile()) {
        await fs.copyFile(childFrom, childTo);
      }
    }
  }
}

async function moveOrCopyToSibling(
  sourceDir: string,
  siblingDir: string,
  rename: RenameFn
): Promise<void> {
  await fs.rm(siblingDir, { recursive: true, force: true });
  try {
    await rename(sourceDir, siblingDir);
  } catch (error) {
    if (!isExdev(error)) throw error;
    await copyDir(sourceDir, siblingDir);
    await fs.rm(sourceDir, { recursive: true, force: true });
  }
}

/**
 * Write a complete tree under run-temp, move/copy it to a same-parent sibling
 * swap under the destination, then rename into place. Final destination rename
 * is always same-filesystem; EXDEV from a cross-device runTemp falls back to copy.
 */
async function writeTreeAtomic(options: {
  runStageDir: string;
  destDir: string;
  files: SplitCollectionFile[];
  rename: RenameFn;
}): Promise<void> {
  const { runStageDir, destDir, files, rename } = options;
  await fs.rm(runStageDir, { recursive: true, force: true });
  await fs.mkdir(runStageDir, { recursive: true });
  const confined = validateSplitFiles(files, runStageDir);
  for (const file of confined) {
    const dest = path.join(runStageDir, file.relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, file.content, 'utf8');
  }

  await fs.mkdir(path.dirname(destDir), { recursive: true });
  const siblingDir = path.join(
    path.dirname(destDir),
    `.__local_artifact_incoming__${path.basename(destDir)}`
  );
  const backupDir = `${destDir}.__local_artifact_backup__`;
  await fs.rm(siblingDir, { recursive: true, force: true });
  await fs.rm(backupDir, { recursive: true, force: true });

  await moveOrCopyToSibling(runStageDir, siblingDir, rename);

  let hadDest = false;
  try {
    await rename(destDir, backupDir);
    hadDest = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
  try {
    await rename(siblingDir, destDir);
  } catch (error) {
    if (hadDest) {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
      await rename(backupDir, destDir).catch(() => undefined);
    } else {
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
    }
    await fs.rm(siblingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  if (hadDest) {
    await fs.rm(backupDir, { recursive: true, force: true });
  }
}

function mergeWorkflowsYaml(existingRaw: string | undefined, pairs: WorkflowPair[]): string {
  let root: JsonRecord = {};
  if (typeof existingRaw === 'string' && existingRaw.trim()) {
    let parsed: unknown;
    try {
      parsed = parseYaml(existingRaw);
    } catch (error) {
      throw new LocalCollectionArtifactsError(
        `.postman/workflows.yaml exists but is not parseable YAML (${error instanceof Error ? error.message : String(error)})`,
        error
      );
    }
    if (parsed === null || parsed === undefined) {
      root = {};
    } else if (!isRecord(parsed)) {
      throw new LocalCollectionArtifactsError(
        '.postman/workflows.yaml exists but does not contain a YAML mapping'
      );
    } else {
      root = { ...parsed };
    }
  }

  const workflows = isRecord(root.workflows) ? { ...root.workflows } : {};
  const currentPairs = asArray(workflows.syncSpecToCollection as unknown[] | undefined)
    .map((entry) => (isRecord(entry) ? { ...entry } : null))
    .filter((entry): entry is JsonRecord => Boolean(entry));

  for (const pair of pairs) {
    const index = currentPairs.findIndex((entry) => String(entry.collection ?? '') === pair.collection);
    if (index >= 0) {
      const previous = currentPairs[index]!;
      const previousOptions = isRecord(previous.options) ? previous.options : {};
      const previousSyncOptions = isRecord(previous.syncOptions) ? previous.syncOptions : {};
      currentPairs[index] = {
        ...previous,
        spec: pair.spec,
        collection: pair.collection,
        options: { ...previousOptions, ...pair.options },
        syncOptions: { ...previousSyncOptions, ...pair.syncOptions }
      };
    } else {
      currentPairs.push({
        spec: pair.spec,
        collection: pair.collection,
        options: { ...pair.options },
        syncOptions: { ...pair.syncOptions }
      });
    }
  }

  workflows.syncSpecToCollection = currentPairs;
  root.workflows = workflows;
  return stringifyYaml(root, { lineWidth: 0 });
}

/**
 * Materialize complete role-aware Collection v3 trees under
 * `postman/collections/<name>`, merge-preserving `.postman/workflows.yaml`,
 * and return a digest-bound manifest plus an idempotent restore handle.
 */
export async function materializeLocalCollectionArtifacts(
  input: MaterializeLocalCollectionArtifactsInput
): Promise<MaterializeLocalCollectionArtifactsResult> {
  if (!input || typeof input.repoRoot !== 'string' || !input.repoRoot.trim()) {
    throw new LocalCollectionArtifactsError('repoRoot is required');
  }
  if (typeof input.runTempDir !== 'string' || !input.runTempDir.trim()) {
    throw new LocalCollectionArtifactsError('runTempDir is required');
  }
  if (!Array.isArray(input.roles) || input.roles.length === 0) {
    throw new LocalCollectionArtifactsError('at least one role payload is required');
  }

  const allowedRoles = new Set<CollectionRole>(['baseline', 'smoke', 'contract']);
  const seenRoles = new Set<CollectionRole>();
  for (const entry of input.roles) {
    const role = entry?.role;
    if (typeof role !== 'string' || !allowedRoles.has(role as CollectionRole)) {
      throw new LocalCollectionArtifactsError(`role must be exactly baseline, smoke, or contract; received ${String(role)}`);
    }
    if (seenRoles.has(role as CollectionRole)) {
      throw new LocalCollectionArtifactsError(`duplicate role ${role}`);
    }
    seenRoles.add(role as CollectionRole);
  }

  const repoRoot = realpathSync(input.repoRoot);
  await fs.mkdir(input.runTempDir, { recursive: true });
  const runTempDir = await fs.realpath(input.runTempDir);
  const rename: RenameFn = input.rename ?? ((oldPath, newPath) => fs.rename(oldPath, newPath));
  const splitter: CollectionSplitter = input.splitter ?? defaultSplitCollection;

  const rolePlans: Array<{
    role: CollectionRole;
    collectionPath: string;
    absCollectionPath: string;
    collection: JsonRecord;
    payloadDigest: string;
    cloudId?: string;
  }> = [];
  const seenPaths = new Set<string>();
  const seenPathLower = new Set<string>();

  for (const role of input.roles) {
    if (!role || typeof role.role !== 'string') {
      throw new LocalCollectionArtifactsError('role is required');
    }
    const collectionName = assertSafeCollectionName(
      role.collectionName,
      `collectionName for ${String(role.role)}`
    );
    if (!isRecord(role.collection)) {
      throw new LocalCollectionArtifactsError(`collection payload is required for role ${role.role}`);
    }
    if (typeof role.payloadDigest !== 'string' || !role.payloadDigest.trim()) {
      throw new LocalCollectionArtifactsError(`payloadDigest is required for role ${role.role}`);
    }
    const collectionPath = confineRepoRelativePath(
      repoRoot,
      path.posix.join('postman/collections', collectionName),
      `collection path for ${role.role}`
    );
    const lower = collectionPath.toLowerCase();
    if (seenPaths.has(collectionPath) || seenPathLower.has(lower)) {
      throw new LocalCollectionArtifactsError(`collection path collision for ${collectionPath}`);
    }
    seenPaths.add(collectionPath);
    seenPathLower.add(lower);
    rolePlans.push({
      role: role.role,
      collectionPath,
      absCollectionPath: path.join(repoRoot, collectionPath),
      collection: role.collection,
      payloadDigest: role.payloadDigest,
      cloudId: role.cloudId
    });
  }

  let relativeSpecPath: string | undefined;
  if (typeof input.specPath === 'string' && input.specPath.trim()) {
    relativeSpecPath = confineRepoRelativePath(repoRoot, input.specPath, 'specPath');
    const absSpec = path.join(repoRoot, relativeSpecPath);
    try {
      const stat = await fs.lstat(absSpec);
      if (stat.isSymbolicLink()) {
        throw new LocalCollectionArtifactsError('specPath must not be a symlink; refusing to read through links');
      }
      if (!stat.isFile()) {
        throw new LocalCollectionArtifactsError(`specPath must be a regular file; received ${input.specPath}`);
      }
    } catch (error) {
      if (error instanceof LocalCollectionArtifactsError) throw error;
      throw new LocalCollectionArtifactsError(`specPath does not exist as a local file; received ${input.specPath}`, error);
    }
    if (!isRecord(input.options)) {
      throw new LocalCollectionArtifactsError('generation options are required when writing syncSpecToCollection pairs');
    }
  }

  const syncOptions: LocalArtifactSyncOptions = {
    syncExamples: true,
    ...(isRecord(input.syncOptions) ? input.syncOptions : {})
  };
  if (typeof syncOptions.syncExamples !== 'boolean') {
    throw new LocalCollectionArtifactsError('syncOptions.syncExamples must be a boolean');
  }

  const workflowsAbs = path.join(repoRoot, '.postman', 'workflows.yaml');
  await assertNoSymlinksInTree(path.dirname(workflowsAbs), '.postman');
  await assertNoSymlinksInTree(workflowsAbs, '.postman/workflows.yaml');
  for (const plan of rolePlans) {
    await assertNoSymlinksInTree(plan.absCollectionPath, plan.collectionPath);
  }

  const snapshots: SnapshotEntry[] = [];
  const snapshotStoreRoot = path.join(runTempDir, 'snapshots', randomUUID());
  await fs.mkdir(snapshotStoreRoot, { recursive: true });
  for (const [index, plan] of rolePlans.entries()) {
    snapshots.push(await snapshotPath(plan.absCollectionPath, snapshotStoreRoot, `role-${index}-${plan.role}`));
  }
  snapshots.push(await snapshotPath(workflowsAbs, snapshotStoreRoot, 'workflows'));

  const restore = async (): Promise<void> => {
    for (const entry of snapshots) {
      await restoreSnapshot(entry);
    }
  };

  let committed = false;
  try {
    const manifest: LocalArtifactManifestEntry[] = [];
    const workflowPairs: WorkflowPair[] = [];

    for (const plan of rolePlans) {
      const files = await splitter(plan.collection);
      const stagedDir = path.join(runTempDir, 'stage', plan.role);
      const stageRoot = path.resolve(runTempDir, 'stage');
      const stagedRelative = path.relative(stageRoot, path.resolve(stagedDir));
      if (!stagedRelative || stagedRelative.startsWith('..') || path.isAbsolute(stagedRelative)) {
        throw new LocalCollectionArtifactsError(`stage path for role ${plan.role} must stay under runTempDir/stage`);
      }
      await writeTreeAtomic({
        runStageDir: stagedDir,
        destDir: plan.absCollectionPath,
        files,
        rename
      });
      await assertNoSymlinksInTree(plan.absCollectionPath, plan.collectionPath);
      const artifactDigest = await computeArtifactDigestFromTree(plan.absCollectionPath);
      manifest.push({
        role: plan.role,
        collectionPath: plan.collectionPath,
        ...(plan.cloudId ? { cloudId: plan.cloudId } : {}),
        payloadDigest: plan.payloadDigest,
        artifactDigest
      });
      if (relativeSpecPath && isRecord(input.options)) {
        workflowPairs.push({
          spec: postmanRelative(relativeSpecPath),
          collection: postmanRelative(plan.collectionPath),
          options: { ...input.options },
          syncOptions: { ...syncOptions }
        });
      }
    }

    if (relativeSpecPath && workflowPairs.length > 0) {
      let existingRaw: string | undefined;
      try {
        const workflowsStat = await fs.lstat(workflowsAbs);
        if (workflowsStat.isSymbolicLink()) {
          throw new LocalCollectionArtifactsError(
            '.postman/workflows.yaml must not be a symlink; refusing to read or write through links'
          );
        }
        existingRaw = await fs.readFile(workflowsAbs, 'utf8');
      } catch (error) {
        if (error instanceof LocalCollectionArtifactsError) throw error;
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      const nextYaml = mergeWorkflowsYaml(existingRaw, workflowPairs);
      await fs.mkdir(path.dirname(workflowsAbs), { recursive: true });
      const stagedWorkflows = path.join(runTempDir, 'stage', 'workflows.yaml');
      const siblingWorkflows = path.join(path.dirname(workflowsAbs), '.__local_artifact_incoming__workflows.yaml');
      await fs.writeFile(stagedWorkflows, nextYaml, 'utf8');
      await fs.rm(siblingWorkflows, { force: true });
      try {
        await rename(stagedWorkflows, siblingWorkflows);
      } catch (error) {
        if (!isExdev(error)) throw error;
        await fs.copyFile(stagedWorkflows, siblingWorkflows);
        await fs.rm(stagedWorkflows, { force: true });
      }
      const backupWorkflows = `${workflowsAbs}.__local_artifact_backup__`;
      await fs.rm(backupWorkflows, { force: true });
      let hadWorkflows = false;
      try {
        await rename(workflowsAbs, backupWorkflows);
        hadWorkflows = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
      try {
        await rename(siblingWorkflows, workflowsAbs);
      } catch (error) {
        if (hadWorkflows) {
          await rename(backupWorkflows, workflowsAbs).catch(() => undefined);
        }
        await fs.rm(siblingWorkflows, { force: true }).catch(() => undefined);
        throw error;
      }
      if (hadWorkflows) {
        await fs.rm(backupWorkflows, { force: true });
      }
    }

    committed = true;
    return { manifest, restore };
  } catch (error) {
    if (!committed) {
      await restore().catch(() => undefined);
    }
    if (error instanceof LocalCollectionArtifactsError) throw error;
    throw new LocalCollectionArtifactsError('failed to materialize local collection artifacts', error);
  }
}
