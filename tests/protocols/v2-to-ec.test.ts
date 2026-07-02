import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildGraphQLCollection,
  instrumentGraphQLCollection,
  parseGraphQLSchema
} from '../../src/lib/protocols/graphql/index.js';
import {
  buildSoapCollection,
  instrumentSoapCollection,
  parseWsdl
} from '../../src/lib/protocols/soap/index.js';
import { convertV2CollectionToEc } from '../../src/lib/protocols/v2-to-ec.js';

function countLeafItems(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total: number, entry) => {
    const record = entry as Record<string, unknown> | null;
    if (record && Array.isArray(record.item)) return total + countLeafItems(record.item);
    return total + 1;
  }, 0);
}

/** Build the instrumented v2.1.0 graphql tree the dispatch transforms to EC. */
function graphqlV2(content: string) {
  const index = parseGraphQLSchema(content, { service: 'T' });
  const collection = buildGraphQLCollection(index, { name: 'T Contract', url: '{{baseUrl}}/graphql' });
  const { collection: instrumented } = instrumentGraphQLCollection(collection, index);
  return { collection: instrumented, operationCount: countLeafItems(instrumented.item) };
}

/** Build the instrumented v2.1.0 soap tree the dispatch transforms to EC. */
function soapV2(content: string) {
  const index = parseWsdl(content);
  const collection = buildSoapCollection(index, { collectionName: 'S' });
  const { collection: instrumented } = instrumentSoapCollection(collection, index);
  const operationCount = index.services.reduce((sum, s) => sum + s.operations.length, 0);
  return { collection: instrumented, operationCount };
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../fixtures');

function read(rel: string): string {
  return readFileSync(resolve(fixtures, rel), 'utf8');
}

type JsonRecord = Record<string, unknown>;

function leaves(node: JsonRecord): JsonRecord[] {
  const out: JsonRecord[] = [];
  const walk = (n: JsonRecord): void => {
    const children = Array.isArray(n.children) ? n.children : [];
    if (children.length === 0 && typeof n.type === 'string' && n.type !== 'collection' && n.type !== 'folder') {
      out.push(n);
      return;
    }
    for (const c of children) if (c && typeof c === 'object') walk(c as JsonRecord);
  };
  walk(node);
  return out;
}

describe('convertV2CollectionToEc (runtime.models transform)', () => {
  it('converts a graphql v2.1.0 collection into a canonical EC tree', () => {
    const built = graphqlV2(read('graphql/telecom.graphql'));

    const ec = convertV2CollectionToEc(built.collection);

    // Canonical EC collection shape: typed root, children nesting (not v2 `item`).
    expect(ec.type).toBe('collection');
    expect(Array.isArray((ec as JsonRecord).children)).toBe(true);
    expect('item' in ec).toBe(false);

    const reqs = leaves(ec);
    expect(reqs.length).toBe(built.operationCount);
    // Every leaf is an http-request with a payload and url.
    for (const r of reqs) {
      expect(r.type).toBe('http-request');
      const payload = r.payload as JsonRecord;
      expect(payload).toBeTruthy();
      expect(typeof payload.url === 'string' || typeof payload.url === 'object').toBe(true);
    }

    // Tests survive as extensions.events with a single-string exec (EC v3 schema),
    // and the v2 `test` listen phase is renamed to `afterResponse`.
    const withEvents = reqs.find((r) => {
      const ext = r.extensions as JsonRecord | undefined;
      return Array.isArray(ext?.events) && (ext.events as unknown[]).length > 0;
    });
    expect(withEvents, 'at least one leaf carries extensions.events').toBeTruthy();
    const event = ((withEvents!.extensions as JsonRecord).events as JsonRecord[])[0];
    expect(event.listen).toBe('afterResponse');
    expect(typeof (event.script as JsonRecord).exec).toBe('string');
  });

  it('converts a soap v2.1.0 collection into an EC tree of http-request leaves', () => {
    const built = soapV2(read('soap/stockquote.wsdl'));

    const ec = convertV2CollectionToEc(built.collection);
    expect(ec.type).toBe('collection');
    const reqs = leaves(ec);
    expect(reqs.length).toBe(built.operationCount);
    for (const r of reqs) expect(r.type).toBe('http-request');
  });
});
