/**
 * WS8 property suite: the bundled dynamic-variable (faker) generator registry.
 *
 * The existing example test proves one invocation per generator. These
 * properties drive every generator repeatedly, proving each of the 118
 * generators yields a
 * DEFINED value on every call, never throws, and that the registry itself
 * stays at exactly 118 generator-bearing entries.
 */

import { createRequire } from 'node:module';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

const dynamicVariables = require('postman-collection/lib/superstring/dynamic-variables') as Record<
  string,
  { generator?: () => unknown }
>;

const EXPECTED_GENERATOR_COUNT = 118;
const NUM_RUNS = 1000;

const generatorEntries = Object.entries(dynamicVariables).flatMap(([name, definition]) =>
  typeof definition.generator === 'function'
    ? [{ name, generate: definition.generator }]
    : []
);

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  warnSpy.mockRestore();
});

describe('dynamic-variable generator properties (WS8)', () => {
  it(`keeps the registry at exactly ${EXPECTED_GENERATOR_COUNT} generators`, () => {
    expect(generatorEntries).toHaveLength(EXPECTED_GENERATOR_COUNT);
  });

  it('every generator yields a defined value on every invocation', { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.nat({ max: NUM_RUNS - 1 }), round => {
        for (const { name, generate } of generatorEntries) {
          let value: unknown;
          expect(() => {
            value = generate();
          }, `generator ${name} threw on round ${round}`).not.toThrow();
          expect(value, `generator ${name} returned undefined on round ${round}`).not.toBeUndefined();
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
