import { describe, expect, it } from 'vitest';

import {
  COLLECTION_SEMANTIC_RECEIPT_KEY,
  parseCollectionSemanticReceipt,
  renderCollectionSemanticReceipt,
  stripCollectionSemanticReceipt
} from '../src/lib/postman/collection-semantic-receipt.js';
import { computePayloadDigest } from '../src/lib/spec/local-openapi-collection-generation.js';

const digest = 'a'.repeat(64);

describe('collection semantic receipt', () => {
  it('round-trips the byte-exact prior description through one strict final-line receipt', () => {
    const base = 'customer prose\nx-pm-onboarding: {"repo":"acme/api","role":"preview"}';
    const rendered = renderCollectionSemanticReceipt(base, digest);

    expect(stripCollectionSemanticReceipt(rendered)).toBe(base);
    expect(parseCollectionSemanticReceipt(rendered)).toEqual({
      schemaVersion: 1,
      algorithm: 'sha256',
      digest
    });
    expect(renderCollectionSemanticReceipt(rendered, 'b'.repeat(64))).not.toContain(digest);
  });

  it('keeps the semantic collection digest stable when the reserved receipt is appended', () => {
    const collection = {
      info: {
        name: 'Payments',
        description: 'owned',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: []
    };
    const expected = computePayloadDigest(collection);
    const withReceipt = structuredClone(collection);
    withReceipt.info.description = renderCollectionSemanticReceipt(
      withReceipt.info.description,
      expected
    );

    expect(computePayloadDigest(withReceipt)).toBe(expected);
  });

  it('canonicalizes a null description as absent before binding the submitted receipt', () => {
    const collection = {
      info: {
        name: 'Payments',
        description: null as string | null,
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
      },
      item: []
    };
    const expected = computePayloadDigest(collection);
    const submitted = structuredClone(collection);
    submitted.info.description = renderCollectionSemanticReceipt(
      submitted.info.description,
      expected
    );

    expect(stripCollectionSemanticReceipt(submitted.info.description)).toBe('');
    expect(parseCollectionSemanticReceipt(submitted.info.description)?.digest).toBe(expected);
    expect(computePayloadDigest(submitted)).toBe(expected);
  });

  it('rejects an SDK description object instead of silently erasing its content', () => {
    expect(() => renderCollectionSemanticReceipt(
      { content: 'keep me', type: 'text/markdown' },
      digest
    )).toThrow(/collection description must be a string/);
  });

  it.each([
    `${COLLECTION_SEMANTIC_RECEIPT_KEY}: nope`,
    `before ${COLLECTION_SEMANTIC_RECEIPT_KEY}: ${JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', digest })}`,
    `${COLLECTION_SEMANTIC_RECEIPT_KEY}: ${JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', digest, extra: true })}`,
    `${COLLECTION_SEMANTIC_RECEIPT_KEY}: ${JSON.stringify({ schemaVersion: 2, algorithm: 'sha256', digest })}`,
    `${COLLECTION_SEMANTIC_RECEIPT_KEY}: ${JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', digest })}\n${COLLECTION_SEMANTIC_RECEIPT_KEY}: ${JSON.stringify({ schemaVersion: 1, algorithm: 'sha256', digest })}`
  ])('rejects malformed or ambiguous reserved receipt text', (description) => {
    expect(() => parseCollectionSemanticReceipt(description)).toThrow(
      /COLLECTION_SEMANTIC_RECEIPT_INVALID/
    );
  });
});
