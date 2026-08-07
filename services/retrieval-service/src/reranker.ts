import type { SearchCandidate, SearchRequest } from '@forexplore/contracts';
import type { LlmReranker, RerankResult } from './types.js';

// ── Retry / error-handling utilities (mirrors embedding.ts patterns) ──────

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND',
  'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

function isRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as NodeJS.ErrnoException).code;
    if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;
  }
  return error.message.includes('fetch failed') || error.message.includes('network');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function apiErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

// ── Prompt construction ───────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  '你是代码检索排序专家。根据目标的行为语义对候选代码排序，',
  '优先选择行为模式匹配（而非名称相似）。',
  '只输出纯JSON数组，不要任何解释、markdown、或额外文字。',
].join('');

export function buildRerankPrompt(
  request: SearchRequest,
  candidates: SearchCandidate[],
): { system: string; user: string } {
  const queryLines = [
    `目标: ${request.target.name}(${request.target.kind}) ${request.target.signature}`,
    `语言: ${request.target.language}`,
    `需求: ${request.requirement}`,
  ];

  const candidateBlocks = candidates.map((c, i) =>
    `[${i}] id=${c.id} | ${c.repository}/${c.title} | ${c.language}/${c.kind} | ${c.summary}`,
  );

  const user = [
    queryLines.join('\n'),
    '',
    `候选 (${candidates.length}条):`,
    candidateBlocks.join('\n'),
    '',
    '按行为语义匹配度排序，输出JSON:',
    '[{"id":"id值","score":0.95}]',
  ].join('\n');

  return { system: SYSTEM_PROMPT, user };
}

// ── Response parsing ──────────────────────────────────────────────────────

interface RawRerankItem {
  rank?: unknown;
  id?: unknown;
  score?: unknown;
  reason?: unknown;
}

function isValidRerankItem(item: unknown): item is RawRerankItem {
  return typeof item === 'object' && item !== null;
}

/**
 * Multi-strategy JSON extraction from LLM text output.
 *
 * 1. Direct JSON.parse (the LLM followed instructions).
 * 2. Extract the first ```json … ``` fenced block.
 * 3. Extract the outermost `[ … ]` span (after stripping leading non-JSON text).
 * 4. Fix unquoted object keys (JSON5 / Qwen style) and retry bracket extraction.
 */
export function parseRerankResponse(text: string): RerankResult[] {
  const trimmed = text.trim();

  const strategies: Array<{ label: string; extract: () => unknown }> = [
    {
      label: 'direct',
      extract: () => JSON.parse(trimmed),
    },
    {
      label: 'code-block',
      extract: () => {
        const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (!match?.[1]) throw new Error('No JSON code block found.');
        return JSON.parse(match[1].trim());
      },
    },
    {
      label: 'bracket-extract',
      extract: () => {
        // Skip leading text until the first '['
        const jsonStart = trimmed.indexOf('[');
        const jsonEnd = trimmed.lastIndexOf(']');
        if (jsonStart === -1 || jsonEnd === -1 || jsonStart >= jsonEnd) {
          throw new Error('No JSON array brackets found.');
        }
        return JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
      },
    },
    {
      label: 'fix-unquoted-keys',
      extract: () => {
        const jsonStart = trimmed.indexOf('[');
        const jsonEnd = trimmed.lastIndexOf(']');
        if (jsonStart === -1 || jsonEnd === -1 || jsonStart >= jsonEnd) {
          throw new Error('No JSON array brackets found.');
        }
        let fragment = trimmed.slice(jsonStart, jsonEnd + 1);
        // Quote unquoted object keys:  {rank:1  →  {"rank":1
        fragment = fragment.replace(/(\{|\,)\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
        return JSON.parse(fragment);
      },
    },
  ];

  const errors: string[] = [];
  for (const strategy of strategies) {
    try {
      const parsed = strategy.extract();
      if (!Array.isArray(parsed)) {
        errors.push(`${strategy.label}: result is not an array`);
        continue;
      }
      const results = parsed
        .filter(isValidRerankItem)
        .filter((item): item is RawRerankItem & { id: unknown; score: unknown } =>
          typeof item.id === 'string' && item.id.length > 0 &&
          typeof item.score === 'number' && Number.isFinite(item.score),
        )
        .map((item, i) => ({
          id: item.id as string,
          score: Math.max(0, Math.min(1, (item.score as number))),
          reason: typeof item.reason === 'string' ? item.reason : `rank ${i + 1}`,
        }));

      if (results.length === 0) {
        errors.push(`${strategy.label}: no valid items in array`);
        continue;
      }

      return results;
    } catch (error) {
      errors.push(
        `${strategy.label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Failed to parse rerank response. Raw (first 300 chars): "${text.slice(0, 300)}"\nErrors by strategy:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
  );
}

// ── OpenAI-compatible chat/completions reranker ───────────────────────────

export class OpenAiCompatibleReranker implements LlmReranker {
  readonly model: string;

  constructor(
    model: string,
    private readonly url: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number = 30_000,
    private readonly maxRetries: number = 2,
    private readonly baseDelayMs: number = 1000,
    private readonly batchSize: number = 20,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.model = model;
  }

  async rerank(
    request: SearchRequest,
    candidates: SearchCandidate[],
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    if (candidates.length <= this.batchSize) {
      return this.rerankBatch(request, candidates);
    }

    // Split into batches and call in parallel.
    const batches: SearchCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += this.batchSize) {
      batches.push(candidates.slice(i, i + this.batchSize));
    }

    const batchResults = await Promise.all(
      batches.map((batch) => this.rerankBatch(request, batch)),
    );

    // Merge all batches, sort by score descending.
    const merged = batchResults.flat();
    merged.sort((a, b) => b.score - a.score);
    return merged;
  }

  // ── private helpers ───────────────────────────────────────────────────

  private async rerankBatch(
    request: SearchRequest,
    candidates: SearchCandidate[],
  ): Promise<RerankResult[]> {
    const { system, user } = buildRerankPrompt(request, candidates);

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.tryRerank(system, user);
      } catch (error: unknown) {
        lastError = error;
        if (attempt === this.maxRetries || !isRetryable(error)) throw error;
        const delay = this.baseDelayMs * 2 ** attempt;
        console.warn(
          `Rerank API request failed (attempt ${attempt + 1}/${this.maxRetries + 1}), ` +
            `retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  private async tryRerank(
    system: string,
    user: string,
  ): Promise<RerankResult[]> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Rerank API returned invalid JSON (HTTP ${response.status}).`,
      );
    }

    if (!response.ok) {
      throw new Error(
        apiErrorMessage(body) ||
          `Rerank API returned HTTP ${response.status}. Body: ${JSON.stringify(body)}`,
      );
    }

    if (typeof body !== 'object' || body === null) {
      throw new Error('Rerank API returned an invalid response body.');
    }

    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('Rerank API returned no choices.');
    }

    const message = (choices[0] as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) {
      throw new Error('Rerank API returned an invalid message.');
    }

    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Rerank API returned empty content.');
    }

    return parseRerankResponse(content);
  }
}
