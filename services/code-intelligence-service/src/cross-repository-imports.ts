import type { DependencyEdgeRecord, TaskRetrievalScope } from '@forexplore/contracts';
import type { IndexStore } from './index-store';

/** Structural module-path evidence, not a claim about runtime package resolution or calls. */
export async function resolvePythonImport(store: IndexStore, source: TaskRetrievalScope, edge: DependencyEdgeRecord,
  scopes: readonly TaskRetrievalScope[], signal: AbortSignal): Promise<Array<{ scope: TaskRetrievalScope; path: string }>> {
  if (!store.queryFiles || !edge.sourceRelativePath.endsWith('.py') || edge.kind !== 'import' ||
      !edge.targetReference || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(edge.targetReference)) return [];
  const module = edge.targetReference.replaceAll('.', '/');
  const paths = [`${module}.py`, `${module}/__init__.py`, `src/${module}.py`, `src/${module}/__init__.py`];
  const matches: Array<{ scope: TaskRetrievalScope; path: string }> = [];
  // Query only exact paths within declared projects/revisions; never enumerate a global registry.
  for (const scope of scopes) {
    signal.throwIfAborted();
    const result = await store.queryFiles(scope, { relativePaths: paths, projectId: scope.projectId, limit: 8 }, signal);
    for (const file of result.files) {
      if (file.repositoryId !== scope.repositoryId || file.analysisRevision !== scope.analysisRevision || !paths.includes(file.relativePath) ||
          scope.projectId && file.projectId !== scope.projectId) throw new Error('Import target escaped the authorized snapshot.');
      matches.push({ scope, path: file.relativePath });
    }
  }
  // Local modules shadow other repositories. Multiple matches stay ambiguous.
  const local = matches.filter(item => item.scope.repositoryId === source.repositoryId && item.scope.analysisRevision === source.analysisRevision);
  return local.length ? local : matches;
}
