import type { EmbeddingProvider } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function features(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const grams: string[] = [];
  for (const word of words) {
    grams.push(`w:${word}`);
    if (word.length < 3) continue;
    for (let index = 0; index <= word.length - 3; index += 1) {
      grams.push(`g:${word.slice(index, index + 3)}`);
    }
  }
  return grams;
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

/**
 * An offline feature-hashing embedder. It is deterministic and useful for
 * development, but an OpenAI-compatible embedding model should be used when
 * semantic quality matters.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimension = 384) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimension }, () => 0);
      for (const feature of features(text)) {
        const hash = fnv1a(feature);
        const position = hash % this.dimension;
        const sign = (hash & 0x80000000) === 0 ? 1 : -1;
        vector[position] = (vector[position] ?? 0) + sign;
      }
      return normalize(vector);
    });
  }
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

class EmbeddingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingHttpError';
  }
}

class EmbeddingResponseError extends Error {}

/** Server bodies and arbitrary transport messages can echo submitted source or credentials. */
function failureReason(error: unknown): string {
  if (error instanceof EmbeddingHttpError || error instanceof EmbeddingResponseError) return error.message;
  if (!(error instanceof Error)) return 'embedding request failed';
  if (error.name === 'TimeoutError') return 'request timed out';
  if (error.name === 'AbortError') return 'request aborted';
  const cause = error.cause;
  const code = (error as NodeJS.ErrnoException).code ??
    (cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined);
  if (code && RETRYABLE_CODES.has(code)) return `network error (${code})`;
  return 'network request failed';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) return isRetryableStatus(error.status);
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as NodeJS.ErrnoException).code;
    if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;
  }
  return error.message.includes('fetch failed') || error.message.includes('network');
}

export interface OpenAiCompatibleEmbeddingProviderOptions {
  /** Set false for compatible models that reject OpenAI's dimensions parameter. */
  supportsDimensions?: boolean;
  request?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  private readonly request: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly supportsDimensions: boolean;

  constructor(
    readonly dimension: number,
    private readonly url: string,
    private readonly apiKey: string,
    private readonly model: string,
    requestOrOptions:
      | typeof globalThis.fetch
      | OpenAiCompatibleEmbeddingProviderOptions = globalThis.fetch,
    legacyTimeoutMs = 30_000,
    legacyMaxRetries = 3,
    legacyBaseDelayMs = 1000,
  ) {
    const options =
      typeof requestOrOptions === 'function' ? undefined : requestOrOptions;
    this.request =
      typeof requestOrOptions === 'function'
        ? requestOrOptions
        : options?.request ?? globalThis.fetch;
    this.timeoutMs = options?.timeoutMs ?? legacyTimeoutMs;
    this.maxRetries = options?.maxRetries ?? legacyMaxRetries;
    this.baseDelayMs = options?.baseDelayMs ?? legacyBaseDelayMs;
    // Preserve the pre-reranking provider behavior: OpenAI-compatible models
    // receive the requested dimension unless a caller explicitly opts out.
    this.supportsDimensions = options?.supportsDimensions ?? true;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted();
    if (texts.length === 0) return [];
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        signal?.throwIfAborted();
        return await this.tryEmbed(texts, signal);
      } catch (error: unknown) {
        lastError = error;
        signal?.throwIfAborted();
        const detail = `Embedding batch of ${texts.length} inputs failed (timeout ${this.timeoutMs}ms per attempt, ` +
          `${attempt + 1} attempts): ${failureReason(error)}`;
        if (attempt === this.maxRetries || !isRetryable(error)) throw new Error(detail);
        const delayMs = this.baseDelayMs * 2 ** attempt;
        console.warn(
          `${detail}; retrying in ${delayMs}ms (${attempt + 1}/${this.maxRetries} retries).`,
        );
        try { await delay(delayMs, undefined, { signal }); }
        catch (error) { signal?.throwIfAborted(); throw error; }
      }
    }
    throw lastError;
  }

  private async tryEmbed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const response = await this.request(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        ...(this.supportsDimensions ? { dimensions: this.dimension } : {}),
        encoding_format: 'float',
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (response.ok && isRetryable(error)) throw error;
      if (!response.ok) {
        throw new EmbeddingHttpError(
          response.status,
          `Embedding API returned HTTP ${response.status} with an invalid JSON body.`,
        );
      }
      throw new EmbeddingResponseError(`Embedding API returned invalid JSON (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      throw new EmbeddingHttpError(
        response.status,
        `Embedding API returned HTTP ${response.status}.`,
      );
    }
    if (typeof body !== 'object' || body === null) {
      throw new EmbeddingResponseError('Embedding API returned an invalid response body.');
    }
    const data = (body as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new EmbeddingResponseError('Embedding API returned an unexpected number of vectors.');
    }
    const items = data.map((item) => {
      if (typeof item !== 'object' || item === null) return null;
      const { index, embedding } = item as { index?: unknown; embedding?: unknown };
      if (
        !Number.isInteger(index) ||
        !Array.isArray(embedding) ||
        !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        return null;
      }
      return { index: Number(index), embedding };
    });
    if (
      items.some((item) => item === null) ||
      new Set(items.map((item) => item?.index)).size !== texts.length ||
      items.some((item) => (item?.index ?? -1) < 0 || (item?.index ?? -1) >= texts.length)
    ) {
      throw new EmbeddingResponseError('Embedding API returned malformed vector entries.');
    }
    const vectors = items
      .sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0))
      .map((item) => item?.embedding ?? []);
    if (vectors.some((vector) => vector.length !== this.dimension)) {
      throw new EmbeddingResponseError(`Embedding API did not return ${this.dimension}-dimensional vectors.`);
    }
    return vectors;
  }
}
