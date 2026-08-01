import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, {
    if?: string;
    steps?: Array<{ uses?: string; run?: string }>;
  }>;
};

const readWorkflow = (name: string): Workflow =>
  parse(readFileSync(join(process.cwd(), '.github/workflows', name), 'utf8')) as Workflow;

describe('cassette drift workflow contract', () => {
  const smoke = readWorkflow('contract-smoke.yml');
  const drift = readWorkflow('cassette-drift.yml');

  it('runs only after a successful scheduled Contract Smoke Tests completion or manual dispatch', () => {
    expect(smoke.name).toBe('Contract Smoke Tests');
    expect(smoke.on?.schedule).toBeDefined();

    expect(drift.on?.workflow_run).toEqual({
      workflows: ['Contract Smoke Tests'],
      types: ['completed']
    });
    expect(drift.on?.workflow_dispatch).toEqual({});
    expect(drift.on?.schedule).toBeUndefined();
    expect(drift.on?.pull_request).toBeUndefined();

    expect(drift.jobs?.preflight?.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(drift.jobs?.preflight?.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(drift.jobs?.preflight?.if).toContain("github.event.workflow_run.event == 'schedule'");
  });

  it('is report-only and preserves scheduled skip versus manual credential errors', () => {
    expect(drift.permissions).toEqual({ contents: 'read' });

    const preflight = drift.jobs?.preflight;
    const credentialStep = preflight?.steps?.find((step) => step.run?.includes('SMOKE_NON_ORG_API_KEY'));
    expect(credentialStep?.run).toContain('[ "$AUTOMATED_NIGHTLY" = "true" ]');
    expect(credentialStep?.run).toContain('::notice::Skipping cassette drift check');
    expect(credentialStep?.run).toContain('::error::Cannot run cassette drift check');

    const steps = Object.values(drift.jobs ?? {}).flatMap((job) => job.steps ?? []);
    expect(steps.some((step) => /upload-artifact|create-pull-request/i.test(step.uses ?? ''))).toBe(false);
    expect(steps.some((step) => /\b(?:git\s+(?:commit|push)|gh\s+pr)\b/i.test(step.run ?? ''))).toBe(false);
  });
});
