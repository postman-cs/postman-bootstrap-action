import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ProtoParseModule } from '../../../src/lib/protocols/grpc/proto-parser.js';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_PATH = resolve(here, '../../../fixtures/grpc/routeguide.proto');

export function readFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

// Resolve protobufjs as a real module. The parser's own auto-loader also finds
// it, but tests resolve it explicitly so they can `describe.skipIf` cleanly
// when the dependency is not installed (the action's package.json declares it;
// CI installs it before running). Returns null when unavailable.
export function tryLoadProtobuf(): ProtoParseModule | null {
  const req = createRequire(import.meta.url);
  for (const candidate of ['@postman/protobufjs', 'protobufjs']) {
    try {
      const mod = req(candidate) as ProtoParseModule;
      if (mod && typeof mod.parse === 'function') return mod;
    } catch {
      /* try next */
    }
  }
  return null;
}

export const PROTOBUF = tryLoadProtobuf();
export const HAS_PROTOBUF = PROTOBUF !== null;
