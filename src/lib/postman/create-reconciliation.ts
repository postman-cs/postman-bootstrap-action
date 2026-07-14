/**
 * Exact-identity reconciliation helpers for unsafe create seams.
 *
 * After an ambiguous create response (accepted upstream, client saw 5xx/timeout),
 * callers discover live/state matches by exact identity and must adopt only a
 * single unambiguous match. Newest-only selection is intentionally unsupported.
 */

export class AmbiguousCreateMatchError extends Error {
  readonly code = 'AMBIGUOUS_CREATE_MATCH';
  readonly identityKey: string;
  readonly matchCount: number;

  constructor(identityKey: string, matchCount: number, detail?: string) {
    super(
      detail ??
        `Ambiguous create reconciliation for ${identityKey}: expected exactly one match, found ${matchCount}`
    );
    this.name = 'AmbiguousCreateMatchError';
    this.identityKey = identityKey;
    this.matchCount = matchCount;
  }
}

export function isAmbiguousTransportError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  if (typeof error !== 'object') {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? '');
  return /(?:^|\D)(?:408|429|502|503|504)(?:\D|$)|ESOCKETTIMEDOUT|ETIMEDOUT|ECONNRESET|timeout|temporar(?:y|ily)|upstream/i.test(
    message
  );
}

/**
 * Require exactly one match for an identity key. Zero matches return undefined
 * so the caller can rethrow the original create failure. Multiple matches fail.
 */
export function adoptExactMatch<T>(
  identityKey: string,
  matches: T[],
  formatMatch?: (match: T) => string
): T | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }
  const detail = formatMatch
    ? `Ambiguous create reconciliation for ${identityKey}: expected exactly one match, found ${matches.length} (${matches.map(formatMatch).join(', ')})`
    : undefined;
  throw new AmbiguousCreateMatchError(identityKey, matches.length, detail);
}

export function filterExactName<T extends { name: string }>(
  entries: T[],
  name: string
): T[] {
  return entries.filter((entry) => entry.name === name);
}
