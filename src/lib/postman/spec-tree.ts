import { assertValidBundleRelativePath } from '../spec/definition-bundle.js';

export type SpecTreeMember = { id: string; path: string; type: 'ROOT' | 'DEFAULT'; parentId?: string; content: string };

export function parseSpecTreePage(value: unknown): SpecTreeMember[] {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (!Array.isArray(record?.data)) throw new Error('SPEC_TREE_INCOMPLETE');
  return record.data.flatMap((raw): SpecTreeMember[] => {
    const file = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
    if (file?.type === 'FOLDER') return [];
    if (file?.type !== 'FILE' || typeof file.id !== 'string' || !file.id.trim() || typeof file.path !== 'string' || typeof file.content !== 'string' || typeof file.fileType !== 'string' || !file.fileType.trim()) throw new Error('SPEC_TREE_INCOMPLETE');
    const path = assertValidBundleRelativePath(file.path);
    return [{ id: file.id.trim(), path, type: file.fileType === 'ROOT' ? 'ROOT' : 'DEFAULT', content: file.content, ...(typeof file.parentId === 'string' && file.parentId.trim() ? { parentId: file.parentId.trim() } : {}) }];
  });
}

export function specTreeNextCursor(value: unknown): string {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  const meta = record?.meta && typeof record.meta === 'object' ? record.meta as Record<string, unknown> : null;
  const cursor = meta?.cursor && typeof meta.cursor === 'object' ? meta.cursor as Record<string, unknown> : null;
  return typeof cursor?.next === 'string' ? cursor.next.trim() : '';
}
