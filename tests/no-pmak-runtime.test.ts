import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('bootstrap PMAK boundary', () => {
  it('accepts PMAK only as an access-token mint credential', () => {
    const manifest = readFileSync(join(process.cwd(), 'action.yml'), 'utf8');
    const contracts = readFileSync(join(process.cwd(), 'src/contracts.ts'), 'utf8');

    expect(manifest).toContain('postman-api-key:');
    expect(contracts).toContain("'postman-api-key':");
    expect(manifest).toMatch(/postman-api-key:[\s\S]*mint|re-mint/i);
    expect(manifest).toContain('postman-access-token:');
  });

  it('uses PMAK only in the token provider preflight and mint requests', () => {
    const files = sourceFiles(join(process.cwd(), 'src'));
    const violations = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const relative = path.replace(`${process.cwd()}/`, '');
      if (
        relative === 'src/lib/postman/token-provider.ts' ||
        relative === 'src/lib/secrets.ts'
      ) return [];
      return [/['"]x-api-key['"]/i, /service-account-tokens/i, /--with-api-key/i]
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${relative}: ${pattern}`);
    });

    expect(violations).toEqual([]);

    const provider = readFileSync(
      join(process.cwd(), 'src/lib/postman/token-provider.ts'),
      'utf8'
    );
    expect(provider).toContain('/service-account-tokens');
    expect(provider).toContain('/me');
    expect(provider).toMatch(/['"]x-api-key['"]:\s*this\.apiKey/i);
  });

  it('never authenticates the Postman CLI with PMAK', () => {
    const source = sourceFiles(join(process.cwd(), 'src'))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/--with-api-key/i);
  });
});
