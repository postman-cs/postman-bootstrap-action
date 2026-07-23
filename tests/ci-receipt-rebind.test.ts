import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- CI helper is plain ESM and intentionally outside tsconfig source roots
import * as rebindModule from '../.github/scripts/rebind-multifile-receipt.mjs';

const planMultifileReceiptRebind = rebindModule.planMultifileReceiptRebind as (
  receipt: ReceiptFixture,
  options: {
    headCommit: string;
    isAncestor: (ancestor: string, descendant: string) => boolean;
    changedPaths: string[];
  }
) => { updated: boolean; receipt: ReceiptFixture };

interface ReceiptFixture {
  schemaVersion: number;
  testedAt: string;
  bootstrapCommit: string;
  legs: unknown[];
  capabilities: Record<string, boolean>;
}

const committedReceipt = JSON.parse(
  readFileSync(join(process.cwd(), 'validation/evidence/multifile-spec-sync.json'), 'utf8')
) as ReceiptFixture;

function receipt(commit = 'a'.repeat(40)): ReceiptFixture {
  return { ...structuredClone(committedReceipt), bootstrapCommit: commit };
}

describe('CI multifile receipt rebind', () => {
  it('rebinds behavior-bearing drift while preserving every live evidence field', () => {
    const original = receipt();
    const snapshot = structuredClone(original);
    const head = 'b'.repeat(40);
    const plan = planMultifileReceiptRebind(original, {
      headCommit: head,
      isAncestor: () => true,
      changedPaths: ['src/index.ts', 'src/lib/postman/gateway-client.ts']
    });

    expect(plan.updated).toBe(true);
    expect(plan.receipt.bootstrapCommit).toBe(head);
    expect(original).toEqual(snapshot);
    expect({ ...plan.receipt, bootstrapCommit: snapshot.bootstrapCommit }).toEqual(snapshot);
  });

  it('does not rewrite exact or release-only-covered receipts', () => {
    const original = receipt();
    expect(
      planMultifileReceiptRebind(original, {
        headCommit: original.bootstrapCommit,
        isAncestor: () => true,
        changedPaths: []
      }).updated
    ).toBe(false);
    expect(
      planMultifileReceiptRebind(original, {
        headCommit: 'b'.repeat(40),
        isAncestor: () => true,
        changedPaths: ['package.json', 'dist/index.cjs']
      }).updated
    ).toBe(false);
  });

  it('refuses non-ancestor and malformed target commits', () => {
    const original = receipt();
    expect(() =>
      planMultifileReceiptRebind(original, {
        headCommit: 'b'.repeat(40),
        isAncestor: () => false,
        changedPaths: ['src/index.ts']
      })
    ).toThrow(/not an ancestor/);
    expect(() =>
      planMultifileReceiptRebind(original, {
        headCommit: 'not-a-sha',
        isAncestor: () => true,
        changedPaths: []
      })
    ).toThrow(/40-char lowercase git sha/);
  });
});
