/**
 * Frozen retrieval baseline for the shared-recall-kernel refactor.
 *
 * Runs the two real engines (NL2Code task retrieval and Code2Code module
 * implementation search) against the live SeekDB index and writes an ordered
 * snapshot. Run it before and after the refactor and diff the two files:
 * NL2Code must be byte-identical, Code2Code must not lose candidates it had.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import type { ModuleTarget, TaskRetrievalRequest } from '@forexplore/contracts';
import {
  ModuleImplementationSearchService,
  SeekDbIndexStore,
  TaskRetrievalService,
} from '@forexplore/code-intelligence-service';

const { values } = parseArgs({ options: {
  database: { type: 'string', default: 'forexplore_javafileupload_flow_20260913' },
  output: { type: 'string', default: 'tmp/recall-baseline/snapshot.json' },
  label: { type: 'string', default: 'before' },
} });
const database = values.database!;
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 8 });
const store = new SeekDbIndexStore({
  host: '127.0.0.1', port: 2881, user: 'root', password: '', database, vectorDimension: 384,
  embedding: { url: 'http://127.0.0.1:4021/v1/embeddings', apiKey: '',
    model: 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78', queryPrefix: 'query: ', documentPrefix: 'passage: ' },
}, pool);
const taskRetrieval = new TaskRetrievalService(store);
const moduleSearch = new ModuleImplementationSearchService(store);

interface Scope { repositoryId: string; analysisRevision: string; projectId?: string }
const repositories = await store.listRepositories();
const byName = new Map(repositories.map((repository) => [repository.displayName, repository]));
const scopeOf = async (displayName: string): Promise<Scope> => {
  const repository = byName.get(displayName);
  assert(repository?.activeRevision, `Repository ${displayName} has no active revision.`);
  const projects = await store.listProjects({ repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision });
  assert(projects.length > 0, `Repository ${displayName} has no project.`);
  return { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, projectId: projects[0]!.projectId };
};
const target = await scopeOf('target-repo');
const history = await Promise.all(['commons-fileupload-csharp', 'commons-fileupload-python', 'commons-fileupload-ts'].map(scopeOf));

// ---- NL2Code: fixed natural-language requests across the three granularities.
const nl2codeCases: Array<{ name: string; request: TaskRetrievalRequest }> = [
  { name: 'function-both', request: { requestId: 'baseline-function-both', requirement: 'parseRequest 上传请求解析和文件项创建', granularity: 'function', scopes: [target, ...history].map((scope, index) => ({ ...scope, role: index === 0 ? 'target' as const : 'reference' as const })), budget: { maxTokens: 8000, maxLatencyMs: 60000, maxFiles: 30, maxSourceLines: 1600 } } },
  { name: 'class-target', request: { requestId: 'baseline-class-target', requirement: '定位上传基类与文件项接口，查看读写约定', granularity: 'class', scopes: [{ ...target, role: 'target' }], budget: { maxTokens: 8000, maxLatencyMs: 60000 } } },
  { name: 'module-both', request: { requestId: 'baseline-module-both', requirement: 'multipart 分段流读取与上传项存储功能模块', granularity: 'module', scopes: [target, ...history].map((scope, index) => ({ ...scope, role: index === 0 ? 'target' as const : 'reference' as const })), budget: { maxTokens: 8000, maxLatencyMs: 60000 } } },
  { name: 'auto-chinese', request: { requestId: 'baseline-auto-chinese', requirement: '恢复 multipart 分段流读取实现：跳过前导并按边界读取正文', granularity: 'auto', scopes: [target, ...history].map((scope, index) => ({ ...scope, role: index === 0 ? 'target' as const : 'reference' as const })), budget: { maxTokens: 8000, maxLatencyMs: 60000 } } },
  { name: 'no-match', request: { requestId: 'baseline-no-match', requirement: 'qzv_unrelated_7f0298 星际导航量子纠错', granularity: 'function', scopes: [...history].map((scope) => ({ ...scope, role: 'reference' as const })), budget: { maxTokens: 8000, maxLatencyMs: 60000 } } },
];

const nl2code: Array<Record<string, unknown>> = [];
for (const entry of nl2codeCases) {
  const packet = await taskRetrieval.search(entry.request, AbortSignal.timeout(120_000));
  nl2code.push({
    name: entry.name,
    requirement: entry.request.requirement,
    granularity: entry.request.granularity ?? 'auto',
    status: packet.status,
    routing: packet.routing,
    tokens: packet.usage.tokens,
    results: packet.results.map((item) => ({ granularity: item.granularity, name: item.name, repositoryId: item.repositoryId, relativePath: item.relativePath, symbolKey: item.symbolKey ?? null, score: Number(item.score.toFixed(6)) })),
    evidenceFocus: packet.evidence.slice(0, 12).map((item) => ({ repositoryId: item.repositoryId, relativePath: item.relativePath, startLine: item.sourceRange.startLine, endLine: item.sourceRange.endLine, role: item.role, chars: item.content.length })),
    relations: packet.relations.map((item) => ({ sourceSymbolKey: item.sourceSymbolKey ?? null, targetReference: item.targetReference ?? null })),
    gaps: [...new Set(packet.gaps.map((gap) => gap.code))].sort(),
  });
}

// ---- Code2Code: one module target and two symbol targets from the real index.
// Module artifacts are keyed by analysis revision; the newest revision may not
// have been re-modelled yet, so collect from every revision of the repository.
const revisionIds = (await store.listRevisions(target.repositoryId).catch(() => []))
  .map((revision) => revision.analysisRevision ?? (revision as unknown as { analysis_revision: string }).analysis_revision);
const moduleArtifacts = (await Promise.all([target.analysisRevision, ...revisionIds]
  .map((analysisRevision) => store.listModuleArtifacts({ repositoryId: target.repositoryId, analysisRevision })))).flat();
const moduleTargetOf = (name: string): ModuleTarget => {
  for (const artifact of moduleArtifacts) {
    const payload = artifact.payload as { proposal?: { modules?: Array<Record<string, any>> } } | undefined;
    for (const module of payload?.proposal?.modules ?? []) {
      if (module.name !== name) continue;
      return {
        id: `module://${module.id}`, name: module.name, kind: 'module', path: module.sourceFiles[0], language: 'Java',
        signature: (module.coreApis ?? []).join('\n'), documentation: module.purpose ?? module.description,
        module: { repositoryId: target.repositoryId, analysisRevision: target.analysisRevision, projectId: target.projectId,
          sourceFiles: module.sourceFiles ?? [], coreApis: module.coreApis ?? [], dependsOn: module.dependsOn ?? [] },
      };
    }
  }
  throw new Error(`Module ${name} is not in the target artifact.`);
};
// The structural index lists every symbol; the local symbol query is bounded and
// anchor-based, so targets are read from the index exactly as C2C reads it.
const targetIndex = await store.getStructuralIndex(target);
assert(targetIndex, 'The target repository has no structural index.');
const symbolTarget = async (kind: 'class' | 'function', qualifiedName: string): Promise<ModuleTarget> => {
  const symbol = targetIndex.symbols.find((item) => item.qualifiedName === qualifiedName)
    ?? targetIndex.symbols.find((item) => item.qualifiedName?.endsWith(`.${qualifiedName}`) && (kind === 'class' ? ['class', 'interface'].includes(item.kind) : ['method', 'function'].includes(item.kind)));
  assert(symbol, `Symbol ${qualifiedName} was not found in the target index.`);
  return { id: `symbol://${symbol.symbolId}`, name: symbol.name, kind, path: symbol.relativePath, language: 'Java',
    signature: symbol.signature ?? symbol.name };
};

const code2codeCases: Array<{ name: string; target: ModuleTarget }> = [
  { name: 'module-multipart', target: moduleTargetOf('Multipart 流解析') },
  { name: 'module-disk', target: moduleTargetOf('磁盘上传项存储') },
  { name: 'class-fileuploadbase', target: await symbolTarget('class', 'org.apache.commons.fileupload.FileUploadBase') },
  { name: 'function-parserequest', target: await symbolTarget('function', 'org.apache.commons.fileupload.FileUploadBase.parseRequest') },
];
const code2code: Array<Record<string, unknown>> = [];
for (const entry of code2codeCases) {
  const candidates = await moduleSearch.search({ target: entry.target, requirement: '恢复 multipart 分段流读取实现', topK: 5,
    repositoryIds: history.map((scope) => scope.repositoryId) }, AbortSignal.timeout(120_000));
  code2code.push({
    name: entry.name,
    targetKind: entry.target.kind,
    targetPath: entry.target.path,
    signature: entry.target.signature,
    candidates: candidates.map((candidate) => ({
      id: candidate.id, title: candidate.title, kind: candidate.kind, repository: candidate.repository, path: candidate.path,
      overall: Number(candidate.score.overall.toFixed(6)), semantic: Number(candidate.score.semantic.toFixed(6)),
      symbol: Number(candidate.score.symbol.toFixed(6)), contract: Number(candidate.score.contract.toFixed(6)),
      moduleId: candidate.sourceModule?.moduleId ?? null, moduleName: candidate.sourceModule?.name ?? null,
    })),
  });
}

const snapshot = { label: values.label, generatedAt: new Date().toISOString(), database, scopes: { target, history }, nl2code, code2code };
await mkdir(path.dirname(path.resolve(values.output!)), { recursive: true });
await writeFile(path.resolve(values.output!), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
await store.close();
console.info(JSON.stringify({
  label: values.label, output: path.resolve(values.output!),
  nl2code: nl2code.map((entry) => `${entry.name}:${entry.status}:${(entry.results as unknown[]).length}`),
  code2code: code2code.map((entry) => `${entry.name}:${(entry.candidates as unknown[]).length}`),
}, null, 2));
void readFile;
