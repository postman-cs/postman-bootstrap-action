import { describe, expect, it } from 'vitest';

import { parseProtoSchema } from '../../../src/lib/protocols/grpc/proto-parser.js';
import { buildGrpcCollection } from '../../../src/lib/protocols/grpc/grpc-collection-builder.js';
import { instrumentGrpcCollection } from '../../../src/lib/protocols/grpc/grpc-instrumenter.js';
import { PROTOBUF, readFixture } from './helpers.js';

const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;

type JsonRecord = Record<string, unknown>;

function allScripts(collection: JsonRecord): string {
  return JSON.stringify(collection);
}

describe('gRPC wire-rule additions (grpc_runtime_transport / proto_semantics lanes)', () => {
  it('emits singleton, percent-grammar, whitespace, trailers-only, and null-policy checks', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://telecom.example.com:443', idSeed: 'golden', schemaLocation: 'fixtures/grpc/routeguide.proto' });
    const { collection: instrumented } = instrumentGrpcCollection(collection, index);
    const scripts = allScripts(instrumented);
    expect(scripts).toContain('standard fields are singletons');
    expect(scripts).toContain('percent-encoded');
    expect(scripts).toContain('leading or trailing whitespace');
    expect(scripts).toContain('grpc-status surfaced in metadata');
    expect(scripts).toContain('emit null only for google.protobuf.Value/NullValue');
  });
});
