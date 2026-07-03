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
  it('graphql builds a v3-ec collection runnable in CI', async () => {
    const result = await buildProtocolCollection('graphql', read('graphql/telecom.graphql'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/graphql'
    });
    expect(result.type).toBe('graphql');
    expect(result.format).toBe('v3-ec');
    expect(result.runnableInCi).toBe(true);
    expect(result.operationCount).toBeGreaterThan(0);
    // Native EC tree: typed root, children nesting (not the v2 `item`).
    expect(result.collection.type).toBe('collection');
    expect(Array.isArray(result.collection.children)).toBe(true);
    expect('item' in result.collection).toBe(false);
  });

  it('soap builds a v3-ec collection runnable in CI', async () => {
    const result = await buildProtocolCollection('soap', read('soap/stockquote.wsdl'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/soap'
    });
    expect(result.type).toBe('soap');
    expect(result.format).toBe('v3-ec');
    expect(result.runnableInCi).toBe(true);
    expect(result.operationCount).toBeGreaterThan(0);
    expect(result.collection.type).toBe('collection');
    expect(Array.isArray(result.collection.children)).toBe(true);
  });

  it.skipIf(!HAS_PROTOBUF)('grpc builds a v3-ec collection runnable in CI', async () => {
    const result = await buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
      name: 'T',
      endpointUrl: 'grpc://host:443',
      protobuf: PROTOBUF ?? undefined
    });
    expect(result.type).toBe('grpc');
    expect(result.format).toBe('v3-ec');
    expect(result.runnableInCi).toBe(true);
    expect(result.operationCount).toBeGreaterThan(0);
    // The v3 tree is service folders containing grpc-request leaves.
    const items = (result.collection.item as Array<Record<string, unknown>>) ?? [];
    expect(items.length).toBeGreaterThan(0);
  });

  it.skipIf(!HAS_PROTOBUF)('grpc collection carries the v3.0.0 $schema authoring descriptor', async () => {
    const result = await buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
      name: 'T',
      endpointUrl: 'grpc://host:443',
      protobuf: PROTOBUF ?? undefined
    });
    expect(result.collection.$schema).toBe(
      'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/'
    );
  });

  it.skipIf(!HAS_PROTOBUF)('grpc tree is service folders of grpc-request leaves carrying test events', async () => {
    const result = await buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
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

  it('asyncapi builds a v3-ec ws collection pruned from CI execution', async () => {
    const result = await buildProtocolCollection('asyncapi', read('asyncapi/ws.yaml'), {
      name: 'T'
    });
    expect(result.type).toBe('asyncapi');
    expect(result.format).toBe('v3-ec');
    expect(result.runnableInCi).toBe(false);
    expect(result.operationCount).toBeGreaterThan(0);
    const items = (result.collection.item as Array<Record<string, unknown>>) ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.type === 'ws-raw-request')).toBe(true);
  });

  it('mcp builds a v3-ec collection runnable when HTTP contract items exist', async () => {
    const result = await buildProtocolCollection('mcp', read('mcp/server.json'), {
      name: 'T'
    });
    expect(result.type).toBe('mcp');
    expect(result.format).toBe('v3-ec');
    expect(result.runnableInCi).toBe(true);
    expect(result.operationCount).toBe(44);
    const items = (result.collection.item as Array<Record<string, unknown>>) ?? [];
    expect(items.filter((item) => item.type === 'mcp-request')).toHaveLength(20);
    expect(items.filter((item) => item.type === 'http-request')).toHaveLength(24);
  });

  it('mcp stdio-only collections stay static and are not runnable in CI', async () => {
    const result = await buildProtocolCollection('mcp', JSON.stringify({
      mcpServers: { local: { command: 'run-mcp' } }
    }), {
      name: 'T'
    });
    expect(result.runnableInCi).toBe(false);
    expect(result.operationCount).toBe(5);
    expect(result.warnings.some((w) => w.startsWith('MCP_RUNTIME_SURFACE_UNAVAILABLE'))).toBe(true);
  });

  it.skipIf(!HAS_PROTOBUF)('all executable protocols emit v3-ec and are runnable in CI', async () => {
    const graphql = await buildProtocolCollection('graphql', read('graphql/telecom.graphql'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/graphql'
    });
    const soap = await buildProtocolCollection('soap', read('soap/stockquote.wsdl'), {
      name: 'T',
      endpointUrl: '{{baseUrl}}/soap'
    });
    const grpc = await buildProtocolCollection('grpc', read('grpc/routeguide.proto'), {
      name: 'T',
      endpointUrl: 'grpc://host:443',
      protobuf: PROTOBUF ?? undefined
    });
    expect(graphql.format).toBe('v3-ec');
    expect(graphql.runnableInCi).toBe(true);
    expect(soap.format).toBe('v3-ec');
    expect(soap.runnableInCi).toBe(true);
    expect(grpc.format).toBe('v3-ec');
    expect(grpc.runnableInCi).toBe(true);
  });

  it('rejects on an unsupported protocol spec type', async () => {
    await expect(
      buildProtocolCollection(
        'thrift' as unknown as Parameters<typeof buildProtocolCollection>[0],
        'irrelevant',
        { name: 'T' }
      )
    ).rejects.toThrow(/Unsupported protocol spec type/);
  });
});
