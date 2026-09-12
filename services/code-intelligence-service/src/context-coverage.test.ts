import { describe, expect, it } from 'vitest';
import type { TaskContextEvidence, TaskRetrievalRequest } from '@forexplore/contracts';
import { compileTaskContext, contextTokenCount, sourceContentHash } from './context-compiler.js';

const request: TaskRetrievalRequest = { requestId: 'coverage', requirement: 'upload size validation error handling', scopes: [{ repositoryId: 'r', analysisRevision: 'v' }], budget: { maxTokens: 3000, maxFiles: 2 } };
const evidence = (name: string, content: string, role: TaskContextEvidence['role'] = 'implementation'): TaskContextEvidence => ({
  repositoryId: 'r', analysisRevision: 'v', evidenceId: name, name, relativePath: `${name}.ts`, content, contentHash: sourceContentHash(content),
  fileHash: 'file', sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, role, reason: 'Task evidence', provider: 'tree-sitter', evidenceLevel: 'syntactic', truncated: false,
});
function compile(items: TaskContextEvidence[], overrides: Partial<TaskRetrievalRequest> = {}) {
  return compileTaskContext({ ...request, ...overrides }, { status: 'complete', snapshots: [], results: [], relations: [], gaps: [], evidence: items,
    routing: { requestedGranularity: 'auto', resolvedGranularities: ['function'], source: 'automatic', reason: 'test' } }, 0);
}
describe('implementation-first context construction', () => {
  it('retains core implementations before supporting code under an explicit file limit', () => {
    const result = compile([evidence('upload', 'function upload() { return sizeValidation(); }'),
      evidence('validation', 'function sizeValidation() { return size > 0; }'),
      evidence('failure', 'function errorHandling(error) { throw error; }', 'dependency')]);
    expect(result.evidence.map(item => item.name)).toEqual(['upload', 'validation']);
    expect(result.status).toBe('partial');
    expect(result.usage.tokens).toBe(contextTokenCount(result.markdown));
    expect(result.usage.tokens).toBeLessThanOrEqual(request.budget.maxTokens!);
  });
  it('retains all selected implementations beyond the old token and line limits by default', () => {
    const items = Array.from({ length: 25 }, (_, i) => evidence(`implementation${i}`, 'return upload;\n'.repeat(100)));
    const result = compile(items, { budget: {} });
    expect(result.evidence).toHaveLength(25);
    expect(result.usage.tokens).toBeGreaterThan(8000);
    expect(result.usage.sourceLines).toBeGreaterThan(1200);
    expect(result.usage.maxTokens).toBeNull();
    expect(result.status).toBe('complete');
  });
  it('deduplicates nested source without dropping distinct versions or known-source changes', () => {
    const outer = { ...evidence('main', 'function main() {\n  return upload;\n}'), sourceRange: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 2 } };
    const inner = { ...outer, evidenceId: 'inner', role: 'dependency' as const, content: 'return upload;', sourceRange: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 17 } };
    expect(compile([inner, outer], { budget: {} }).evidence).toEqual([outer]);
    expect(compile([outer], { budget: {}, knownEvidence: [{ evidenceId: 'main', contentHash: 'previous-content' }] }).evidence).toEqual([outer]);
  });
  it('does not erase identical source at distinct locations or across versions', () => {
    const first = evidence('first', 'return value;');
    const second = { ...first, evidenceId: 'second', sourceRange: { startLine: 5, startColumn: 1, endLine: 6, endColumn: 1 } };
    const third = { ...first, evidenceId: 'third', analysisRevision: 'v2' };
    expect(compile([first, second, third]).evidence).toHaveLength(3);
    expect(compile([first, second], { knownEvidence: [{ evidenceId: 'first', contentHash: first.contentHash }] }).evidence).toEqual([second]);
  });
  it('retains a complete method when its containing class does not fit an explicit limit', () => {
    const method = { ...evidence('method', 'run() { return 1; }'), relativePath: 'service.ts',
      sourceRange: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 20 } };
    const parent = { ...evidence('parent', 'class Service {\n' + 'run() { return 1; }\n'.repeat(500) + '}'), relativePath: 'service.ts',
      sourceRange: { startLine: 1, startColumn: 1, endLine: 502, endColumn: 2 } };
    for (const items of [[parent, method], [method, parent]]) {
      expect(compile(items, { budget: { maxTokens: 500 } }).evidence).toEqual([method]);
    }
  });
  it('enforces exact Markdown token and line budgets with adversarial fences', () => {
    const items = [evidence('main', '`'.repeat(40) + '\n' + '复杂文本 error handling '.repeat(100)), evidence('small', 'size validation')];
    const result = compile(items, { budget: { maxTokens: 500, maxSourceLines: 1 } });
    expect(result.evidence.map(item => item.name)).toEqual(['small']);
    expect(result.usage.tokens).toBeLessThanOrEqual(500);
    expect(result.usage.sourceLines).toBe(1);
  });
});
