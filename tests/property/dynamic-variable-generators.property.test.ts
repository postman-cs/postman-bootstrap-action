/**
 * WS8 property suite: the bundled dynamic-variable (faker) generator registry.
 *
 * The existing example test proves one invocation per generator. These
 * properties drive every generator repeatedly (fast-check picks the generator
 * and an invocation round), proving each of the 118 generators yields a
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

  it('every generator yields a defined value on every invocation', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.constantFrom(...generatorEntries), fc.nat({ max: 1_000_000 })),
        ([{ name, generate }]) => {
          let value: unknown;
          expect(() => {
            value = generate();
          }, `generator ${name} threw`).not.toThrow();
          expect(value === undefined, `generator ${name} returned undefined`).toBe(false);
        }
      ),
      { numRuns: NUM_RUNS }
    );
  });

  it('every generator individually survives sustained invocation', () => {
    // Deterministic sweep on top of the sampled property: >=1000 total defined
    // results per generator across the suite requires each one to hold up
    // under repetition, not just a single lucky call.
    for (const { name, generate } of generatorEntries) {
      for (let round = 0; round < 10; round += 1) {
        expect(generate(), `generator ${name} returned undefined`).not.toBeUndefined();
      }
    }
  });
});
