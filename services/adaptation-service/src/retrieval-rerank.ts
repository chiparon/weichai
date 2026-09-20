import { buildTaskRerankPrompt, parseTaskRerankResponse, type TaskRerankCandidate } from '@forexplore/code-intelligence-service/task-reranker';
import { completeWithDeepSeek } from './deepseek-client';

export interface RetrievalRerankInput { requirement: string; candidates: TaskRerankCandidate[] }
export function parseRetrievalRerank(value: unknown): RetrievalRerankInput {
  const body = value as RetrievalRerankInput;
  if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['requirement', 'candidates'].includes(k)) ||
      typeof body.requirement !== 'string' || !body.requirement.trim() || body.requirement.length > 8000 ||
      !Array.isArray(body.candidates) || body.candidates.length < 2 || body.candidates.length > 40) throw new Error('Invalid bounded rerank request');
  const ids = new Set<string>();
  for (const item of body.candidates) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(k => !['id', 'name', 'granularity', 'relativePath', 'signature', 'preview'].includes(k))) throw new Error('Invalid rerank candidate');
    for (const field of ['id', 'name', 'granularity', 'relativePath'] as const) {
      if (typeof item[field] !== 'string' || item[field].length > 2048) throw new Error('Invalid candidate field');
    }
    if (!item.id || ids.has(item.id)) throw new Error('Candidate identities must be unique');
    ids.add(item.id);
    for (const field of ['signature', 'preview'] as const) if (item[field] !== undefined && (typeof item[field] !== 'string' || item[field]!.length > 8000)) throw new Error('Candidate text exceeds limit');
  }
  return body;
}

/** Uses the same request-scoped provider and secret as analysis/translation. */
export async function rankRetrieval(input: RetrievalRerankInput, signal: AbortSignal): Promise<string[]> {
  const prompt = buildTaskRerankPrompt(input.requirement, input.candidates);
  const ids = new Set(input.candidates.map(c => c.id));
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await completeWithDeepSeek([{ role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user + (attempt ? '\n上次结果无效，请只返回每个候选 ID 各一次的完整 JSON 数组。' : '') }],
      { apiKey: () => process.env.DEEPSEEK_API_KEY ?? '', temperature: 0 }, signal);
    const order = parseTaskRerankResponse(content, ids);
    if (order) return order;
  }
  throw new Error('Model ranking did not preserve candidate identities');
}
