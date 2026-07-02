import { describe, expect, it } from 'vitest';
import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { createContractScript } from '../src/lib/spec/collection-contracts.js';

type JsonRecord = Record<string, unknown>;

function specWithScheme(requirement: Record<string, string[]>, schemes: JsonRecord): JsonRecord {
  return {
    openapi: '3.0.3',
    info: { title: 'Security prefix', version: '1.0.0' },
    security: [requirement],
    paths: {
      '/ping': {
        get: { operationId: 'ping', responses: { '200': { description: 'ok' } } }
      }
    },
    components: { securitySchemes: schemes }
  };
}

// RFC 9110 section 11.1: credentials open with a case-insensitive auth-scheme
// token. Basic is RFC 7617, Bearer is RFC 6750; other registered schemes are
// checked by their scheme name.
describe('Authorization scheme-prefix security checks', () => {
  it('emits a Basic prefix check for http basic', () => {
    const index = buildContractIndex(specWithScheme({ basicAuth: [] }, { basicAuth: { type: 'http', scheme: 'basic' } }));
    expect(index.operations).toHaveLength(1);
    expect(index.operations[0]!.security).toMatchObject([[{ scheme: 'basicAuth', kind: 'http:basic', checkable: true, prefix: 'Basic ' }]]);
  });

  it('emits a Bearer prefix check for http bearer', () => {
    const index = buildContractIndex(specWithScheme({ bearerAuth: [] }, { bearerAuth: { type: 'http', scheme: 'bearer' } }));
    expect(index.operations[0]!.security).toMatchObject([[{ kind: 'http:bearer', checkable: true, prefix: 'Bearer ' }]]);
  });

  it('emits a scheme-token prefix check for any registered http scheme', () => {
    const index = buildContractIndex(specWithScheme({ proofAuth: [] }, { proofAuth: { type: 'http', scheme: 'dpop' } }));
    expect(index.operations[0]!.security).toMatchObject([[{ kind: 'http:dpop', checkable: true, prefix: 'Dpop ' }]]);
  });

  it('compares the Authorization prefix case-insensitively in the generated script', () => {
    const index = buildContractIndex(specWithScheme({ bearerAuth: [] }, { bearerAuth: { type: 'http', scheme: 'bearer' } }));
    const script = createContractScript(index.operations[0]!).join('\n');
    expect(script).toContain('requestHeader("Authorization").toLowerCase().indexOf(check.prefix.toLowerCase()) === 0');
  });
});
