/**
 * WS8 property suite: `normalizeCollectionModelIdentity`.
 *
 * The function is the sole identity-collapse seam between the two unambiguous
 * collection identifier shapes (bare UUID, numeric-owner-prefixed UID) and
 * every other alias, which must stay byte-exact. Example tests pin known
 * shapes; these properties pin the algebra for ALL strings:
 *
 *   1. idempotence     normalize(normalize(x)) === normalize(x)
 *   2. identity collapse  normalize(`${owner}-${uuid}`) === normalize(uuid)
 *      === uuid.toLowerCase() for every numeric owner and UUID casing
 *   3. non-UUID aliases pass through exactly (modulo trim), so a hyphenated
 *      server id can never be conflated with a model identity
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeCollectionModelIdentity } from '../../src/lib/postman/collection-model-identity.js';

const NUM_RUNS = 1000;

const hexChar = fc.constantFrom(...'0123456789abcdefABCDEF'.split(''));
const hexString = (length: number): fc.Arbitrary<string> =>
  fc.array(hexChar, { minLength: length, maxLength: length }).map((chars) => chars.join(''));

const uuidArb: fc.Arbitrary<string> = fc
  .tuple(hexString(8), hexString(4), hexString(4), hexString(4), hexString(12))
  .map((parts) => parts.join('-'));

const ownerArb: fc.Arbitrary<string> = fc
  .bigInt({ min: 0n, max: 99999999999999999999n })
  .map((value) => value.toString());

describe('normalizeCollectionModelIdentity properties (WS8)', () => {
  it('is idempotent for every string', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const once = normalizeCollectionModelIdentity(value);
        expect(normalizeCollectionModelIdentity(once)).toBe(once);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('is idempotent for every UUID-shaped and owner-prefixed input', () => {
    fc.assert(
      fc.property(uuidArb, ownerArb, (uuid, owner) => {
        for (const candidate of [uuid, `${owner}-${uuid}`]) {
          const once = normalizeCollectionModelIdentity(candidate);
          expect(normalizeCollectionModelIdentity(once)).toBe(once);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('collapses owner-prefixed UIDs and bare UUIDs to one lowercase identity', () => {
    fc.assert(
      fc.property(uuidArb, ownerArb, (uuid, owner) => {
        const bare = normalizeCollectionModelIdentity(uuid);
        const prefixed = normalizeCollectionModelIdentity(`${owner}-${uuid}`);
        expect(bare).toBe(uuid.toLowerCase());
        expect(prefixed).toBe(bare);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('passes through every non-identity alias exactly (after trim)', () => {
    const uuidLike =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    const prefixedLike =
      /^\d+-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    fc.assert(
      fc.property(fc.string(), (value) => {
        const trimmed = value.trim();
        fc.pre(!uuidLike.test(trimmed) && !prefixedLike.test(trimmed));
        expect(normalizeCollectionModelIdentity(value)).toBe(trimmed);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
