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

/**
 * True for a bare `<uuid>` model id — what `sync POST /collection/import`
 * returns, and the only form the sync routes address collections by.
 *
 * Collection-service ROOT routes (`GET`/`PATCH /v3/collections/:id`) reject
 * this form `403 FORBIDDEN` and require the full `<owner>-<uuid>` public uid
 * (live-proven 2026-08-03 on non-org and org sandbox keys), so a bare id must
 * be resolved through workspace inventory before it addresses a ROOT route.
 */
export function isBareCollectionUuid(value: string): boolean {
  return BARE_COLLECTION_UUID_RE.test(String(value ?? '').trim());
}

/** True only for the ROOT-addressable `<numeric-owner>-<uuid>` public uid. */
export function isFullPublicCollectionUid(value: string): boolean {
  return PUBLIC_COLLECTION_UID_RE.test(String(value ?? '').trim());
}
