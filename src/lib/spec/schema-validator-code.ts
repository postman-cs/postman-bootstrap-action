import { validator, type Schema } from '@exodus/schemasafe';

// Repairing one example validates the same packed schema hundreds of times
// (once per node, plus up to 20 candidate attempts each), and schemasafe
// codegen-compiles on every call. Memoizing by schema identity turns that back
// into one compile per distinct schema object; measured on PayPal's
// checkout_orders_v2 this is the difference between ~35s and ~2s per run.
// Keyed on object identity: packed schemas are rebuilt per pack and are not
// mutated after packing, and a WeakMap lets them be collected with their
// document.
const validatorCache = new WeakMap<object, ((value: unknown) => boolean) | null>();

// Instrumentation-time validator for checking spec examples against their own
// schemas in Node; returns null when the schema cannot compile so callers can
// skip rather than fail.
export function compileSchemaValidator(schema: unknown): ((value: unknown) => boolean) | null {
  const cacheKey = typeof schema === 'object' && schema !== null ? (schema as object) : null;
  if (cacheKey && validatorCache.has(cacheKey)) return validatorCache.get(cacheKey) ?? null;
  const compiled = compileSchemaValidatorUncached(schema);
  if (cacheKey) validatorCache.set(cacheKey, compiled);
  return compiled;
}

function compileSchemaValidatorUncached(schema: unknown): ((value: unknown) => boolean) | null {
  try {
    const validate = validator(schema as Schema, {
      includeErrors: false,
      // Real-world specs legally mix enum/const with other keywords; without
      // this flag schemasafe refuses to compile them (observed in Stripe,
      // Plaid, and DigitalOcean public specs).
      allowUnusedKeywords: true,
      contentValidation: false,
      formatAssertion: true,
      isJSON: true,
      mode: 'default',
      removeAdditional: false,
      requireSchema: true,
      requireStringValidation: false,
      useDefaults: false
    });
    return (value: unknown) => validate(value as Parameters<typeof validate>[0]);
  } catch {
    return null;
  }
}

export function compileSchemaValidatorCode(schema: unknown): string {
  try {
    const validate = validator(schema as Schema, {
      includeErrors: true,
      allErrors: true,
      // Real-world specs legally mix enum/const with other keywords; without
      // this flag schemasafe refuses to compile them (observed in Stripe,
      // Plaid, and DigitalOcean public specs).
      allowUnusedKeywords: true,
      contentValidation: false,
      formatAssertion: true,
      isJSON: true,
      mode: 'default',
      removeAdditional: false,
      requireSchema: true,
      requireStringValidation: false,
      useDefaults: false
    });
    const source = validate.toModule();
    if (/\beval\s*\(/.test(source) || /new\s+Function\b/.test(source)) {
      throw new Error('schemasafe generated forbidden dynamic code');
    }
    return source;
  } catch (error) {
    throw new Error(
      `CONTRACT_SCHEMA_COMPILE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
