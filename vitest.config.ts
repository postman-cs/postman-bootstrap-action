import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Telemetry is fire-and-forget; keep it fully disabled in unit tests so no
    // run ever attempts a network call. Tests that exercise the enabled path
    // pass an explicit env to createTelemetryContext.
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' }
  }
});
