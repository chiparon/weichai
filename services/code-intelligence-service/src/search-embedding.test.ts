import { afterEach, describe, expect, it, vi } from 'vitest';
import { HashSearchEmbeddingProvider, ModelSearchEmbeddingProvider } from './search-embedding.js';

afterEach(() => vi.restoreAllMocks());

describe('model embedding adapter', () => {
  it('pins preprocessing and identity against later configuration mutations', async () => {
    const requests: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.input);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
    const config = { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model', documentPrefix: 'passage: ' };
    const provider = new ModelSearchEmbeddingProvider(2, config);
    const identity = provider.identity;
    config.documentPrefix = 'changed: ';
    await provider.embed(['same']);
    expect(requests).toEqual([['passage: same']]);
    expect(provider.identity).toBe(identity);
    expect(new ModelSearchEmbeddingProvider(2, config).identity).not.toBe(identity);
  });

  /**
   * The store reuses a stored vector whenever the model input repeats, keyed by
   * this identity. A device or precision change alters the vector, so it must alter
   * the identity too — otherwise an index keeps vectors from the other provider.
   */
  it('treats the inference variant as part of the model identity', () => {
    const config = { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' };
    const cpu = new ModelSearchEmbeddingProvider(2, { ...config, variant: 'cpu-q8' });
    const gpu = new ModelSearchEmbeddingProvider(2, { ...config, variant: 'dml-fp16' });
    const unspecified = new ModelSearchEmbeddingProvider(2, config);
    expect(gpu.identity).not.toBe(cpu.identity);
    expect(unspecified.identity).not.toBe(cpu.identity);
    expect(new ModelSearchEmbeddingProvider(2, { ...config, variant: 'cpu-q8' }).identity).toBe(cpu.identity);
  });

  it('deduplicates content, separates query/document instructions and protects cached vectors', async () => {
    const requests: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body.input);
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model',
      queryPrefix: 'query: ', documentPrefix: 'passage: ' });
    const first = await provider.embed(['same', 'same']);
    first[0]![0] = 99;
    expect(await provider.embed(['same'])).toEqual([[1, 0]]);
    expect(await provider.embedQuery('same')).toEqual([1, 0]);
    expect(requests).toEqual([['passage: same'], ['query: same']]);
    await expect(provider.embed(['same'], AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(requests).toHaveLength(2);
  });

  it('coalesces concurrent query channels within one request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    const signal = new AbortController().signal;
    const vectors = await Promise.all([1, 2, 3].map(() => provider.embedQuery('same request', signal)));
    expect(fetch).toHaveBeenCalledTimes(1);
    vectors[0]![0] = 99;
    expect(vectors[1]).toEqual([1, 0]);
  });

  it('limits batch size and skips empty requests', async () => {
    const sizes: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); sizes.push(body.input.length);
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [0, 1] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    expect(await provider.embed([])).toEqual([]);
    expect(await provider.embed(Array.from({ length: 35 }, (_, i) => String(i)))).toHaveLength(35);
    expect(sizes).toEqual([16, 16, 3]);
  });

  it('rejects zero vectors without caching a successful result', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0, 0] }] })));
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    await expect(provider.embed(['bad'])).rejects.toThrow('zero vector');
    await expect(provider.embed(['bad'])).rejects.toThrow('zero vector');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  /**
   * The server needs about 0.2ms per character and the previous 16-item batch with
   * an 8s timeout turned one slow request into a failed revision, so a request is
   * bounded by payload as well as by item count.
   */
  it('bounds each request by characters as well as by item count', async () => {
    const batches: Array<{ items: number; chars: number }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      batches.push({ items: body.input.length, chars: body.input.reduce((sum: number, text: string) => sum + text.length, 0) });
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    const documents = Array.from({ length: 35 }, (_, index) => `${index}`.padEnd(10_000, 'x'));
    expect(await provider.embed(documents)).toHaveLength(35);
    expect(batches.every((batch) => batch.items <= 16)).toBe(true);
    expect(batches.every((batch) => batch.chars <= 16_384)).toBe(true);
    // 10,000 characters per document against a 16,384 character budget is one per request.
    expect(batches.map((batch) => batch.items)).toEqual(Array.from({ length: 35 }, () => 1));
  });

  it('keeps one oversized document inside the server input limit instead of failing the revision', async () => {
    const inputs: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      inputs.push(body.input);
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    await provider.embed(['y'.repeat(40_000)]);
    expect(inputs).toEqual([['y'.repeat(32_000)]]);
  });

  it('retries a slow batch instead of losing the projection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model', baseDelayMs: 0 });
    expect(await provider.embed(['recoverable'])).toEqual([[1, 0]]);
    expect(calls).toBe(2);
  });

  it('bounds long-code batches without changing input text or output order', async () => {
    const batches: string[][] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); batches.push(body.input);
      return Response.json({ data: body.input.map((text: string, index: number) => ({ index, embedding: [text.length, 1] })) });
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model', documentPrefix: 'passage: ' });
    const input = ['a'.repeat(12000), 'b'.repeat(12000), '中文🤾'.repeat(3000), 'short'];
    const vectors = await provider.embed(input);
    expect(batches.flat()).toEqual(input.map(text => `passage: ${text}`));
    expect(batches.every(batch => batch.reduce((sum, text) => sum + text.length, 0) <= 16384)).toBe(true);
    expect(vectors).toEqual(input.map(text => [text.length + 9, 1]));
  });

  it('retries a transient document timeout with the indexing budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const request = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('request timed out', 'TimeoutError'))
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model', baseDelayMs: 0 });
    await expect(provider.embed(['document'])).resolves.toEqual([[1, 0]]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls).toEqual([[30_000], [30_000]]);
  });

  it('limits document retries and reports the exhausted batch budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('private source', 'TimeoutError'));
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model', baseDelayMs: 0 });
    await expect(provider.embed(['private source'])).rejects.toThrow(
      'Document embedding failed: Embedding batch of 1 inputs failed (timeout 30000ms per attempt, 3 attempts): request timed out',
    );
    expect(request).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private source');
  });

  it.each([400, 401])('does not retry HTTP %s or expose submitted content in errors', async (status) => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(
      { error: { message: 'private source and secret-api-key' } }, { status },
    ));
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: 'secret-api-key', model: 'test-model' });
    const failure = await provider.embed(['private source', 'another document']).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(`batch of 2 inputs failed (timeout 30000ms per attempt, 1 attempts): Embedding API returned HTTP ${status}`);
    expect((failure as Error).message).not.toMatch(/private source|secret-api-key/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps query embedding at eight seconds without retries', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('request timed out', 'TimeoutError'));
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    await expect(provider.embedQuery('query')).rejects.toThrow('timeout 8000ms per attempt, 1 attempts');
    expect(request).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls).toEqual([[8_000]]);
  });
});

describe('HashSearchEmbeddingProvider', () => {
  it('produces deterministic normalized vectors at the configured dimension', async () => {
    const provider = new HashSearchEmbeddingProvider(16);
    const [first, second] = await provider.embed(['export class Widget {}', 'export class Widget {}']);
    expect(first).toHaveLength(16);
    expect(second).toEqual(first);
    expect(Math.sqrt(first!.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 8);
  });
});
