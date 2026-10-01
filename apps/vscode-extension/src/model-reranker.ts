import type { TaskCandidateReranker, TaskRerankCandidate } from '../../../services/code-intelligence-service/src/task-reranker';
import type { ModuleReranker } from '../../../services/code-intelligence-service/src/module-reranker';
import { localFetch } from './local-fetch';

/** The transport obtains fresh SecretStorage credentials on every call. */
export class ConfiguredModelReranker implements TaskCandidateReranker, ModuleReranker {
  readonly model = 'configured-model';
  constructor(private readonly endpoint: () => string, private readonly ensureStarted: () => Promise<unknown>,
    private readonly transport: typeof localFetch = localFetch) {}

  async rerank(requirement: string, candidates: readonly TaskRerankCandidate[], signal?: AbortSignal): Promise<TaskRerankCandidate[]> {
    if (candidates.length < 2) return [...candidates];
    signal?.throwIfAborted();
    await this.ensureStarted();
    signal?.throwIfAborted();
    const url = new URL(this.endpoint());
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/retrieval-rerank`;
    url.search = ''; url.hash = '';
    const response = await this.transport(url.toString(), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requirement: requirement.slice(0, 8000), candidates }),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new Error(`模型重排后端返回 HTTP ${response.status}`);
    const payload = await response.json() as { order?: unknown };
    const byId = new Map(candidates.map(c => [c.id, c]));
    if (!Array.isArray(payload.order) || payload.order.length !== candidates.length || new Set(payload.order).size !== candidates.length ||
        payload.order.some(id => typeof id !== 'string' || !byId.has(id))) throw new Error('模型重排返回了无效候选顺序');
    return payload.order.map(id => byId.get(id)!);
  }

  async rank(query: string, documents: readonly string[], signal: AbortSignal): Promise<Array<{ index: number; score: number }>> {
    const candidates = documents.map((text, index) => ({ id: `c${index}`, name: `module-${index}`, granularity: 'module', relativePath: '', preview: text.slice(0, 8000) }));
    return (await this.rerank(query, candidates, signal)).map((item, rank) => ({ index: Number(item.id.slice(1)), score: 1 - rank / Math.max(1, documents.length) }));
  }
}
