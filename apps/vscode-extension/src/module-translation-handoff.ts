import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ModuleTarget, SearchCandidate } from '@forexplore/contracts';
import { buildModuleTranslationScope } from './module-translation-scope';
import type { WorkspaceTranslationModuleScope } from './workspace-translation-host';

/** Both product hosts pass their own selected target and explicitly chosen candidate. */
export async function prepareModuleTranslationScope(input: {
  workspaceRoot: string; target: ModuleTarget; candidate: SearchCandidate;
  requirement: string; decisionNotes: string;
  includeCandidateContext?: boolean;
}): Promise<WorkspaceTranslationModuleScope> {
  const { target, candidate } = input;
  if (target.kind !== 'module' || !target.module || candidate.kind !== 'module' || !candidate.sourceModule) {
    throw new Error('模块翻译需要当前目标模块和已选中的历史模块候选。');
  }
  const source = candidate.sourceModule;
  const scope = buildModuleTranslationScope({
    workspaceRoot: await realpath(input.workspaceRoot),
    targetModule: { ...target.module, name: target.name, language: target.language },
    requirement: [input.requirement.trim(), input.decisionNotes.trim()].filter(Boolean).join('\n补充约束：'),
    includeCandidateContext: input.includeCandidateContext,
    candidates: [{ repositoryId: source.repositoryId, repositoryName: candidate.repository,
      analysisRevision: source.analysisRevision, projectId: source.projectId, moduleId: source.moduleId,
      name: source.name, purpose: source.purpose, language: candidate.language,
      sourceFiles: source.sourceFiles ?? [candidate.path], coreApis: source.coreApis ?? [], dependsOn: source.dependsOn ?? candidate.dependencies,
      preview: candidate.preview }],
  });
  scope.profile.sourceLanguage = candidate.language;
  const fileHashes: Record<string, string> = {};
  for (const file of scope.profile.writeFiles) {
    fileHashes[file] = await moduleFileHash(scope.profile.workspaceRoot, file);
  }
  return { ...scope, fileHashes };
}

export async function moduleFileHash(root: string, file: string): Promise<string> {
  const fullPath = await realpath(path.resolve(root, file));
  const relative = path.relative(await realpath(root), fullPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('模块文件不能位于目标工作区之外。');
  }
  return createHash('sha256').update(await readFile(fullPath)).digest('hex');
}
