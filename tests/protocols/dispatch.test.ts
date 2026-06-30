import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildProtocolCollection } from '../../src/lib/protocols/dispatch.js';
import { PROTOBUF, HAS_PROTOBUF } from './grpc/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../fixtures');

function read(rel: string): string {
  return readFileSync(resolve(fixtures, rel), 'utf8');
}

describe('protocol dispatch format discriminant', () => {
  it('graphql builds a v2.1.0 collection runnable in CI', () => {
    const result = buildProtocolCollection('graphql', read('graphql/telecom.graphql'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/graphql'
    });
    expect(result.type).toBe('graphql');
    expect(result.format).toBe('v2.1.0');
    expect(result.runnableInCi).toBe(true);
    expect(result.operationCount).toBeGreaterThan(0);
  });

  it('soap builds a v2.1.0 collection runnable in CI', () => {
    const result = buildProtocolCollection('soap', read('soap/stockquote.wsdl'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/soap'
    });
    expect(result.type).toBe('soap');
    expect(result.format).toBe('v2.1.0');
    expect(result.runnableInCi).toBe(true);
    expect(result.operationCount).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_PROTOBUF)('grpc builds a v3-ec collection gated from CI execution', () => {
    const result = buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
      name: 'T',
      endpointUrl: 'grpc://host:443',
      protobuf: PROTOBUF ?? undefined
    });
    expect(result.type).toBe('grpc');
    expect(result.format).toBe('v3-ec');
    expect(result.runnableInCi).toBe(false);
    expect(result.operationCount).toBeGreaterThan(0);
    // The v3 tree is service folders containing grpc-request leaves.
    const items = (result.collection.item as Array<Record<string, unknown>>) ?? [];
    expect(items.length).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_PROTOBUF)('grpc collection carries the v3.0.0 $schema authoring descriptor', () => {
    const result = buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
      name: 'T',
      endpointUrl: 'grpc://host:443',
      protobuf: PROTOBUF ?? undefined
    });
    expect(result.collection.$schema).toBe(
      'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/'
    );
  });

  it.skipIf(!HAS_PROTOBUF)('grpc tree is service folders of grpc-request leaves carrying test events', () => {
    const result = buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
      name: 'T',
      endpointUrl: 'grpc://host:443',
      protobuf: PROTOBUF ?? undefined
    });
    const folders = (result.collection.item as Array<Record<string, unknown>>) ?? [];
    expect(folders.length).toBeGreaterThan(0);
    let leaves = 0;
    for (const folder of folders) {
      expect(folder.type).toBe('folder');
      const children = (folder.item as Array<Record<string, unknown>>) ?? [];
      expect(children.length).toBeGreaterThan(0);
      for (const leaf of children) {
        expect(leaf.type).toBe('grpc-request');
        // The instrumenter writes the v2.1.0 test event the EC client later maps.
        const events = (leaf.event as Array<Record<string, unknown>>) ?? [];
        expect(events.some((e) => e.listen === 'test')).toBe(true);
        leaves += 1;
      }
    }
    expect(leaves).toBe(result.operationCount);
  });

  it('runnableInCi tracks the wire format: HTTP protocols true, gRPC false', () => {
    const graphql = buildProtocolCollection('graphql', read('graphql/telecom.graphql'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/graphql'
    });
    const soap = buildProtocolCollection('soap', read('soap/stockquote.wsdl'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/soap'
    });
    expect(graphql.format).toBe('v2.1.0');
    expect(graphql.runnableInCi).toBe(true);
    expect(soap.format).toBe('v2.1.0');
    expect(soap.runnableInCi).toBe(true);
  });

  it('throws on an unsupported protocol spec type', () => {
    expect(() =>
      buildProtocolCollection(
        'thrift' as unknown as Parameters<typeof buildProtocolCollection>[0],
        'irrelevant',
        { name: 'T' }
      )
    ).toThrow(/Unsupported protocol spec type/);
  });
});
