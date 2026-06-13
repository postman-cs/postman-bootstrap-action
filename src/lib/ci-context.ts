// CI-system detection for telemetry. Framework-agnostic: reads only env, never
// shells out, no @actions/core. Covers the providers these actions actually run
// on (GitHub, GitLab, Jenkins, CircleCI, Harness, Concourse); everything else
// resolves to 'unknown'. runner_kind is only reliable on GitHub; elsewhere it
// stays 'unknown' rather than guessing.

export type CiProvider =
  | 'github'
  | 'gitlab'
  | 'jenkins'
  | 'circleci'
  | 'harness'
  | 'concourse'
  | 'unknown';

export type RunnerKind = 'hosted' | 'self-hosted' | 'unknown';

export interface CiContext {
  ciProvider: CiProvider;
  runId?: string;
  runAttempt?: string;
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
      runAttempt: norm(env.GITHUB_RUN_ATTEMPT),
      runnerKind
    };
  }

  if (norm(env.GITLAB_CI)) {
    return {
      ciProvider: 'gitlab',
      runId: norm(env.CI_PIPELINE_ID),
      runAttempt: norm(env.CI_PIPELINE_IID),
      runnerKind: 'unknown'
    };
  }

  if (norm(env.JENKINS_URL)) {
    return {
      ciProvider: 'jenkins',
      runId: norm(env.BUILD_ID) ?? norm(env.BUILD_NUMBER),
      runAttempt: undefined,
      runnerKind: 'self-hosted'
    };
  }

  if (norm(env.CIRCLECI)) {
    return {
      ciProvider: 'circleci',
      runId: norm(env.CIRCLE_WORKFLOW_ID) ?? norm(env.CIRCLE_BUILD_NUM),
      runAttempt: undefined,
      runnerKind: 'unknown'
    };
  }

  if (norm(env.HARNESS_BUILD_ID)) {
    return {
      ciProvider: 'harness',
      runId: norm(env.HARNESS_BUILD_ID),
      runAttempt: undefined,
      runnerKind: 'unknown'
    };
  }

  if (norm(env.ATC_EXTERNAL_URL) || (norm(env.BUILD_ID) && norm(env.BUILD_PIPELINE_NAME))) {
    return {
      ciProvider: 'concourse',
      runId: norm(env.BUILD_ID),
      runAttempt: norm(env.BUILD_NAME),
      runnerKind: 'self-hosted'
    };
  }

  return { ciProvider: 'unknown', runnerKind: 'unknown' };
}
