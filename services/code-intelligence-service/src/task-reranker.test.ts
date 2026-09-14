import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  RERANK_CANDIDATE_LIMIT, RERANK_PREVIEW_CHARS, buildTaskRerankPrompt, candidatePassage, parseTaskRerankResponse,
  rerankCandidateId, rerankTaskCandidates, taskRerankConfigFromEnvironment, type TaskRerankCandidate, type TaskRerankConfig,
} from './task-reranker.js';

/**
 * Regression cover for the reranker.
 *
 * The reason this file exists: an id built from `${scope}\u0000${result.id}` could
 * not be echoed by the model, so every answer failed validation and
 * `rerankTaskCandidates` returned null *while the model was called on every
 * request*. Retrieval looked correct and only the latency betrayed it. The
 * permutation checks below are what make that class of silent no-op impossible.
 */

const candidate = (id: string, overrides: Partial<TaskRerankCandidate> = {}): TaskRerankCandidate =>
  ({ id, name: `Sym${id}`, granularity: 'function', relativePath: `src/${id}.java`, ...overrides });

const localConfig = (overrides: Partial<TaskRerankConfig> = {}): TaskRerankConfig =>
  ({ provider: 'local', url: '', url: 'http://127.0.0.1:4022/rerank', model: 'm', timeoutMs: 5000, candidateLimit: 12, ...overrides });

afterEach(() => { vi.unstubAllGlobals(); });

describe('rerank candidate identity', () => {
  it('is short and echoable — the property whose absence made reranking a silent no-op', () => {
    const ids = [0, 1, 2, 11].map(rerankCandidateId);
    expect(ids).toEqual(['c1', 'c2', 'c3', 'c12']);
    for (const id of ids) expect(id).toMatch(/^c\d+$/);
    expect(ids.join('')).not.toContain('\u0000');
  });
});

describe('parseTaskRerankResponse', () => {
  const ids = new Set(['c1', 'c2', 'c3']);

  it('accepts a complete permutation, including one wrapped in prose or a code fence', () => {
    expect(parseTaskRerankResponse('["c3","c1","c2"]', ids)).toEqual(['c3', 'c1', 'c2']);
    expect(parseTaskRerankResponse('结果如下：\n```json\n["c2","c3","c1"]\n```', ids)).toEqual(['c2', 'c3', 'c1']);
  });

  it('rejects every answer that would silently reorder the delivery', () => {
    expect(parseTaskRerankResponse('["c1","c2"]', ids)).toBeNull();                    // dropped a candidate
    expect(parseTaskRerankResponse('["c1","c1","c2","c3"]', ids)).toBeNull();          // duplicate
    expect(parseTaskRerankResponse('["c1","c2","c9"]', ids)).toBeNull();               // invented id
    expect(parseTaskRerankResponse('["c1","c2",1]', ids)).toBeNull();                  // not an id
    expect(parseTaskRerankResponse('[{"id":"c1","score":1}]', ids)).toBeNull();        // the old scored shape
    expect(parseTaskRerankResponse('no array here', ids)).toBeNull();
    expect(parseTaskRerankResponse('["c1","c2","c3"', ids)).toBeNull();                // truncated json
  });
});

describe('candidatePassage', () => {
  it('carries the same fields the LLM prompt does, and bounds the preview', () => {
    const passage = candidatePassage(candidate('c1', { signature: 'void a()', preview: 'x'.repeat(RERANK_PREVIEW_CHARS + 500) }));
    expect(passage).toContain('Symc1');
    expect(passage).toContain('src/c1.java');
    expect(passage).toContain('void a()');
    expect(passage.length).toBeLessThan(RERANK_PREVIEW_CHARS + 200);
  });

  it('omits an absent signature instead of rendering an empty field', () => {
    expect(candidatePassage(candidate('c1'))).not.toContain('签名');
  });
});

describe('buildTaskRerankPrompt', () => {
  it('asks for a ranking, not for scored objects', () => {
    const { user } = buildTaskRerankPrompt('需求文本', [candidate('c1'), candidate('c2')]);
    expect(user).toContain('需求文本');
    expect(user).toContain('candidatePassage'.length ? 'c1' : '');
    expect(user).toContain('["候选 ID","候选 ID", ...]');
    expect(user).not.toContain('"score"');
  });
});

describe('taskRerankConfigFromEnvironment', () => {
  it('is off unless asked for', () => {
    expect(taskRerankConfigFromEnvironment({})).toBeNull();
    expect(taskRerankConfigFromEnvironment({ RECAST_RETRIEVAL_RERANK: 'off' })).toBeNull();
    expect(taskRerankConfigFromEnvironment({ RECAST_RETRIEVAL_RERANK: 'cascade' })).toBeNull();
  });

  it('selects the local provider without requiring a key', () => {
    const config = taskRerankConfigFromEnvironment({ RECAST_RETRIEVAL_RERANK: 'local' });
    expect(config).toMatchObject({ provider: 'local', url: 'http://127.0.0.1:4022/rerank', candidateLimit: RERANK_CANDIDATE_LIMIT });
  });

  it('requires a key for the llm provider and names the provider in the error', () => {
    expect(() => taskRerankConfigFromEnvironment({ RECAST_RETRIEVAL_RERANK: 'llm' })).toThrow(/DEEPSEEK_API_KEY/);
    expect(taskRerankConfigFromEnvironment({ RECAST_RETRIEVAL_RERANK: 'on', DEEPSEEK_API_KEY: 'k' })).toMatchObject({ provider: 'llm' });
  });

  it('bounds the candidate limit and the timeout rather than trusting the environment', () => {
    const config = taskRerankConfigFromEnvironment({ RECAST_RETRIEVAL_RERANK: 'local', RECAST_RETRIEVAL_RERANK_LIMIT: '999', RECAST_RETRIEVAL_RERANK_TIMEOUT_MS: '5' });
    expect(config).toMatchObject({ candidateLimit: RERANK_CANDIDATE_LIMIT, timeoutMs: 5000 });
  });
});

describe('rerankTaskCandidates', () => {
  it('returns null for fewer than two candidates, so a single candidate is never reordered', async () => {
    expect(await rerankTaskCandidates(localConfig(), 'q', [candidate('c1')])).toBeNull();
  });

  it('orders by the score vector and leaves the caller untouched on a malformed answer', async () => {
    const candidates = [candidate('c1'), candidate('c2'), candidate('c3')];
    const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    stub({ scores: [0.1, 0.9, 0.5] });
    expect((await rerankTaskCandidates(localConfig(), 'q', candidates))!.map((item) => item.id)).toEqual(['c2', 'c3', 'c1']);
    stub({ scores: [0.1, 0.9] });
    await expect(rerankTaskCandidates(localConfig(), 'q', candidates)).rejects.toThrow(/unusable score vector/);
    expect(candidates.map((item) => item.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('keeps the caller order when the local server is unreachable only if the caller opted into the llm provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }));
    const candidates = [candidate('c1'), candidate('c2')];
    await expect(rerankTaskCandidates(localConfig(), 'q', candidates)).rejects.toThrow(/ECONNREFUSED/);
    expect(await rerankTaskCandidates(localConfig({ provider: 'llm', url: 'http://127.0.0.1:1/x', apiKey: 'k' }), 'q', candidates)).toBeNull();
  });
});
