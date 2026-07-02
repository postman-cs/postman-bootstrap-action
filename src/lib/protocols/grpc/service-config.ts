import type { GrpcContractIndex } from './proto-parser.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

/**
 * Canonical gRPC status-code names (google.rpc.Code). Service configs name
 * retryable/non-fatal codes either by these strings or by integer 1-16
 * (grpc/service_config/service_config.proto; gRFC A6 client retries).
 */
const CANONICAL_STATUS_NAMES = new Set([
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED'
]);

/**
 * Load-balancing policy names registered by the core gRPC implementations.
 * Unknown names are surfaced as warnings only (clients skip unknown policies
 * rather than rejecting the config, so this is a SHOULD-level lint).
 */
const KNOWN_LB_POLICIES = new Set([
  'pick_first',
  'round_robin',
  'weighted_round_robin',
  'grpclb',
  'ring_hash_experimental',
  'ring_hash',
  'least_request_experimental',
  'outlier_detection_experimental',
  'priority_experimental',
  'weighted_target_experimental',
  'xds_cluster_manager_experimental',
  'cds_experimental',
  'xds_cluster_impl_experimental'
]);

/** ProtoJSON google.protobuf.Duration string: decimal seconds + "s". */
const DURATION_RE = /^\d+(\.\d{1,9})?s$/;

function isDuration(value: unknown): value is string {
  return typeof value === 'string' && DURATION_RE.test(value);
}

function isPositiveDuration(value: string): boolean {
  return parseFloat(value) > 0;
}

function isNonNegativeInteger(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0;
  if (typeof value === 'string') return /^\d+$/.test(value);
  return false;
}

function validStatusCode(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 16;
  if (typeof value === 'string') return CANONICAL_STATUS_NAMES.has(value.toUpperCase());
  return false;
}

function lintStatusCodeList(list: unknown, label: string, warnings: string[]): void {
  if (!Array.isArray(list) || list.length === 0) {
    warnings.push(`GRPC_SERVICE_CONFIG_STATUS_CODES_INVALID: ${label} must be a non-empty list of gRPC status codes (service_config.proto / gRFC A6)`);
    return;
  }
  for (const code of list) {
    if (!validStatusCode(code)) {
      warnings.push(`GRPC_SERVICE_CONFIG_STATUS_CODES_INVALID: ${label} entry ${JSON.stringify(code)} is not a canonical gRPC status code name or integer 1-16 (google.rpc.Code)`);
    }
  }
}

function lintRetryPolicy(policy: JsonRecord, where: string, warnings: string[]): void {
  const maxAttempts = policy.maxAttempts;
  if (!(typeof maxAttempts === 'number' && Number.isInteger(maxAttempts) && maxAttempts >= 2)) {
    warnings.push(`GRPC_SERVICE_CONFIG_RETRY_INVALID: ${where}.retryPolicy.maxAttempts must be an integer >= 2 (service_config.proto / gRFC A6); got ${JSON.stringify(maxAttempts)}`);
  }
  for (const key of ['initialBackoff', 'maxBackoff'] as const) {
    const backoff = policy[key];
    if (!isDuration(backoff) || !isPositiveDuration(backoff)) {
      warnings.push(`GRPC_SERVICE_CONFIG_RETRY_INVALID: ${where}.retryPolicy.${key} must be a positive ProtoJSON duration like "0.1s" (service_config.proto / gRFC A6); got ${JSON.stringify(backoff)}`);
    }
  }
  const multiplier = policy.backoffMultiplier;
  if (!(typeof multiplier === 'number' && multiplier > 0)) {
    warnings.push(`GRPC_SERVICE_CONFIG_RETRY_INVALID: ${where}.retryPolicy.backoffMultiplier must be a number > 0 (service_config.proto / gRFC A6); got ${JSON.stringify(multiplier)}`);
  }
  lintStatusCodeList(policy.retryableStatusCodes, `${where}.retryPolicy.retryableStatusCodes`, warnings);
}

function lintHedgingPolicy(policy: JsonRecord, where: string, warnings: string[]): void {
  const maxAttempts = policy.maxAttempts;
  if (!(typeof maxAttempts === 'number' && Number.isInteger(maxAttempts) && maxAttempts >= 2)) {
    warnings.push(`GRPC_SERVICE_CONFIG_HEDGING_INVALID: ${where}.hedgingPolicy.maxAttempts must be an integer >= 2 (service_config.proto / gRFC A6); got ${JSON.stringify(maxAttempts)}`);
  }
  if (policy.hedgingDelay !== undefined && !isDuration(policy.hedgingDelay)) {
    warnings.push(`GRPC_SERVICE_CONFIG_HEDGING_INVALID: ${where}.hedgingPolicy.hedgingDelay must be a ProtoJSON duration (service_config.proto); got ${JSON.stringify(policy.hedgingDelay)}`);
  }
  if (policy.nonFatalStatusCodes !== undefined) {
    lintStatusCodeList(policy.nonFatalStatusCodes, `${where}.hedgingPolicy.nonFatalStatusCodes`, warnings);
  }
}

function lintLoadBalancingConfig(config: JsonRecord, warnings: string[]): void {
  const entries = config.loadBalancingConfig;
  if (entries === undefined) return;
  if (!Array.isArray(entries)) {
    warnings.push('GRPC_SERVICE_CONFIG_LB_INVALID: loadBalancingConfig must be a list of single-policy objects (service_config.proto)');
    return;
  }
  for (const entry of entries) {
    const record = asRecord(entry);
    const keys = record ? Object.keys(record) : [];
    if (!record || keys.length !== 1) {
      warnings.push('GRPC_SERVICE_CONFIG_LB_INVALID: each loadBalancingConfig entry must be an object with exactly one policy key (service_config.proto)');
      continue;
    }
    if (!KNOWN_LB_POLICIES.has(keys[0]!)) {
      warnings.push(`GRPC_SERVICE_CONFIG_LB_POLICY_UNKNOWN: loadBalancingConfig policy "${keys[0]}" is not a registered gRPC LB policy; clients skip unknown policies (service_config.proto)`);
    }
  }
}

/**
 * Generation-time lints for a gRPC service config JSON document against the
 * parsed proto contract (grpc/service_config/service_config.proto; gRFC A6).
 * Advisory only: every finding is a GRPC_SERVICE_CONFIG_* warning so a broken
 * config never blocks collection generation, but a config the runtime would
 * reject (or silently never apply after a rename) is surfaced loudly.
 */
export function lintGrpcServiceConfig(raw: string, index: GrpcContractIndex): string[] {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return [`GRPC_SERVICE_CONFIG_PARSE_FAILED: service config is not valid JSON (${error instanceof Error ? error.message : String(error)})`];
  }
  const config = asRecord(parsed);
  if (!config) return ['GRPC_SERVICE_CONFIG_INVALID: service config must be a JSON object (service_config.proto)'];

  const declaredServices = new Set(index.operations.map((operation) => operation.serviceFullName));
  const declaredMethods = new Set(index.operations.map((operation) => `${operation.serviceFullName}/${operation.method}`));

  lintLoadBalancingConfig(config, warnings);

  const throttling = asRecord(config.retryThrottling);
  if (config.retryThrottling !== undefined) {
    const maxTokens = throttling?.maxTokens;
    const tokenRatio = throttling?.tokenRatio;
    if (!throttling || !(typeof maxTokens === 'number' && maxTokens > 0 && maxTokens <= 1000)) {
      warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_INVALID: retryThrottling.maxTokens must be a number in (0, 1000] (service_config.proto / gRFC A6); got ${JSON.stringify(throttling?.maxTokens)}`);
    }
    if (!throttling || !(typeof tokenRatio === 'number' && tokenRatio > 0)) {
      warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_INVALID: retryThrottling.tokenRatio must be a number > 0 (service_config.proto / gRFC A6); got ${JSON.stringify(throttling?.tokenRatio)}`);
    }
  }

  const methodConfigs = config.methodConfig;
  if (methodConfigs === undefined) return warnings;
  if (!Array.isArray(methodConfigs)) {
    warnings.push('GRPC_SERVICE_CONFIG_INVALID: methodConfig must be a list (service_config.proto)');
    return warnings;
  }

  const seenTargets = new Set<string>();
  methodConfigs.forEach((entry, i) => {
    const where = `methodConfig[${i}]`;
    const methodConfig = asRecord(entry);
    if (!methodConfig) {
      warnings.push(`GRPC_SERVICE_CONFIG_INVALID: ${where} must be an object (service_config.proto)`);
      return;
    }

    const names = methodConfig.name;
    if (!Array.isArray(names) || names.length === 0) {
      warnings.push(`GRPC_SERVICE_CONFIG_NAME_INVALID: ${where}.name must be a non-empty list of {service, method} selectors (service_config.proto)`);
    } else {
      names.forEach((nameEntry, j) => {
        const selector = asRecord(nameEntry);
        if (!selector) {
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_INVALID: ${where}.name[${j}] must be an object (service_config.proto)`);
          return;
        }
        const service = typeof selector.service === 'string' ? selector.service : '';
        const method = typeof selector.method === 'string' ? selector.method : '';
        if (method && !service) {
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_INVALID: ${where}.name[${j}] sets method "${method}" without a service; a method selector requires its service (service_config.proto)`);
          return;
        }
        const target = service ? (method ? `${service}/${method}` : service) : '{}';
        if (seenTargets.has(target)) {
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_DUPLICATE: selector ${target === '{}' ? 'the default {}' : `"${target}"`} appears in more than one methodConfig entry; each name may be targeted once (service_config.proto)`);
        }
        seenTargets.add(target);
        if (service && !declaredServices.has(service)) {
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_UNRESOLVED: ${where}.name[${j}] targets service "${service}" which is not declared in the proto contract; the config would silently never apply (service_config.proto)`);
        } else if (service && method && !declaredMethods.has(`${service}/${method}`)) {
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_UNRESOLVED: ${where}.name[${j}] targets "${service}/${method}" which is not declared in the proto contract; the config would silently never apply (service_config.proto)`);
        }
      });
    }

    if (methodConfig.timeout !== undefined && !isDuration(methodConfig.timeout)) {
      warnings.push(`GRPC_SERVICE_CONFIG_TIMEOUT_INVALID: ${where}.timeout must be a ProtoJSON duration like "10s" or "1.5s" (service_config.proto); got ${JSON.stringify(methodConfig.timeout)}`);
    }
    if (methodConfig.waitForReady !== undefined && typeof methodConfig.waitForReady !== 'boolean') {
      warnings.push(`GRPC_SERVICE_CONFIG_INVALID: ${where}.waitForReady must be a boolean (service_config.proto); got ${JSON.stringify(methodConfig.waitForReady)}`);
    }
    for (const key of ['maxRequestMessageBytes', 'maxResponseMessageBytes'] as const) {
      if (methodConfig[key] !== undefined && !isNonNegativeInteger(methodConfig[key])) {
        warnings.push(`GRPC_SERVICE_CONFIG_INVALID: ${where}.${key} must be a non-negative integer (service_config.proto); got ${JSON.stringify(methodConfig[key])}`);
      }
    }

    const retryPolicy = asRecord(methodConfig.retryPolicy);
    const hedgingPolicy = asRecord(methodConfig.hedgingPolicy);
    if (methodConfig.retryPolicy !== undefined && methodConfig.hedgingPolicy !== undefined) {
      warnings.push(`GRPC_SERVICE_CONFIG_RETRY_HEDGING_CONFLICT: ${where} sets both retryPolicy and hedgingPolicy; they are mutually exclusive (service_config.proto oneof retry_or_hedging_policy)`);
    }
    if (methodConfig.retryPolicy !== undefined && !retryPolicy) {
      warnings.push(`GRPC_SERVICE_CONFIG_RETRY_INVALID: ${where}.retryPolicy must be an object (service_config.proto)`);
    } else if (retryPolicy) {
      lintRetryPolicy(retryPolicy, where, warnings);
    }
    if (methodConfig.hedgingPolicy !== undefined && !hedgingPolicy) {
      warnings.push(`GRPC_SERVICE_CONFIG_HEDGING_INVALID: ${where}.hedgingPolicy must be an object (service_config.proto)`);
    } else if (hedgingPolicy) {
      lintHedgingPolicy(hedgingPolicy, where, warnings);
    }
  });

  return warnings;
}
