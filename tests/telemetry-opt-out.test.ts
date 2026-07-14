import { describe, expect, it, vi } from 'vitest';
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

describe('telemetry opt-out', () => {
  it.each([
    { POSTMAN_ACTIONS_TELEMETRY: 'off' },
    { DO_NOT_TRACK: '1' }
  ])('suppresses transport after team id + emitCompletion when %j', (env) => {
    const transport = vi.fn();
    const telemetry = createTelemetryContext({
      action: 'postman-bootstrap-action',
      env,
      transport: transport as unknown as typeof fetch
    });

    telemetry.setTeamId('10490519');
    telemetry.emitCompletion('success');

    expect(transport).not.toHaveBeenCalled();
  });
});
