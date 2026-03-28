import { normalizeGitRepoUrl } from './postman-assets-client.js';

type WorkspaceCandidate = {
  id: string;
  linkedRepoUrl?: string | null;
};

type ChooseCanonicalWorkspaceArgs = {
  repoWorkspaceId?: string;
  repoUrl: string;
  matchingWorkspaces: WorkspaceCandidate[];
};

type WorkspaceLookupClient = {
  findWorkspacesByName(name: string): Promise<Array<{ id: string; name: string }>>;
  getWorkspaceGitRepoUrl(workspaceId: string, teamId: string, accessToken: string): Promise<string | null>;
};

export type CanonicalWorkspaceSelection =
  | { type: 'existing'; workspaceId: string; source: 'linked_match' | 'repo_var' | 'name_match'; warning?: string }
  | { type: 'create' }
  | { type: 'manual_review'; reason: string };

export function chooseCanonicalWorkspace(args: ChooseCanonicalWorkspaceArgs): CanonicalWorkspaceSelection {
  const repoWorkspaceId = String(args.repoWorkspaceId || '').trim();
  const normalizedRepoUrl = normalizeGitRepoUrl(args.repoUrl);
  const matchingWorkspaces = [...args.matchingWorkspaces].sort((a, b) => a.id.localeCompare(b.id));

  const linkedMatches = matchingWorkspaces.filter((workspace) =>
    normalizeGitRepoUrl(workspace.linkedRepoUrl) === normalizedRepoUrl,
  );

  if (linkedMatches.length === 1) {
    const linked = linkedMatches[0];
    return {
      type: 'existing',
      workspaceId: linked.id,
      source: 'linked_match',
      warning: repoWorkspaceId && repoWorkspaceId !== linked.id
        ? `Replacing repo workspace ${repoWorkspaceId} with canonical GitHub-linked workspace ${linked.id}`
        : undefined,
    };
  }

  if (linkedMatches.length > 1) {
    if (repoWorkspaceId && linkedMatches.some((workspace) => workspace.id === repoWorkspaceId)) {
      return {
        type: 'existing',
        workspaceId: repoWorkspaceId,
        source: 'linked_match',
        warning: `Multiple GitHub-linked workspaces matched ${normalizedRepoUrl}; keeping existing linked repo workspace ${repoWorkspaceId} until manual cleanup.`,
      };
    }
    return {
      type: 'manual_review',
      reason: `Multiple GitHub-linked workspaces matched ${normalizedRepoUrl}: ${linkedMatches.map((workspace) => workspace.id).join(', ')}`,
    };
  }

  if (repoWorkspaceId) {
    const candidate = matchingWorkspaces.find((w) => w.id === repoWorkspaceId);
    if (candidate && candidate.linkedRepoUrl && normalizeGitRepoUrl(candidate.linkedRepoUrl) !== normalizedRepoUrl) {
      return { type: 'create' };
    }
    return {
      type: 'existing',
      workspaceId: repoWorkspaceId,
      source: 'repo_var',
    };
  }

  if (matchingWorkspaces.length > 0) {
    const candidate = matchingWorkspaces[0];
    if (candidate.linkedRepoUrl && normalizeGitRepoUrl(candidate.linkedRepoUrl) !== normalizedRepoUrl) {
      return { type: 'create' };
    }
    return {
      type: 'existing',
      workspaceId: candidate.id,
      source: 'name_match',
    };
  }

  return { type: 'create' };
}

export async function resolveCanonicalWorkspaceSelection(args: {
  postman: WorkspaceLookupClient;
  workspaceName: string;
  repoWorkspaceId?: string;
  repoUrl: string;
  teamId: string;
  accessToken: string;
  warn?: (message: string) => void;
}): Promise<CanonicalWorkspaceSelection> {
  let matchingWorkspaces: Array<{ id: string; name: string; linkedRepoUrl?: string | null }> = [];

  try {
    matchingWorkspaces = await args.postman.findWorkspacesByName(args.workspaceName);
  } catch (error) {
    if (!args.repoWorkspaceId) throw error;
    args.warn?.(`Workspace duplicate check failed; falling back to repo workspace ${args.repoWorkspaceId}: ${error}`);
  }

  if (matchingWorkspaces.length > 0) {
    matchingWorkspaces = await Promise.all(matchingWorkspaces.map(async (workspace) => ({
      ...workspace,
      linkedRepoUrl: await args.postman.getWorkspaceGitRepoUrl(workspace.id, args.teamId, args.accessToken),
    })));
  }

  return chooseCanonicalWorkspace({
    repoWorkspaceId: args.repoWorkspaceId,
    repoUrl: args.repoUrl,
    matchingWorkspaces,
  });
}
