const RECEIPT_KEY = 'x-pm-onboarding-content-receipt';

export const COLLECTION_SEMANTIC_RECEIPT_KEY = RECEIPT_KEY;

export interface CollectionSemanticReceipt {
  schemaVersion: 1;
  algorithm: 'sha256';
  digest: string;
}

function invalidReceipt(reason: string): Error {
  return new Error(`COLLECTION_SEMANTIC_RECEIPT_INVALID: ${reason}`);
}

function receiptSuffix(description: string): { base: string; payload: string } | undefined {
  const prefix = `${RECEIPT_KEY}: `;
  const ownLine = description.startsWith(prefix) ? 0 : description.lastIndexOf(`\n${prefix}`);
  if (ownLine < 0) return undefined;
  const lineStart = ownLine === 0 ? 0 : ownLine + 1;
  const payload = description.slice(lineStart + prefix.length);
  if (payload.includes('\n') || payload.includes('\r')) {
    throw invalidReceipt('reserved receipt must be the final description line');
  }
  return {
    base: ownLine === 0 ? '' : description.slice(0, ownLine),
    payload
  };
}

/** Parse the strict, final-line receipt. Reserved-key lookalikes fail closed. */
export function parseCollectionSemanticReceipt(
  description: unknown
): CollectionSemanticReceipt | undefined {
  if (typeof description !== 'string' || !description) return undefined;
  const suffix = receiptSuffix(description);
  if (!suffix) {
    if (description.includes(RECEIPT_KEY)) {
      throw invalidReceipt('reserved receipt key is not a final-line receipt');
    }
    return undefined;
  }
  if (suffix.base.includes(RECEIPT_KEY)) {
    throw invalidReceipt('multiple reserved receipt keys are forbidden');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(suffix.payload);
  } catch {
    throw invalidReceipt('receipt payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidReceipt('receipt payload must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== 'algorithm' ||
    keys[1] !== 'digest' ||
    keys[2] !== 'schemaVersion' ||
    record.schemaVersion !== 1 ||
    record.algorithm !== 'sha256' ||
    typeof record.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.digest)
  ) {
    throw invalidReceipt('receipt shape is not the supported sha256 schema');
  }
  return {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest: record.digest
  };
}

/** Remove only a valid receipt suffix, restoring the byte-exact prior description. */
export function stripCollectionSemanticReceipt(description: unknown): unknown {
  if (typeof description !== 'string' || !description) return description;
  const receipt = parseCollectionSemanticReceipt(description);
  if (!receipt) return description;
  return receiptSuffix(description)!.base;
}

/** Append one deterministic receipt suffix; an existing valid suffix is replaced. */
export function renderCollectionSemanticReceipt(
  description: unknown,
  digest: string
): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw invalidReceipt('digest must be lowercase 64-hex');
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw invalidReceipt('collection description must be a string when a receipt is attached');
  }
  const stripped = stripCollectionSemanticReceipt(description);
  const base = typeof stripped === 'string' ? stripped : '';
  const receipt: CollectionSemanticReceipt = {
    schemaVersion: 1,
    algorithm: 'sha256',
    digest
  };
  const line = `${RECEIPT_KEY}: ${JSON.stringify(receipt)}`;
  return base ? `${base}\n${line}` : line;
}
