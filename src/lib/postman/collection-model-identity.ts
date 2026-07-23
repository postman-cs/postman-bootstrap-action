const BARE_COLLECTION_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const PUBLIC_COLLECTION_UID_RE =
  /^\d+-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/**
 * Normalize only the two collection identifiers whose model identity is
 * unambiguous: a bare UUID and a numeric-owner-prefixed UUID. Arbitrary aliases
 * remain exact so a hyphenated server id can never be accidentally conflated.
 */
export function normalizeCollectionModelIdentity(value: string): string {
  const id = String(value ?? '').trim();
  if (BARE_COLLECTION_UUID_RE.test(id)) return id.toLowerCase();
  return PUBLIC_COLLECTION_UID_RE.exec(id)?.[1]?.toLowerCase() ?? id;
}
