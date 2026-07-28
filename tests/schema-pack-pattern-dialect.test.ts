import { describe, expect, it } from 'vitest';

import { packSchema } from '../src/lib/spec/schema-pack.js';
import { compileSchemaValidator } from '../src/lib/spec/schema-validator-code.js';

// schemasafe compiles every `pattern` with the RegExp `u` flag
// (@exodus/schemasafe/src/scope-utils.js). JSON Schema only says `pattern`
// SHOULD be ECMA-262; it does not require `u`. Real specs (PayPal
// checkout_orders_v2) carry patterns that are legal ECMA-262 but illegal
// under `u` -- e.g. a redundant `\!` escape inside a character class. Those
// made the whole packed validator fail to compile, which aborted local
// OpenAPI collection generation for the entire spec.
const OAS_ROOT = { openapi: '3.0.3', info: { title: 't', version: '1' }, paths: {} };

function packed(schema: unknown): unknown {
  const result = packSchema(OAS_ROOT, schema, '3.0', 'request');
  expect(result.unsupported).toBeUndefined();
  return result.schema;
}

describe('packSchema pattern dialect compatibility', () => {
  it('keeps a u-legal pattern as a live assertion', () => {
    const schema = packed({ type: 'string', pattern: '^[a-z]+$' }) as Record<string, unknown>;
    expect(schema.pattern).toBe('^[a-z]+$');

    const validate = compileSchemaValidator(schema);
    expect(validate).not.toBeNull();
    expect(validate?.('abc')).toBe(true);
    expect(validate?.('ABC')).toBe(false);
  });

  it('drops a u-illegal but ECMA-262-legal pattern instead of failing the whole schema', () => {
    // Legal ECMA-262 (annex B identity escape); illegal under /u.
    const pattern = "^[\\w'\\-.,\":;\\!?]*$";
    expect(() => new RegExp(pattern)).not.toThrow();
    expect(() => new RegExp(pattern, 'u')).toThrow();

    const schema = packed({ type: 'string', pattern }) as Record<string, unknown>;
    expect(schema.pattern).toBeUndefined();
    expect(schema.type).toBe('string');

    const validate = compileSchemaValidator(schema);
    expect(validate).not.toBeNull();
    expect(validate?.('anything goes')).toBe(true);
  });

  it('drops a truly malformed pattern rather than emitting an uncompilable validator', () => {
    const schema = packed({ type: 'string', pattern: '[' }) as Record<string, unknown>;
    expect(schema.pattern).toBeUndefined();
    expect(compileSchemaValidator(schema)).not.toBeNull();
  });

  it('keeps the rest of a schema working when a nested pattern is u-illegal', () => {
    const schema = packed({
      type: 'object',
      required: ['invoice_id'],
      properties: {
        invoice_id: { type: 'string', pattern: "^[\\w'\\-.,\":;\\!?]*$", maxLength: 4 },
        code: { type: 'string', pattern: '^[A-Z]{2}$' }
      }
    }) as Record<string, unknown>;

    const validate = compileSchemaValidator(schema);
    expect(validate).not.toBeNull();
    // maxLength on the same property still asserts.
    expect(validate?.({ invoice_id: 'toolong' })).toBe(false);
    expect(validate?.({ invoice_id: 'ok' })).toBe(true);
    // The sibling u-legal pattern is untouched.
    expect(validate?.({ invoice_id: 'ok', code: 'lower' })).toBe(false);
    expect(validate?.({ invoice_id: 'ok', code: 'US' })).toBe(true);
  });

  it('does not touch patternProperties keys, which are not `pattern` assertions', () => {
    const schema = packed({
      type: 'object',
      patternProperties: { '^x-': { type: 'string' } }
    }) as Record<string, Record<string, unknown>>;

    expect(Object.keys(schema.patternProperties)).toEqual(['^x-']);
    expect(compileSchemaValidator(schema)).not.toBeNull();
  });
});
