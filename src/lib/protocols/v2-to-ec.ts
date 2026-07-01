import * as V2 from '@postman/runtime.models/v2';
import { transform, FormatVersion } from '@postman/runtime.models/transforms';

type JsonRecord = Record<string, unknown>;

/**
 * Convert a Postman v2.1.0 collection into the Extensible Collection (EC v3)
 * shape using the `@postman/runtime.models` transform — the same in-app
 * transform (no bespoke field mapping). The output
 * is the canonical Extensible collection:
 *   { type:'collection', title, payload, children:[...], extensions }
 * with leaves typed (`http-request`, ...), `script.exec` already collapsed to a
 * single string, and v2 `event` listen phases already renamed
 * (`test`→`afterResponse`, `prerequest`→`beforeRequest`) under
 * `extensions.events`. Children nest under `children` (not the v2 `item`).
 *
 * gRPC is intentionally NOT routed through here: a `grpc-request` has no v2.1.0
 * representation, so its builder emits EC nodes natively.
 */
export function convertV2CollectionToEc(v2Collection: JsonRecord): JsonRecord {
  // `V2.Collection` is the runtime Model<T> descriptor the transform dispatches on.
  return transform(
    (V2 as unknown as { Collection: unknown }).Collection as never,
    FormatVersion.Extensible,
    v2Collection as never
  ) as unknown as JsonRecord;
}
