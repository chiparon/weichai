/**
 * Runs the agent module analysis for the enterprise asset repositories offline.
 *
 * Module analysis normally happens inside the workbench, where the extension host
 * owns the repository and the model key. This command drives the same host path —
 * the same adaptive tree builder, the same hierarchy planner over
 * /v1/module-hierarchy/decision, the same publication — without a window, so a
 * seven-repository dataset can be modelled in one run.
 *
 *   npx tsx scripts/model-asset-repositories.mts --repos apscheduler
 *   npx tsx scripts/model-asset-repositories.mts                  # every indexed asset repository
 *
 * The per-project model budget comes from the builder default (120 decisions).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  codeIntelligenceHostInternals,
  type RepositoryIdentityStore,
} from '../apps/vscode-extension/src/code-intelligence-host.js';
import { requestSemanticModuleMigrationProposal } from '../apps/vscode-extension/src/module-plan-client.js';
import { HttpModuleHierarchyPlanner } from '../apps/vscode-extension/src/module-hierarchy-client.js';

const argument = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const database = argument('database', process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE ?? 'forexplore_javafileupload_flow_20260913')!;
const adaptationApiUrl = argument('adaptation', process.env.ADAPTATION_API_URL ?? 'http://127.0.0.1:8788')!;
process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = database;
process.env.CODE_INTELLIGENCE_EMBEDDING_URL ??= 'http://127.0.0.1:4021/v1/embeddings';
process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ??= 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78';
process.env.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS ??= 'false';
process.env.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ??= 'query: ';
process.env.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ??= 'passage: ';
process.env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ??= '384';

const assetRoot = resolve('experiments/enterprise-asset-upgrade/source-repositories');
const available = existsSync(assetRoot)
  ? readdirSync(assetRoot).filter((name) => { try { return statSync(join(assetRoot, name)).isDirectory(); } catch { return false; } })
  : [];
const requested = argument('repos')?.split(',').map((value) => value.trim()).filter(Boolean)
  // A caller that names explicit paths does not want the whole dataset as well.
  ?? (argument('paths') ? [] : available);
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length) throw new Error(`Unknown asset repositories: ${unknown.join(', ')}. Available: ${available.join(', ')}`);

const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 2 });
// Every registered repository, so a path outside the dataset (a large external
// checkout registered in the same store) can be modelled too.
const [rows] = await pool.query<Array<{ repositoryId: string; localPath: string; activeRevision: string | null; displayName: string }>>(
  `SELECT repository_id AS repositoryId, local_path AS localPath, active_revision AS activeRevision, display_name AS displayName
   FROM repositories ORDER BY display_name`);
const extraPaths = argument('paths')?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
const inputs = [
  ...requested.map((name) => {
    const localPath = join(assetRoot, name);
    const row = rows.find((entry) => entry.localPath === localPath);
    return { name, localPath, row };
  }),
  ...extraPaths.map((path) => {
    const localPath = resolve(path);
    const row = rows.find((entry) => entry.localPath === localPath);
    return { name: row?.displayName ?? localPath, localPath, row };
  }),
].filter((input) => input.row?.activeRevision);
const missing = [...requested, ...extraPaths].filter((name) => !inputs.some((input) => input.name === name || input.localPath === resolve(name)));
for (const name of missing) console.log(`skipping ${name}: no active revision yet (index it first)`);
if (!inputs.length) { await pool.end(); throw new Error('Nothing to model: no selected repository has an active revision.'); }

/** Stands in for `context.globalState` so registered paths keep their repository identity. */
class MemoryState implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: string): Promise<void> { this.values.set(key, value); }
}
const identityStore = new MemoryState();
for (const row of rows) identityStore.values.set(codeIntelligenceHostInternals.stableIdentityKey(row.localPath), row.repositoryId);

let planCalls = 0;
const semanticPort = Number(argument('semantic-port', process.env.FOREXPLORE_SEMANTIC_QUERY_PORT ?? '8790'));
const host = new CodeIntelligenceHost({
  runtimeOptions: codeIntelligenceRuntimeOptionsFromEnvironment(process.env, { allowInMemory: false }),
  identityStore,
  planProject: async (scope) => {
    planCalls += 1;
    // The workbench starts this revision-scoped query port before asking for a plan;
    // without it the service answers "Revision-scoped semantic module planning is not
    // configured" and every project reports zero modules.
    await host.startSemanticQueryServer({
      port: semanticPort,
      bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
    });
    return requestSemanticModuleMigrationProposal(adaptationApiUrl, scope, undefined, AbortSignal.timeout(600_000));
  },
  hierarchyPlanner: new HttpModuleHierarchyPlanner(() => adaptationApiUrl),
  output: { appendLine: (line: string) => console.log(`    ${line}`) },
});

const started = Date.now();
try {
  for (const input of inputs) {
    console.log(`\n=== ${input.name} (${input.row!.activeRevision}) ===`);
    const synchronized = await host.synchronize({ repositories: [{ localPath: input.localPath, role: 'history' }] });
    const repository = synchronized.presentation.repositories[0];
    if (!repository) { console.log('  面板没有返回仓库，跳过'); continue; }
    // Enumerate projects from the database rather than from an explorer payload: the
    // synthetic bucket that holds files no project claims has no candidates, so
    // modelling it would report success with zero modules.
    const [projectRows] = await pool.query<Array<{ projectId: string; displayName: string | null; files: number }>>(
      `SELECT p.project_id AS projectId, p.display_name AS displayName, COUNT(f.file_id) AS files
       FROM projects p LEFT JOIN files f ON f.project_id = p.project_id AND f.analysis_revision = p.analysis_revision
       WHERE p.repository_id=? AND p.analysis_revision=? GROUP BY p.project_id, p.display_name
       ORDER BY files DESC`,
      [repository.repositoryId, repository.activeRevision]);
    const scopes = projectRows
      // Several asset checkouts contain only a source tree, so their single project
      // is the bucket for files no marker claims. Dropping it unconditionally left
      // nothing to model; it is only skipped when a real project exists.
      .filter((project, _, all) => all.length === 1 || !/未归属|unassigned/i.test(project.displayName ?? ''))
      .map((project) => ({ repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision!,
        projectId: project.projectId, displayName: project.displayName ?? project.projectId, fileCount: Number(project.files) }));
    const limit = Number(argument('max-projects', '0'));
    const selected = limit > 0 ? scopes.slice(0, limit) : scopes;
    console.log(`  工程 ${selected.length}/${scopes.length} 个，开始逐个建模`);
    for (const scope of selected) {
      const projectStarted = Date.now();
      process.stdout.write(`  建模 ${scope.displayName}（${scope.fileCount} 文件）… `);
      try {
        await host.retryProject({ repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, projectId: scope.projectId }, true);
        await host.waitForProjects();
      } catch (error) {
        console.log(`✗ ${(error as Error).message.slice(0, 160)}`);
        continue;
      }
      const analysis = (await host.explorerData()).find((item) => item.projectId === scope.projectId)?.analysis;
      const [stored] = await pool.query<Array<{ payload: unknown }>>(
        `SELECT payload FROM module_artifacts WHERE repository_id=? AND analysis_revision=? AND kind='module-summary' AND status='current'`,
        [scope.repositoryId, scope.analysisRevision]);
      // The published record carries the proposal under `proposal`, not at the top level.
      const record = stored
        .map((row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
          projectId?: string; state?: string; projection?: string; error?: string;
          proposal?: { modules?: Array<{ nodeKind?: string }>; hierarchy?: { modelDecisionCount?: number; deferredCount?: number; maxDepth?: number } };
        })
        .find((payload) => payload?.projectId === scope.projectId);
      const proposal = record?.proposal ?? analysis?.proposal;
      const hierarchy = proposal?.hierarchy;
      const modules = proposal?.modules ?? [];
      const failure = record?.error ?? (record?.state && record.state !== 'ready' ? `state=${record.state}` : undefined);
      console.log(`${record?.state === 'ready' ? '✓' : '✗'} 模块 ${modules.length}` +
        ` 子系统 ${modules.filter((module) => module.nodeKind === 'subsystem').length}` +
        ` 模型决策 ${hierarchy?.modelDecisionCount ?? 0} 待细化 ${hierarchy?.deferredCount ?? 0} 层深 ${hierarchy?.maxDepth ?? 0}` +
        ` 投影 ${record?.projection ?? '-'} 用时 ${Math.round((Date.now() - projectStarted) / 1000)}s` +
        (failure ? `  原因: ${String(failure).slice(0, 200)}` : ''));
    }
  }
} finally {
  host.dispose();
}

console.log('\n数据库里的模块产物:');
for (const input of inputs) {
  const [artifacts] = await pool.query<Array<{ kind: string; status: string; total: number }>>(
    `SELECT kind, status, COUNT(*) AS total FROM module_artifacts WHERE repository_id=? AND analysis_revision=? GROUP BY kind, status`,
    [input.row!.repositoryId, input.row!.activeRevision]);
  console.log(`  ${input.name}: ${artifacts.map((row) => `${row.kind}/${row.status}×${row.total}`).join(' ') || '(无)'}`);
}
await pool.end();
console.log(`\n建模结束：plan 调用 ${planCalls} 次，总用时 ${Math.round((Date.now() - started) / 1000)}s`);
