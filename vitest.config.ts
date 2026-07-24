import { defineConfig } from 'vitest/config';

// Hosted CI runners (Windows especially) run this suite under heavy contention:
// ~1600 tests, several of them driving full runAction flows that take 15-20s
// there versus tens of milliseconds locally. Those known-slow tests already
// carry explicit 20-30s timeouts, so the only casualties are ordinary tests
// left on vitest's 5000ms default, and which ones lose the race changes from
// run to run. Give CI headroom rather than annotating an unbounded set of
// individual tests; local runs keep the strict default so a real slowdown
// still surfaces as a failure instead of hiding behind a generous budget.
const CI_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    ...(process.env.CI
      ? { testTimeout: CI_TIMEOUT_MS, hookTimeout: CI_TIMEOUT_MS }
      : {}),
    // Telemetry is fire-and-forget; keep it fully disabled in unit tests so no
    // run ever attempts a network call. Tests that exercise the enabled path
    // pass an explicit env to createTelemetryContext.
    env: { POSTMAN_ACTIONS_TELEMETRY: 'off' }
  }
});
