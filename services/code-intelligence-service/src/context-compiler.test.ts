import { describe, expect, it } from 'vitest';
import type { TaskContextEvidence, TaskRetrievalRequest } from '@forexplore/contracts';
import { compileTaskContext, compileTaskContextAdaptive, compileTaskContextLegacy, contextTokenCount, regionOf, signatureOf, skeletonize, sourceContentHash } from './context-compiler.js';

const request: TaskRetrievalRequest = { requestId: 'compiler', requirement: '修改上传大小限制', scopes: [{ repositoryId: 'r', analysisRevision: 'v' }], budget: { maxTokens: 4000 } };
const evidence = (name: string, content: string, role: TaskContextEvidence['role'] = 'implementation'): TaskContextEvidence => ({
  repositoryId: 'r', analysisRevision: 'v', evidenceId: name, name, relativePath: `${name}.ts`, content, contentHash: sourceContentHash(content),
  fileHash: 'file', sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }, role, reason: 'Task evidence',
  provider: 'tree-sitter', evidenceLevel: 'syntactic', truncated: false,
});
const body = (name: string): string => `function ${name}(input) {\n${Array.from({ length: 60 }, (_, i) => `  const v${i} = compute(${i});`).join('\n')}\n  if (input > limit) { throw new Error('exceeded'); }\n  return input;\n}`;

function compile(items: TaskContextEvidence[], overrides: Partial<TaskRetrievalRequest> = {}, mode: 'adaptive' | 'legacy' = 'adaptive') {
  const input = { status: 'complete' as const, snapshots: [], results: [{ id: 'res-1', granularity: 'function' as const, name: 'target', repositoryId: 'r',
    analysisRevision: 'v', relativePath: 'target.ts', score: 1, reason: 'Matched the indexed declaration.' }], relations: [], gaps: [], evidence: items,
    routing: { requestedGranularity: 'auto' as const, resolvedGranularities: ['function' as const], source: 'automatic' as const, reason: 'test' } };
  const merged = { ...request, ...overrides };
  return mode === 'legacy' ? compileTaskContextLegacy(merged, input, 0) : compileTaskContextAdaptive(merged, input, 0);
}

describe('adaptive context compiler', () => {
  it('never exceeds the token budget', () => {
    const items = [evidence('a', body('a')), evidence('b', body('b')), evidence('c', body('c')), evidence('d', body('d'))];
    for (const maxTokens of [800, 1024, 2000, 4000, 8000]) {
      const packet = compile(items, { budget: { maxTokens } });
      expect(packet.usage.tokens).toBeLessThanOrEqual(maxTokens);
      expect(packet.usage.tokens).toBe(contextTokenCount(packet.markdown));
    }
  });

  it('still delivers a signature-grade excerpt at the minimum allowed budget, where the legacy packer delivers nothing', () => {
    const items = [evidence('a', body('a')), evidence('b', body('b'))];
    const adaptive = compile(items, { budget: { maxTokens: 256 } });
    expect(adaptive.usage.tokens).toBeLessThanOrEqual(256);
    expect(adaptive.evidence.length).toBeGreaterThan(0);
    expect(adaptive.evidence.every(item => ['region', 'skeleton', 'signature'].includes(item.renderLevel ?? 'full'))).toBe(true);
    expect(adaptive.evidence.some(item => item.renderLevel !== undefined)).toBe(true);
    const legacy = compile(items, { budget: { maxTokens: 256 } }, 'legacy');
    expect(legacy.evidence).toHaveLength(0);
  });

  it('downgrades oversized evidence instead of dropping it, and records the downgrade', () => {
    const packet = compile([evidence('huge', body('huge')), evidence('small', 'const limit = 1;')], { budget: { maxTokens: 400 } });
    const huge = packet.evidence.find(item => item.name === 'huge');
    expect(huge).toBeDefined();
    expect(huge?.renderLevel).toBeDefined();
    expect(['region', 'skeleton', 'signature']).toContain(huge?.renderLevel);
    expect(packet.gaps.some(gap => gap.code === 'CONTEXT_EVIDENCE_DOWNGRADED')).toBe(true);
    expect(packet.gaps.find(gap => gap.code === 'CONTEXT_EVIDENCE_DOWNGRADED')?.message).toContain('huge');
  });

  it('keeps the complete rendering when the budget allows it', () => {
    const packet = compile([evidence('a', body('a'))], { budget: { maxTokens: 20000 } });
    expect(packet.evidence[0]?.renderLevel).toBeUndefined();
    expect(packet.evidence[0]?.content).toBe(body('a'));
    expect(packet.usage.retrieval?.compiler?.levels.full).toBe(1);
  });

  it('never removes ranked results to make room for evidence', () => {
    const packet = compile([evidence('a', body('a')), evidence('b', body('b'))], { budget: { maxTokens: 400 } });
    expect(packet.results).toHaveLength(1);
    const legacy = compile([evidence('a', body('a')), evidence('b', body('b'))], { budget: { maxTokens: 400 } }, 'legacy');
    expect(legacy.results.length).toBeLessThan(1 + packet.results.length);
  });

  it('keeps code share at or above the acceptance threshold', () => {
    const items = [evidence('a', body('a')), evidence('b', body('b')), evidence('c', body('c'))];
    for (const maxTokens of [2000, 4000, 8000]) {
      const share = compile(items, { budget: { maxTokens } }).usage.retrieval?.compiler?.codeShare ?? 0;
      expect(share).toBeGreaterThanOrEqual(0.7);
    }
  });

  it('is deterministic', () => {
    const items = [evidence('a', body('a')), evidence('b', body('b'))];
    const first = compile(items, { budget: { maxTokens: 1500 } });
    const second = compile(items, { budget: { maxTokens: 1500 } });
    expect(second.markdown).toBe(first.markdown);
    expect(second.usage.tokens).toBe(first.usage.tokens);
  });

  it('is substantially faster than the legacy packer on large inputs', () => {
    const items = Array.from({ length: 120 }, (_, i) => evidence(`fn${i}`, body(`fn${i}`)));
    const started = performance.now();
    compileTaskContextAdaptive({ ...request, budget: { maxTokens: 8000 } }, {
      status: 'complete', snapshots: [], results: [], relations: [], gaps: [], evidence: items,
      routing: { requestedGranularity: 'auto', resolvedGranularities: ['function'], source: 'automatic', reason: 'test' } }, 0);
    const adaptiveMs = performance.now() - started;
    const startedLegacy = performance.now();
    compileTaskContextLegacy({ ...request, budget: { maxTokens: 8000 } }, {
      status: 'complete', snapshots: [], results: [], relations: [], gaps: [], evidence: items,
      routing: { requestedGranularity: 'auto', resolvedGranularities: ['function'], source: 'automatic', reason: 'test' } }, 0);
    const legacyMs = performance.now() - startedLegacy;
    expect(adaptiveMs * 2).toBeLessThan(legacyMs);
  });

  it('defaults to adaptive and honours the legacy switch', () => {
    const previous = process.env.RECAST_CONTEXT_COMPILER;
    try {
      delete process.env.RECAST_CONTEXT_COMPILER;
      expect(compileTaskContext({ ...request, budget: { maxTokens: 2000 } }, contextInput(), 0).usage.retrieval?.compiler?.mode).toBe('adaptive');
      process.env.RECAST_CONTEXT_COMPILER = 'legacy';
      expect(compileTaskContext({ ...request, budget: { maxTokens: 2000 } }, contextInput(), 0).usage.retrieval?.compiler).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.RECAST_CONTEXT_COMPILER; else process.env.RECAST_CONTEXT_COMPILER = previous;
    }
  });
});

function contextInput() {
  return { status: 'complete' as const, snapshots: [], results: [], relations: [], gaps: [], evidence: [evidence('a', body('a'))],
    routing: { requestedGranularity: 'auto' as const, resolvedGranularities: ['function' as const], source: 'automatic' as const, reason: 'test' } };
}

describe('render levels', () => {
  it('joins several regions when a task spans distant methods', () => {
    const distant = [
      'class Service {',                                    // 1
      ...Array.from({ length: 30 }, (_, i) => `  helper${i}() { return ${i}; }`),
      '  validateSize(value) { if (value > sizeMax) throw new SizeLimitExceededException(); }',   // 32
      ...Array.from({ length: 30 }, (_, i) => `  filler${i}() { return ${i}; }`),
      '  parseRequest(context) { if (context.size > fileSizeMax) throw new FileSizeLimitExceededException(); }',
      '}',                                                  // 64
    ].join('\n');
    const window = regionOf(evidence('service', distant), ['size', 'request', 'parse', 'max'], 900, 3);
    expect(window).not.toBeNull();
    expect(window!.regions).toBeGreaterThanOrEqual(2);
    expect(window!.content).toContain('sizeMax');
    expect(window!.content).toContain('fileSizeMax');
    expect(window!.content).toContain('省略');
    expect(window!.sourceRange.startLine).toBeLessThanOrEqual(32);
    expect(window!.sourceRange.endLine).toBeGreaterThanOrEqual(63);
  });

  it('skeleton keeps control flow and marks elided runs', () => {
    const skeleton = skeletonize(body('a'));
    expect(skeleton).not.toBeNull();
    expect(skeleton).toContain('省略');
    expect(skeleton).toContain('if (input > limit)');
    expect(skeleton!.length).toBeLessThan(body('a').length);
  });

  it('skeleton declines short bodies and signature keeps the first line', () => {
    expect(skeletonize('const a = 1;')).toBeNull();
    expect(signatureOf(body('a'))).toContain('function a(input)');
    expect(signatureOf('x')).toBeNull();
  });
});
