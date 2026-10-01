import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { DependencyEdgeRecord, TaskRetrievalScope } from '@forexplore/contracts';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from './index';
import { TaskRetrievalService, validateTaskRetrievalRequest } from './task-retrieval';
import { resolvePythonImport } from './cross-repository-imports';
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('retrieves a transitive three-repository import graph within nine frozen scopes using bounded reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cross-import-')); roots.push(root);
  const store = new InMemoryIndexStore(); const runtime = await createCodeIntelligenceRuntime({ store });
  try {
    const files = [ ['entry.py', 'from business import approve\ndef submit_warranty():\n    return approve()\n'],
      ['business.py', 'from policy import limit\napprove = limit\n'],
      ['policy.py', 'def limit():\n    return 300\n'] ];
    const scopes: TaskRetrievalScope[] = [];
    for (let i = 0; i < 9; i++) {
      const directory = path.join(root, String(i)); await mkdir(directory);
      const [name, source] = files[i] ?? [`extra${i}.py`, `def unrelated${i}():\n    return 0\n`];
      await writeFile(path.join(directory, name!), source!);
      await runtime.registry.register({ repositoryId: `repo-${i}`, localPath: directory, role: 'history' });
      const result = await runtime.coordinator.run({ repositoryId: `repo-${i}` }); scopes.push({ ...result.scope, role: 'reference' });
    }
    const search = store.searchSearchDocuments.bind(store);
    vi.spyOn(store, 'searchSearchDocuments').mockImplementation((scope, ...args) => scope.repositoryId === 'repo-0' ? search(scope, ...args) : Promise.resolve([]));
    vi.spyOn(store, 'getStructuralIndex').mockRejectedValue(new Error('Unbounded read'));
    // InMemoryIndexStore implements bounded slices over its stored string; forbid full-index enumeration instead.
    for (const method of ['listFiles', 'listSymbols', 'listDependencyEdges'] as const) vi.spyOn(store, method).mockRejectedValue(new Error('Unbounded read'));
    const service = new TaskRetrievalService(store, { rerank: null, expansion: null });
    const packet = await service.search({ requestId: 'cross-import', requirement: 'submit_warranty', granularity: 'function', scopes, budget: { maxLatencyMs: 30000 } });
    expect(packet.snapshots).toHaveLength(9);
    expect(packet.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryId: 'repo-1', relativePath: 'business.py', role: 'dependency' }),
      expect.objectContaining({ repositoryId: 'repo-2', relativePath: 'policy.py', role: 'dependency' }),
    ]));
    expect(packet.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ repositoryId: 'repo-0', targetRepositoryId: 'repo-1', targetAnalysisRevision: scopes[1]!.analysisRevision }),
      expect.objectContaining({ repositoryId: 'repo-1', targetRepositoryId: 'repo-2', targetAnalysisRevision: scopes[2]!.analysisRevision }),
    ]));
    expect(packet.markdown).toContain(`repo-2@${scopes[2]!.analysisRevision}`);
  } finally { await runtime.close(); }
}, 30000);

it('preserves same-name ambiguity and never queries undeclared repositories', async () => {
  const scopes = ['source', 'one', 'two'].map(repositoryId => ({ repositoryId, analysisRevision: 'v1' }));
  const queryFiles = vi.fn(async (scope: TaskRetrievalScope) => ({ files: scope.repositoryId === 'source' ? [] : [{ ...scope, relativePath: 'policy.py' }], truncated: false }));
  const edge = { kind: 'import', sourceRelativePath: 'entry.py', targetReference: 'policy' } as DependencyEdgeRecord;
  const matches = await resolvePythonImport({ queryFiles } as any, scopes[0]!, edge, scopes, new AbortController().signal);
  expect(matches.map(m => m.scope.repositoryId)).toEqual(['one', 'two']);
  expect(queryFiles.mock.calls.map(([s]) => s.repositoryId)).toEqual(['source', 'one', 'two']);
  expect(() => validateTaskRetrievalRequest({ requestId: 'overflow', requirement: 'upload', scopes: Array(65).fill(scopes[0]), budget: {} })).toThrow('64');
});
