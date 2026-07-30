import { createRequire } from 'node:module';

import { expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);

it('keeps every Postman dynamic variable generator compatible with the Faker override', () => {
  const dynamicVariables = require('postman-collection/lib/superstring/dynamic-variables') as Record<
    string,
    { generator?: () => unknown }
  >;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const generators = Object.values(dynamicVariables).flatMap(({ generator }) =>
    generator ? [generator] : []
  );

  try {
    expect(generators).toHaveLength(118);
    for (const generate of generators) expect(() => generate()).not.toThrow();
  } finally {
    warning.mockRestore();
  }
});

it('proves the BUNDLED dynamic-variable registry from the committed dist bytes', () => {
  // The dist bundle inlines its own postman-collection copy; the installed-tree
  // assertion above cannot see it. Exercise the shipped bytes directly.
  const dist = require('../dist/index.cjs') as {
    observeBundledDynamicVariables: () => {
      total: number;
      generators: number;
      failures: string[];
    };
  };
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const observed = dist.observeBundledDynamicVariables();
    expect(observed.generators).toBe(118);
    expect(observed.failures).toEqual([]);
  } finally {
    warning.mockRestore();
  }
});
