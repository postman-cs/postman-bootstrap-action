import { computePayloadDigest, type JsonRecord } from './local-openapi-collection-generation.js';

/** Frozen first-canary bound: no granular plan may mutate more than five entities. */
export const COLLECTION_DELTA_MAX_OPERATIONS = 5;
/** Frozen first-canary bound: no granular plan may carry more than 64 KiB of changed entities. */
export const COLLECTION_DELTA_MAX_CHANGED_BYTES = 64 * 1024;

export type CollectionDeltaEntityType = 'collection' | 'http-request';
export type CollectionDeltaOperationKind = 'create' | 'patch' | 'move' | 'delete';

export interface CollectionDeltaOperation {
  kind: CollectionDeltaOperationKind;
  key: string;
  entityType: CollectionDeltaEntityType;
  /** Preserved v2 structural id when this operation addresses an existing entity. */
  sourceId?: string;
  /** Stable parent key, omitted only for a root-level entity. */
  parentKey?: string;
  index: number;
  item: JsonRecord;
}

export type CollectionDeltaPlan =
  | { decision: 'unchanged'; changedBytes: 0; operations: [] }
  | { decision: 'fallback'; reason: CollectionDeltaFallbackReason; changedBytes: number; operations: [] }
  | { decision: 'apply'; changedBytes: number; operations: CollectionDeltaOperation[] };

export type CollectionDeltaFallbackReason =
  | 'ambiguous-semantic-key'
  | 'invalid-collection-shape'
  | 'operation-count-exceeded'
  | 'changed-bytes-exceeded'
  | 'unsupported-root-attribute'
  | 'unsupported-workflow-shape'
  | 'unsupported-script-transform'
  | 'unsupported-example-transform'
  | 'unsupported-response-transform'
  | 'unsupported-auth-transform'
  | 'unsupported-entity-transform';

export interface PlanCollectionDeltaInput {
  snapshot: JsonRecord;
  desired: JsonRecord;
  maxOperations?: number;
  maxChangedBytes?: number;
}

interface IndexedEntity {
  key: string;
  sourceId?: string;
  entityType: CollectionDeltaEntityType;
  parentKey?: string;
  index: number;
  depth: number;
  item: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function entityType(item: JsonRecord): CollectionDeltaEntityType | null {
  if (Array.isArray(item.item) && !isRecord(item.request)) return 'collection';
  if (isRecord(item.request) && !Array.isArray(item.item)) return 'http-request';
  return null;
}

function semanticSegment(item: JsonRecord, kind: CollectionDeltaEntityType): string {
  const name = typeof item.name === 'string' ? item.name : '';
  const method = kind === 'http-request' && isRecord(item.request)
    ? String(item.request.method ?? '').toUpperCase()
    : '';
  return `${kind}:${method}:${name}`;
}

function preservedId(item: JsonRecord): string | undefined {
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  return id || undefined;
}

interface StructuralNode {
  item: JsonRecord;
  kind: CollectionDeltaEntityType;
  id?: string;
  semanticKey: string;
}

function structuralNodes(collection: JsonRecord): { nodes: StructuralNode[]; invalid: boolean } {
  const nodes: StructuralNode[] = [];
  let invalid = !Array.isArray(collection.item);
  const visit = (items: unknown[], parentPath: string): void => {
    for (const raw of items) {
      if (!isRecord(raw)) {
        invalid = true;
        continue;
      }
      const kind = entityType(raw);
      if (!kind) {
        invalid = true;
        continue;
      }
      const semantic = `${parentPath}/${semanticSegment(raw, kind)}`;
      nodes.push({ item: raw, kind, id: preservedId(raw), semanticKey: semantic });
      if (kind === 'collection') visit(raw.item as unknown[], semantic);
    }
  };
  if (Array.isArray(collection.item)) visit(collection.item, '');
  return { nodes, invalid };
}

function directId(record: JsonRecord): string | undefined {
  return typeof record.id === 'string' && record.id.trim() ? record.id : undefined;
}

function copyDirectStructuralId(snapshot: JsonRecord, desired: JsonRecord): void {
  const id = directId(snapshot);
  if (id) desired.id = id;
  else delete desired.id;
}

function responseWithoutStructuralId(value: JsonRecord): JsonRecord {
  const copy = cloneRecord(value);
  delete copy.id;
  return copy;
}

/** Copy only direct saved-response ids when every non-structural response field is unchanged. */
function normalizeSavedResponseIds(snapshot: JsonRecord, desired: JsonRecord): void {
  if (!Array.isArray(snapshot.response) || !Array.isArray(desired.response)) return;
  if (snapshot.response.length !== desired.response.length) return;
  for (let index = 0; index < snapshot.response.length; index += 1) {
    const previous = snapshot.response[index];
    const next = desired.response[index];
    if (!isRecord(previous) || !isRecord(next)) continue;
    if (stable(responseWithoutStructuralId(previous)) !== stable(responseWithoutStructuralId(next))) continue;
    copyDirectStructuralId(previous, next);
  }
}

function normalizeMatchedStructuralIds(snapshot: StructuralNode, desired: StructuralNode): void {
  copyDirectStructuralId(snapshot.item, desired.item);
  if (isRecord(snapshot.item.request) && isRecord(desired.item.request)) {
    copyDirectStructuralId(snapshot.item.request, desired.item.request);
  }
  normalizeSavedResponseIds(snapshot.item, desired.item);
}

/**
 * Converter output randomizes v2 structural ids. Canonicalize only a desired
 * clone's proven structural peers: exact ids first, then unique semantic peers.
 */
function normalizeDesiredStructuralIdentities(
  snapshot: JsonRecord,
  desired: JsonRecord
): { desired: JsonRecord; ambiguous: boolean } {
  const normalized = cloneRecord(desired);
  const before = structuralNodes(snapshot);
  const after = structuralNodes(normalized);
  if (before.invalid || after.invalid) return { desired: normalized, ambiguous: false };

  const snapshotIds = new Map<string, StructuralNode>();
  const desiredIdCounts = new Map<string, number>();
  for (const node of before.nodes) {
    if (!node.id) continue;
    if (snapshotIds.has(node.id)) return { desired: normalized, ambiguous: true };
    snapshotIds.set(node.id, node);
  }
  for (const node of after.nodes) {
    if (node.id) desiredIdCounts.set(node.id, (desiredIdCounts.get(node.id) ?? 0) + 1);
  }

  const matched = new Map<StructuralNode, StructuralNode>();
  const usedSnapshot = new Set<StructuralNode>();
  for (const node of after.nodes) {
    if (!node.id || desiredIdCounts.get(node.id) !== 1) continue;
    const previous = snapshotIds.get(node.id);
    if (previous && !usedSnapshot.has(previous)) {
      matched.set(node, previous);
      usedSnapshot.add(previous);
    }
  }

  const bySemantic = (nodes: readonly StructuralNode[]) => {
    const groups = new Map<string, StructuralNode[]>();
    for (const node of nodes) groups.set(node.semanticKey, [...(groups.get(node.semanticKey) ?? []), node]);
    return groups;
  };
  const beforeSemantic = bySemantic(before.nodes);
  const afterSemantic = bySemantic(after.nodes);
  let ambiguous = false;
  for (const desiredNode of after.nodes) {
    if (matched.has(desiredNode)) continue;
    const priorCandidates = beforeSemantic.get(desiredNode.semanticKey) ?? [];
    const desiredCandidates = afterSemantic.get(desiredNode.semanticKey) ?? [];
    if (priorCandidates.length === 0) continue;
    if (priorCandidates.length !== 1 || desiredCandidates.length !== 1) {
      ambiguous = true;
      continue;
    }
    const previous = priorCandidates[0]!;
    if (!usedSnapshot.has(previous)) {
      matched.set(desiredNode, previous);
      usedSnapshot.add(previous);
    }
  }
  if (ambiguous) return { desired: normalized, ambiguous: true };
  for (const [desiredNode, snapshotNode] of matched) {
    normalizeMatchedStructuralIds(snapshotNode, desiredNode);
  }
  return { desired: normalized, ambiguous: false };
}

function indexCollection(
  collection: JsonRecord
): { entries: IndexedEntity[]; invalid: boolean; ambiguous: boolean } {
  const entries: IndexedEntity[] = [];
  const seenKeys = new Set<string>();
  let invalid = !Array.isArray(collection.item);
  let ambiguous = false;

  const visit = (items: unknown[], parentKey: string | undefined, parentPath: string, depth: number): void => {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!isRecord(item)) {
        invalid = true;
        continue;
      }
      const kind = entityType(item);
      if (!kind) {
        invalid = true;
        continue;
      }
      const sourceId = preservedId(item);
      const semantic = `${parentPath}/${semanticSegment(item, kind)}`;
      const key = sourceId ? `id:${sourceId}` : `semantic:${semantic}`;
      if (seenKeys.has(key)) {
        ambiguous = true;
        continue;
      }
      seenKeys.add(key);
      const entry = { key, sourceId, entityType: kind, parentKey, index, depth, item };
      entries.push(entry);
      if (kind === 'collection') {
        visit(item.item as unknown[], key, semantic, depth + 1);
      }
    }
  };

  if (Array.isArray(collection.item)) visit(collection.item, undefined, '', 0);
  return { entries, invalid, ambiguous };
}

function changedUnsupportedField(snapshot: JsonRecord, desired: JsonRecord, field: string): boolean {
  return stable(snapshot[field]) !== stable(desired[field]);
}

function unsupportedTransform(snapshot: JsonRecord, desired: JsonRecord): CollectionDeltaFallbackReason | null {
  for (const item of [snapshot, desired]) {
    if ('workflow' in item || 'workflows' in item) return 'unsupported-workflow-shape';
  }
  if (changedUnsupportedField(snapshot, desired, 'event')) return 'unsupported-script-transform';
  if (changedUnsupportedField(snapshot, desired, 'response')) return 'unsupported-response-transform';
  if (changedUnsupportedField(snapshot, desired, 'auth')) return 'unsupported-auth-transform';
  if (changedUnsupportedField(snapshot, desired, 'example')) return 'unsupported-example-transform';
  const allowed = new Set(['id', 'name', 'description', 'request', 'item', 'event', 'response', 'auth', 'example']);
  for (const key of new Set([...Object.keys(snapshot), ...Object.keys(desired)])) {
    if (!allowed.has(key) && changedUnsupportedField(snapshot, desired, key)) {
      return 'unsupported-entity-transform';
    }
  }
  return null;
}

function operation(kind: CollectionDeltaOperationKind, entry: IndexedEntity): CollectionDeltaOperation {
  return {
    kind,
    key: entry.key,
    entityType: entry.entityType,
    ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
    ...(entry.parentKey ? { parentKey: entry.parentKey } : {}),
    index: entry.index,
    item: cloneRecord(entry.item)
  };
}

/**
 * Conservatively plan a content-only v2.1 collection delta. Any structure or
 * transform outside folders and HTTP requests returns a named fallback decision
 * instead of approximating a partial update.
 */
export function planCollectionDelta(input: PlanCollectionDeltaInput): CollectionDeltaPlan {
  if (!isRecord(input.snapshot) || !isRecord(input.desired)) {
    return { decision: 'fallback', reason: 'invalid-collection-shape', changedBytes: 0, operations: [] };
  }
  const normalized = normalizeDesiredStructuralIdentities(input.snapshot, input.desired);
  if (normalized.ambiguous) {
    return { decision: 'fallback', reason: 'ambiguous-semantic-key', changedBytes: 0, operations: [] };
  }
  const desired = normalized.desired;
  if (computePayloadDigest(input.snapshot) === computePayloadDigest(desired)) {
    return { decision: 'unchanged', changedBytes: 0, operations: [] };
  }

  const snapshotInfo = isRecord(input.snapshot.info) ? cloneRecord(input.snapshot.info) : {};
  const desiredInfo = isRecord(desired.info) ? cloneRecord(desired.info) : {};
  delete snapshotInfo._postman_id;
  delete desiredInfo._postman_id;
  if (stable(snapshotInfo) !== stable(desiredInfo)) {
    return { decision: 'fallback', reason: 'unsupported-root-attribute', changedBytes: 0, operations: [] };
  }
  if ('workflow' in input.snapshot || 'workflows' in input.snapshot || 'workflow' in desired || 'workflows' in desired) {
    return { decision: 'fallback', reason: 'unsupported-workflow-shape', changedBytes: 0, operations: [] };
  }

  // Root attributes outside info/item - auth, variable, event, and anything else
  // the planner does not model granularly - have no delta operation. Without this
  // check a root-only change reports an eligible apply carrying zero operations,
  // which would silently skip the write and leave the remote collection stale.
  const rootAttributesOutsideItems = (collection: JsonRecord): string => {
    const rest: JsonRecord = {};
    for (const key of Object.keys(collection)) {
      if (key === 'info' || key === 'item') continue;
      rest[key] = collection[key];
    }
    return stable(rest);
  };
  if (rootAttributesOutsideItems(input.snapshot) !== rootAttributesOutsideItems(desired)) {
    return { decision: 'fallback', reason: 'unsupported-root-attribute', changedBytes: 0, operations: [] };
  }
  const before = indexCollection(input.snapshot);
  const after = indexCollection(desired);
  if (before.invalid || after.invalid) {
    return { decision: 'fallback', reason: 'invalid-collection-shape', changedBytes: 0, operations: [] };
  }
  if (before.ambiguous || after.ambiguous) {
    return { decision: 'fallback', reason: 'ambiguous-semantic-key', changedBytes: 0, operations: [] };
  }

  const beforeByKey = new Map(before.entries.map((entry) => [entry.key, entry]));
  const afterByKey = new Map(after.entries.map((entry) => [entry.key, entry]));
  const creates: IndexedEntity[] = [];
  const patches: IndexedEntity[] = [];
  const moves: IndexedEntity[] = [];
  const deletes: IndexedEntity[] = [];

  for (const entry of after.entries) {
    const previous = beforeByKey.get(entry.key);
    if (!previous) {
      const unsupported = unsupportedTransform({}, entry.item);
      if (unsupported) return { decision: 'fallback', reason: unsupported, changedBytes: 0, operations: [] };
      creates.push(entry);
      continue;
    }
    if (previous.entityType !== entry.entityType) {
      return { decision: 'fallback', reason: 'unsupported-entity-transform', changedBytes: 0, operations: [] };
    }
    const unsupported = unsupportedTransform(previous.item, entry.item);
    if (unsupported) return { decision: 'fallback', reason: unsupported, changedBytes: 0, operations: [] };
    const oldContent = cloneRecord(previous.item);
    const newContent = cloneRecord(entry.item);
    delete oldContent.id;
    delete newContent.id;
    delete oldContent.item;
    delete newContent.item;
    if (stable(oldContent) !== stable(newContent)) patches.push(entry);
    if (previous.parentKey !== entry.parentKey || previous.index !== entry.index) moves.push(entry);
  }
  for (const entry of before.entries) {
    if (!afterByKey.has(entry.key)) deletes.push(entry);
  }

  creates.sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  patches.sort((a, b) => a.key.localeCompare(b.key));
  // Moving an item later shifts its following siblings earlier without moving
  // those siblings themselves. Emit that single explicit move when available;
  // if the requested order only has earlier moves, the first deterministic
  // earlier move is the inverse representation.
  const explicitMoves = moves.filter((entry) => {
    const previous = beforeByKey.get(entry.key);
    return previous?.parentKey !== entry.parentKey || (previous?.index ?? entry.index) < entry.index;
  });
  const orderedMoves = (explicitMoves.length > 0 ? explicitMoves : moves)
    .sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key));
  deletes.sort((a, b) => b.depth - a.depth || a.key.localeCompare(b.key));
  const operations = [
    ...creates.map((entry) => operation('create', entry)),
    ...patches.map((entry) => operation('patch', entry)),
    ...orderedMoves.map((entry) => operation('move', entry)),
    ...deletes.map((entry) => operation('delete', entry))
  ];
  const changedBytes = Buffer.byteLength(stable(operations), 'utf8');
  const maxOperations = input.maxOperations ?? COLLECTION_DELTA_MAX_OPERATIONS;
  const maxChangedBytes = input.maxChangedBytes ?? COLLECTION_DELTA_MAX_CHANGED_BYTES;
  if (operations.length > maxOperations) {
    return { decision: 'fallback', reason: 'operation-count-exceeded', changedBytes, operations: [] };
  }
  if (changedBytes > maxChangedBytes) {
    return { decision: 'fallback', reason: 'changed-bytes-exceeded', changedBytes, operations: [] };
  }
  if (operations.length === 0) {
    // Digests differed above, so an empty plan means the change is outside every
    // modeled entity. Fall back rather than report a no-write apply.
    return { decision: 'fallback', reason: 'unsupported-root-attribute', changedBytes, operations: [] };
  }
  return { decision: 'apply', changedBytes, operations };
}
