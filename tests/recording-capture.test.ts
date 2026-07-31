import { cassetteRequest, createEmptyCassette, createRecordingFetch } from '@postman-cse/automation-core/cassette';
import { describe, expect, it, vi } from 'vitest';

import { createSanitizableRecordingFetch, type RawCapturedCassetteInteraction } from '../scripts/recording-capture.js';

vi.mock('@postman-cse/automation-core/cassette', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@postman-cse/automation-core/cassette')>();
  return { ...actual, createRecordingFetch: vi.fn(actual.createRecordingFetch) };
});

function rawCassette() {
  return createEmptyCassette() as Omit<ReturnType<typeof createEmptyCassette>, 'interactions'> & {
    interactions: RawCapturedCassetteInteraction[];
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('createSanitizableRecordingFetch', () => {
  it('delegates recording to the shared recorder and captures string request bodies', async () => {
    const cassette = rawCassette();
    const recording = createSanitizableRecordingFetch(
      vi.fn(async () => new Response('{"ok":true}', { status: 201 })),
      cassette
    );

    await expect(recording('https://example.test/resources', { method: 'POST', body: '{"id":"live"}' })).resolves.toMatchObject({ status: 201 });

    expect(createRecordingFetch).toHaveBeenCalledOnce();
    expect(cassette.interactions).toEqual([
      expect.objectContaining({
        ...cassetteRequest('https://example.test/resources', 'POST', '{"id":"live"}'),
        rawRequestBody: '{"id":"live"}',
        status: 201,
        body: '{"ok":true}'
      })
    ]);
  });

  it('captures Request bodies through a clone without consuming the request', async () => {
    const cassette = rawCassette();
    const request = new Request('https://example.test/resources', {
      method: 'POST',
      body: '{"id":"request"}'
    });
    const inner = vi.fn(async (input: RequestInfo | URL) => {
      expect(await (input as Request).clone().text()).toBe('{"id":"request"}');
      return new Response('ok');
    });

    await createSanitizableRecordingFetch(inner, cassette)(request);

    expect(cassette.interactions[0]?.rawRequestBody).toBe('{"id":"request"}');
    expect(await request.text()).toBe('{"id":"request"}');
  });

  it('associates concurrent differently keyed requests with their own completed interaction', async () => {
    const cassette = rawCassette();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const inner = vi.fn((input: RequestInfo | URL) =>
      String(input).endsWith('/first') ? first.promise : second.promise
    );
    const recording = createSanitizableRecordingFetch(inner, cassette);

    const firstRequest = recording('https://example.test/first', { method: 'POST', body: '{"id":"first"}' });
    const secondRequest = recording('https://example.test/second', { method: 'POST', body: '{"id":"second"}' });
    second.resolve(new Response('second'));
    await secondRequest;
    first.resolve(new Response('first'));
    await firstRequest;

    expect(cassette.interactions).toEqual([
      expect.objectContaining({
        key: cassetteRequest('https://example.test/second', 'POST', '{"id":"second"}').key,
        rawRequestBody: '{"id":"second"}'
      }),
      expect.objectContaining({
        key: cassetteRequest('https://example.test/first', 'POST', '{"id":"first"}').key,
        rawRequestBody: '{"id":"first"}'
      })
    ]);
  });

  it('associates concurrent same-key requests with the interaction recorded by each completion', async () => {
    const cassette = rawCassette();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const inner = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const recording = createSanitizableRecordingFetch(inner, cassette);

    const firstRequest = recording('https://example.test/resources', { method: 'POST', body: '{"id":"same"}' });
    const secondRequest = recording('https://example.test/resources', { method: 'POST', body: '{"id":"same"}' });
    second.resolve(new Response('second'));
    await secondRequest;
    first.resolve(new Response('first'));
    await firstRequest;

    expect(cassette.interactions).toEqual([
      expect.objectContaining({ body: 'second', rawRequestBody: '{"id":"same"}' }),
      expect.objectContaining({ body: 'first', rawRequestBody: '{"id":"same"}' })
    ]);
  });

  it('omits raw metadata for requests without bodies', async () => {
    const cassette = rawCassette();

    await createSanitizableRecordingFetch(async () => new Response('ok'), cassette)(
      'https://example.test/resources'
    );

    expect(cassette.interactions[0]).not.toHaveProperty('rawRequestBody');
  });

  it('fails closed before recording unsupported streaming bodies', async () => {
    const cassette = rawCassette();
    const inner = vi.fn(async () => new Response('unexpected'));
    const recording = createSanitizableRecordingFetch(inner, cassette);
    const stream = new ReadableStream({ start(controller) { controller.enqueue('stream'); controller.close(); } });

    await expect(recording('https://example.test/resources', { method: 'POST', body: stream })).rejects.toThrow(
      'Cassette transport cannot key a streaming request body'
    );
    expect(inner).not.toHaveBeenCalled();
    expect(cassette.interactions).toEqual([]);
  });
});
