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
   * The local server needs ~0.2ms per character, and the previous 16-item batch
   * with an 8s timeout turned one slow request into a failed revision: a 16-file
   * batch of ordinary sources measured 25s. Bound the payload, not just the count.
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
    expect(batches.every((batch) => batch.chars <= 24_000)).toBe(true);
    expect(batches.map((batch) => batch.items)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1]);
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
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    });
    const provider = new ModelSearchEmbeddingProvider(2, { url: 'http://127.0.0.1/embeddings', apiKey: '', model: 'test-model' });
    expect(await provider.embed(['recoverable'])).toEqual([[1, 0]]);
    expect(calls).toBe(2);
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
