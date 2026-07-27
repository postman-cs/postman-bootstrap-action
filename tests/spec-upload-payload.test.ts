import { describe, expect, it } from 'vitest';

import {
  SPEC_HUB_RAW_PAYLOAD_LIMIT_BYTES,
  assertRawSpecUploadPayloadWithinLimit,
  rawSpecUploadPayloadBytes,
  specContentSha256
} from '../src/lib/postman/spec-upload-payload.js';

describe('raw Spec Hub upload payload', () => {
  it('counts authored UTF-8 bytes across every file', () => {
    const files = [
      { path: 'openapi.yaml', content: 'openapi: 3.1.0\n' },
      { path: 'components/café.yaml', content: 'description: café\n' }
    ];
    const expected = files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
      0
    );
    expect(rawSpecUploadPayloadBytes(files)).toBe(expected);
    expect(assertRawSpecUploadPayloadWithinLimit(files)).toBe(expected);
  });

  it('names the real size and limit before an oversized payload can be sent', () => {
    const actualBytes = SPEC_HUB_RAW_PAYLOAD_LIMIT_BYTES + 1;
    expect(() =>
      assertRawSpecUploadPayloadWithinLimit([
        { path: 'openapi.json', content: 'x'.repeat(actualBytes) }
      ])
    ).toThrow(
      `CONTRACT_SPEC_HUB_PAYLOAD_TOO_LARGE: Raw Spec Hub upload is ${actualBytes} bytes ` +
        `across 1 file(s), exceeding the ${SPEC_HUB_RAW_PAYLOAD_LIMIT_BYTES}-byte (20 MiB) platform limit`
    );
  });

  it('hashes the exact UTF-8 source content', () => {
    expect(specContentSha256('café\n')).toBe(
      '7b49b9e063bd91a4f9252b413261f5557b9c570aa61516989499f64a62dbcdd6'
    );
  });
});
