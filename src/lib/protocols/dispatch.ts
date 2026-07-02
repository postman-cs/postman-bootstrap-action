import {
  buildGraphQLCollection,
  instrumentGraphQLCollection,
  parseGraphQLSchema
} from './graphql/index.js';
import {
  buildGrpcCollection,
  instrumentGrpcCollection,
  lintGrpcServiceConfig,
  parseProtoSchema,
  type ProtoParseModule
} from './grpc/index.js';
import {
  buildSoapCollection,
  instrumentSoapCollection,
  parseWsdl
} from './soap/index.js';
import {
  buildAsyncApiCollection,
  instrumentAsyncApiCollection,
  parseAsyncApi
} from './asyncapi/index.js';
import {
  buildMcpCollection,
  instrumentMcpCollection,
  parseMcpServerSpec
} from './mcp/index.js';
import { convertV2CollectionToEc } from './v2-to-ec.js';
import type { SpecType } from '../spec/detect-spec-type.js';

type JsonRecord = Record<string, unknown>;

export type ProtocolSpecType = Exclude<SpecType, 'openapi'>;

function countLeafItems(items: unknown): number {
  if (!Array.isArray(items)) return 0;
  return items.reduce((total: number, entry) => {
    const record = entry as JsonRecord | null;
    if (record && Array.isArray(record.item)) return total + countLeafItems(record.item);
    return total + 1;
  }, 0);
}

export interface ProtocolBuildOptions {
  /** Service/collection display name (defaults to the project name). */
  name?: string;
  /** Endpoint URL/authority used by generated requests (variable-friendly). */
  endpointUrl?: string;
  /** Source location of the spec, recorded on the collection where supported. */
  schemaLocation?: string;
  /** Test-only protobufjs override; production uses the bundled module. */
  protobuf?: ProtoParseModule;
  /** gRPC service config JSON found alongside the proto, linted against it. */
  grpcServiceConfigJson?: string;
  /** Resolves relative wsdl:import/xsd:import locations to sibling documents. */
  wsdlImportResolver?: (location: string) => string | undefined;
}

export interface ProtocolCollectionResult {
  /** The protocol the spec was classified as. */
  type: ProtocolSpecType;
  /** Fully instrumented collection ready to POST to /collections. */
  collection: JsonRecord;
  /** Wire format of the produced collection. */
  format: 'v2.1.0' | 'v3-ec';
  /** Whether the collection runs in Postman CLI / Newman. */
  runnableInCi: boolean;
  /** All non-fatal warnings (no silent drops), deduped, first-seen order. */
  warnings: string[];
  /** Number of leaf request items generated. */
  operationCount: number;
}

/**
 * Parse a non-OpenAPI spec, build its Postman collection, and inject the
 * deterministic contract assertions. Returns a uniform result regardless of
 * protocol so the orchestrator can create + tag + persist the collection the
 * same way it does for the OAS contract collection.
 *
 * All protocols produce v3/Extensible Collections. GraphQL and SOAP build a
 * v2.1.0 HTTP tree and run it through the `@postman/runtime.models` transform
 * (`convertV2CollectionToEc`) so the emitted collection is native EC with
 * `http-request` leaves that run in the Postman CLI / Newman HTTP path. gRPC
 * builds EC natively and runs as `grpc-request`. AsyncAPI builds EC `ws-raw-request`
 * / `ws-socketio-request` / `mqtt-request` items natively, and MCP builds EC
 * `mcp-request` items; those item types are pruned by the Postman CLI runner
 * and carry no test-script slot, so their contract check is
 * generation-time/static and they are `runnableInCi:false`.
 *
 * Async because the AsyncAPI parser is async; the other branches resolve
 * synchronously.
 */
export async function buildProtocolCollection(
  type: ProtocolSpecType,
  content: string,
  options: ProtocolBuildOptions = {}
): Promise<ProtocolCollectionResult> {
  switch (type) {
    case 'asyncapi': {
      const index = await parseAsyncApi(content, { endpointUrl: options.endpointUrl });
      const collection = buildAsyncApiCollection(index, {
        name: options.name ? `${options.name} Contract` : undefined
      });
      const { collection: instrumented, warnings } = instrumentAsyncApiCollection(collection, index);
      const operationCount = index.channels.reduce((sum, channel) => sum + channel.messages.length, 0);
      return {
        type,
        collection: instrumented,
        format: 'v3-ec',
        runnableInCi: false,
        warnings,
        operationCount
      };
    }
    case 'mcp': {
      const index = parseMcpServerSpec(content);
      const collection = buildMcpCollection(index, {
        name: options.name ? `${options.name} Contract` : undefined
      });
      const { collection: instrumented, warnings } = instrumentMcpCollection(collection, index);
      const runtimeServerCount = index.servers.filter((server) => server.transport === 'sse' && !!server.url).length;
      const operationCount = Array.isArray(collection.item) ? collection.item.length : 0;
      return {
        type,
        collection: instrumented,
        format: 'v3-ec',
        runnableInCi: runtimeServerCount > 0,
        warnings,
        operationCount
      };
    }
    case 'graphql': {
      const index = parseGraphQLSchema(content, { service: options.name });
      const collection = buildGraphQLCollection(index, {
        name: options.name ? `${options.name} Contract` : undefined,
        url: options.endpointUrl
      });
      const { collection: instrumented, warnings } = instrumentGraphQLCollection(collection, index);
      return {
        type,
        collection: convertV2CollectionToEc(instrumented),
        format: 'v3-ec',
        runnableInCi: true,
        warnings,
        operationCount: countLeafItems(instrumented.item)
      };
    }
    case 'soap': {
      const index = parseWsdl(content, { resolveImport: options.wsdlImportResolver });
      const collection = buildSoapCollection(index, {
        collectionName: options.name,
        schemaLocation: options.schemaLocation
      });
      const { collection: instrumented, warnings } = instrumentSoapCollection(collection, index);
      const operationCount = index.services.reduce((sum, service) => sum + service.operations.length, 0);
      return {
        type,
        collection: convertV2CollectionToEc(instrumented),
        format: 'v3-ec',
        runnableInCi: true,
        warnings,
        operationCount
      };
    }
    case 'grpc': {
      const index = parseProtoSchema(content, options.protobuf ? { protobuf: options.protobuf } : undefined);
      const serviceConfigWarnings = options.grpcServiceConfigJson !== undefined
        ? lintGrpcServiceConfig(options.grpcServiceConfigJson, index)
        : [];
      const built = buildGrpcCollection(index, {
        name: options.name ? `${options.name} Contract` : undefined,
        baseUrl: options.endpointUrl,
        schemaLocation: options.schemaLocation
      });
      const { collection: instrumented, warnings } = instrumentGrpcCollection(built.collection, index);
      return {
        type,
        collection: instrumented,
        format: 'v3-ec',
        runnableInCi: true,
        warnings: [...serviceConfigWarnings, ...built.warnings, ...warnings],
        operationCount: index.operations.length
      };
    }
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported protocol spec type: ${String(exhaustive)}`);
    }
  }
}
