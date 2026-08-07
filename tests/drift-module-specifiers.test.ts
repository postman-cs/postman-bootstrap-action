import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPTS_DIRECTORY = resolve(import.meta.dirname, '..', 'scripts');

function relativeStaticSpecifiers(
  script: string
): Array<{ script: string; specifier: string; typeOnly: boolean }> {
  const source = readFileSync(resolve(SCRIPTS_DIRECTORY, script), 'utf8');
  return Array.from(source.matchAll(/^[ \t]*import[\s\S]*?;$/gm)).flatMap((statement) => {
    const match = statement[0].match(
      /^[ \t]*import[ \t]+(type[ \t]+)?[\s\S]*?['"](\.{1,2}\/[^'"]+)['"]/
    );
    return match ? [{ script, specifier: match[2], typeOnly: Boolean(match[1]) }] : [];
  });
}

describe('drift script module specifiers', () => {
  it('uses existing .ts specifiers for direct runtime script imports', () => {
    const driftCheck = relativeStaticSpecifiers('drift-check.ts');
    const recordLive = relativeStaticSpecifiers('record-live.ts');

    const runtimeSpecifiers = [
      ...driftCheck.filter(({ specifier, typeOnly }) => !typeOnly && specifier.startsWith('./')),
      ...recordLive.filter(({ specifier, typeOnly }) => !typeOnly && specifier.startsWith('./'))
    ];

    expect(runtimeSpecifiers.map(({ specifier }) => specifier)).toEqual(expect.arrayContaining([
      './cassette-shape.ts',
      './record-live.ts',
      './sanitize-cassette.ts',
      './fresh-onboard-parity.ts',
      './recording-capture.ts'
    ]));
    for (const { specifier } of runtimeSpecifiers) {
      expect(existsSync(resolve(SCRIPTS_DIRECTORY, specifier))).toBe(true);
    }

    expect(recordLive).toContainEqual({
      script: 'record-live.ts',
      specifier: '../src/index.js',
      typeOnly: true
    });

    for (const { specifier, typeOnly } of [...driftCheck, ...recordLive]) {
      if (!typeOnly && specifier.endsWith('.js')) {
        expect(existsSync(resolve(SCRIPTS_DIRECTORY, specifier))).toBe(true);
      }
    }
  });
});
