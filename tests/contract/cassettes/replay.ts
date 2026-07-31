/**
 * Shared cassette file plumbing for the scenario suite: where a scenario's
 * committed fixture lives, and the byte-stable serialization the recorder emits
 * so a re-record with no behavior change produces no diff.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Cassette } from '@postman-cse/automation-core/cassette';

const CASSETTE_DIR = resolve(import.meta.dirname);

export function cassettePath(name: string): string {
  return resolve(CASSETTE_DIR, `${name}.json`);
}

/**
 * The recorder stamps `recordedAt` from the run clock. Fake timers pin that to a
 * constant, so no field here is wall-clock dependent.
 */
export function stableCassetteText(cassette: Cassette): string {
  return `${JSON.stringify(cassette, null, 2)}\n`;
}

export function readCassette(name: string): Cassette {
  return JSON.parse(readFileSync(cassettePath(name), 'utf8')) as Cassette;
}

/**
 * Interactions allowed to declare `repeatLast`, and nothing else.
 *
 * Replay is fail-closed on an exhausted queue unless the fixture opts that entry
 * in. The org-detection squads probe is the one read whose CALL COUNT is not
 * reproducible: it is issued concurrently with other preflight work and is
 * in-flight-deduped, so whether a second caller hits the memo or issues its own
 * request depends on interleaving, and replay resolves faster than the fake.
 * The response is a constant org/squad listing with no cursor and no state, so
 * repeating it cannot mask a missing interaction.
 *
 * Deliberately NOT here: every mutation, every paginated list, and every route
 * whose response advances state. Those must stay one-shot so a duplicated or
 * dropped call fails the suite.
 */
const REPEATABLE_READ_PREFIXES = ['proxy:ums GET /api/teams/'] as const;

export function isRepeatableRead(key: string): boolean {
  return REPEATABLE_READ_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Opt the allowlisted constant reads into repeat-last, in place. */
export function applyRepeatableReads(cassette: Cassette): Cassette {
  for (const interaction of cassette.interactions) {
    if (isRepeatableRead(interaction.key)) interaction.repeatLast = true;
  }
  return cassette;
}
