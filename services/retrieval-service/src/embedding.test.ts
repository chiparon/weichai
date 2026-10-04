import { afterEach, describe, expect, it, vi } from 'vitest';
import { HashEmbeddingProvider, OpenAiCompatibleEmbeddingProvider } from './embedding.js';

afterEach(() => vi.restoreAllMocks());

function dot(left: number[], right: number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

describe('HashEmbeddingProvider', () => {
  it('creates deterministic, normalized vectors with useful lexical similarity', async () => {
    const provider = new HashEmbeddingProvider(64);
    const [first, repeated, related, unrelated] = await provider.embed([
      'async ttl cache with stale fallback',
      'async ttl cache with stale fallback',
      'ttl cache and request fallback',
      'database schema migration ledger',
    ]);

    expect(first).toHaveLength(64);
    expect(first).toEqual(repeated);
    expect(Math.sqrt(dot(first!, first!))).toBeCloseTo(1, 6);
    expect(dot(first!, related!)).toBeGreaterThan(dot(first!, unrelated!));
  });
});

describe('OpenAiCompatibleEmbeddingProvider', () => {
  it('keeps a request injection in the legacy fifth constructor argument', async () => {
    let requestCount = 0;
    let requestBody: unknown;
    const request: typeof globalThis.fetch = async (_input, init) => {
      requestCount += 1;
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] },
          ],
        }),
      );
    };
    const provider = new OpenAiCompatibleEmbeddingProvider(
      2,
      'https://example.test/embeddings',
      'test-key',
      'test-model',
      request,
    );

    await expect(provider.embed(['first', 'second'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(requestCount).toBe(1);
    expect(requestBody).toMatchObject({
      input: ['first', 'second'],
      model: 'test-model',
      dimensions: 2,
      encoding_format: 'float',
    });
  });

  it('allows models without a dimensions parameter to opt out explicitly', async () => {
    let requestBody: unknown;
    const request: typeof globalThis.fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    };
    const provider = new OpenAiCompatibleEmbeddingProvider(
      2,
      'https://example.test/embeddings',
      'test-key',
      'test-model',
      { request, maxRetries: 0, baseDelayMs: 0, supportsDimensions: false },
    );

    await expect(provider.embed(['first'])).resolves.toEqual([[1, 0]]);
    expect(requestBody).not.toHaveProperty('dimensions');
  });

  it('retries transient HTTP responses and timeout errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let requestCount = 0;
    const request: typeof globalThis.fetch = async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
        });
      }
      if (requestCount === 2) {
        throw new DOMException('request timed out', 'TimeoutError');
      }
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    };
    const provider = new OpenAiCompatibleEmbeddingProvider(
      2,
      'https://example.test/embeddings',
      'test-key',
      'test-model',
      request,
      30_000,
      2,
      0,
    );

    await expect(provider.embed(['first'])).resolves.toEqual([[1, 0]]);
    expect(requestCount).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('rejects duplicate indexes and non-finite vector values', async () => {
    const request = async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: [1, 0] },
            { index: 0, embedding: [1, null] },
          ],
        }),
      );
    const provider = new OpenAiCompatibleEmbeddingProvider(
      2,
      'https://example.test/embeddings',
      'test-key',
      'test-model',
      request,
    );

    await expect(provider.embed(['first', 'second'])).rejects.toThrow(
      'malformed vector entries',
    );
  });

  it('cancels a retry backoff promptly without making another request', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(console, 'warn').mockImplementation(() => started());
    const request = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const provider = new OpenAiCompatibleEmbeddingProvider(2, 'https://example.test/embeddings', 'test-key', 'test-model', {
      request, maxRetries: 2, baseDelayMs: 60_000,
    });
    const cancellation = new Error('indexing cancelled');
    const result = provider.embed(['first'], controller.signal).catch(error => error);
    await waiting;
    controller.abort(cancellation);
    let timeout!: ReturnType<typeof setTimeout>;
    const deadline = new Promise(resolve => { timeout = setTimeout(() => resolve('still waiting'), 250); });
    try {
      expect(await Promise.race([result, deadline])).toBe(cancellation);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { clearTimeout(timeout); }
  });

  it('does not retry when the caller cancels an active request', async () => {
    const controller = new AbortController();
    const cancellation = new Error('indexing cancelled');
    const request = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
      controller.abort(cancellation);
      throw new DOMException('request aborted', 'AbortError');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const provider = new OpenAiCompatibleEmbeddingProvider(2, 'https://example.test/embeddings', 'test-key', 'test-model', {
      request, maxRetries: 2, baseDelayMs: 0,
    });
    await expect(provider.embed(['first'], controller.signal)).rejects.toBe(cancellation);
    expect(request).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
