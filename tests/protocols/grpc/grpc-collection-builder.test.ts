import { describe, expect, it } from 'vitest';
import { parseProtoSchema } from '../../../src/lib/protocols/grpc/proto-parser.js';
import { buildGrpcCollection } from '../../../src/lib/protocols/grpc/grpc-collection-builder.js';
import { HAS_PROTOBUF, PROTOBUF, readFixture } from './helpers.js';

const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;

type JsonRecord = Record<string, unknown>;

function flattenItems(collection: JsonRecord): JsonRecord[] {
  const out: JsonRecord[] = [];
  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node && typeof node === 'object') {
        const record = node as JsonRecord;
        if (record.type === 'grpc-request') out.push(record);
        walk(record.item);
      }
    }
  };
  walk(collection.item);
  return out;
}

describe.skipIf(!HAS_PROTOBUF)('buildGrpcCollection', () => {
  it('emits one grpc-request per operation grouped into service folders', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'test' });
    const items = flattenItems(collection);
    expect(items).toHaveLength(index.operations.length);
    const folders = collection.item as JsonRecord[];
    expect(folders.every((folder) => folder.type === 'folder')).toBe(true);
  });

  it('shapes the payload exactly per the grpc-request contract', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'test', schemaLocation: 'fixtures/grpc/routeguide.proto' });
    const item = flattenItems(collection).find((entry) => (entry.payload as JsonRecord).methodPath === 'telecom.network.v1.TowerService/GetTower')!;
    expect(item.type).toBe('grpc-request');
    const payload = item.payload as JsonRecord;
    expect(Object.keys(payload).sort()).toEqual(['message', 'metadata', 'methodDescriptor', 'methodPath', 'settings', 'url'].sort());
    expect(payload.url).toBe('grpcs://host:443');
    expect(payload.methodPath).toBe('telecom.network.v1.TowerService/GetTower');
    expect(payload.message).toEqual({ content: '{}' });
    expect(payload.metadata).toEqual([]);
    const settings = payload.settings as JsonRecord;
    expect(settings.maxResponseMessageSize).toBe(0); // MB; 0 = unlimited (runtime converts to -1)
    expect(settings.includeDefaultFields).toBe(false);
    expect(settings.strictSSL).toBe(true);
    expect(settings.connectionTimeout).toBe(30000);
    expect(settings.secureConnection).toBe(true); // derived from grpcs://
    expect((item.extensions as JsonRecord).schema).toEqual({ source: 'file', location: 'fixtures/grpc/routeguide.proto' });
  });

  it('derives secureConnection=false for grpc:// targets', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, { baseUrl: 'grpc://host:50051', idSeed: 'test' });
    const item = flattenItems(collection)[0];
    expect(((item.payload as JsonRecord).settings as JsonRecord).secureConnection).toBe(false);
  });

  it('warns GRPC_NO_TARGET when no baseUrl is provided', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { warnings } = buildGrpcCollection(index, { idSeed: 'test' });
    expect(warnings.some((warning) => warning.startsWith('GRPC_NO_TARGET'))).toBe(true);
  });

  it('produces byte-identical output across repeated builds (deterministic)', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const a = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'test' });
    const b = buildGrpcCollection(index, { baseUrl: 'grpcs://host:443', idSeed: 'test' });
    expect(JSON.stringify(a.collection)).toBe(JSON.stringify(b.collection));
  });

  it('honors settings overrides', () => {
    const index = parseProtoSchema(readFixture(), deps);
    const { collection } = buildGrpcCollection(index, {
      baseUrl: 'grpcs://host:443',
      idSeed: 'test',
      settings: { maxResponseMessageSize: 16, strictSSL: false, connectionTimeout: 5000, serverNameOverride: 'sni.host', proxy: 'http://proxy:8080' }
    });
    const settings = (flattenItems(collection)[0].payload as JsonRecord).settings as JsonRecord;
    expect(settings.maxResponseMessageSize).toBe(16);
    expect(settings.strictSSL).toBe(false);
    expect(settings.connectionTimeout).toBe(5000);
    expect(settings.serverNameOverride).toBe('sni.host');
    expect(settings.proxy).toBe('http://proxy:8080');
  });
});
