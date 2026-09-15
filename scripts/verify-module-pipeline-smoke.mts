/** Real-model smoke test. Uses an isolated fixture, real indexing/retrieval,
 * authenticated HTTP, filesystem writes, and Node gates. Optional SeekDB/model
 * embeddings and --model-analysis replace the default reviewed fixture metadata.
 * This deliberately does not claim to exercise the VS Code/browser UI wiring.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import type { ModuleTarget } from '@forexplore/contracts';
import { indexModuleHierarchy } from '@forexplore/contracts';
import { ModelModuleHierarchyPlanner } from '@forexplore/code-intelligence-service/module-hierarchy-planner';
import { completeWithDeepSeek } from '../services/adaptation-service/src/deepseek-client.js';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, ProjectAnalysisCoordinator,
  projectAnalysisObjective, projectPlanHash, createSemanticQueryHttpServer } from '@forexplore/code-intelligence-service';
import { prepareModuleTranslationScope } from '../apps/vscode-extension/src/module-translation-handoff.js';
import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';
import { WorkspaceTranslationRuntime } from '../services/adaptation-service/src/workspace-translation-runtime.js';
import { createWorkspaceTranslationModelClient } from '../services/adaptation-service/src/workspace-translation-agent.js';
import { createHttpServer } from '../services/adaptation-service/src/http-server.js';
import { HttpWorkspaceEvidencePort } from '../services/adaptation-service/src/http-workspace-evidence-port.js';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string' }, database: { type: 'string' },
  'embedding-url': { type: 'string' }, 'embedding-model': { type: 'string' },
  'model-analysis': { type: 'boolean', default: false },
  output: { type: 'string', default: 'tmp/pipeline-verification/live-smoke.json' },
} });
const env = values['env-file'] ? parse(await readFile(values['env-file'], 'utf8')) : process.env;
assert(env.DEEPSEEK_API_KEY, 'A configured DEEPSEEK_API_KEY is required.');
const output = path.resolve(values.output!);
await mkdir(path.dirname(output), { recursive: true });
const root = await mkdtemp(path.join(path.dirname(output), 'module-smoke-'));
const sourceRoot = path.join(root, 'history');
const targetRoot = path.join(root, 'target');
await mkdir(sourceRoot); await mkdir(targetRoot);
const source = `public final class LimitPolicy {
  // Increment a nonnegative integer; reject negatives and values over 100.
  public static int limit(int value) {
    if (value < 0 || value > 100) throw new IllegalArgumentException("range");
    return value + 1;
  }
}\n`;
const skeleton = 'import { isAllowed } from "./policy.ts";\nexport function limit(value: unknown): number { throw new Error("TODO"); }\n';
const policySkeleton = 'export function isAllowed(value: unknown): boolean { throw new Error("TODO"); }\n';
const verifier = `import assert from 'node:assert/strict';
import { limit } from './target.ts';
import { isAllowed } from './policy.ts';
for (let n = 0; n <= 100; n++) { assert.equal(limit(n), n + 1); assert.equal(isAllowed(n), true); }
for (const n of [-1, -50, 101, 10000, NaN, Infinity, 1.5, '2', null, undefined]) { assert.throws(() => limit(n)); assert.equal(isAllowed(n), false); }
console.log('222 boundary assertions passed');\n`;
await writeFile(path.join(sourceRoot, 'LimitPolicy.java'), source);
await writeFile(path.join(targetRoot, 'target.ts'), skeleton);
await writeFile(path.join(targetRoot, 'policy.ts'), policySkeleton);
const report: Record<string, unknown> = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  generatedAt: new Date().toISOString(), root, model: env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
  store: values.database ? (values['embedding-url'] ? 'SeekDB/model embeddings' : 'SeekDB/hash embeddings') : 'InMemoryIndexStore/lexical retrieval',
  database: values.database, embeddingModel: values['embedding-model'],
  moduleAnalysis: values['model-analysis'] ? 'Real model analysis of history and target' : 'Reviewed fixture metadata; model-based module analysis is not tested', passed: false };
const cleanups: Array<() => Promise<unknown>> = [];
const stage = (name: string, details: unknown) => console.log(JSON.stringify({ stage: name, details }));
try {
  assert(!values['embedding-url'] || (values.database && values['embedding-model']), 'Model embeddings require --database and --embedding-model.');
  const hierarchyPlanner = new ModelModuleHierarchyPlanner({ timeoutMs: 120_000,
    complete: (messages, signal) => completeWithDeepSeek(messages, { apiKey: () => env.DEEPSEEK_API_KEY!,
      jsonMode: true, temperature: 0, modelConfig: { apiBase: env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com/v1',
        model: env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash' } }, signal) });
  const seekdb = values.database ? {
    host: '127.0.0.1', port: 2881, user: 'root', password: '', database: values.database, vectorDimension: 384,
    ...(values['embedding-url'] ? { embedding: { url: values['embedding-url'], apiKey: '', model: values['embedding-model']!,
      supportsDimensions: false, queryPrefix: 'query: ', documentPrefix: 'passage: ' } } : {}),
  } : undefined;
  const intelligence = await createCodeIntelligenceRuntime({ ...(seekdb ? { seekdb } : { store: new InMemoryIndexStore() }),
    projectAnalysis: { hierarchyPlanner } });
  cleanups.push(() => intelligence.close());
  await intelligence.registry.register({ repositoryId: 'smoke-history', displayName: 'Java limit policy', role: 'history', localPath: sourceRoot });
  const indexed = await intelligence.coordinator.run({ repositoryId: 'smoke-history' });
  const index = (await intelligence.store.getStructuralIndex(indexed.scope))!;
  const projectScope = { ...indexed.scope, projectId: index.projects[0]!.projectId };
  const analysis = values['model-analysis'] ? intelligence.projectAnalysis : new ProjectAnalysisCoordinator({ store: intelligence.store, plan: async () => {
    const proposal = { ...projectScope, analysisHash: index.analysisHash, objective: projectAnalysisObjective,
      summary: 'Bounded integer increment policy', modules: [{ id: 'limit-policy', kind: 'feature', name: 'Limit policy',
        description: 'Increment integers in range 0 through 100 and reject values outside the range.',
        language: 'Java', coreApis: ['limit'], sourceFiles: ['LimitPolicy.java'], symbolKeys: [], dependsOn: [],
        evidenceIds: [`project:${projectScope.projectId}`] }] };
    return { proposal, evidence: { ...projectScope, analysisHash: index.analysisHash,
      planHash: projectPlanHash(proposal), evidenceIds: [`project:${projectScope.projectId}`] } };
  } });
  await analysis.ensure(projectScope);
  const historyAnalysis = await analysis.read(projectScope);
  assert.equal(historyAnalysis.state, 'ready', JSON.stringify(historyAnalysis));
  assert.equal(historyAnalysis.projection, 'ready');
  report.historyAnalysis = historyAnalysis;
  stage('history-analysis', { state: historyAnalysis.state, hierarchy: historyAnalysis.proposal?.hierarchy });
  let target: ModuleTarget = { id: 'module-limit', name: 'Limit policy', kind: 'module', path: 'target.ts',
    language: 'TypeScript', signature: 'limit(value)', module: { sourceFiles: ['target.ts', 'policy.ts'], coreApis: ['limit'], dependsOn: [] } };
  if (values['model-analysis']) {
    assert((historyAnalysis.proposal?.hierarchy?.modelDecisionCount ?? 0) > 0);
    await intelligence.registry.register({ repositoryId: 'smoke-target', displayName: 'TypeScript limit target', role: 'target', localPath: targetRoot });
    const targetIndexed = await intelligence.coordinator.run({ repositoryId: 'smoke-target' });
    const targetIndex = (await intelligence.store.getStructuralIndex(targetIndexed.scope))!;
    const targetScope = { ...targetIndexed.scope, projectId: targetIndex.projects[0]!.projectId };
    await intelligence.projectAnalysis.ensure(targetScope);
    const targetAnalysis = await intelligence.projectAnalysis.read(targetScope);
    report.targetAnalysis = targetAnalysis;
    assert.equal(targetAnalysis.state, 'ready', JSON.stringify(targetAnalysis));
    assert.equal(targetAnalysis.projection, 'ready');
    assert((targetAnalysis.proposal?.hierarchy?.modelDecisionCount ?? 0) > 0);
    const tree = indexModuleHierarchy(targetAnalysis.proposal!.modules);
    const module = tree.roots.find(node => {
      const files = tree.sourceFiles(node.id).files;
      return files.includes('target.ts') && files.includes('policy.ts');
    });
    assert(module, 'Model analysis must expose a module containing the complete target implementation.');
    const files = tree.sourceFiles(module.id).files;
    assert.deepEqual([...files].sort(), ['policy.ts', 'target.ts']);
    target = { ...target, id: module.id, name: module.name, module: { sourceFiles: files,
      coreApis: module.coreApis ?? [], dependsOn: module.dependsOn } };
    stage('target-analysis', { state: targetAnalysis.state, hierarchy: targetAnalysis.proposal?.hierarchy, files });
  }
  // Validation infrastructure is installed after the source snapshot; it is never part of the writable module.
  await writeFile(path.join(targetRoot, 'verify.mjs'), verifier);
  await writeFile(path.join(targetRoot, 'package.json'), '{"type":"module"}\n');
  const requirement = 'Translate the retrieved Java limit policy into a two-file TypeScript module. First query_evidence for the historical LimitPolicy implementation. Implement isAllowed(value) in policy.ts returning true only for numeric integers 0..100 inclusive, false otherwise. target.ts must import and use isAllowed and export limit(value), returning value + 1 when allowed and throwing otherwise. Reject out-of-range values, non-integers, NaN, Infinity and all non-number inputs. Preserve verify.mjs.';
  const candidates = await intelligence.moduleImplementationSearch.search({ target, requirement, topK: 3, repositoryIds: ['smoke-history'] });
  assert(candidates.length > 0, 'No module recalled.');
  const top = candidates[0]!;
  assert.equal(top.kind, 'module'); assert(top.sourceModule);
  const m = top.sourceModule;
  report.retrieval = { candidates: candidates.length, top: top.title, score: top.score, sourceModule: m };
  stage('retrieved', report.retrieval);
  if (seekdb) {
    const reopened = await createCodeIntelligenceRuntime({ seekdb, projectAnalysis: { hierarchyPlanner } });
    try {
      const restoredAnalysis = await reopened.projectAnalysis.read(projectScope);
      assert.equal(restoredAnalysis.planHash, historyAnalysis.planHash);
      const persistedCandidates = await reopened.moduleImplementationSearch.search({ target, requirement, topK: 3, repositoryIds: ['smoke-history'] });
      assert.equal(persistedCandidates[0]?.id, top.id, 'Retrieval changed after reopening SeekDB.');
      report.persistence = { passed: true, candidates: persistedCandidates.length, planHash: restoredAnalysis.planHash };
      stage('persistence', report.persistence);
    } finally { await reopened.close(); }
  }
  const scope = await prepareModuleTranslationScope({ workspaceRoot: targetRoot, target, candidate: top,
    requirement, decisionNotes: 'Use .ts extensions in imports and keep public parameters typed as unknown.', includeCandidateContext: false });
  const queryServer = createSemanticQueryHttpServer({ queryPort: intelligence.queryPort, taskRetrieval: intelligence.taskRetrieval });
  await new Promise<void>(resolve => queryServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => queryServer.close(e => e ? reject(e) : resolve())));
  const queryUrl = `http://127.0.0.1:${(queryServer.address() as AddressInfo).port}`;
  const runtime = new WorkspaceTranslationRuntime({ workspaceRoot: targetRoot,
    compileCommand: { executable: process.execPath, args: [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--allowImportingTsExtensions',
      '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--strict', 'target.ts', 'policy.ts'] },
    verification: { command: { executable: process.execPath, args: ['verify.mjs'] }, protectedFiles: ['verify.mjs', 'package.json'] },
    evidence: { port: new HttpWorkspaceEvidencePort({ endpoint: queryUrl }) }, maxModelTurns: 24, timeoutMs: 600_000,
    client: createWorkspaceTranslationModelClient({ apiKey: () => env.DEEPSEEK_API_KEY!, temperature: 0,
      modelConfig: { apiBase: env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com/v1', model: env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash' } }),
  });
  cleanups.push(() => runtime.shutdown());
  const token = randomBytes(32).toString('hex');
  const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Not used by workspace translation'); } },
    workspaceTranslation: { runtime, bearerToken: token } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${url}/v1/workspace-translations/configuration`)).status, 401);
  const config = { url, token };
  const host = new WorkspaceTranslationHost(() => config);
  const moduleScopeId = host.rememberModuleScope(scope);
  const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe', action: 'describe', moduleScopeId });
  assert(described.type === 'WORKSPACE_TRANSLATION_RESULT' && described.profile);
  const started = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'start', action: 'start', moduleScopeId,
    profileId: described.profile.profileId });
  assert(started.type === 'WORKSPACE_TRANSLATION_RESULT' && started.run, JSON.stringify(started));
  let run = started.run; let last = '';
  const deadline = Date.now() + 660_000;
  while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const response = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'poll', action: 'read', runId: run.id });
    assert(response.type === 'WORKSPACE_TRANSLATION_RESULT' && response.run);
    run = response.run;
    const progress = `${run.status} turns=${run.modelTurns} changes=${run.changes.length}`;
    if (last !== progress) { stage('translation', progress); last = progress; }
  }
  report.run = run;
  assert.equal(run.status, 'completed', JSON.stringify({ status: run.status, error: run.error }));
  assert.equal(run.acceptance, 'behavior-verified');
  assert.deepEqual([...new Set(run.changes.map(change => change.path))].sort(), ['policy.ts', 'target.ts']);
  assert((run.evidenceQueries?.length ?? 0) > 0, 'The model must retrieve historical evidence.');
  assert(run.evidenceQueries?.some(query => query.excerptCount > 0), 'At least one historical evidence query must return source excerpts.');
  assert.equal(await readFile(path.join(targetRoot, 'verify.mjs'), 'utf8'), verifier);
  const generated = await readFile(path.join(targetRoot, 'target.ts'), 'utf8');
  assert.notEqual(generated, skeleton);
  report.independentVerification = execFileSync(process.execPath, ['verify.mjs'], { cwd: targetRoot, encoding: 'utf8' }).trim();
  await writeFile(path.join(root, 'generated.ts'), generated);
  await writeFile(path.join(root, 'generated-policy.ts'), await readFile(path.join(targetRoot, 'policy.ts'), 'utf8'));
  const restoredHost = new WorkspaceTranslationHost(() => config);
  const rolled = await restoredHost.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'rollback', action: 'rollback', runId: run.id });
  assert(rolled.type === 'WORKSPACE_TRANSLATION_RESULT' && rolled.run?.status === 'rolled-back', JSON.stringify(rolled));
  assert.equal(await readFile(path.join(targetRoot, 'target.ts'), 'utf8'), skeleton);
  assert.equal(await readFile(path.join(targetRoot, 'policy.ts'), 'utf8'), policySkeleton);
  report.rollback = 'passed'; report.passed = true;
  stage('passed', { verification: report.independentVerification, rollback: report.rollback });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  stage('failed', report.error); process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  for (const cleanup of cleanups.reverse()) await cleanup();
  console.log(`Report: ${output}`);
}
