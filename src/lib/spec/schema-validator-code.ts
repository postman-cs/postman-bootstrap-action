import { validator, type Schema } from '@exodus/schemasafe';

export function compileSchemaValidatorCode(schema: unknown): string {
  try {
    const validate = validator(schema as Schema, {
      includeErrors: true,
      allErrors: true,
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
