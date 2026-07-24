import { describe, expect, it } from 'vitest';

import { buildContractIndex } from '../../src/lib/spec/contract-index.js';
import { createContractScript } from '../../src/lib/spec/collection-contracts.js';
import { packSchema } from '../../src/lib/spec/schema-pack.js';

const doc31 = (schema: unknown): Record<string, unknown> => ({
  openapi: '3.1.0',
  info: { title: 'T', version: '1' },
  paths: {
    '/x': {
      get: {
        operationId: 'getX',
        responses: {
          '200': { description: 'OK', content: { 'application/json': { schema } } }
        }
      }
    }
  }
});

/**
 * OAS 3.1 schemas are JSON Schema 2020-12, where `items` MUST be a single schema
 * and tuple positions are expressed with `prefixItems`. The OAS 3.0 draft-04
 * array form (`items: [ ... ]`) is NOT valid 2020-12, but @readme/openapi-parser
 * accepts it under 3.1 (3.1 delegates schema validity to the dialect), so it
 * reaches packSchema. packSchema rejects it under 3.0 and must reject it under
 * 3.1 too: an unrejected tuple `items` packs into a $schema-2020-12 validator
 * schema that schemasafe refuses to compile, silently downgrading that
 * operation's response-body validation to a runtime skip at the customer.
 */
describe('OAS 3.1 tuple-form items is rejected before it reaches the validator', () => {
  it('fails packSchema closed for a 3.1 tuple items array', () => {
    const packed = packSchema({}, { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] }, '3.1');
    expect(packed.unsupported).toContain('items');
    expect(packed.schema).toBeUndefined();
  });

  it('fails packSchema closed for a nested 3.1 tuple items array', () => {
    const packed = packSchema(
      {},
      { type: 'object', properties: { tags: { type: 'array', items: [{ type: 'string' }] } } },
      '3.1'
    );
    expect(packed.unsupported).toContain('items');
    expect(packed.schema).toBeUndefined();
  });

  it('surfaces the rejection reason on the indexed response media instead of a packed schema', () => {
    const index = buildContractIndex(doc31({ type: 'array', items: [{ type: 'string' }] }));
    const media = index.operations[0]!.responses['200']!.content['application/json']!;
    expect(media.schema).toBeUndefined();
    expect(media.unsupported).toContain('Tuple array items are unsupported in OpenAPI 3.1');
  });

  it('does not embed an uncompilable tuple items schema in the generated script', () => {
    const index = buildContractIndex(doc31({ type: 'array', items: [{ type: 'string' }] }));
    const warnings: string[] = [];
    const script = createContractScript(index.operations[0]!, warnings).join('\n');
    expect(warnings.join('\n')).not.toContain('CONTRACT_SCHEMA_COMPILE_FAILED');
    expect(script).not.toContain('Unexpected type');
  });

  it('still packs the valid 2020-12 prefixItems tuple form under 3.1', () => {
    const packed = packSchema({}, { type: 'array', prefixItems: [{ type: 'string' }], items: false }, '3.1');
    expect(packed.unsupported).toBeUndefined();
    expect(packed.schema).toMatchObject({ prefixItems: [{ type: 'string' }] });
  });

  it('still packs a single-schema items under 3.1', () => {
    const packed = packSchema({}, { type: 'array', items: { type: 'string' } }, '3.1');
    expect(packed.unsupported).toBeUndefined();
    expect(packed.schema).toMatchObject({ items: { type: 'string' } });
  });
});