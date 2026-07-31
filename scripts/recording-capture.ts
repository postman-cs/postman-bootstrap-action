import {
  cassetteRequest,
  createRecordingFetch,
  type Cassette,
  type CassetteInteraction
} from '@postman-cse/automation-core/cassette';

/**
 * Extra material retained only in gitignored raw recordings so the sanitizer
 * can rebuild request digests after parameterizing volatile request values.
 */
export interface RawCapturedCassetteInteraction extends CassetteInteraction {
  rawRequestBody?: string;
}

type SanitizableCassette = Omit<Cassette, 'interactions'> & {
  interactions: RawCapturedCassetteInteraction[];
};

async function requestBodyText(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
  const body = init?.body;
  if (body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString();
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString();
  }
  if (body !== undefined) {
    throw new TypeError('Cassette transport cannot key a streaming request body');
  }
  if (input instanceof Request && input.body !== null) return input.clone().text();
  return undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

/**
 * Delegate recording to automation-core, then annotate only its newly-recorded
 * interaction with the raw request body needed by the local sanitizer.
 */
export function createSanitizableRecordingFetch(
  inner: typeof fetch,
  cassette: SanitizableCassette,
  mask?: (value: string) => string
): typeof fetch {
  const recording = createRecordingFetch(inner, cassette, mask);

  return async (input, init) => {
    const rawRequestBody = await requestBodyText(input, init);
    const request = cassetteRequest(requestUrl(input), requestMethod(input, init), rawRequestBody);
    const interactionCount = cassette.interactions.length;
    const response = await recording(input, init);

    if (rawRequestBody === undefined) return response;

    const interaction = cassette.interactions
      .slice(interactionCount)
      .reverse()
      .find((candidate) => candidate.key === request.key);
    if (!interaction) {
      throw new Error(`Shared cassette recorder did not record interaction for "${request.key}"`);
    }
    interaction.rawRequestBody = rawRequestBody;
    return response;
  };
}
