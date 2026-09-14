/**
 * End-to-end acceptance for the module-level flow, driven entirely by real components:
 *
 *   imported corpus (workbench + SeekDB)  ->  module-level retrieval
 *   ->  automatic top-1 review            ->  module-scope translation (real model)
 *   ->  write-back into the target repo   ->  independent compile + Apache JUnit re-run
 *
 * Nothing here is synthesised: candidates come from the Code2Code module engine,
 * the context is built exactly as the extension builds it, and the grade is the
 * upstream Apache Commons FileUpload test suite, re-run by this script after the
 * translation finished.
 *
 *   npx tsx scripts/verify-module-flow-e2e.mts --reset-target
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
import type { ModuleTarget, SearchCandidate, WorkspaceTranslationRun } from '@forexplore/contracts';
import { ModuleImplementationSearchService, SeekDbIndexStore } from '@forexplore/code-intelligence-service';
import { buildModuleTranslationScope, type ModuleCandidatePackage } from '../apps/vscode-extension/src/module-translation-scope.js';
import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';

const { values } = parseArgs({ options: {
  database: { type: 'string', default: 'forexplore_javafileupload_flow_20260913' },
  service: { type: 'string', default: 'http://127.0.0.1:8790' },
  token: { type: 'string', default: process.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN ?? '' },
  repo: { type: 'string', default: 'tmp/java-fileupload-flow/target-repo' },
  'target-file': { type: 'string', default: 'src/main/java/org/apache/commons/fileupload/MultipartStream.java' },
  requirement: { type: 'string', default: '恢复 Apache Commons FileUpload 中缺失的 multipart 分段流读取实现：跳过前导并按边界流式读取分段正文' },
  'top-k': { type: 'string', default: '5' },
  'min-score': { type: 'string', default: '0.5' },
  'reset-target': { type: 'boolean', default: false },
  /** Keep earlier waves' applied changes; only the target file's stubs are required. */
  'keep-target-changes': { type: 'boolean', default: false },
  'candidate-context': { type: 'boolean', default: true },
  'max-output-tokens': { type: 'string', default: '32768' },
  /** Apache's full upload suite, or the tool's own default subset when empty. */
  'junit-classes': { type: 'string', default: process.env.FOREXPLORE_JUNIT_CLASSES ?? '' },
  output: { type: 'string', default: 'tmp/java-fileupload-flow/module-flow-e2e.json' },
} });

const repositoryRoot = path.resolve(values.repo!);
const targetFile = values['target-file']!;
const topK = Number(values['top-k']);
const minScore = Number(values['min-score']);
const token = values.token!;
assert(token.length >= 32, 'ADAPTATION_WORKSPACE_TRANSLATION_TOKEN is required.');

// The service defaults to 8192 output tokens, which cannot hold a whole-file
// rewrite of a 33 KB Java source. The extension injects this header from its
// settings; a headless run has to inject it itself.
const serviceOrigin = new URL(values.service!).origin;
const modelConfig = encodeURIComponent(JSON.stringify({ ...DEFAULT_LLM_SETTINGS, maxOutputTokens: Number(values['max-output-tokens']) }));
const baseFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof baseFetch>[0], init?: Parameters<typeof baseFetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  if (!url.startsWith(serviceOrigin)) return baseFetch(input, init);
  const headers = new Headers(init?.headers);
  headers.set('x-recast-model-config', modelConfig);
  return baseFetch(input, { ...init, headers });
}) as typeof baseFetch;

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const node = (script: string): { ok: boolean; output: string } => {
  try {
    return { ok: true, output: execFileSync(process.execPath, [script], { cwd: repositoryRoot, encoding: 'utf8', timeout: 900_000,
      env: { ...process.env, ...(values['junit-classes'] ? { FOREXPLORE_JUNIT_CLASSES: values['junit-classes']! } : {}) } }) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim() || String(failure.message) };
  }
};

// 0. The target must start from its committed skeleton, or there is nothing to translate.
if (values['reset-target']) {
  git('checkout', '--', targetFile);
  console.info(JSON.stringify({ stage: 'reset-target', file: targetFile }));
}
if (!values['keep-target-changes']) {
  assert.equal(git('status', '--porcelain', '--', targetFile), '', `${targetFile} has uncommitted changes; re-run with --reset-target.`);
}
const skeleton = await readFile(path.join(repositoryRoot, targetFile), 'utf8');
assert(skeleton.includes('UnsupportedOperationException'), `${targetFile} is not an unimplemented skeleton.`);
console.info(JSON.stringify({ stage: 'precondition', file: targetFile, bytes: Buffer.byteLength(skeleton) }));

// 1. Target module: straight from the persisted, current module plan.
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database: values.database, connectionLimit: 4 });
const [targets] = await pool.query(`SELECT repository_id AS repositoryId, display_name AS displayName, active_revision AS analysisRevision
  FROM repositories WHERE role = 'target' AND active_revision IS NOT NULL`);
const target = (targets as Array<{ repositoryId: string; displayName: string; analysisRevision: string }>)[0];
assert(target, 'No target repository is registered.');
const [projectRows] = await pool.query(`SELECT project_id AS projectId FROM projects WHERE repository_id = ? AND analysis_revision = ?`,
  [target.repositoryId, target.analysisRevision]);
const targetProjectId = (projectRows as Array<{ projectId: string }>)[0]?.projectId;
assert(targetProjectId, 'The target repository has no project in its active revision.');
const [summaries] = await pool.query(`SELECT payload FROM module_artifacts
  WHERE repository_id = ? AND analysis_revision = ? AND kind = 'module-summary' AND status = 'current'`, [target.repositoryId, target.analysisRevision]);
assert((summaries as unknown[]).length > 0, 'The target repository has no current module summary; run the module-analysis step first.');
type ModuleRecord = { id: string; name: string; description?: string; purpose?: string; language?: string; sourceFiles?: string[]; coreApis?: string[]; dependsOn?: string[] };
const modules: ModuleRecord[] = [];
for (const row of summaries as Array<{ payload: unknown }>) {
  const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as { proposal?: { modules?: ModuleRecord[] } };
  modules.push(...(payload.proposal?.modules ?? []));
}
const targetModule = modules.find((module) => (module.sourceFiles ?? []).includes(targetFile));
assert(targetModule, `No modelled module owns ${targetFile}.`);
const targetModuleFiles = targetModule.sourceFiles ?? [];
console.info(JSON.stringify({ stage: 'module-analysis', target: target.displayName, module: targetModule.name,
  files: targetModuleFiles.length, coreApis: targetModule.coreApis?.length ?? 0, writeSet: targetModuleFiles }));

// 2. Real module-level retrieval over every imported reference project.
const vectorDimension = Number(process.env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ?? 384);
const store = new SeekDbIndexStore({
  host: '127.0.0.1', port: 2881, user: 'root', password: '', database: values.database, vectorDimension,
  embedding: { url: process.env.CODE_INTELLIGENCE_EMBEDDING_URL ?? 'http://127.0.0.1:4021/v1/embeddings', apiKey: '',
    model: process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    queryPrefix: 'query: ', documentPrefix: 'passage: ' },
}, pool);
const history = (await store.listRepositories()).filter((repository) => repository.role === 'history' && repository.activeRevision);
const retrievalTarget: ModuleTarget = {
  id: `module://${targetModule.id}`, name: targetModule.name, kind: 'module', path: targetFile,
  language: 'Java', signature: (targetModule.coreApis ?? []).join('\n'),
  documentation: targetModule.purpose ?? targetModule.description,
  module: { repositoryId: target.repositoryId, analysisRevision: target.analysisRevision, projectId: targetProjectId,
    sourceFiles: targetModuleFiles, coreApis: targetModule.coreApis ?? [], dependsOn: targetModule.dependsOn ?? [] },
};
const retrievalStarted = Date.now();
const candidates = await new ModuleImplementationSearchService(store)
  .search({ target: retrievalTarget, requirement: values.requirement!, topK, repositoryIds: history.map((repository) => repository.repositoryId) },
    AbortSignal.timeout(180_000));
const retrievalMs = Date.now() - retrievalStarted;
console.info(JSON.stringify({ stage: 'retrieval', repositories: history.length, candidates: candidates.length, ms: retrievalMs,
  ranked: candidates.map((candidate, rank) => ({ rank, repo: candidate.repository, module: candidate.sourceModule?.moduleId ?? candidate.title,
    overall: Number(candidate.score.overall.toFixed(4)), semantic: Number(candidate.score.semantic.toFixed(4)),
    contract: Number(candidate.score.contract.toFixed(4)) })) }));
assert(candidates.length > 0, 'Module retrieval over the imported corpus returned no candidate.');
const top = candidates[0]!;
// An automatic top-1 review must be gradeable: a weak winner stops the run instead
// of being translated as if it had been chosen.
assert(top.score.overall >= minScore, `Top-1 candidate ${top.title} scored ${top.score.overall.toFixed(4)} < ${minScore}; review the corpus before translating.`);
const packageOf = (candidate: SearchCandidate): ModuleCandidatePackage => {
  const module = candidate.sourceModule;
  assert(module, `Candidate ${candidate.title} has no module identity and cannot be used as module context.`);
  return { repositoryId: module.repositoryId, repositoryName: candidate.repository, analysisRevision: module.analysisRevision,
    ...(module.projectId ? { projectId: module.projectId } : {}), moduleId: module.moduleId, name: module.name,
    ...(module.purpose ? { purpose: module.purpose } : {}), language: candidate.language,
    sourceFiles: module.sourceFiles ?? [candidate.path], coreApis: module.coreApis ?? [],
    dependsOn: candidate.dependencies, ...(candidate.preview ? { preview: candidate.preview } : {}) };
};
const chosen = packageOf(top);
console.info(JSON.stringify({ stage: 'review', decision: 'top-1', repository: chosen.repositoryName, moduleId: chosen.moduleId,
  name: chosen.name, files: chosen.sourceFiles.length, coreApis: chosen.coreApis.length, overall: Number(top.score.overall.toFixed(4)),
  why: { semantic: top.score.semantic, identity: top.score.symbol, typeFit: top.score.contract } }));

// 3. Host-owned scope, built exactly as the extension builds it from one reviewed candidate.
const scope = buildModuleTranslationScope({
  workspaceRoot: repositoryRoot,
  targetModule: { ...targetModule, sourceFiles: targetModuleFiles, name: targetModule.name,
    language: targetModule.language ?? 'Java', coreApis: targetModule.coreApis ?? [], dependsOn: targetModule.dependsOn ?? [] },
  candidates: [chosen],
  requirement: values.requirement!,
  ...(values['candidate-context'] ? {} : { includeCandidateContext: false }),
});
console.info(JSON.stringify({ stage: 'scope', label: scope.label, writeFiles: scope.profile.writeFiles,
  evidenceScopes: scope.evidenceScopes.length, contextEntries: scope.context.length, characters: scope.contextCharacters, warnings: scope.warnings }));

// 4. Real translation against the real service, with the compiler and the upstream
//    JUnit suite as its own gates.
const staticProfile = JSON.stringify({ workspaceRoot: repositoryRoot, sourceLanguage: 'Java', targetLanguage: 'Java',
  workspaceFiles: targetModuleFiles, writeFiles: targetModuleFiles });
const host = new WorkspaceTranslationHost(() => ({ url: values.service!, token, profile: staticProfile }));
const scopeId = host.rememberModuleScope({ label: scope.label, spec: scope.spec, profile: scope.profile, context: scope.context,
  evidenceScopes: scope.evidenceScopes, warnings: scope.warnings });
const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe', action: 'describe' });
assert.equal(described.type, 'WORKSPACE_TRANSLATION_RESULT', JSON.stringify(described).slice(0, 300));
if (described.type !== 'WORKSPACE_TRANSLATION_RESULT') throw new Error('unreachable');
assert.equal(described.profile?.moduleScopeId, scopeId);
assert(described.profile?.behavioralVerification, 'The service has no behavioral verification command configured.');
const started = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'start', action: 'start',
  profileId: described.profile.profileId, moduleScopeId: scopeId });
assert.equal(started.type, 'WORKSPACE_TRANSLATION_RESULT', JSON.stringify(started).slice(0, 400));
if (started.type !== 'WORKSPACE_TRANSLATION_RESULT' || !started.run) throw new Error('unreachable');
const runId = started.run.id;
console.info(JSON.stringify({ stage: 'started', runId, profile: described.profile.label, writeFiles: described.profile.writeFiles }));

let run: WorkspaceTranslationRun = started.run;
let seen = '';
const deadline = Date.now() + 3_600_000;
while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const read = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'read', action: 'read', runId });
  if (read.type !== 'WORKSPACE_TRANSLATION_RESULT' || !read.run) throw new Error(JSON.stringify(read).slice(0, 300));
  run = read.run;
  const line = `${run.status} turns=${run.modelTurns} steps=${run.completedSteps.length} changes=${run.changes.length} compiles=${run.compilations.length} evidence=${run.evidenceQueries?.length ?? 0}`;
  if (line !== seen) { console.info(JSON.stringify({ stage: 'poll', detail: line })); seen = line; }
}

// 5. Independent re-run of the same gates, outside the translation runtime.
const changed = git('status', '--porcelain').split('\n').filter(Boolean);
const compiled = node('tools/compile.mjs');
const verified = node('tools/verify.mjs');
const junit = /OK \(\d+ tests?\)|Tests run: \d+, {2}Failures: \d+/.exec(verified.output)?.[0];
const outsideWriteSet = run.changes.map((change) => change.path).filter((file) => !targetModuleFiles.includes(file));
console.info(JSON.stringify({ stage: 'independent-verification', compile: { ok: compiled.ok, tail: compiled.output.slice(-200) },
  verify: { ok: verified.ok, summary: junit ?? verified.output.slice(-200) }, workspaceChanges: changed, outsideWriteSet }));

const report = {
  generatedAt: new Date().toISOString(),
  database: values.database, target: { repository: target.displayName, module: targetModule.name, writeSet: targetModuleFiles, file: targetFile },
  retrieval: { repositories: history.length, ms: retrievalMs, minScore, candidates: candidates.map((candidate, rank) => ({
    rank, repository: candidate.repository, moduleId: candidate.sourceModule?.moduleId ?? null, name: candidate.sourceModule?.name ?? candidate.title,
    overall: Number(candidate.score.overall.toFixed(6)), semantic: Number(candidate.score.semantic.toFixed(6)),
    identity: Number(candidate.score.symbol.toFixed(6)), typeFit: Number(candidate.score.contract.toFixed(6)),
  })) },
  review: { decision: 'top-1', chosen: `${chosen.repositoryName}/${chosen.moduleId}`, score: Number(top.score.overall.toFixed(6)) },
  scope: { label: scope.label, writeFiles: scope.profile.writeFiles, evidenceScopes: scope.evidenceScopes,
    contextEntries: scope.context.length, characters: scope.contextCharacters, warnings: scope.warnings },
  run: { id: runId, status: run.status, acceptance: run.acceptance, error: run.error, modelTurns: run.modelTurns,
    completedSteps: run.completedSteps, evidenceQueries: run.evidenceQueries ?? [],
    changes: run.changes.map((change) => ({ path: change.path, applied: change.applied })),
    compilations: run.compilations.map((entry) => ({ success: entry.success, exitCode: entry.exitCode })),
    verification: run.verification?.runs.map((entry) => ({ success: entry.success, filesUnchanged: entry.filesUnchanged })) },
  independent: { compile: { ok: compiled.ok, output: compiled.output.slice(-2_000) },
    verify: { ok: verified.ok, summary: junit ?? null, output: verified.output.slice(-2_000) } },
  workspaceChanges: changed, outsideWriteSet,
  passed: run.status === 'completed' && run.acceptance === 'behavior-verified' && compiled.ok && verified.ok && outsideWriteSet.length === 0,
};
await mkdir(path.dirname(path.resolve(values.output!)), { recursive: true });
await writeFile(path.resolve(values.output!), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
// The index store shares this pool; closing it closes the pool.
await store.close();
console.info(JSON.stringify({ stage: 'result', passed: report.passed, status: run.status, acceptance: run.acceptance, turns: run.modelTurns,
  error: run.error, junit: junit ?? null, changes: changed, output: path.resolve(values.output!) }, null, 2));
if (!report.passed) process.exitCode = 1;
