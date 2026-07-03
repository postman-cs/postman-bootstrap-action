import { readFileSync, writeFileSync } from 'node:fs';
import { parseGraphQLSchema } from '../../src/lib/protocols/graphql/index.js';
import { buildGraphQLCollection } from '../../src/lib/protocols/graphql/index.js';
import { instrumentGraphQLCollection } from '../../src/lib/protocols/graphql/index.js';

const sdlPath = process.argv[2];
const outPath = process.argv[3];
const sdl = readFileSync(sdlPath, 'utf8');
const index = parseGraphQLSchema(sdl, { service: 'Telecom' } as Parameters<typeof parseGraphQLSchema>[1]);
const collection = buildGraphQLCollection(index, {
  url: '{{baseUrl}}/graphql',
  variables: [{ key: 'baseUrl', value: '' }]
});
const result = instrumentGraphQLCollection(collection, index);
writeFileSync(outPath, JSON.stringify(result.collection, null, 2));
const items = (result.collection.item as Array<{ name?: string }>) ?? [];
console.error('[gql-generator] operations=' + index.operations.length + ' items=' + items.length + ' warnings=' + result.warnings.length);
console.error('item names: ' + items.map((i) => i.name).join(' | '));
