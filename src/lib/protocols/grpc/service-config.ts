import type { GrpcContractIndex } from './proto-parser.js';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Canonical gRPC status-code names (google.rpc.Code) in integer order 1-16.
 * Service configs name retryable/non-fatal codes either by these strings or by
 * integer 1-16 (grpc/service_config/service_config.proto; gRFC A6 client retries).
 */
const CANONICAL_STATUS_CODES: readonly string[] = [
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
];

const CANONICAL_STATUS_NAMES = new Set(CANONICAL_STATUS_CODES);

/**
 * Statuses a server APPLICATION (not the transport) typically generates.
 * Retrying or hedging them re-runs application logic that already executed
 * once, so gRFC A6 treats them as unsafe defaults for retryableStatusCodes /
 * nonFatalStatusCodes; their presence is disclosed as an advisory.
 */
const APPLICATION_GENERATED_STATUS = new Set([
  'ALREADY_EXISTS',
  'DATA_LOSS',
  'FAILED_PRECONDITION',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'OUT_OF_RANGE',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'UNIMPLEMENTED'
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

/**
 * Full ProtoJSON google.protobuf.Duration string: optional sign, integer
 * seconds bounded by +/-315576000000 (10000 years), up to 9 fractional
 * digits, "s" suffix (protobuf JSON mapping).
 */
const DURATION_RE = /^(-?)(\d+)(?:\.(\d{1,9}))?s$/;
const DURATION_MAX_SECONDS = 315576000000;

function parseDurationSeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = DURATION_RE.exec(value);
  if (!match) return null;
  const seconds = Number(match[2]);
  if (seconds > DURATION_MAX_SECONDS) return null;
  const magnitude = seconds + (match[3] ? Number(`0.${match[3]}`) : 0);
  return match[1] === '-' ? -magnitude : magnitude;
}

function isDuration(value: unknown): value is string {
  return parseDurationSeconds(value) !== null;
}

function isPositiveDuration(value: string): boolean {
  return (parseDurationSeconds(value) ?? 0) > 0;
}

const UINT32_MAX = 4294967295;

/** service_config.proto message-size limits are google.protobuf.UInt32Value. */
function isUint32(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
  if (typeof value === 'string') return /^\d+$/.test(value) && Number(value) <= UINT32_MAX;
  return false;
}

function validStatusCode(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 16;
  if (typeof value === 'string') return CANONICAL_STATUS_NAMES.has(value.toUpperCase());
  return false;
}

function statusCodeName(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16) return CANONICAL_STATUS_CODES[value - 1];
  if (typeof value === 'string' && CANONICAL_STATUS_NAMES.has(value.toUpperCase())) return value.toUpperCase();
  return null;
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

/**
 * Retry-safety disclosure (gRFC A6): statuses the application itself generates
 * mean the RPC reached and ran application code, so a retry or hedged attempt
 * repeats its side effects.
 */
function lintStatusCodeSafety(list: unknown, label: string, warnings: string[]): void {
  if (!Array.isArray(list)) return;
  const risky = [...new Set(
    list.map(statusCodeName).filter((name): name is string => name !== null && APPLICATION_GENERATED_STATUS.has(name))
  )].sort();
  if (risky.length > 0) {
    warnings.push(`GRPC_SERVICE_CONFIG_RETRY_CODE_ADVISORY: ${label} includes ${risky.join(', ')}; these statuses are typically application-generated, so retrying or hedging them can repeat application side effects (gRFC A6)`);
  }
}

const KNOWN_RETRY_POLICY_FIELDS = new Set(['maxAttempts', 'initialBackoff', 'maxBackoff', 'backoffMultiplier', 'retryableStatusCodes']);
const KNOWN_HEDGING_POLICY_FIELDS = new Set(['maxAttempts', 'hedgingDelay', 'nonFatalStatusCodes']);

function lintRetryPolicy(policy: JsonRecord, where: string, warnings: string[]): void {
  const maxAttempts = policy.maxAttempts;
  if (!(typeof maxAttempts === 'number' && Number.isInteger(maxAttempts) && maxAttempts >= 2)) {
    warnings.push(`GRPC_SERVICE_CONFIG_RETRY_INVALID: ${where}.retryPolicy.maxAttempts must be an integer >= 2 (service_config.proto / gRFC A6); got ${JSON.stringify(maxAttempts)}`);
  } else if (maxAttempts > 5) {
    warnings.push(`GRPC_SERVICE_CONFIG_RETRY_ATTEMPTS_CLAMPED: ${where}.retryPolicy.maxAttempts ${maxAttempts} exceeds 5; gRPC clients clamp retry attempts to 5 (gRFC A6)`);
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
  lintStatusCodeSafety(policy.retryableStatusCodes, `${where}.retryPolicy.retryableStatusCodes`, warnings);
  for (const key of Object.keys(policy)) {
    if (!KNOWN_RETRY_POLICY_FIELDS.has(key)) {
      warnings.push(`GRPC_SERVICE_CONFIG_FIELD_UNKNOWN: ${where}.retryPolicy.${key} is not a retryPolicy field (service_config.proto); clients ignore unknown fields`);
    }
  }
}

function lintHedgingPolicy(policy: JsonRecord, where: string, warnings: string[]): void {
  const maxAttempts = policy.maxAttempts;
  if (!(typeof maxAttempts === 'number' && Number.isInteger(maxAttempts) && maxAttempts >= 2)) {
    warnings.push(`GRPC_SERVICE_CONFIG_HEDGING_INVALID: ${where}.hedgingPolicy.maxAttempts must be an integer >= 2 (service_config.proto / gRFC A6); got ${JSON.stringify(maxAttempts)}`);
  } else if (maxAttempts > 5) {
    warnings.push(`GRPC_SERVICE_CONFIG_HEDGING_ATTEMPTS_CLAMPED: ${where}.hedgingPolicy.maxAttempts ${maxAttempts} exceeds 5; gRPC clients clamp hedged attempts to 5 (gRFC A6)`);
  }
  if (policy.hedgingDelay !== undefined && !isDuration(policy.hedgingDelay)) {
    warnings.push(`GRPC_SERVICE_CONFIG_HEDGING_INVALID: ${where}.hedgingPolicy.hedgingDelay must be a ProtoJSON duration (service_config.proto); got ${JSON.stringify(policy.hedgingDelay)}`);
  }
  if (policy.nonFatalStatusCodes !== undefined) {
    lintStatusCodeList(policy.nonFatalStatusCodes, `${where}.hedgingPolicy.nonFatalStatusCodes`, warnings);
    lintStatusCodeSafety(policy.nonFatalStatusCodes, `${where}.hedgingPolicy.nonFatalStatusCodes`, warnings);
  }
  for (const key of Object.keys(policy)) {
    if (!KNOWN_HEDGING_POLICY_FIELDS.has(key)) {
      warnings.push(`GRPC_SERVICE_CONFIG_FIELD_UNKNOWN: ${where}.hedgingPolicy.${key} is not a hedgingPolicy field (service_config.proto); clients ignore unknown fields`);
    }
  }
}

/** Bounded recursion for composite policies that embed childPolicy lists. */
const LB_MAX_DEPTH = 4;

function lintLoadBalancingEntries(entries: unknown, label: string, warnings: string[], depth: number): void {
  if (!Array.isArray(entries)) {
    warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${label} must be a list of single-policy objects (service_config.proto)`);
    return;
  }
  for (const entry of entries) {
    const record = asRecord(entry);
    const keys = record ? Object.keys(record) : [];
    if (!record || keys.length !== 1) {
      warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: each ${label} entry must be an object with exactly one policy key (service_config.proto)`);
      continue;
    }
    const policy = keys[0]!;
    if (!KNOWN_LB_POLICIES.has(policy)) {
      warnings.push(`GRPC_SERVICE_CONFIG_LB_POLICY_UNKNOWN: ${label} policy "${policy}" is not a registered gRPC LB policy; clients skip unknown policies (service_config.proto)`);
      continue;
    }
    const config = asRecord(record[policy]);
    if (!config) {
      warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${label} policy "${policy}" config must be a JSON object (service_config.proto)`);
      continue;
    }
    lintLbPolicyConfig(policy, config, `${label}.${policy}`, warnings, depth);
  }
}

function lintLbPolicyConfig(policy: string, config: JsonRecord, path: string, warnings: string[], depth: number): void {
  const flagUnknown = (known: readonly string[]): void => {
    for (const key of Object.keys(config)) {
      if (!known.includes(key)) {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.${key} is not a known ${policy} field; clients ignore unknown fields (service_config.proto)`);
      }
    }
  };
  const recurseChild = (value: unknown, key: string): void => {
    if (value === undefined) return;
    if (depth >= LB_MAX_DEPTH) {
      warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.${key} exceeds the supported childPolicy nesting depth (${LB_MAX_DEPTH})`);
      return;
    }
    lintLoadBalancingEntries(value, `${path}.${key}`, warnings, depth + 1);
  };
  switch (policy) {
    case 'pick_first': {
      flagUnknown(['shuffleAddressList']);
      if (config.shuffleAddressList !== undefined && typeof config.shuffleAddressList !== 'boolean') {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.shuffleAddressList must be a boolean (gRFC A62)`);
      }
      break;
    }
    case 'round_robin': {
      flagUnknown([]);
      break;
    }
    case 'grpclb': {
      flagUnknown(['childPolicy', 'serviceName']);
      if (config.serviceName !== undefined && typeof config.serviceName !== 'string') {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.serviceName must be a string (service_config.proto GrpcLbConfig)`);
      }
      recurseChild(config.childPolicy, 'childPolicy');
      break;
    }
    case 'ring_hash':
    case 'ring_hash_experimental': {
      flagUnknown(['minRingSize', 'maxRingSize', 'requestHashHeader']);
      const ringMax = 8388608;
      for (const key of ['minRingSize', 'maxRingSize'] as const) {
        const value = config[key];
        if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= ringMax)) {
          warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.${key} must be an integer in [1, ${ringMax}] (gRFC A42)`);
        }
      }
      if (typeof config.minRingSize === 'number' && typeof config.maxRingSize === 'number' && config.minRingSize > config.maxRingSize) {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.minRingSize ${config.minRingSize} exceeds maxRingSize ${config.maxRingSize} (gRFC A42)`);
      }
      if (config.requestHashHeader !== undefined && typeof config.requestHashHeader !== 'string') {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.requestHashHeader must be a string (gRFC A76)`);
      }
      break;
    }
    case 'least_request_experimental': {
      flagUnknown(['choiceCount']);
      const count = config.choiceCount;
      if (count !== undefined) {
        if (!(typeof count === 'number' && Number.isInteger(count))) {
          warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.choiceCount must be an integer (gRFC A48)`);
        } else if (count < 2 || count > 10) {
          warnings.push(`GRPC_SERVICE_CONFIG_LB_CLAMPED: ${path}.choiceCount ${count} is outside [2, 10]; clients clamp it to that range (gRFC A48)`);
        }
      }
      break;
    }
    case 'weighted_round_robin': {
      flagUnknown(['enableOobLoadReport', 'oobReportingPeriod', 'blackoutPeriod', 'weightExpirationPeriod', 'weightUpdatePeriod', 'errorUtilizationPenalty']);
      if (config.enableOobLoadReport !== undefined && typeof config.enableOobLoadReport !== 'boolean') {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.enableOobLoadReport must be a boolean (gRFC A58)`);
      }
      for (const key of ['oobReportingPeriod', 'blackoutPeriod', 'weightExpirationPeriod', 'weightUpdatePeriod'] as const) {
        if (config[key] !== undefined && !isDuration(config[key])) {
          warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.${key} must be a ProtoJSON duration (gRFC A58)`);
        }
      }
      if (config.errorUtilizationPenalty !== undefined && !(typeof config.errorUtilizationPenalty === 'number' && config.errorUtilizationPenalty >= 0)) {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.errorUtilizationPenalty must be a number >= 0 (gRFC A58)`);
      }
      break;
    }
    case 'outlier_detection_experimental': {
      for (const key of ['interval', 'baseEjectionTime', 'maxEjectionTime'] as const) {
        if (config[key] !== undefined && !isDuration(config[key])) {
          warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.${key} must be a ProtoJSON duration (gRFC A50)`);
        }
      }
      if (config.maxEjectionPercent !== undefined && !(typeof config.maxEjectionPercent === 'number' && Number.isInteger(config.maxEjectionPercent) && config.maxEjectionPercent >= 0 && config.maxEjectionPercent <= 100)) {
        warnings.push(`GRPC_SERVICE_CONFIG_LB_INVALID: ${path}.maxEjectionPercent must be an integer in [0, 100] (gRFC A50)`);
      }
      recurseChild(config.childPolicy, 'childPolicy');
      break;
    }
    default: {
      // Remaining registered policies are xds-managed composites; validate the
      // recursive childPolicy shape and leave xds-supplied fields to the runtime.
      recurseChild(config.childPolicy, 'childPolicy');
      break;
    }
  }
}

/** AIP-193 standard error-detail payloads (google/rpc/error_details.proto). */
const GOOGLE_RPC_ERROR_DETAIL_TYPES = new Set([
  'google.rpc.BadRequest',
  'google.rpc.DebugInfo',
  'google.rpc.ErrorInfo',
  'google.rpc.Help',
  'google.rpc.LocalizedMessage',
  'google.rpc.PreconditionFailure',
  'google.rpc.QuotaFailure',
  'google.rpc.RequestInfo',
  'google.rpc.ResourceInfo',
  'google.rpc.RetryInfo'
]);

/** Fully-qualified proto identifier: the type.googleapis.com/<name> Any suffix. */
const PROTO_FQN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Cross-reference a google.api.Service document (apis[]/types[]/enums[]) against
 * the parsed proto contract. types[] is the declared manifest of messages
 * reachable through google.protobuf.Any (their type_url suffixes), and the
 * google.rpc.* subset is the declared error-detail payload set (AIP-193).
 */
function lintGoogleApiServiceConfig(config: JsonRecord, index: GrpcContractIndex, warnings: string[]): void {
  warnings.push('GRPC_SERVICE_CONFIG_KIND_MISMATCH: input declares apis[], the shape of a google.api.Service document, not a gRPC service config (service_config.proto); cross-referencing its declared surface against the proto contract instead');
  const declaredServices = new Set(index.operations.map((operation) => operation.serviceFullName));
  const seenApis = new Set<string>();
  asArray(config.apis).forEach((entry, i) => {
    const record = asRecord(entry);
    const name = record && typeof record.name === 'string' ? record.name : null;
    if (!name) {
      warnings.push(`GRPC_GOOGLE_API_CONFIG_INVALID: apis[${i}] must be an object with a string name (google.api.Service)`);
      return;
    }
    if (seenApis.has(name)) {
      warnings.push(`GRPC_GOOGLE_API_CONFIG_DUPLICATE: apis[] lists "${name}" more than once (google.api.Service)`);
    }
    seenApis.add(name);
    if (!declaredServices.has(name)) {
      warnings.push(`GRPC_GOOGLE_API_CONFIG_API_UNRESOLVED: apis[] entry "${name}" does not resolve to a service in the parsed proto set (google.api.Service apis[])`);
    }
  });
  const lintTypeList = (listKey: 'types' | 'enums', resolves: (name: string) => boolean, kind: string): void => {
    const seen = new Set<string>();
    asArray(config[listKey]).forEach((entry, i) => {
      const record = asRecord(entry);
      const name = record && typeof record.name === 'string' ? record.name : null;
      if (!name) {
        warnings.push(`GRPC_GOOGLE_API_CONFIG_INVALID: ${listKey}[${i}] must be an object with a string name (google.api.Service)`);
        return;
      }
      if (seen.has(name)) {
        warnings.push(`GRPC_GOOGLE_API_CONFIG_DUPLICATE: ${listKey}[] lists "${name}" more than once; declared Any payload and error-detail types must be unique (google.api.Service / AIP-193)`);
      }
      seen.add(name);
      if (!PROTO_FQN_RE.test(name)) {
        warnings.push(`GRPC_GOOGLE_API_CONFIG_TYPE_URL_INVALID: ${listKey}[] entry "${name}" is not a fully-qualified proto ${kind} name; a google.protobuf.Any type_url suffix (type.googleapis.com/<name>) cannot resolve it (protobuf Any / google.api.Service)`);
        return;
      }
      if (name.startsWith('google.rpc.')) {
        if (name !== 'google.rpc.Status' && !GOOGLE_RPC_ERROR_DETAIL_TYPES.has(name)) {
          warnings.push(`GRPC_GOOGLE_API_CONFIG_ERROR_DETAIL_UNKNOWN: ${listKey}[] entry "${name}" is not a standard google.rpc error-detail payload (google/rpc/error_details.proto / AIP-193)`);
        }
        return;
      }
      if (name.startsWith('google.protobuf.')) return;
      if (!resolves(name)) {
        warnings.push(`GRPC_GOOGLE_API_CONFIG_TYPE_UNRESOLVED: ${listKey}[] entry "${name}" does not resolve to a ${kind} in the parsed proto set, so google.protobuf.Any payloads with type_url suffix "${name}" cannot be shape-checked (google.api.Service ${listKey}[])`);
      }
    });
  };
  lintTypeList('types', (name) => index.messages[name] !== undefined, 'message');
  lintTypeList('enums', (name) => index.enums[name] !== undefined, 'enum');
  const declaredDetails = asArray(config.types)
    .map((entry) => asRecord(entry)?.name)
    .filter((name): name is string => typeof name === 'string' && GOOGLE_RPC_ERROR_DETAIL_TYPES.has(name));
  if (declaredDetails.length > 0 && !declaredDetails.includes('google.rpc.ErrorInfo')) {
    warnings.push('GRPC_GOOGLE_API_CONFIG_ERRORINFO_MISSING: types[] declares google.rpc error-detail payloads but omits google.rpc.ErrorInfo; AIP-193 requires ErrorInfo in service errors');
  }
}

const KNOWN_TOP_LEVEL_FIELDS = new Set(['loadBalancingPolicy', 'loadBalancingConfig', 'methodConfig', 'retryThrottling', 'healthCheckConfig']);
const KNOWN_METHOD_CONFIG_FIELDS = new Set(['name', 'timeout', 'waitForReady', 'maxRequestMessageBytes', 'maxResponseMessageBytes', 'retryPolicy', 'hedgingPolicy']);

function lintServiceConfigObject(config: JsonRecord, index: GrpcContractIndex, warnings: string[]): void {
  const declaredServices = new Set(index.operations.map((operation) => operation.serviceFullName));
  const declaredMethods = new Set(index.operations.map((operation) => `${operation.serviceFullName}/${operation.method}`));

  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      warnings.push(`GRPC_SERVICE_CONFIG_FIELD_UNKNOWN: "${key}" is not a service config field (service_config.proto); clients ignore unknown fields`);
    }
  }

  if (config.loadBalancingPolicy !== undefined) {
    warnings.push('GRPC_SERVICE_CONFIG_LB_POLICY_DEPRECATED: loadBalancingPolicy is deprecated; use loadBalancingConfig (service_config.proto)');
    if (!(typeof config.loadBalancingPolicy === 'string' && ['pick_first', 'round_robin'].includes(config.loadBalancingPolicy.toLowerCase()))) {
      warnings.push(`GRPC_SERVICE_CONFIG_LB_POLICY_UNKNOWN: loadBalancingPolicy ${JSON.stringify(config.loadBalancingPolicy)} is not a policy the deprecated field accepts (pick_first or round_robin, case-insensitive)`);
    }
  }
  if (config.loadBalancingConfig !== undefined) {
    lintLoadBalancingEntries(config.loadBalancingConfig, 'loadBalancingConfig', warnings, 0);
  }
  if (config.loadBalancingPolicy !== undefined || config.loadBalancingConfig !== undefined) {
    warnings.push('GRPC_SERVICE_CONFIG_LB_RUNTIME_UNSUPPORTED: the generated Postman grpc-request items expose no load-balancing settings, so LB policy selection is not applied when the collection runs in Postman');
  }

  if (config.healthCheckConfig !== undefined) {
    const health = asRecord(config.healthCheckConfig);
    if (!health) {
      warnings.push('GRPC_SERVICE_CONFIG_INVALID: healthCheckConfig must be an object (service_config.proto)');
    } else {
      for (const key of Object.keys(health)) {
        if (key !== 'serviceName') {
          warnings.push(`GRPC_SERVICE_CONFIG_FIELD_UNKNOWN: healthCheckConfig.${key} is not a healthCheckConfig field (service_config.proto); clients ignore unknown fields`);
        }
      }
      if (health.serviceName !== undefined && typeof health.serviceName !== 'string') {
        warnings.push(`GRPC_SERVICE_CONFIG_INVALID: healthCheckConfig.serviceName must be a string (service_config.proto); got ${JSON.stringify(health.serviceName)}`);
      }
    }
  }

  const throttling = asRecord(config.retryThrottling);
  if (config.retryThrottling !== undefined) {
    const maxTokens = throttling?.maxTokens;
    const tokenRatio = throttling?.tokenRatio;
    if (!throttling || !(typeof maxTokens === 'number' && maxTokens > 0 && maxTokens <= 1000)) {
      warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_INVALID: retryThrottling.maxTokens must be a number in (0, 1000] (service_config.proto / gRFC A6); got ${JSON.stringify(throttling?.maxTokens)}`);
    } else if (!Number.isInteger(maxTokens)) {
      warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_INVALID: retryThrottling.maxTokens must be an integer (service_config.proto / gRFC A6); got ${JSON.stringify(maxTokens)}`);
    }
    if (!throttling || !(typeof tokenRatio === 'number' && tokenRatio > 0)) {
      warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_INVALID: retryThrottling.tokenRatio must be a number > 0 (service_config.proto / gRFC A6); got ${JSON.stringify(throttling?.tokenRatio)}`);
    } else {
      const decimals = String(tokenRatio).split('.')[1];
      if (decimals !== undefined && decimals.length > 3) {
        warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_PRECISION: retryThrottling.tokenRatio ${tokenRatio} carries more than 3 decimal places; clients truncate tokenRatio to 3 decimal places (gRFC A6)`);
      }
    }
    if (throttling) {
      for (const key of Object.keys(throttling)) {
        if (key !== 'maxTokens' && key !== 'tokenRatio') {
          warnings.push(`GRPC_SERVICE_CONFIG_FIELD_UNKNOWN: retryThrottling.${key} is not a retryThrottling field (service_config.proto); clients ignore unknown fields`);
        }
      }
    }
  }

  const methodConfigs = config.methodConfig;
  if (methodConfigs === undefined) return;
  if (!Array.isArray(methodConfigs)) {
    warnings.push('GRPC_SERVICE_CONFIG_INVALID: methodConfig must be a list (service_config.proto)');
    return;
  }

  // Per-entry selector metadata for effective (most-specific-match) analysis:
  // exact method selector > service selector > default {} (gRFC A2 / A6).
  interface EntryMeta { targets: Set<string>; unresolved: boolean; retry: boolean; hedge: boolean; selectorCount: number }
  const entryMeta: EntryMeta[] = [];

  const seenTargets = new Set<string>();
  methodConfigs.forEach((entry, i) => {
    const where = `methodConfig[${i}]`;
    const meta: EntryMeta = { targets: new Set(), unresolved: false, retry: false, hedge: false, selectorCount: 0 };
    entryMeta.push(meta);
    const methodConfig = asRecord(entry);
    if (!methodConfig) {
      warnings.push(`GRPC_SERVICE_CONFIG_INVALID: ${where} must be an object (service_config.proto)`);
      return;
    }

    for (const key of Object.keys(methodConfig)) {
      if (KNOWN_METHOD_CONFIG_FIELDS.has(key)) continue;
      if (key === 'retryThrottling') {
        warnings.push(`GRPC_SERVICE_CONFIG_THROTTLING_MISPLACED: ${where}.retryThrottling is misplaced; retryThrottling is a top-level service config field, not a per-method field (service_config.proto / gRFC A6)`);
        continue;
      }
      warnings.push(`GRPC_SERVICE_CONFIG_FIELD_UNKNOWN: ${where}.${key} is not a methodConfig field (service_config.proto); clients ignore unknown fields`);
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
        meta.selectorCount += 1;
        meta.targets.add(target);
        if (service && !declaredServices.has(service)) {
          meta.unresolved = true;
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_UNRESOLVED: ${where}.name[${j}] targets service "${service}" which is not declared in the proto contract; the config would silently never apply (service_config.proto)`);
        } else if (service && method && !declaredMethods.has(`${service}/${method}`)) {
          meta.unresolved = true;
          warnings.push(`GRPC_SERVICE_CONFIG_NAME_UNRESOLVED: ${where}.name[${j}] targets "${service}/${method}" which is not declared in the proto contract; the config would silently never apply (service_config.proto)`);
        }
      });
    }

    if (methodConfig.timeout !== undefined) {
      const seconds = parseDurationSeconds(methodConfig.timeout);
      if (seconds === null || seconds < 0) {
        warnings.push(`GRPC_SERVICE_CONFIG_TIMEOUT_INVALID: ${where}.timeout must be a ProtoJSON duration like "10s" or "1.5s" (service_config.proto); got ${JSON.stringify(methodConfig.timeout)}`);
      } else if (seconds === 0) {
        warnings.push(`GRPC_SERVICE_CONFIG_TIMEOUT_ZERO: ${where}.timeout is a zero duration, a deadline that is already expired; every matched RPC would fail DEADLINE_EXCEEDED (service_config.proto)`);
      }
    }
    if (methodConfig.waitForReady !== undefined && methodConfig.waitForReady !== null && typeof methodConfig.waitForReady !== 'boolean') {
      warnings.push(`GRPC_SERVICE_CONFIG_INVALID: ${where}.waitForReady must be a boolean or ProtoJSON null (google.protobuf.BoolValue); got ${JSON.stringify(methodConfig.waitForReady)}`);
    }
    for (const key of ['maxRequestMessageBytes', 'maxResponseMessageBytes'] as const) {
      if (methodConfig[key] !== undefined && !isUint32(methodConfig[key])) {
        warnings.push(`GRPC_SERVICE_CONFIG_INVALID: ${where}.${key} must be a non-negative integer within uint32 range [0, ${UINT32_MAX}] (service_config.proto google.protobuf.UInt32Value); got ${JSON.stringify(methodConfig[key])}`);
      }
    }

    const retryPolicy = asRecord(methodConfig.retryPolicy);
    const hedgingPolicy = asRecord(methodConfig.hedgingPolicy);
    meta.retry = methodConfig.retryPolicy !== undefined;
    meta.hedge = methodConfig.hedgingPolicy !== undefined;
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

  // Effective most-specific MethodConfig per declared RPC, plus the streaming
  // joins that only the winning entry can trigger.
  const winners = new Set<number>();
  for (const operation of index.operations) {
    const exact = `${operation.serviceFullName}/${operation.method}`;
    let winner = -1;
    for (const target of [exact, operation.serviceFullName, '{}']) {
      winner = entryMeta.findIndex((meta) => meta.targets.has(target));
      if (winner !== -1) break;
    }
    if (winner === -1) continue;
    winners.add(winner);
    const meta = entryMeta[winner];
    if (meta.retry && operation.stream !== 'unary') {
      warnings.push(`GRPC_SERVICE_CONFIG_STREAMING_RETRY_DISCLOSURE: methodConfig[${winner}].retryPolicy is the effective config for ${operation.id}, a ${operation.stream}-streaming RPC; retries only replay when no response has been committed, and client/bidi streams require replayable request messages (gRFC A6)`);
    }
    if (meta.hedge && (operation.stream === 'client' || operation.stream === 'bidi')) {
      warnings.push(`GRPC_SERVICE_CONFIG_STREAMING_HEDGE_DISCLOSURE: methodConfig[${winner}].hedgingPolicy is the effective config for ${operation.id}, a ${operation.stream}-streaming RPC; hedged attempts run concurrently and cannot replay client-streamed messages (gRFC A6)`);
    }
  }
  entryMeta.forEach((meta, i) => {
    if (meta.selectorCount === 0 || meta.unresolved || winners.has(i)) return;
    warnings.push(`GRPC_SERVICE_CONFIG_ENTRY_INEFFECTIVE: methodConfig[${i}] never provides the effective config for any declared RPC; every RPC it targets is matched by a more specific methodConfig entry (service_config.proto most-specific-match)`);
  });
}

export interface GrpcServiceConfigLintOptions {
  /**
   * Fail-closed policy: throw (instead of returning findings) when the config
   * has any finding, for callers that must gate generation on a clean config.
   * Default is the advisory warnings-only behavior.
   */
  failClosed?: boolean;
}

/**
 * Generation-time lints for a gRPC service config JSON document against the
 * parsed proto contract (grpc/service_config/service_config.proto; gRFC A6).
 * Also accepts the two DNS-resolved wrappers from gRFC A2: a raw TXT
 * `grpc_config=<JSON>` attribute value and the choice-list array form.
 * Advisory by default: every finding is a GRPC_SERVICE_CONFIG_* warning so a
 * broken config never blocks collection generation, but a config the runtime
 * would reject (or silently never apply after a rename) is surfaced loudly.
 * Pass `{ failClosed: true }` to throw on any finding instead.
 */
export function lintGrpcServiceConfig(raw: string, index: GrpcContractIndex, options?: GrpcServiceConfigLintOptions): string[] {
  const warnings: string[] = [];
  const finish = (): string[] => {
    if (options?.failClosed === true && warnings.length > 0) {
      throw new Error(`GRPC_SERVICE_CONFIG_LINT_FAILED: fail-closed policy rejected the service config with ${warnings.length} finding(s):\n${warnings.join('\n')}`);
    }
    return warnings;
  };

  // gRFC A2: a DNS TXT record carries the config as a grpc_config=<JSON>
  // attribute; unwrap it and lint the embedded choice list.
  let text = raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith('grpc_config=')) {
    warnings.push('GRPC_SERVICE_CONFIG_DNS_TXT_DETECTED: input is a DNS TXT grpc_config attribute (gRFC A2); linting the embedded choice list');
    if (/[^\x20-\x7e\s]/.test(trimmed)) {
      warnings.push('GRPC_SERVICE_CONFIG_DNS_TXT_ENCODING_INVALID: DNS TXT grpc_config value contains characters outside printable ASCII; TXT character-strings are ASCII-encoded (gRFC A2 / RFC 1035)');
    }
    text = trimmed.slice('grpc_config='.length);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warnings.push(`GRPC_SERVICE_CONFIG_PARSE_FAILED: service config is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return finish();
  }

  // gRFC A2 choice list: an array of {clientLanguage?, percentage?,
  // clientHostname?, serviceConfig} objects selecting one embedded config.
  if (Array.isArray(parsed)) {
    parsed.forEach((entry, i) => {
      const where = `grpc_config[${i}]`;
      const choice = asRecord(entry);
      if (!choice) {
        warnings.push(`GRPC_SERVICE_CONFIG_CHOICE_INVALID: ${where} must be an object (gRFC A2 choice list)`);
        return;
      }
      for (const key of Object.keys(choice)) {
        if (!['clientLanguage', 'percentage', 'clientHostname', 'serviceConfig'].includes(key)) {
          warnings.push(`GRPC_SERVICE_CONFIG_CHOICE_INVALID: ${where}.${key} is not a choice field (gRFC A2)`);
        }
      }
      for (const key of ['clientLanguage', 'clientHostname'] as const) {
        const value = choice[key];
        if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string'))) {
          warnings.push(`GRPC_SERVICE_CONFIG_CHOICE_INVALID: ${where}.${key} must be a list of strings (gRFC A2)`);
        }
      }
      if (choice.percentage !== undefined && !(typeof choice.percentage === 'number' && choice.percentage >= 0 && choice.percentage <= 100)) {
        warnings.push(`GRPC_SERVICE_CONFIG_CHOICE_INVALID: ${where}.percentage must be a number in [0, 100] (gRFC A2)`);
      }
      const embedded = asRecord(choice.serviceConfig);
      if (!embedded) {
        warnings.push(`GRPC_SERVICE_CONFIG_CHOICE_INVALID: ${where}.serviceConfig must be a JSON object (gRFC A2)`);
        return;
      }
      lintServiceConfigObject(embedded, index, warnings);
    });
    return finish();
  }

  const config = asRecord(parsed);
  if (!config) {
    warnings.push('GRPC_SERVICE_CONFIG_INVALID: service config must be a JSON object (service_config.proto)');
    return finish();
  }

  // A google.api.Service document in the service-config slot is a different
  // artifact; cross-reference its declared surface instead of rejecting it.
  if (Array.isArray(config.apis)) {
    lintGoogleApiServiceConfig(config, index, warnings);
    return finish();
  }

  lintServiceConfigObject(config, index, warnings);
  return finish();
}
