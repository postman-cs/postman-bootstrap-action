// Build a v3/EC (Extensible Collection) JSON object with one `grpc-request`
// item per gRPC operation.
//
// Grounding for the node + payload shape:
//   - executable item type `grpc-request`: postman-cli lib/run/unified/run.ts:17-19
//     (SUPPORTED_ITEM_TYPES) and summary.ts:45-54 (ITEM_TYPE_TO_PROTOCOL).
//   - node envelope { type, id, title, createdAt, payload, extensions }:
//     proto/resolver.ts:75-108 (buildReflectionRequest).
//   - payload keys (url, methodPath, methodDescriptor, message.content,
//     metadata[], settings{...}) and the settings normalization (maxResponse
//     MessageSize MB, includeDefaultFields default false, strictSSL default
//     true): proto/normalizer.ts:12-46 and the recon payloadShape.
//
// Output ordering is fully deterministic (operations already sorted by the
// parser) so repeated builds and golden snapshots are stable.

import type { GrpcContractIndex, GrpcOperation } from './proto-parser.js';

type JsonRecord = Record<string, unknown>;

export interface GrpcCollectionOptions {
  // Collection display name.
  name?: string;
  // gRPC target authority, e.g. `grpc://localhost:50051` or `grpcs://host:443`.
  // When omitted, requests carry an empty url for the operator to fill in and a
  // GRPC_NO_TARGET warning is surfaced by the builder result.
  baseUrl?: string;
  // Deterministic id seed; when set, item ids are derived from it instead of a
  // random uuid, keeping snapshots stable. The orchestrator may omit this for
  // production (real uuids) and tests set it for golden output.
  idSeed?: string;
  // Fixed timestamp for createdAt; defaults to a stable sentinel so output is
  // deterministic. The orchestrator can pass new Date().toISOString().
  createdAt?: string;
  // gRPC settings overrides; merged over the defaults below.
  settings?: GrpcRequestSettings;
  // Optional raw methodDescriptor (JSON-stringified FileDescriptorProto) keyed
  // by methodPath. When absent, methodDescriptor is left empty and the schema
  // source is `file` (the .proto travels with the collection out-of-band).
  methodDescriptors?: Record<string, string>;
  // The proto source location recorded in extensions.schema (source: 'file').
  schemaLocation?: string;
}

export interface GrpcRequestSettings {
  maxResponseMessageSize?: number;
  includeDefaultFields?: boolean;
  strictSSL?: boolean;
  secureConnection?: boolean;
  serverNameOverride?: string;
  connectionTimeout?: number;
  proxy?: string;
}

export interface GrpcBuildResult {
  collection: JsonRecord;
  warnings: string[];
}

const DEFAULT_CREATED_AT = '1970-01-01T00:00:00.000Z';
const DEFAULT_CONNECTION_TIMEOUT_MS = 30_000;

// Mirrors proto/normalizer.ts defaults. We emit the author-facing values
// (maxResponseMessageSize in MB, 0 = unlimited); the runtime normalizer
// converts MB->bytes and 0->-1 at execution time, so we do NOT pre-convert.
function defaultSettings(): Required<Pick<GrpcRequestSettings, 'maxResponseMessageSize' | 'includeDefaultFields' | 'strictSSL' | 'connectionTimeout'>> {
  return {
    maxResponseMessageSize: 0,
    includeDefaultFields: false,
    strictSSL: true,
    connectionTimeout: DEFAULT_CONNECTION_TIMEOUT_MS
  };
}

function secureFromUrl(url: string): boolean {
  return /^grpcs:\/\//i.test(url.trim());
}

function buildSettings(url: string, overrides?: GrpcRequestSettings): JsonRecord {
  const base = defaultSettings();
  const settings: JsonRecord = {
    maxResponseMessageSize: overrides?.maxResponseMessageSize ?? base.maxResponseMessageSize,
    includeDefaultFields: overrides?.includeDefaultFields ?? base.includeDefaultFields,
    strictSSL: overrides?.strictSSL ?? base.strictSSL,
    connectionTimeout: overrides?.connectionTimeout ?? base.connectionTimeout
  };
  const secure = overrides?.secureConnection ?? (url ? secureFromUrl(url) : undefined);
  if (secure !== undefined) settings.secureConnection = secure;
  if (overrides?.serverNameOverride) settings.serverNameOverride = overrides.serverNameOverride;
  if (overrides?.proxy) settings.proxy = overrides.proxy;
  return settings;
}

// Deterministic, dependency-free id: a short stable hash of the seed + key so
// two operations never collide and re-builds are reproducible.
function stableId(seed: string, key: string): string {
  let h1 = 0x811c9dc5;
  const input = `${seed}:${key}`;
  for (let i = 0; i < input.length; i += 1) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0');
  // uuid-shaped but derived, so it reads as an id without pretending to be a
  // collision-resistant v4.
  return `${hex}-0000-4000-8000-${key.length.toString(16).padStart(12, '0')}`;
}

function buildItem(operation: GrpcOperation, options: GrpcCollectionOptions): JsonRecord {
  const url = options.baseUrl?.trim() ?? '';
  const createdAt = options.createdAt ?? DEFAULT_CREATED_AT;
  const seed = options.idSeed ?? 'grpc';
  const methodDescriptor = options.methodDescriptors?.[operation.methodPath] ?? '';

  return {
    type: 'grpc-request',
    id: stableId(seed, operation.id),
    title: operation.id,
    name: operation.id,
    createdAt,
    payload: {
      url,
      methodPath: operation.methodPath,
      methodDescriptor,
      message: { content: '{}' },
      metadata: [],
      settings: buildSettings(url, options.settings)
    },
    extensions: {
      schema: {
        source: 'file',
        ...(options.schemaLocation ? { location: options.schemaLocation } : {})
      }
    }
  };
}

// Group operations into one folder per service so the collection tree mirrors
// the proto service layout. Folder + item ordering is deterministic.
function buildServiceFolders(index: GrpcContractIndex, options: GrpcCollectionOptions): JsonRecord[] {
  const byService = new Map<string, GrpcOperation[]>();
  for (const operation of index.operations) {
    const list = byService.get(operation.serviceFullName) ?? [];
    list.push(operation);
    byService.set(operation.serviceFullName, list);
  }
  const seed = options.idSeed ?? 'grpc';
  return [...byService.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([serviceFullName, operations]) => ({
      type: 'folder',
      id: stableId(seed, `folder:${serviceFullName}`),
      name: serviceFullName,
      title: serviceFullName,
      item: operations.map((operation) => buildItem(operation, options))
    }));
}

export function buildGrpcCollection(index: GrpcContractIndex, options: GrpcCollectionOptions = {}): GrpcBuildResult {
  const warnings = [...index.warnings, ...index.operations.flatMap((operation) => operation.warnings)];
  if (!options.baseUrl || !options.baseUrl.trim()) {
    warnings.push('GRPC_NO_TARGET: no gRPC target url was provided; generated grpc-request items carry an empty url and must be pointed at a host:port before they can execute');
  }

  const name = options.name ?? (index.package ? `${index.package} gRPC contract` : 'gRPC contract');
  const collection: JsonRecord = {
    // v3 authoring descriptor $schema; the EC transform consumes this shape.
    $schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/',
    info: {
      name,
      schema: 'https://schema.postman.com/json/draft-2020-12/collection/v3.0.0/'
    },
    item: buildServiceFolders(index, options)
  };

  return { collection, warnings };
}
