import { describe, expect, it } from 'vitest';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import { buildProjectExplorer } from './project-explorer';

function entry(): Awaited<ReturnType<CodeIntelligenceHost['explorerData']>>[number] {
  const scope = { repositoryId: 'target', analysisRevision: 'revision' };
  return {
    repository: { repositoryId: 'target', displayName: 'Target', localPath: '/target', role: 'target',
      activeRevision: 'revision', analysisStatus: 'ready', createdAt: '', updatedAt: '' },
    selectedTarget: true, projectId: 'project',
    index: { ...scope, analysisHash: 'hash', diagnostics: [], dependencyEdges: [],
      projects: [{ ...scope, projectId: 'project', kind: 'node', displayName: 'Target', relativePath: '', manifestPaths: ['package.json'], sourceRoots: [''], testRoots: [], languageIds: ['typescript'] }],
      files: ['payment.ts', 'receipt.ts'].map((relativePath) => ({ ...scope, fileId: relativePath, relativePath, projectId: 'project',
        languageId: 'typescript', role: 'source', sha256: 'hash', sizeBytes: 100, parseStatus: 'parsed' })),
      symbols: [{ ...scope, symbolId: 'pay', symbolKey: 'pay', astDeclarationId: 'pay', name: 'pay', qualifiedName: 'pay', kind: 'function',
        languageId: 'typescript', relativePath: 'payment.ts', projectId: 'project', exported: true, provider: 'tree-sitter', confidence: 1,
        evidenceLevel: 'structural', sourceRange: { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 } }] },
    analysis: { ...scope, projectId: 'project', state: 'ready', projection: 'ready', analysisProfile: 'code-understanding/v1', updatedAt: '',
      proposal: { ...scope, analysisHash: 'hash', objective: 'understand', summary: 'Payments', modules: [{ id: 'payments', name: 'Payments',
        kind: 'feature', description: 'Payments with receipts', language: 'TypeScript', sourceFiles: ['payment.ts', 'receipt.ts'],
        coreApis: ['pay'], symbolKeys: ['pay'], dependsOn: [], evidenceIds: ['pay'] }] } },
  };
}

describe('live project explorer read-only analysis', () => {
  it('presents complete current modules without granting migration authority', async () => {
    const result = await buildProjectExplorer({ explorerData: async () => [entry()] });
    expect(result.presentation.target).toMatchObject({
      repositoryId: 'target', projectId: 'project', snapshotId: 'revision',
      lifecycle: { ready: false, publicationActive: false },
    });
    expect(result.presentation.target.tree[0]).toMatchObject({
      kind: 'module', name: 'Payments', coreApis: ['pay'],
      children: [{ path: 'payment.ts' }, { path: 'receipt.ts' }],
    });
    expect(JSON.stringify(result.presentation)).not.toContain('targetId');
    expect(JSON.stringify(result.presentation)).not.toContain('historyModule');
  });

  it('keeps historical revisions read-only', async () => {
    const data = entry();
    data.repository.activeRevision = 'new-revision';
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    expect(result.presentation.target.tree[0]!.targetId).toBeUndefined();
    expect(result.presentation.target.lifecycle.stage).toBe('historical-analysis');
  });

  it('does not select a module before its analysis is ready', async () => {
    const data = entry();
    data.analysis!.state = 'failed';
    const result = await buildProjectExplorer({ explorerData: async () => [data] });
    expect(result.presentation.target.tree[0]!.targetId).toBeUndefined();
    expect(result.presentation.target.lifecycle).toMatchObject({ stage: 'failed', ready: false });
  });
});
