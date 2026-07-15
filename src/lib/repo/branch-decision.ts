/**
 * Branch identity resolution + BranchDecision contract (branch-aware sync).
 *
 * One immutable decision, resolved from provider CI env BEFORE any credential
 * is validated or minted, classifies every run into an asset tier:
 *
 *   canonical  exactly one canonical branch; sole writer of canonical assets,
 *              repo link, insights, and tracked state (.postman/resources.yaml)
 *   channel    long-lived promotion branches (develop=DEV, staging=STAGE,
 *              release/* -> RC); prefix-named parallel asset sets
 *   preview    any other branch under branch-strategy: preview; suffix-named,
 *              TTL-governed asset sets
 *   gated      any other branch under branch-strategy: publish-gate;
 *              credential-free static validation only, zero writes
 *   legacy     branch-blind pre-v2 behavior (default under v1)
 *
 * Identity-ref resolution table (provider x trigger):
 *
 *   provider   push / branch build          PR / MR build
 *   github     GITHUB_REF_NAME              GITHUB_HEAD_REF (GITHUB_REF_NAME is "N/merge")
 *   gitlab     CI_COMMIT_BRANCH             CI_MERGE_REQUEST_SOURCE_BRANCH_NAME
 *   bitbucket  BITBUCKET_BRANCH             BITBUCKET_BRANCH (source branch; BITBUCKET_PR_ID marks PR)
 *   azure      BUILD_SOURCEBRANCH stripped  SYSTEM_PULLREQUEST_SOURCEBRANCH stripped
 *              (BUILD_SOURCEBRANCHNAME is the LAST path segment only -- never use it)
 *
 * Default-branch resolution never silently guesses:
 *   1. explicit canonical-branch / default-branch input
 *   2. GitLab CI_DEFAULT_BRANCH; GitHub default_branch from the event payload
 *      at GITHUB_EVENT_PATH (offline, present in every run)
 *   3. otherwise unresolved -> the caller MUST fail loud under any
 *      non-legacy strategy (CONTRACT_DEFAULT_BRANCH_UNRESOLVED).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type BranchTier = 'canonical' | 'channel' | 'preview' | 'gated' | 'legacy';
export type BranchStrategy = 'legacy' | 'publish-gate' | 'preview';
export type RefKind = 'default-branch' | 'branch' | 'tag' | 'unknown';
export type IdentityProvider = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'unknown';

export interface BranchIdentity {
  provider: IdentityProvider;
  /** Resolved head branch name (source branch in PR context). Undefined for tags/detached. */
  headBranch?: string;
  /** Raw ref as the provider reported it (before refs/heads strip). */
  rawRef?: string;
  /** Resolved default branch, when the provider exposes it offline. */
  defaultBranch?: string;
  refKind: RefKind;
  isPrContext: boolean;
  /** True when the PR head repo differs from the base repo. Preview-ineligible. */
  isForkPr: boolean;
  headSha?: string;
}

export interface ChannelRule {
  /** Branch name or glob (trailing `*` only, e.g. `release/*`). */
  pattern: string;
  /** Uppercase channel code used as the naming prefix, e.g. DEV, STAGE, RC. */
  code: string;
}

export interface BranchDecision {
  tier: BranchTier;
  strategy: BranchStrategy;
  identity: BranchIdentity;
  canonicalBranch?: string;
  /** Set when tier === 'channel'. */
  channel?: ChannelRule;
  /** Human-readable one-line reason for the classification. */
  reason: string;
}

export class ContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'ContractError';
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripRefPrefix(ref: string | undefined): { name?: string; kind: RefKind } {
  const raw = clean(ref);
  if (!raw) {
    return { kind: 'unknown' };
  }
  if (raw.startsWith('refs/heads/')) {
    return { name: raw.slice('refs/heads/'.length), kind: 'branch' };
  }
  if (raw.startsWith('refs/tags/')) {
    return { name: raw.slice('refs/tags/'.length), kind: 'tag' };
  }
  if (raw.startsWith('refs/pull/') || raw.startsWith('refs/merge')) {
    return { kind: 'unknown' };
  }
  return { name: raw, kind: 'branch' };
}

function detectProvider(env: NodeJS.ProcessEnv): IdentityProvider {
  if (clean(env.GITHUB_ACTIONS) || clean(env.GITHUB_REPOSITORY)) return 'github';
  if (clean(env.GITLAB_CI) || clean(env.CI_PROJECT_PATH)) return 'gitlab';
  if (clean(env.BITBUCKET_REPO_SLUG) || clean(env.BITBUCKET_BRANCH)) return 'bitbucket';
  if (clean(env.TF_BUILD) || clean(env.BUILD_REPOSITORY_URI)) return 'azure-devops';
  return 'unknown';
}

interface GithubEventPayload {
  repository?: { default_branch?: string; full_name?: string };
  pull_request?: {
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    base?: { repo?: { full_name?: string } };
  };
}

function readGithubEvent(env: NodeJS.ProcessEnv): GithubEventPayload | undefined {
  const path = clean(env.GITHUB_EVENT_PATH);
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GithubEventPayload;
  } catch {
    return undefined;
  }
}

/**
 * Resolve branch identity from provider CI env. Pure given (env, explicit
 * overrides); performs no network I/O (GitHub event payload is a local file).
 */
export function resolveBranchIdentity(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { defaultBranch?: string } = {}
): BranchIdentity {
  const provider = detectProvider(env);
  const explicitDefault = clean(overrides.defaultBranch);

  let headBranch: string | undefined;
  let rawRef: string | undefined;
  let refKind: RefKind;
  let isPrContext = false;
  let isForkPr = false;
  let defaultBranch: string | undefined = explicitDefault;
  let headSha: string | undefined;

  switch (provider) {
    case 'github': {
      const event = readGithubEvent(env);
      headSha = clean(env.GITHUB_SHA);
      defaultBranch ??= clean(event?.repository?.default_branch);
      const headRef = clean(env.GITHUB_HEAD_REF);
      if (headRef) {
        // pull_request context: GITHUB_REF_NAME is "<N>/merge", never the branch.
        isPrContext = true;
        headBranch = headRef;
        rawRef = clean(env.GITHUB_REF) ?? headRef;
        refKind = 'branch';
        const headRepo = event?.pull_request?.head?.repo?.full_name;
        const baseRepo = event?.pull_request?.base?.repo?.full_name ?? event?.repository?.full_name;
        isForkPr = Boolean(headRepo && baseRepo && headRepo !== baseRepo);
        headSha = clean(event?.pull_request?.head?.sha) ?? headSha;
      } else {
        rawRef = clean(env.GITHUB_REF) ?? clean(env.GITHUB_REF_NAME);
        const parsed = stripRefPrefix(rawRef);
        headBranch = parsed.kind === 'branch' ? parsed.name : undefined;
        refKind = parsed.kind;
      }
      break;
    }
    case 'gitlab': {
      headSha = clean(env.CI_COMMIT_SHA);
      defaultBranch ??= clean(env.CI_DEFAULT_BRANCH);
      const mrSource = clean(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME);
      if (mrSource) {
        isPrContext = true;
        headBranch = mrSource;
        rawRef = mrSource;
        refKind = 'branch';
        const sourceProject = clean(env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID);
        const targetProject = clean(env.CI_MERGE_REQUEST_PROJECT_ID);
        isForkPr = Boolean(sourceProject && targetProject && sourceProject !== targetProject);
      } else if (clean(env.CI_COMMIT_TAG)) {
        rawRef = clean(env.CI_COMMIT_TAG);
        refKind = 'tag';
      } else {
        headBranch = clean(env.CI_COMMIT_BRANCH) ?? clean(env.CI_COMMIT_REF_NAME);
        rawRef = headBranch;
        refKind = headBranch ? 'branch' : 'unknown';
      }
      break;
    }
    case 'bitbucket': {
      headSha = clean(env.BITBUCKET_COMMIT);
      // No default-branch env var exists on Bitbucket Pipelines.
      if (clean(env.BITBUCKET_TAG)) {
        rawRef = clean(env.BITBUCKET_TAG);
        refKind = 'tag';
      } else {
        headBranch = clean(env.BITBUCKET_BRANCH);
        rawRef = headBranch;
        refKind = headBranch ? 'branch' : 'unknown';
        isPrContext = Boolean(clean(env.BITBUCKET_PR_ID));
        // Fork PRs in Bitbucket Pipelines run in the fork's own pipeline; the
        // destination workspace's pipeline only sees same-repo sources.
      }
      break;
    }
    case 'azure-devops': {
      headSha = clean(env.BUILD_SOURCEVERSION);
      // No default-branch variable exists on Azure DevOps.
      const prSource = clean(env.SYSTEM_PULLREQUEST_SOURCEBRANCH);
      if (prSource) {
        isPrContext = true;
        const parsed = stripRefPrefix(prSource);
        headBranch = parsed.kind === 'branch' ? parsed.name : undefined;
        rawRef = prSource;
        refKind = parsed.kind;
        const forkFlag = clean(env.SYSTEM_PULLREQUEST_ISFORK);
        isForkPr = forkFlag?.toLowerCase() === 'true';
      } else {
        // BUILD_SOURCEBRANCHNAME is the LAST path segment only (feature/x -> x).
        // Always resolve from the full BUILD_SOURCEBRANCH.
        rawRef = clean(env.BUILD_SOURCEBRANCH);
        const parsed = stripRefPrefix(rawRef);
        headBranch = parsed.kind === 'branch' ? parsed.name : undefined;
        refKind = parsed.kind;
      }
      break;
    }
    default: {
      refKind = 'unknown';
    }
  }

  if (refKind === 'branch' && headBranch && defaultBranch && headBranch === defaultBranch) {
    refKind = 'default-branch';
  }

  return { provider, headBranch, rawRef, defaultBranch, refKind, isPrContext, isForkPr, headSha };
}

/** Parse the `channels` input: `develop=DEV, staging=STAGE, release/*=RC`. */
export function parseChannelRules(input: string | undefined): ChannelRule[] {
  const raw = clean(input);
  if (!raw) return [];
  const rules: ChannelRule[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new ContractError(
        'CONTRACT_CHANNELS_INPUT_INVALID',
        `channels entry "${entry}" must be <branch-or-glob>=<CODE>`
      );
    }
    const pattern = entry.slice(0, eq).trim();
    const code = entry.slice(eq + 1).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_-]{0,15}$/.test(code)) {
      throw new ContractError(
        'CONTRACT_CHANNELS_INPUT_INVALID',
        `channel code "${code}" must be 1-16 chars, A-Z 0-9 _ -, starting with a letter`
      );
    }
    rules.push({ pattern, code });
  }
  return rules;
}

function matchChannel(branch: string, rules: ChannelRule[]): ChannelRule | undefined {
  for (const rule of rules) {
    if (rule.pattern.endsWith('*')) {
      const prefix = rule.pattern.slice(0, -1);
      if (branch.startsWith(prefix)) return rule;
    } else if (branch === rule.pattern) {
      return rule;
    }
  }
  return undefined;
}

export interface ResolveDecisionOptions {
  strategy: BranchStrategy;
  identity: BranchIdentity;
  /** Explicit canonical branch input; falls back to identity.defaultBranch. */
  canonicalBranch?: string;
  channels?: ChannelRule[];
}

/**
 * Classify the run. Throws CONTRACT_DEFAULT_BRANCH_UNRESOLVED when a
 * non-legacy strategy cannot resolve the canonical branch.
 */
export function resolveBranchDecision(options: ResolveDecisionOptions): BranchDecision {
  const { strategy, identity } = options;
  const channels = options.channels ?? [];

  if (strategy === 'legacy') {
    return {
      tier: 'legacy', strategy, identity,
      canonicalBranch: clean(options.canonicalBranch) ?? identity.defaultBranch,
      reason: 'branch-strategy legacy: branch-blind pre-v2 behavior'
    };
  }

  const canonicalBranch = clean(options.canonicalBranch) ?? identity.defaultBranch;
  if (!canonicalBranch) {
    throw new ContractError(
      'CONTRACT_DEFAULT_BRANCH_UNRESOLVED',
      `cannot resolve the canonical branch on ${identity.provider} (no explicit canonical-branch input and the provider exposes no default-branch variable). Set the canonical-branch input.`
    );
  }

  if (identity.refKind === 'tag' || identity.refKind === 'unknown' || !identity.headBranch) {
    return {
      tier: 'gated', strategy, identity, canonicalBranch,
      reason: `ref kind ${identity.refKind}: never canonical/preview-eligible; no-op with annotation`
    };
  }

  if (identity.headBranch === canonicalBranch) {
    return {
      tier: 'canonical', strategy, identity, canonicalBranch,
      reason: `head branch equals canonical branch ${canonicalBranch}`
    };
  }

  const channel = matchChannel(identity.headBranch, channels);
  if (channel) {
    return {
      tier: 'channel', strategy, identity, canonicalBranch, channel,
      reason: `branch ${identity.headBranch} matches channel ${channel.pattern}=${channel.code}`
    };
  }

  if (strategy === 'preview') {
    if (identity.isForkPr) {
      return {
        tier: 'gated', strategy, identity, canonicalBranch,
        reason: 'fork PR: preview-ineligible (same-repo gate), gated instead'
      };
    }
    return {
      tier: 'preview', strategy, identity, canonicalBranch,
      reason: `branch ${identity.headBranch} under branch-strategy preview`
    };
  }

  return {
    tier: 'gated', strategy, identity, canonicalBranch,
    reason: `branch ${identity.headBranch} under branch-strategy publish-gate`
  };
}

export const BRANCH_DECISION_ENV = 'POSTMAN_BRANCH_DECISION';

/** Serialize for hand-off between actions (env/step output). */
export function serializeBranchDecision(decision: BranchDecision): string {
  return JSON.stringify(decision);
}

export function parseBranchDecision(raw: string | undefined): BranchDecision | undefined {
  const value = clean(raw);
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ContractError('CONTRACT_BRANCH_DECISION_INVALID', 'POSTMAN_BRANCH_DECISION is not valid JSON');
  }
  const candidate = parsed as Partial<BranchDecision>;
  const tiers: BranchTier[] = ['canonical', 'channel', 'preview', 'gated', 'legacy'];
  if (!candidate || typeof candidate !== 'object' || !tiers.includes(candidate.tier as BranchTier) || !candidate.identity) {
    throw new ContractError('CONTRACT_BRANCH_DECISION_INVALID', 'POSTMAN_BRANCH_DECISION does not carry a valid BranchDecision');
  }
  return candidate as BranchDecision;
}

/**
 * Resolve the effective decision: an inherited serialized decision wins
 * (single decide step per run); otherwise resolve locally.
 */
export function resolveEffectiveBranchDecision(
  options: ResolveDecisionOptions,
  env: NodeJS.ProcessEnv = process.env
): BranchDecision {
  const inherited = parseBranchDecision(env[BRANCH_DECISION_ENV]);
  if (inherited) return inherited;
  return resolveBranchDecision(options);
}

/** Max human slug length in preview suffixes (before the lossy hash). */
export const PREVIEW_SLUG_MAX = 30;

export interface BranchSlug {
  /** Final suffix token, e.g. `feature-payments` or `feature-payments-serv-1a2b3c`. */
  suffix: string;
  slug: string;
  /** True when sanitization or truncation lost information (hash appended). */
  lossy: boolean;
}

/**
 * Sanitize a branch name into a collision-safe suffix token. A 6-char sha256
 * hash of the FULL raw ref is appended whenever sanitization or truncation is
 * lossy -- `/`->`-` alone already collides `a/b` with `a-b`.
 */
export function buildBranchSlug(rawBranch: string): BranchSlug {
  const sanitized = rawBranch
    .replace(/^refs\/heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  const truncated = sanitized.slice(0, PREVIEW_SLUG_MAX);
  const lossy = truncated !== rawBranch.replace(/^refs\/heads\//, '');
  if (!lossy) {
    return { suffix: truncated, slug: truncated, lossy };
  }
  const hash = createHash('sha256').update(rawBranch).digest('hex').slice(0, 6);
  return { suffix: `${truncated}-${hash}`, slug: truncated, lossy };
}

/** Preview asset name: `<name> @<slug>[-<hash6>]`. */
export function previewAssetName(baseName: string, rawBranch: string): string {
  return `${baseName} @${buildBranchSlug(rawBranch).suffix}`;
}

/** Channel asset name: `[CODE] <name>`. */
export function channelAssetName(baseName: string, code: string): string {
  return `[${code}] ${baseName}`;
}

export const MARKER_KEY = 'x-pm-onboarding';

export interface AssetMarker {
  repo: string;
  rawBranch: string;
  sanitizedBranch: string;
  headRepoId?: string;
  prNumber?: number;
  role: 'preview' | 'channel';
  headSha?: string;
  createdAt: string;
  lastSyncedAt: string;
  expiresAt?: string;
  run?: string;
  retirementDetectedAt?: string;
  retirementReason?: 'branch-deleted' | 'mapping-removed';
  deleteAfter?: string;
}

/** Render the marker as a description-embedded JSON line. */
export function renderAssetMarker(marker: AssetMarker): string {
  return `${MARKER_KEY}: ${JSON.stringify(marker)}`;
}

/** Extract a marker from an asset description. Absent/malformed -> undefined (stranger). */
export function parseAssetMarker(description: string | undefined): AssetMarker | undefined {
  if (!description) return undefined;
  const index = description.indexOf(`${MARKER_KEY}:`);
  if (index === -1) return undefined;
  const jsonStart = description.indexOf('{', index);
  if (jsonStart === -1) return undefined;
  // Balance braces to find the JSON object end (descriptions may carry trailing prose).
  let depth = 0;
  for (let i = jsonStart; i < description.length; i += 1) {
    const ch = description[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(description.slice(jsonStart, i + 1)) as AssetMarker;
          if (parsed && typeof parsed === 'object' && parsed.repo && parsed.role) return parsed;
        } catch {
          return undefined;
        }
        return undefined;
      }
    }
  }
  return undefined;
}
