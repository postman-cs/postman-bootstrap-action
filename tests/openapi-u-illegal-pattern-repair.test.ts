import { describe, expect, it, vi } from 'vitest';

import { buildContractIndex } from '../src/lib/spec/contract-index.js';
import { repairGeneratedCollectionExamples } from '../src/lib/spec/request-example-repair.js';

// Regression for the production `LOCAL_OPENAPI_ORCHESTRATION_FAILED` seen on
// PayPal's checkout_orders_v2 spec. `@exodus/schemasafe` compiles every
// `pattern` with the RegExp `u` flag, so a spec-legal ECMA-262 pattern that is
// illegal under `u` made the packed validator fail to compile. Repair then
// threw `... validator did not compile` for the operation, and that aborted the
// whole bootstrap run. Containment alone is not enough: without the packer fix
// the run "succeeds" while shipping every example unrepaired and unvalidated.
//
// The pattern below is taken from the real spec
// (#/components/schemas/level_2_card_processing_data/.../invoice_id).
const U_ILLEGAL_PATTERN = "^[\\w'\\-.,\":;\\!?]*$";

function specWithUIllegalPattern(): string {
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'U Illegal Pattern', version: '1.0.0' },
    servers: [{ url: 'https://example.test' }],
    paths: {
      '/orders': {
        post: {
          operationId: 'createOrder',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['invoice_id', 'amount'],
                  properties: {
                    invoice_id: { type: 'string', pattern: U_ILLEGAL_PATTERN, maxLength: 6 },
                    amount: { type: 'string', pattern: '^\\d+$' }
                  }
                }
              }
            }
          },
          responses: { '200': { description: 'ok' } }
        }
      }
    }
  });
}

function collectionWith(body: unknown): Record<string, unknown> {
  return {
    info: { name: 'U Illegal Pattern' },
    item: [{
      name: 'createOrder',
      request: {
        method: 'POST',
        url: { raw: 'https://example.test/orders', path: ['orders'] },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify(body) }
      }
    }]
  };
}

function requestBody(collection: Record<string, unknown>): unknown {
  const item = (collection.item as Array<Record<string, unknown>>)[0];
  const request = item.request as Record<string, unknown>;
  const body = request.body as Record<string, unknown>;
  return JSON.parse(body.raw as string);
}

describe('example repair with a u-illegal but ECMA-262-legal pattern', () => {
  it('is legal ECMA-262 yet rejected under the u flag schemasafe forces', () => {
    expect(() => new RegExp(U_ILLEGAL_PATTERN)).not.toThrow();
    expect(() => new RegExp(U_ILLEGAL_PATTERN, 'u')).toThrow();
  });

  it('repairs the operation instead of failing its validator compilation', () => {
    const bundled = specWithUIllegalPattern();
    // invoice_id is over maxLength and must be repaired; amount already
    // satisfies its own (u-legal) pattern. Before the packer fix this operation
    // never got that far: the u-illegal invoice_id pattern stopped the whole
    // packed validator from compiling, repair threw, and the run aborted.
    const collection = collectionWith({ invoice_id: 'toolongtobevalid', amount: '4200' });

    const warnings = repairGeneratedCollectionExamples(
      collection,
      buildContractIndex(JSON.parse(bundled)),
      bundled,
      () => 'generated'
    );

    // The bug: repair threw here, which aborted the whole bootstrap run.
    expect(warnings).toEqual([]);

    const repaired = requestBody(collection) as Record<string, unknown>;
    // Constraints that survive packing are still enforced: maxLength trims and
    // the sibling u-legal pattern is repaired to a matching value.
    expect(String(repaired.invoice_id).length).toBeLessThanOrEqual(6);
    expect(String(repaired.amount)).toBe('4200');
  });

  it('does not consult the schema faker when the example already satisfies the schema', () => {
    const bundled = specWithUIllegalPattern();
    const collection = collectionWith({ invoice_id: 'INV-1', amount: '4200' });
    const candidate = vi.fn(() => 'generated');

    const warnings = repairGeneratedCollectionExamples(
      collection,
      buildContractIndex(JSON.parse(bundled)),
      bundled,
      candidate
    );

    expect(warnings).toEqual([]);
    expect(candidate).not.toHaveBeenCalled();
    expect(requestBody(collection)).toEqual({ invoice_id: 'INV-1', amount: '4200' });
  });
});
