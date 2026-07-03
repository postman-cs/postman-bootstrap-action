import { readFileSync, writeFileSync } from 'node:fs';
import { parseOpenApiDocument } from '../../src/lib/spec/openapi-loader.js';
import { buildContractIndex } from '../../src/lib/spec/contract-index.js';
import { instrumentContractCollection } from '../../src/lib/spec/collection-contracts.js';

type J = Record<string, unknown>;

const specPath = process.argv[2];
const outPath = process.argv[3];

const doc = parseOpenApiDocument(readFileSync(specPath, 'utf8'));
const index = buildContractIndex(doc as J);

function sampleFromSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return 'x';
  const s = schema as J & { type?: string | string[]; example?: unknown; properties?: J; items?: unknown };
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if (s.example !== undefined) return s.example;
  if (t === 'object' || s.properties) {
    const o: J = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) o[k] = sampleFromSchema(v);
    return o;
  }
  if (t === 'array') return [sampleFromSchema(s.items)];
  if (t === 'integer' || t === 'number') return 1;
  if (t === 'boolean') return true;
  return 'x';
}

const items = index.operations.map((op) => {
  const concretePath = op.path.replace(/\{([^}]+)\}/g, '1');
  const query = op.declaredQueryParameters.map((name) => ({ key: name, value: 'x' }));
  const qs = query.length ? '?' + query.map((q) => q.key + '=' + q.value).join('&') : '';
  const raw = '{{baseUrl}}' + concretePath + qs;
  const request: J = {
    method: op.method,
    header: [] as J[],
    url: { raw, host: ['{{baseUrl}}'], path: concretePath.split('/').filter(Boolean), query }
  };
  const rb = op.requestBody;
  if (rb && rb.required) {
    const jsonCt = rb.contentTypes.find((c) => /json/.test(c)) ?? rb.contentTypes[0];
    const schema = (rb.jsonSchemas ?? {})[jsonCt];
    (request.header as J[]).push({ key: 'Content-Type', value: jsonCt });
    request.body = { mode: 'raw', raw: JSON.stringify(sampleFromSchema(schema)), options: { raw: { language: 'json' } } };
  }
  return { name: op.id, request, event: [] as J[] };
});

const collection: J = {
  info: { name: 'Widget Contract (integration)', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: items,
  variable: []
};

const result = instrumentContractCollection(collection, index);
// Integration runs hit a local mock, not AWS SecretsManager: drop the auto-prepended secrets resolver item.
result.collection.item = (result.collection.item as J[]).filter((it) => !/Resolve Secrets/.test(String((it as J).name ?? '')));
writeFileSync(outPath, JSON.stringify(result.collection, null, 2));
console.error('[generator] operations=' + index.operations.length + ' warnings=' + result.warnings.length);
if (result.warnings.length) console.error(result.warnings.map((w) => '  ! ' + w).join('\n'));
