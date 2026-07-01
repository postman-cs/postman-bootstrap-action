/**
 * Frontier T12 exploration check. Two questions:
 *   (1) Can a NATIVE gRPC EC leaf (the shape grpc-collection-builder emits, with
 *       events folded to extensions.events the way postman-ec-client posts it) be
 *       validated by @postman/runtime.models/extensible GRPCRequest before create
 *       (the goal's "validate before create, instead of raw JsonRecord")?
 *   (2) Does routing gRPC through the v2->EC transform (convertV2CollectionToEc)
 *       PRESERVE the grpc-request type, or collapse it to http-request?
 *
 * Offline; no protobuf. The leaf shape mirrors grpc-collection-builder.buildItem
 * + grpc-instrumenter (a `test` event) + postman-ec-client.mergeEventExtensions
 * (event -> extensions.events, exec joined to a string, listen renamed).
 * Prints VALID/grpc-request/events= markers the frontier check greps for.
 */
import { GRPCRequest } from '@postman/runtime.models/extensible';

import { convertV2CollectionToEc } from '../src/lib/protocols/v2-to-ec.js';

type JsonRecord = Record<string, unknown>;

function firstLeaf(node: JsonRecord): JsonRecord | null {
  const kids = (node.item ?? node.children) as unknown[] | undefined;
  if (!Array.isArray(kids)) return null;
  for (const raw of kids) {
    const n = raw as JsonRecord;
    const grandkids = (n.item ?? n.children) as unknown[] | undefined;
    if (Array.isArray(grandkids) && grandkids.length > 0) {
      const deep = firstLeaf(n);
      if (deep) return deep;
    } else if (typeof n.type === 'string' && n.type.endsWith('-request')) {
      return n;
    }
  }
  return null;
}

// EC create-shape grpc-request leaf: buildItem payload + extensions.schema, with
// the instrumenter's test event already folded into extensions.events (EC phase
// name, exec collapsed to a string) exactly as postman-ec-client.createItem posts.
const grpcLeaf: JsonRecord = {
  type: 'grpc-request',
  title: 'GetFeature',
  payload: {
    url: 'grpc://host:443',
    methodPath: 'route.RouteGuide/GetFeature',
    methodDescriptor: '',
    message: { content: '{}' },
    metadata: [],
    settings: {}
  },
  extensions: {
    schema: { source: 'file' },
    events: [{ listen: 'afterResponse', script: { type: 'text/javascript', exec: 'pm.test("ok", () => {});' } }]
  }
};

console.log(`native leaf type=${grpcLeaf.type}`);
const events = (grpcLeaf.extensions as JsonRecord).events;
console.log(`events=${Array.isArray(events) ? events.length : 0}`);

const res = GRPCRequest.validate(grpcLeaf);
const issues = (res as { issues?: unknown }).issues;
const ok = !issues;
console.log(`native grpc-request VALID=${ok}`);
if (!ok) console.log('issues=' + JSON.stringify(issues).slice(0, 800));

// (2) v2-route: gRPC has no v2 form; the closest v2 leaf is an http request, so
// transform CANNOT yield grpc-request — proving why gRPC stays native.
const v2Stub: JsonRecord = {
  info: {
    name: 'Route',
    description: { content: '' },
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
  },
  item: [
    {
      name: 'GetFeature',
      request: {
        method: 'POST',
        description: { content: '' },
        url: { raw: '{{baseUrl}}/route.RouteGuide/GetFeature' }
      }
    }
  ]
};
const viaV2 = convertV2CollectionToEc(v2Stub);
const v2Leaf = firstLeaf(viaV2);
console.log(`v2-route leaf type=${v2Leaf?.type} (grpc-request preserved=${v2Leaf?.type === 'grpc-request'})`);
