import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Resolve this action's version at runtime from the packaged package.json.
// Deliberately not baked into the bundle via esbuild --define so the committed
// dist stays a pure function of source and does not churn on every version bump.
export function resolveActionVersion(): string {
  try {
    const raw = readFileSync(join(__dirname, '..', 'package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
