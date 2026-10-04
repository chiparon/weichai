import { createHash } from 'node:crypto';
import { OpenAiCompatibleEmbeddingProvider } from './embedding-client.js';

/** Minimal embedding abstraction kept within the code-intelligence boundary. */
export interface SearchEmbeddingProvider {
  readonly dimension: number;
  /** Immutable model/revision, preprocessing and instruction identity, required for persisted custom providers. */
  readonly identity?: string;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery?(text: string, signal?: AbortSignal): Promise<number[]>;
}

export interface ModelSearchEmbeddingConfig {
  url: string;
  apiKey: string;
  model: string;
  supportsDimensions?: boolean;
  queryPrefix?: string;
  documentPrefix?: string;
  /**
   * Deployment detail that changes the produced vectors, such as the inference
   * device and precision ("dml-fp16"). It belongs to the model identity: the store
   * reuses an embedding whenever the model input repeats, so a provider change that
   * is invisible here would silently keep vectors computed by the other provider.
   */
  variant?: string;
}

/** The local embedding server accepts at most 16 inputs of at most 32,000 characters. */
const maxBatchItems = 16;
const maxInputChars = 32_000;
/**
 * Latency follows the total characters in a batch, not the item count: measured
 * against the local server, 16 ordinary source documents (128k characters) took
 * 25s while this provider allowed 8s and no retry, so every large repository lost
 * its whole search projection to "The operation was aborted due to timeout".
 * Bound the payload per request instead, and keep a timeout that is generous for
 * a bounded batch (about 5s measured) rather than tight.
 */
const maxBatchChars = 24_000;
const requestTimeoutMs = 60_000;
const maxRetries = 2;

/** A document longer than the server limit is embedded from its prefix, which beats failing the revision. */
const embeddingInput = (text: string) => text.length > maxInputChars ? text.slice(0, maxInputChars) : text;

/** Bounded content cache is scoped to one immutable model configuration. */
export class ModelSearchEmbeddingProvider implements SearchEmbeddingProvider {
  readonly identity: string;
  readonly #client: OpenAiCompatibleEmbeddingProvider;
  readonly #cache = new Map<string, number[]>();
  readonly #queryFlights = new WeakMap<AbortSignal, Map<string, Promise<number[]>>>();
  constructor(readonly dimension: number, private readonly config: ModelSearchEmbeddingConfig) {
    this.config = Object.freeze({ ...config });
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || !config.model.trim() || !Number.isInteger(dimension) || dimension < 1) {
      throw new Error('Embedding requires an HTTP endpoint, model and positive dimension.');
    }
    this.#client = new OpenAiCompatibleEmbeddingProvider(dimension, config.url, config.apiKey, config.model,
      { supportsDimensions: config.supportsDimensions, timeoutMs: requestTimeoutMs, maxRetries });
    this.identity = createHash('sha256').update(JSON.stringify({ dimension, url: config.url, model: config.model,
      supportsDimensions: config.supportsDimensions ?? true, queryPrefix: config.queryPrefix ?? '', documentPrefix: config.documentPrefix ?? '',
      variant: config.variant ?? '' })).digest('hex');
  }
  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.encode(texts.map((text) => `${this.config.documentPrefix ?? ''}${text}`), signal);
  }
  async embedQuery(text: string, signal?: AbortSignal): Promise<number[]> {
    signal?.throwIfAborted();
    // Share only within one cancellation domain: aborting another task must not
    // cancel this request's embedding, even when its text happens to match.
    if (!signal) return (await this.encode([`${this.config.queryPrefix ?? ''}${text}`]))[0]!;
    let flights = this.#queryFlights.get(signal);
    if (!flights) { flights = new Map(); this.#queryFlights.set(signal, flights); }
    let pending = flights.get(text);
    if (!pending) {
      pending = this.encode([`${this.config.queryPrefix ?? ''}${text}`], signal).then(vectors => vectors[0]!)
        .finally(() => flights!.delete(text));
      flights.set(text, pending);
    }
    return [...await pending];
  }
  private async encode(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    const keys = texts.map((text) => createHash('sha256').update(text).digest('hex'));
    const output = keys.map((key) => this.#cache.get(key));
    const missing = new Map<string, { text: string; indices: number[] }>();
    keys.forEach((key, index) => {
      if (output[index]) { const vector = output[index]!; this.#cache.delete(key); this.#cache.set(key, vector); return; }
      const entry = missing.get(key) ?? { text: texts[index]!, indices: [] };
      entry.indices.push(index); missing.set(key, entry);
    });
    const entries = [...missing.entries()];
    for (let offset = 0; offset < entries.length;) {
      signal?.throwIfAborted();
      // One request carries at most 16 inputs and at most a bounded payload: a
      // single oversized document still travels alone rather than failing.
      const batch: typeof entries = [];
      let chars = 0;
      while (offset < entries.length && batch.length < maxBatchItems) {
        const entry = entries[offset]!;
        const size = embeddingInput(entry[1].text).length;
        if (batch.length > 0 && chars + size > maxBatchChars) break;
        batch.push(entry);
        chars += size;
        offset += 1;
      }
      const vectors = await this.#client.embed(batch.map(([, entry]) => embeddingInput(entry.text)), signal);
      batch.forEach(([key, entry], index) => {
        const vector = vectors[index]!;
        if (!vector.some((value) => value !== 0)) throw new Error('Embedding model returned a zero vector.');
        this.#cache.set(key, vector);
        entry.indices.forEach((position) => { output[position] = vector; });
        while (this.#cache.size > 4096) this.#cache.delete(this.#cache.keys().next().value!);
      });
    }
    return output.map((vector) => [...vector!]);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function features(text: string): string[] {
  const words = text.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const values: string[] = [];
  for (const word of words) {
    values.push(`word:${word}`);
    for (let index = 0; index <= word.length - 3; index += 1) values.push(`gram:${word.slice(index, index + 3)}`);
  }
  return values;
}

/**
 * Deterministic offline fallback. A host can inject a model-backed provider,
 * while this keeps every SeekDB projection row vector-indexable in local
 * setups instead of silently storing NULL embeddings.
 */
export class HashSearchEmbeddingProvider implements SearchEmbeddingProvider {
  readonly identity = 'hash-v1';
  constructor(readonly dimension = 384) {
    if (!Number.isInteger(dimension) || dimension < 1) {
      throw new Error('Search embedding dimension must be a positive integer.');
    }
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return texts.map((text) => {
      signal?.throwIfAborted();
      const vector = Array.from({ length: this.dimension }, () => 0);
      for (const feature of features(text)) {
        const hash = fnv1a(feature);
        const position = hash % this.dimension;
        vector[position] = (vector[position] ?? 0) + ((hash & 0x80000000) === 0 ? 1 : -1);
      }
      return normalize(vector);
    });
  }
}

export const searchEmbeddingInternals = { features, fnv1a, normalize };
