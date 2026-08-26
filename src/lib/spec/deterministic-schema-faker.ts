import { createHash } from 'node:crypto';

import converterSchemaFaker from 'openapi-to-postmanv2/assets/json-schema-faker.js';

export type SchemaCandidateGenerator = (schema: unknown, attempt?: number) => unknown;

let fakerAccess = Promise.resolve();
const CONVERTER_RANDOM_SEED = 'postman-local-openapi-schema-faker-v1';

function deterministicRandom(source: string): () => number {
  let state = createHash('sha256').update(source).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function schemaForPinnedFaker(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaForPinnedFaker);
  if (!schema || typeof schema !== 'object') return schema;
  const source = schema as Record<string, unknown>;
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema') continue;
    const targetKey = key === '$defs' ? 'definitions' : key;
    converted[targetKey] = typeof value === 'string' && key === '$ref'
      ? value.replace(/^#\/\$defs\//, '#/definitions/')
      : schemaForPinnedFaker(value);
  }
  return converted;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/**
 * The exact-pinned converter exposes no scoped random option, and its bundled
 * schema faker stores `random` process-globally. Serialize the complete
 * conversion-and-repair critical section so concurrent calls cannot replace
 * each other's source, and restore the previous function in `finally` across
 * synchronous throws, callback failures, and async work.
 */
export async function withDeterministicSchemaFaker<T>(
  _source: string,
  work: (candidate: SchemaCandidateGenerator) => Promise<T> | T
): Promise<T> {
  const previousAccess = fakerAccess;
  let release!: () => void;
  fakerAccess = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousAccess;

  const previousRandom = converterSchemaFaker.option('random');
  converterSchemaFaker.option({ random: deterministicRandom(CONVERTER_RANDOM_SEED) });
  try {
    return await work((schema, attempt = 0) => {
      const converted = schemaForPinnedFaker(schema);
      const outerRandom = converterSchemaFaker.option('random');
      converterSchemaFaker.option({
        random: deterministicRandom(`${CONVERTER_RANDOM_SEED}\n${attempt}\n${stableStringify(converted)}`)
      });
      try {
        return converterSchemaFaker(converted);
      } finally {
        converterSchemaFaker.option({ random: outerRandom });
      }
    });
  } finally {
    converterSchemaFaker.option({ random: previousRandom });
    release();
  }
}
