import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface WorkingDirectoryActivation {
  changed: boolean;
  originalRoot: string;
  effectiveRoot: string;
}

function invalidWorkingDirectory(message: string): never {
  throw new Error(`Invalid working-directory: ${message}`);
}

function isOutside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

export function activateWorkingDirectory(
  input: string | undefined,
  baseRoot: string
): WorkingDirectoryActivation {
  const originalRoot = path.resolve(baseRoot);
  const requested = input?.trim() ?? '';
  if (!requested) {
    return { changed: false, originalRoot, effectiveRoot: originalRoot };
  }
  if (path.isAbsolute(requested)) {
    invalidWorkingDirectory('expected a repository-root-relative directory');
  }
  if (requested.split(/[\\/]/u).includes('..')) {
    invalidWorkingDirectory('path traversal is not allowed');
  }

  let originalRealPath: string;
  let effectiveRoot: string;
  try {
    originalRealPath = realpathSync(originalRoot);
    effectiveRoot = realpathSync(path.resolve(originalRealPath, requested));
  } catch {
    invalidWorkingDirectory(`directory does not exist: ${requested}`);
  }
  if (isOutside(originalRealPath, effectiveRoot)) {
    invalidWorkingDirectory('resolved path must stay inside the repository root');
  }
  if (!statSync(effectiveRoot).isDirectory()) {
    invalidWorkingDirectory(`path is not a directory: ${requested}`);
  }

  process.chdir(effectiveRoot);
  process.env.GITHUB_WORKSPACE = effectiveRoot;
  return { changed: true, originalRoot: originalRealPath, effectiveRoot };
}
