import type { CodeIntelligencePresentation } from './ui-types';

/** Narrow host bridge for the service's analysis progress; no runtime service import. */
export interface IndexingProgress {
  stage: 'snapshot' | 'parse' | 'assemble' | 'recover' | 'structural-write' | 'search-projection' | 'activation';
  completed?: number;
  total?: number;
}

export interface RepositoryIndexingProgress extends IndexingProgress {
  repositoryId: string;
  displayName: string;
}

const stageLabels: Record<IndexingProgress['stage'], string> = {
  snapshot: '正在采集源码快照',
  parse: '正在解析源文件',
  assemble: '正在整理符号与依赖',
  recover: '正在恢复可复用的索引数据',
  'structural-write': '正在保存结构索引',
  'search-projection': '正在生成检索向量',
  activation: '正在启用索引版本',
};

export function indexingProgressMessage(progress: RepositoryIndexingProgress): string {
  const count = progress.completed === undefined ? '' : progress.total === undefined
    ? `（${progress.completed}）` : `（${progress.completed}/${progress.total}）`;
  return `${progress.displayName}：${stageLabels[progress.stage]}${count}`;
}

/** Stage changes and completion are immediate; ordinary counts update at most twice per second. */
export function createIndexingProgressReporter(
  report: (progress: RepositoryIndexingProgress) => void,
  now: () => number = Date.now,
): (progress: RepositoryIndexingProgress) => void {
  let previous: RepositoryIndexingProgress | undefined;
  let lastReport = -Infinity;
  return progress => {
    const time = now();
    const changed = previous?.repositoryId !== progress.repositoryId || previous?.stage !== progress.stage;
    const complete = progress.total !== undefined && progress.completed === progress.total;
    if (!changed && !complete && time - lastReport < 500) return;
    if (!changed && previous?.completed === progress.completed && previous?.total === progress.total) return;
    previous = progress;
    lastReport = time;
    report(progress);
  };
}

export function isIndexingCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** A failed repository does not disconnect a runtime that still serves a usable revision. */
export function retrievalAvailable(presentation: CodeIntelligencePresentation): boolean {
  return presentation.repositories.some(repository => Boolean(repository.activeRevision)) ||
    presentation.status === 'ready' && !presentation.repositories.some(repository => repository.analysisStatus === 'failed');
}
