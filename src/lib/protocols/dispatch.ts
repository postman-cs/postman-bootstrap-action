import {
  buildGraphQLCollection,
  instrumentGraphQLCollection,
  parseGraphQLSchema
} from './graphql/index.js';
import {
  buildGrpcCollection,
  instrumentGrpcCollection,
  parseProtoSchema,
  type ProtoParseModule
} from './grpc/index.js';
import {
  buildSoapCollection,
  instrumentSoapCollection,
  parseWsdl
} from './soap/index.js';
import type { SpecType } from '../spec/detect-spec-type.js';

type JsonRecord = Record<string, unknown>;

export type ProtocolSpecType = Exclude<SpecType, 'openapi'>;

export interface ProtocolBuildOptions {
  /** Service/collection display name (defaults to the project name). */
  name?: string;
  /** Endpoint URL/authority used by generated requests (variable-friendly). */
  endpointUrl?: string;
  /** Source location of the spec, recorded on the collection where supported. */
  schemaLocation?: string;
  /** Test-only protobufjs override; production uses the bundled module. */
  protobuf?: ProtoParseModule;
}

export interface ProtocolCollectionResult {
  /** The protocol the spec was classified as. */
  type: ProtocolSpecType;
  /** Fully instrumented collection ready to POST to /collections. */
  collection: JsonRecord;
  /** Wire format of the produced collection. */
  format: 'v2.1.0' | 'v3-ec';
  /** Whether the collection runs in Postman CLI / Newman without a feature flag. */
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
 * GraphQL and SOAP produce v2.1.0 HTTP collections that run in the Postman CLI /
 * Newman HTTP path with no feature flag. gRPC produces a v3/EC collection whose
 * `grpc-request` execution is gated by the `grpc_protocol_execution_allowed`
 * account feature flag (upstream Postman CLI limitation).
 */
export function buildProtocolCollection(
  type: ProtocolSpecType,
  content: string,
  options: ProtocolBuildOptions = {}
): ProtocolCollectionResult {
  switch (type) {
    case 'graphql': {
      const index = parseGraphQLSchema(content, { service: options.name });
      const collection = buildGraphQLCollection(index, {
        name: options.name ? `${options.name} Contract` : undefined,
        url: options.endpointUrl
      });
      const { collection: instrumented, warnings } = instrumentGraphQLCollection(collection, index);
      return {
        type,
        collection: instrumented,
        format: 'v2.1.0',
        runnableInCi: true,
        warnings,
        operationCount: index.operations.length
      };
    }
    case 'soap': {
      const index = parseWsdl(content);
      const collection = buildSoapCollection(index, {
        collectionName: options.name,
        schemaLocation: options.schemaLocation
      });
      const { collection: instrumented, warnings } = instrumentSoapCollection(collection, index);
      const operationCount = index.services.reduce((sum, service) => sum + service.operations.length, 0);
      return {
        type,
        collection: instrumented,
        format: 'v2.1.0',
        runnableInCi: true,
        warnings,
        operationCount
      };
    }
    case 'grpc': {
      const index = parseProtoSchema(content, options.protobuf ? { protobuf: options.protobuf } : undefined);
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
        runnableInCi: false,
        warnings: [...built.warnings, ...warnings],
        operationCount: index.operations.length
      };
    }
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported protocol spec type: ${String(exhaustive)}`);
    }
  }
}
