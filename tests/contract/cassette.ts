/**
 * Record/replay transport for contract tests.
 *
 * A cassette is a diffable JSON file of {key -> ordered responses} captured
 * from a real (or fake) transport. Keys are wire-shape aware: Bifrost /ws/proxy
 * requests key on the proxied {service, method, path} envelope (the URL alone
 * is a single opaque POST), everything else keys on METHOD + URL. Secrets are
 * redacted at record time: request bodies/headers are never stored, response
 * bodies pass through the caller's masker, and mint responses have the token
 * value replaced with a stable placeholder so no live credential can land in
 * a checked-in cassette.
 */

export interface CassetteInteraction {
  key: string;
  status: number;
  body: string;
}

export interface Cassette {
  version: 1;
  recordedAt?: string;
  interactions: CassetteInteraction[];
}

export function createEmptyCassette(): Cassette {
  return { version: 1, interactions: [] };
}

/** Wire-shape-aware match key for a request. */
export function interactionKey(
  url: string,
  method: string,
  requestBody: string | undefined
): string {
  if (/\/ws\/proxy$/.test(url) && requestBody) {
    try {
      const envelope = JSON.parse(requestBody) as {
        service?: string;
        method?: string;
        path?: string;
      };
      const service = String(envelope.service ?? '');
      const proxied = String(envelope.method ?? 'get').toUpperCase();
      // Strip volatile ids (uuids/hashes) is deliberately NOT done: the path is
      // part of the shape contract. Replay FIFO absorbs repeats.
      return `proxy:${service} ${proxied} ${String(envelope.path ?? '')}`;
    } catch {
      // fall through to the plain key
    }
  }
  return `${method.toUpperCase()} ${url}`;
}

const MINT_KEY_PATTERN = /^POST https:\/\/[^ ]+\/service-account-tokens$/;
export const CASSETTE_MINTED_TOKEN = 'cassette-access-token';

function redactResponseBody(key: string, body: string, mask: (value: string) => string): string {
  if (MINT_KEY_PATTERN.test(key)) {
    // Never store a real minted token; replay consistency does not depend on
    // the token value (transport is matched on shape, not auth headers).
    return JSON.stringify({ access_token: CASSETTE_MINTED_TOKEN });
  }
  return mask(body);
}

/**
 * Wrap a transport so every response is captured into the cassette.
 * `mask` redacts secret values from stored response bodies.
 */
export function createRecordingFetch(
  inner: typeof fetch,
  cassette: Cassette,
  mask: (value: string) => string = (value) => value
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    const key = interactionKey(url, method, typeof init?.body === 'string' ? init.body : undefined);
    const response = await inner(input, init);
    const body = await response.clone().text().catch(() => '');
    cassette.interactions.push({
      key,
      status: response.status,
      body: redactResponseBody(key, body, mask)
    });
    cassette.recordedAt = new Date().toISOString();
    return response;
  }) as typeof fetch;
}

/**
 * Replay transport: responses are served per-key in recorded order (FIFO).
 * A key that runs out of recorded responses replays its last one (absorbs
 * poll loops); an unknown key throws with the recorded key inventory so a
 * platform-shape drift is loud and diagnosable.
 */
export function createReplayFetch(cassette: Cassette): typeof fetch {
  const queues = new Map<string, CassetteInteraction[]>();
  for (const interaction of cassette.interactions) {
    const queue = queues.get(interaction.key) ?? [];
    queue.push(interaction);
    queues.set(interaction.key, queue);
  }
  const lastServed = new Map<string, CassetteInteraction>();

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    const key = interactionKey(url, method, typeof init?.body === 'string' ? init.body : undefined);
    const queue = queues.get(key);
    const interaction = queue?.shift() ?? lastServed.get(key);
    if (!interaction) {
      throw new Error(
        `Cassette has no recorded response for "${key}". Recorded keys:\n` +
          [...new Set(cassette.interactions.map((entry) => entry.key))].join('\n')
      );
    }
    lastServed.set(key, interaction);
    return new Response(interaction.body, { status: interaction.status });
  }) as typeof fetch;
}
