export interface RetryDecisionContext {
  attempt: number;
  maxAttempts: number;
}

export interface RetryContext extends RetryDecisionContext {
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  onRetry?: (context: RetryContext) => void | Promise<void>;
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeRetryOptions(options: RetryOptions): Required<RetryOptions> {
  return {
    maxAttempts: Math.max(1, options.maxAttempts ?? 3),
    delayMs: Math.max(0, options.delayMs ?? 2000),
    backoffMultiplier: Math.max(1, options.backoffMultiplier ?? 1),
    maxDelayMs:
      options.maxDelayMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.maxDelayMs),
    onRetry: options.onRetry ?? (async () => undefined),
    shouldRetry: options.shouldRetry ?? (() => true),
    sleep: options.sleep ?? sleep
  };
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const normalized = normalizeRetryOptions(options);
  let nextDelayMs = normalized.delayMs;

  for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const shouldRetry =
        attempt < normalized.maxAttempts &&
        normalized.shouldRetry(error, {
          attempt,
          maxAttempts: normalized.maxAttempts
        });

      if (!shouldRetry) {
        throw error;
      }

      await normalized.onRetry({
        attempt,
        maxAttempts: normalized.maxAttempts,
        delayMs: nextDelayMs,
        error
      });
      await normalized.sleep(nextDelayMs);
      nextDelayMs = Math.min(
        normalized.maxDelayMs,
        Math.round(nextDelayMs * normalized.backoffMultiplier)
      );
    }
  }

  throw new Error('Retry exhausted without returning or throwing');
}

/**
 * Full jitter (AWS, "Exponential Backoff And Jitter"): sleep a uniform random
 * value in [0, min(capMs, baseMs * 2^attempt)). Randomizing the WHOLE interval,
 * not adding a small jitter to a fixed backoff, is what de-synchronizes many CI
 * runners that all fail against the shared gateway at the same instant -- the
 * amplifier that makes a retry storm worse under concurrency. `attempt` is
 * zero-based (0 = first retry). Averaging half the ceiling, full jitter also
 * completes faster than deterministic backoff, which serves speed-to-green.
 */
export function fullJitterDelayMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * Math.max(0, ceiling));
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable. Server-authoritative backpressure
 * beats any client-side heuristic, so honor it verbatim when present.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}
