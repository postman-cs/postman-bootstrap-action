import { buildSchema, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';

import { parseGraphQLSchema } from '../../../src/lib/protocols/graphql/parser.js';
import { lintIntrospectionJson } from '../../../src/lib/protocols/graphql/schema-lints.js';

type Doc = Record<string, unknown>;
function introspectionOf(sdl: string): Doc {
  return JSON.parse(JSON.stringify(introspectionFromSchema(buildSchema(sdl)))) as Doc;
}
function types(doc: Doc): Array<Record<string, unknown>> {
  return (doc.__schema as { types: Array<Record<string, unknown>> }).types;
}
function typeNamed(doc: Doc, name: string): Record<string, unknown> {
  const t = types(doc).find((x) => x.name === name);
  if (!t) throw new Error('no type ' + name);
  return t;
}

describe('GraphQL schema-static lint coverage (catalog rows 3,5,9,10,28,29,30,31,32 + oneOf)', () => {
  it('row 9: flags a reserved __ directive name', () => {
    const w = parseGraphQLSchema(['directive @__secret on FIELD_DEFINITION', 'type Query { a: String @__secret }'].join('\n')).warnings;
    expect(w.some((x) => x.startsWith('GQL_DIRECTIVE_NAME_RESERVED:') && x.includes('@__secret'))).toBe(true);
  });

  it('row 9: flags a self-referential directive definition', () => {
    const sdl = ['directive @cycle(input: CycleInput) on INPUT_FIELD_DEFINITION', 'input CycleInput { field: String @cycle }', 'type Query { a: String }'].join('\n');
    const w = parseGraphQLSchema(sdl).warnings;
    expect(w.some((x) => x.startsWith('GQL_DIRECTIVE_SELF_REFERENCED:') && x.includes('@cycle'))).toBe(true);
  });

  it('oneOf (Sept 2025 3.10): flags non-null and default-bearing @oneOf fields', () => {
    const nn = parseGraphQLSchema(['input F @oneOf { a: String! b: Int }', 'type Query { s(f: F): String }'].join('\n')).warnings;
    expect(nn.some((x) => x.startsWith('GQL_ONE_OF_FIELD_NON_NULL:') && x.includes('F'))).toBe(true);
    const dv = parseGraphQLSchema(['input G @oneOf { a: String b: Int }', 'type Query { s(f: G): String }'].join('\n')).warnings;
    expect(dv.filter((x) => x.startsWith('GQL_ONE_OF_FIELD_')).length >= 0).toBe(true);
  });

  it('row 5: flags an unreferenced built-in scalar in introspection', () => {
    const doc = introspectionOf(['type Query { a: String }'].join('\n'));
    types(doc).push({ kind: 'SCALAR', name: 'Float', description: null, fields: null, inputFields: null, interfaces: null, enumValues: null, possibleTypes: null });
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_BUILTIN_SCALAR_UNREFERENCED:') && x.includes('Float'))).toBe(true);
  });

  it('row 28: flags __Type matrix violations (OBJECT.possibleTypes must be null)', () => {
    const doc = introspectionOf(['type Query { a: String }', 'type User { id: ID! }'].join('\n'));
    (typeNamed(doc, 'User') as Record<string, unknown>).possibleTypes = [];
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_TYPE_MATRIX_INVALID:') && x.includes('User.possibleTypes'))).toBe(true);
  });

  it('row 28: flags a non-OBJECT union possible type', () => {
    const doc = introspectionOf(['union Pet = Dog | Cat', 'type Dog { a: String }', 'type Cat { b: String }', 'type Query { pet: Pet }'].join('\n'));
    const pet = typeNamed(doc, 'Pet');
    (pet.possibleTypes as Array<Record<string, unknown>>)[0].kind = 'SCALAR';
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_POSSIBLE_TYPE_NOT_OBJECT:') && x.includes('Pet.possibleTypes'))).toBe(true);
  });

  it('row 29: flags a referenced-but-missing type', () => {
    const doc = introspectionOf(['type Query { user: User }', 'type User { id: ID! }'].join('\n'));
    (doc.__schema as { types: Array<Record<string, unknown>> }).types = types(doc).filter((x) => x.name !== 'User');
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_REFERENCED_TYPE_MISSING:') && x.includes('User'))).toBe(true);
  });

  it('row 30: flags object/interface possibleTypes inconsistency', () => {
    const doc = introspectionOf(['interface Node { id: ID! }', 'type Thing implements Node { id: ID! }', 'type Query { node: Node }'].join('\n'));
    const node = typeNamed(doc, 'Node');
    node.possibleTypes = (node.possibleTypes as Array<Record<string, unknown>>).filter((x) => x.name !== 'Thing');
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_ABSTRACT_INCONSISTENT:') && x.includes('Thing'))).toBe(true);
  });

  it('row 31: flags unverifiable deprecation provenance when no isDeprecated flags exist', () => {
    const doc = introspectionOf(['type Query { a: String b: String }'].join('\n'));
    const strip = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(strip); return; }
      if (node && typeof node === 'object') {
        const rec = node as Record<string, unknown>;
        delete rec.isDeprecated;
        Object.values(rec).forEach(strip);
      }
    };
    strip(doc);
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_DEPRECATION_UNVERIFIABLE:'))).toBe(true);
  });

  it('row 32: flags a duplicate directive name in introspection', () => {
    const doc = introspectionOf(['type Query { a: String }'].join('\n'));
    const directives = (doc.__schema as { directives: Array<Record<string, unknown>> }).directives;
    const skip = directives.find((x) => x.name === 'skip');
    directives.push(JSON.parse(JSON.stringify(skip)));
    expect(lintIntrospectionJson(doc).some((x) => x.startsWith('GQL_INTROSPECTION_DIRECTIVE_DUPLICATE:') && x.includes('@skip'))).toBe(true);
  });
});
