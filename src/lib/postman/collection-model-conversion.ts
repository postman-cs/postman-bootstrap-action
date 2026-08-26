import * as V2 from '@postman/runtime.models/v2';
import * as V3 from '@postman/runtime.models/v3';
import { FormatVersion, transform } from '@postman/runtime.models/transforms';

type JsonRecord = Record<string, unknown>;
type CollectionModel = { parse: (value: unknown) => unknown };

const V2_COLLECTION = (V2 as unknown as { Collection: CollectionModel }).Collection;
const V3_COLLECTION = (V3 as unknown as { Collection: CollectionModel }).Collection;

export function assertV2CollectionModel(value: unknown): void {
  V2_COLLECTION.parse(value ?? {});
}

export function convertV2CollectionToV3Model(value: unknown): JsonRecord {
  const parsed = V2_COLLECTION.parse(value ?? {});
  return transform(
    V2_COLLECTION as never,
    FormatVersion.V3,
    parsed as never
  ) as unknown as JsonRecord;
}

export function convertV3CollectionToV2Model(value: unknown): JsonRecord {
  const parsed = V3_COLLECTION.parse(value ?? {});
  return transform(
    V3_COLLECTION as never,
    FormatVersion.V2,
    parsed as never
  ) as unknown as JsonRecord;
}

export function canonicalizeV2CollectionForSync(value: unknown): JsonRecord {
  const wireClone = JSON.parse(JSON.stringify(value ?? {})) as JsonRecord;
  return JSON.parse(
    JSON.stringify(convertV3CollectionToV2Model(convertV2CollectionToV3Model(wireClone)))
  ) as JsonRecord;
}

export function convertV2CollectionToExtensibleModel(value: unknown): JsonRecord {
  return transform(
    V2_COLLECTION as never,
    FormatVersion.Extensible,
    value as never
  ) as unknown as JsonRecord;
}
