// CI-system detection for telemetry. Framework-agnostic: reads only env, never
// shells out, no @actions/core. Covers 11 named providers plus 'other'/'unknown'
// fallbacks; the named set is (GitHub, GitLab, CircleCI, Buildkite, Azure Pipelines, AWS
// CodeBuild, Bitbucket Pipelines, TeamCity, Harness, Jenkins, Concourse); a run
// in any other CI lands in 'other', and a run outside CI lands in 'unknown'.
// runner_kind is reported only where a contractual hosted/self-hosted env flag
// exists (GitHub via RUNNER_ENVIRONMENT, Buildkite via BUILDKITE_COMPUTE_TYPE);
// self-hosted is a product fact for Jenkins, Concourse, and TeamCity; everything
// else stays 'unknown' rather than guessing.

export type CiProvider =
  | 'github'
  | 'gitlab'
  | 'jenkins'
  | 'circleci'
  | 'harness'
  | 'concourse'
  | 'azure'
  | 'codebuild'
  | 'bitbucket'
  | 'teamcity'
  | 'buildkite'
  | 'other'
  | 'unknown';

export type RunnerKind = 'hosted' | 'self-hosted' | 'unknown';

export interface CiContext {
  ciProvider: CiProvider;
  runId?: string;
  runnerKind: RunnerKind;
}

function norm(value?: string): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function detectCiContext(env: NodeJS.ProcessEnv = process.env): CiContext {
  if (norm(env.GITHUB_ACTIONS)) {
    const runnerEnv = norm(env.RUNNER_ENVIRONMENT);
    const runnerKind: RunnerKind =
      runnerEnv === 'github-hosted'
        ? 'hosted'
        : runnerEnv === 'self-hosted'
          ? 'self-hosted'
          : 'unknown';
    return {
      ciProvider: 'github',
      runId: norm(env.GITHUB_RUN_ID),
      runnerKind
    };
  }

  if (norm(env.GITLAB_CI)) {
    return {
      ciProvider: 'gitlab',
      runId: norm(env.CI_PIPELINE_ID) ?? norm(env.CI_PIPELINE_IID),
      runnerKind: 'unknown'
    };
  }

  if (norm(env.CIRCLECI)) {
    return {
      ciProvider: 'circleci',
      runId: norm(env.CIRCLE_WORKFLOW_ID) ?? norm(env.CIRCLE_BUILD_NUM),
      runnerKind: 'unknown'
    };
  }

  // Buildkite: BUILDKITE is vendor-unique (always 'true'). BUILDKITE_COMPUTE_TYPE
  // is a contractual hosted/self-hosted flag ('hosted' on Buildkite Hosted
  // Agents), the one non-GitHub provider with a real runner-kind signal.
  if (norm(env.BUILDKITE)) {
    const computeType = norm(env.BUILDKITE_COMPUTE_TYPE);
    const runnerKind: RunnerKind =
      computeType === 'hosted'
        ? 'hosted'
        : computeType === 'self-hosted'
          ? 'self-hosted'
          : 'unknown';
    return {
      ciProvider: 'buildkite',
      runId: norm(env.BUILDKITE_BUILD_ID) ?? norm(env.BUILDKITE_BUILD_NUMBER),
      runnerKind
    };
  }

  // Azure Pipelines: TF_BUILD is vendor-unique and collision-free; does not set
  // bare CI. No contractual hosted/self-hosted env flag, so runner_kind stays
  // unknown per policy. Run id is BUILD_BUILDID, never BUILD_BUILDNUMBER (a
  // configurable display name).
  if (norm(env.TF_BUILD)) {
    return {
      ciProvider: 'azure',
      runId: norm(env.BUILD_BUILDID),
      runnerKind: 'unknown'
    };
  }

  // AWS CodeBuild: CODEBUILD_BUILD_ID is vendor-unique and is also the run id.
  // Placed after GITHUB_ACTIONS, so a CodeBuild-hosted GitHub Actions runner
  // (which sets both surfaces) counts as github. CodeBuild is AWS-managed
  // compute, but no per-build env flag asserts it, so runner_kind stays unknown
  // per the GitHub-only policy.
  if (norm(env.CODEBUILD_BUILD_ID)) {
    return {
      ciProvider: 'codebuild',
      runId: norm(env.CODEBUILD_BUILD_ID),
      runnerKind: 'unknown'
    };
  }

  // Bitbucket Pipelines: key on BITBUCKET_BUILD_NUMBER (the canonical per-build
  // var), not BITBUCKET_COMMIT. Bitbucket sets bare CI=true, so it must match a
  // BITBUCKET_-namespaced var and never CI.
  if (norm(env.BITBUCKET_BUILD_NUMBER)) {
    return {
      ciProvider: 'bitbucket',
      runId: norm(env.BITBUCKET_BUILD_NUMBER),
      runnerKind: 'unknown'
    };
  }

  // TeamCity: TEAMCITY_VERSION is the vendor-recommended detection signal.
  // BUILD_NUMBER is generic (Jenkins/Bamboo also set it); read it for run id
  // only after TeamCity is confirmed. TeamCity is on-prem/self-hosted by
  // product definition.
  if (norm(env.TEAMCITY_VERSION)) {
    return {
      ciProvider: 'teamcity',
      runId: norm(env.BUILD_NUMBER),
      runnerKind: 'self-hosted'
    };
  }

  // Harness CI: detect on HARNESS_BUILD_ID. Ordered before any future Drone
  // branch precisely because Harness is Drone-derived and also exports DRONE
  // (always 'true') plus DRONE_BUILD_NUMBER, so a Drone branch keyed on DRONE
  // placed before this one would misclassify Harness as drone.
  // HARNESS_EXECUTION_ID is the per-run UUID; HARNESS_BUILD_ID is an incremental
  // counter fallback.
  if (norm(env.HARNESS_BUILD_ID)) {
    return {
      ciProvider: 'harness',
      runId: norm(env.HARNESS_EXECUTION_ID) ?? norm(env.HARNESS_BUILD_ID),
      runnerKind: 'unknown'
    };
  }

  // Jenkins must precede Concourse: both can carry BUILD_ID; Jenkins is gated on
  // JENKINS_URL so it wins cleanly. BUILD_TAG is a secondary fingerprint if
  // BUILD_ID/BUILD_NUMBER are absent.
  if (norm(env.JENKINS_URL)) {
    return {
      ciProvider: 'jenkins',
      runId: norm(env.BUILD_ID) ?? norm(env.BUILD_NUMBER) ?? norm(env.BUILD_TAG),
      runnerKind: 'self-hosted'
    };
  }

  // Concourse is the ONLY branch allowed to read bare BUILD_ID, and only with the
  // BUILD_PIPELINE_NAME co-signal so it cannot swallow Jenkins/GCB runs. Note:
  // Concourse metadata vars reach resource containers only, not task steps, so a
  // task-step run may land in 'unknown' (an expected coverage gap).
  if (norm(env.ATC_EXTERNAL_URL) || (norm(env.BUILD_ID) && norm(env.BUILD_PIPELINE_NAME))) {
    return {
      ciProvider: 'concourse',
      runId: norm(env.BUILD_ID) ?? norm(env.BUILD_NAME),
      runnerKind: 'self-hosted'
    };
  }

  // Generic fallback: in CI but unrecognized vendor (e.g. Tekton, Argo, Google
  // Cloud Build task steps, or any niche system that sets CI). 'other' is
  // distinct from 'unknown' (= not in CI at all).
  if (norm(env.CI)) {
    return { ciProvider: 'other', runnerKind: 'unknown' };
  }

  return { ciProvider: 'unknown', runnerKind: 'unknown' };
}
