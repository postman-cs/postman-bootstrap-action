import { describe, expect, it } from 'vitest';
import { parseProtoSchema } from '../../../src/lib/protocols/grpc/proto-parser.js';
import { lintGrpcServiceConfig } from '../../../src/lib/protocols/grpc/service-config.js';
import { HAS_PROTOBUF, PROTOBUF } from './helpers.js';

const deps = PROTOBUF ? { protobuf: PROTOBUF } : undefined;
const PROTO = ['syntax = "proto3";', 'package t;', 'message M { string a = 1; }', 'service S { rpc G(M) returns (M); rpc H(M) returns (stream M); }'].join('\n');

describe.skipIf(!HAS_PROTOBUF)('lintGrpcServiceConfig', () => {
  const lint = (config: unknown) => lintGrpcServiceConfig(typeof config === 'string' ? config : JSON.stringify(config), parseProtoSchema(PROTO, deps));

  it('reports invalid JSON and non-object choice entries', () => {
    expect(lint('{nope').join('\n')).toContain('GRPC_SERVICE_CONFIG_PARSE_FAILED');
    expect(lint('[1,2]').join('\n')).toContain('GRPC_SERVICE_CONFIG_CHOICE_INVALID');
  });

  it('validates methodConfig field shapes against service_config.proto', () => {
    const warnings = lint({ bogus: 1, methodConfig: [{ name: [{ service: 'nope.Svc' }], timeout: '5', waitForReady: 'yes', maxRequestMessageBytes: -3 }] }).join('\n');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_FIELD_UNKNOWN');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_NAME_UNRESOLVED');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_TIMEOUT_INVALID');
    expect(warnings).toContain('waitForReady must be a boolean');
    expect(warnings).toContain('maxRequestMessageBytes must be a non-negative integer');
  });

  it('flags zero timeouts and entries shadowed by more specific configs', () => {
    const warnings = lint({ methodConfig: [{ name: [{ service: 't.S', method: 'G' }], timeout: '0s' }, { name: [{ service: 't.S' }], timeout: '2s' }, { name: [{}], timeout: '3s' }] }).join('\n');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_TIMEOUT_ZERO');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_ENTRY_INEFFECTIVE');
  });

  it('validates retry, hedging, and throttling per gRFC A6', () => {
    const warnings = lint({ methodConfig: [{ name: [{ service: 't.S', method: 'G' }], retryPolicy: { maxAttempts: 10, initialBackoff: '0s', backoffMultiplier: 0, retryableStatusCodes: ['UNKNOWN_CODE', 14] } }, { name: [{ service: 't.S', method: 'H' }], hedgingPolicy: { maxAttempts: 9, hedgingDelay: '-1s' } }], retryThrottling: { maxTokens: 0.5, tokenRatio: 0.1234567 } }).join('\n');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_RETRY_ATTEMPTS_CLAMPED');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_RETRY_INVALID');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_STATUS_CODES_INVALID');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_HEDGING_ATTEMPTS_CLAMPED');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_THROTTLING_INVALID');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_THROTTLING_PRECISION');
  });

  it('validates load-balancing policy configs and discloses runtime inapplicability', () => {
    const warnings = lint({ loadBalancingPolicy: 'round_robin', loadBalancingConfig: [{ bogus_policy: {} }, { round_robin: { extra: 1 } }, { ring_hash: { minRingSize: 'x' } }] }).join('\n');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_LB_POLICY_DEPRECATED');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_LB_POLICY_UNKNOWN');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_LB_INVALID');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_LB_RUNTIME_UNSUPPORTED');
  });

  it('cross-references google.api.Service documents against the proto contract', () => {
    const warnings = lint({ apis: [{ name: 't.S' }, { name: 't.S' }, { name: 'missing.Svc' }], types: [{ name: 'google.rpc.RetryInfo' }], enums: [{ name: 'not a fqn!' }] }).join('\n');
    expect(warnings).toContain('GRPC_SERVICE_CONFIG_KIND_MISMATCH');
    expect(warnings).toContain('GRPC_GOOGLE_API_CONFIG_DUPLICATE');
    expect(warnings).toContain('GRPC_GOOGLE_API_CONFIG_API_UNRESOLVED');
    expect(warnings).toContain('GRPC_GOOGLE_API_CONFIG_TYPE_URL_INVALID');
    expect(warnings).toContain('GRPC_GOOGLE_API_CONFIG_ERRORINFO_MISSING');
  });
});
