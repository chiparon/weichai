import type { ModuleSearchCandidate, ModuleSearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { buildModuleRerankPrompt, DeepSeekModuleReranker } from './module-reranker.js';

const request: ModuleSearchRequest = {
  target: {
    id: 'target', name: 'Payment', language: 'Java', purpose: 'Complete payments.',
    coreApis: ['pay()', 'refund()'], dependencies: [],
  },
  requirement: 'support refunds', topK: 2, repositoryScopes: ['fixture/payments'],
};

function candidate(id: string): ModuleSearchCandidate {
  return {
    id, repository: 'fixture/payments', moduleId: id, name: id, kind: 'feature', language: 'Python',
    license: 'MIT', purpose: 'Complete and refund payments.', domain: 'payment', coreApis: ['pay()', 'refund()'],
    sourceFiles: ['pay.py'], symbolIds: ['pay'], dependencies: [], structureTerms: ['pay', 'refund'],
    representativeSymbols: [], compatibility: [], risks: [], snapshotId: 'snapshot', contentHash: 'hash',
    score: { overall: 0.8, semantic: 0.8, lexical: 0.8, structural: 0.8, apiCoverage: 1, adaptability: 0.8, quality: 0.8, hybrid: 0.8 },
    matchedApis: ['pay()', 'refund()'], missingApis: [], matchedRequirements: ['refund'],
  };
}

describe('module reranker', () => {
  it('uses short prompt keys without exposing them as returned candidate IDs', () => {
    const prompt = buildModuleRerankPrompt(request, [candidate('repository:long:module')]);
    expect(prompt.user).toContain('候选键: M1');
    expect(prompt.ids.get('M1')).toBe('repository:long:module');
  });

  it('repairs an incomplete result and maps prompt keys back to stable IDs', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '[{"id":"M1","score":0.9}]' } }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '[{"id":"M1","score":0.9},{"id":"M2","score":0.8}]' } }],
      }), { status: 200 }));
    const reranker = new DeepSeekModuleReranker(
      'deepseek', 'https://example.test/chat/completions', 'key', 1_000, 0, 1,
      fetchImpl as unknown as typeof fetch,
    );

    await expect(reranker.rerankModules(request, [candidate('one'), candidate('two')]))
      .resolves.toEqual([
        { id: 'one', score: 0.9, reason: '' },
        { id: 'two', score: 0.8, reason: '' },
      ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
