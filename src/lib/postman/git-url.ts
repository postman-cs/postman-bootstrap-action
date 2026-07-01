/**
 * Normalize a git remote URL to a canonical `https://<host>/<owner>/<repo>` form
 * (lowercased, `.git` and trailing slashes stripped, `git@host:owner/repo`
 * rewritten to https). Used for repo-link identity comparisons. Extracted from the
 * retired PMAK assets client so it survives that client's removal.
 */
export function normalizeGitRepoUrl(url: string | null | undefined): string {
  const raw = String(url || '').trim();
  if (!raw) return '';

  // git@<host>:<owner>/<repo>.git  ->  https://<host>/<owner>/<repo>
  const sshMatch = raw.match(/^git@([^:]+):(.+)$/i);
  if (sshMatch?.[1] && sshMatch?.[2]) {
    return normalizeGitRepoUrl(`https://${sshMatch[1]}/${sshMatch[2]}`);
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (parts.length < 2) return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
    return `https://${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  } catch {
    return raw.replace(/\.git$/i, '').replace(/\/+$/g, '').toLowerCase();
  }
}
