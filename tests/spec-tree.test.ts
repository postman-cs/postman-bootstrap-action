import { describe, expect, it } from 'vitest';

import { parseSpecTreePage, specTreeNextCursor } from '../src/lib/postman/spec-tree.js';

describe('parseSpecTreePage', () => {
  it('ignores folders and maps the root and dependency files', () => {
    expect(parseSpecTreePage({ data: [
      { type: 'FOLDER', id: 'folder' },
      { type: 'FILE', id: 'root', path: 'openapi.yaml', fileType: 'ROOT', content: 'openapi: 3.0.3' },
      { type: 'FILE', id: 'dep', path: 'paths/pets.yaml', parentId: 'folder', fileType: 'YAML', content: '{}' }
    ] })).toEqual([
      { id: 'root', path: 'openapi.yaml', type: 'ROOT', content: 'openapi: 3.0.3' },
      { id: 'dep', path: 'paths/pets.yaml', parentId: 'folder', type: 'DEFAULT', content: '{}' }
    ]);
  });

  it('throws SPEC_TREE_INCOMPLETE when the data array is missing', () => {
    expect(() => parseSpecTreePage({ meta: {} })).toThrow(/SPEC_TREE_INCOMPLETE/);
    expect(() => parseSpecTreePage(null)).toThrow(/SPEC_TREE_INCOMPLETE/);
    expect(() => parseSpecTreePage(undefined)).toThrow(/SPEC_TREE_INCOMPLETE/);
  });

  it('throws SPEC_TREE_INCOMPLETE when a file entry is structurally incomplete', () => {
    expect(() => parseSpecTreePage({ data: [{ type: 'FILE', id: 'x' }] })).toThrow(/SPEC_TREE_INCOMPLETE/);
    expect(() => parseSpecTreePage({ data: [{ type: 'FILE', id: 'x', path: 'a.yaml' }] })).toThrow(/SPEC_TREE_INCOMPLETE/);
    expect(() => parseSpecTreePage({ data: [{ type: 'FILE', id: 'x', path: 'a.yaml', fileType: 'YAML' }] })).toThrow(/SPEC_TREE_INCOMPLETE/);
  });

  it('throws SPEC_TREE_INCOMPLETE when the file type is blank', () => {
    expect(() => parseSpecTreePage({ data: [
      { type: 'FILE', id: '  ', path: 'a.yaml', fileType: 'ROOT', content: 'x' }
    ] })).toThrow(/SPEC_TREE_INCOMPLETE/);
    expect(() => parseSpecTreePage({ data: [
      { type: 'FILE', id: 'x', path: 'a.yaml', fileType: '  ', content: 'x' }
    ] })).toThrow(/SPEC_TREE_INCOMPLETE/);
  });

  it('rejects unsafe paths (absolute, parent traversal, backslash, NUL)', () => {
    expect(() => parseSpecTreePage({ data: [
      { type: 'FILE', id: 'r', path: '/etc/openapi.yaml', fileType: 'ROOT', content: 'x' }
    ] })).toThrow(/ESCAPE/);
    expect(() => parseSpecTreePage({ data: [
      { type: 'FILE', id: 'r', path: '../../openapi.yaml', fileType: 'ROOT', content: 'x' }
    ] })).toThrow(/ESCAPE/);
    expect(() => parseSpecTreePage({ data: [
      { type: 'FILE', id: 'r', path: 'a\\b.yaml', fileType: 'ROOT', content: 'x' }
    ] })).toThrow(/ESCAPE/);
    expect(() => parseSpecTreePage({ data: [
      { type: 'FILE', id: 'r', path: 'a\u0000b.yaml', fileType: 'ROOT', content: 'x' }
    ] })).toThrow(/ESCAPE/);
  });

  it('trims ids/parentId and preserves the root/default type mapping', () => {
    expect(parseSpecTreePage({ data: [
      { type: 'FILE', id: '  root  ', path: 'openapi.yaml', fileType: 'ROOT', content: 'x' },
      { type: 'FILE', id: '  dep  ', path: 'a.yaml', parentId: '  folder  ', fileType: 'YAML', content: 'y' }
    ] })).toEqual([
      { id: 'root', path: 'openapi.yaml', type: 'ROOT', content: 'x' },
      { id: 'dep', path: 'a.yaml', parentId: 'folder', type: 'DEFAULT', content: 'y' }
    ]);
  });
});

describe('specTreeNextCursor', () => {
  it('returns the trimmed next cursor from meta.cursor.next', () => {
    expect(specTreeNextCursor({ meta: { cursor: { next: '  abc  ' } } })).toBe('abc');
  });

  it('returns an empty string when no cursor is present', () => {
    expect(specTreeNextCursor({ meta: {} })).toBe('');
    expect(specTreeNextCursor({})).toBe('');
    expect(specTreeNextCursor(null)).toBe('');
    expect(specTreeNextCursor(undefined)).toBe('');
    expect(specTreeNextCursor({ meta: { cursor: {} } })).toBe('');
    expect(specTreeNextCursor({ meta: { cursor: { next: 123 } } })).toBe('');
  });
});
