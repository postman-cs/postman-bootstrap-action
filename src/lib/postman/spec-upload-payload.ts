import { createHash } from 'node:crypto';

export const SPEC_HUB_RAW_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

export interface RawSpecUploadFile {
  path: string;
  content: string;
}

export function rawSpecUploadPayloadBytes(files: Iterable<RawSpecUploadFile>): number {
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += Buffer.byteLength(file.content, 'utf8');
  }
  return totalBytes;
}

/**
 * Fail before any Spec Hub request when the authored UTF-8 file contents exceed
 * the platform's aggregate 20 MiB definition limit.
 */
export function assertRawSpecUploadPayloadWithinLimit(
  files: Iterable<RawSpecUploadFile>
): number {
  const materialized = [...files];
  const totalBytes = rawSpecUploadPayloadBytes(materialized);
  if (totalBytes > SPEC_HUB_RAW_PAYLOAD_LIMIT_BYTES) {
    throw new Error(
      `CONTRACT_SPEC_HUB_PAYLOAD_TOO_LARGE: Raw Spec Hub upload is ${totalBytes} bytes ` +
        `across ${materialized.length} file(s), exceeding the ${SPEC_HUB_RAW_PAYLOAD_LIMIT_BYTES}-byte ` +
        '(20 MiB) platform limit. Reduce or split the authored specification before retrying.'
    );
  }
  return totalBytes;
}

export function specContentSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
