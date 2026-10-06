/**
 * Runs the RECAST module pipeline for a real target project, offline.
 *
 * The workbench normally drives this chain by hand: index the target, review its
 * module tree, pick a module, let retrieval propose a history candidate, confirm the
 * candidate, and translate. This command performs the same chain for every module of
 * the target project without a window, so an enterprise dataset can be measured
 * end to end:
 *
 *   index target -> module plan -> Top-1 history candidate per module ->
 *   prepareModuleTranslationScope -> host-created history-view ->
 *   CodexWorkspaceTranslationRuntime -> host compile/verification gates
 *
 *   npx tsx scripts/run-target-module-pipeline.mts --target experiments/enterprise-asset-upgrade/target-project --dry-run
 *   npx tsx scripts/run-target-module-pipeline.mts --target <path> --top-k 1 --out results/module-pipeline.json
 *
 * Options
 *   --target <path>      target project root (required)
 *   --database <name>    SeekDB database (default forexplore_asset_upgrade_20261004)
 *   --top-k <n>          retrieval width; Top-1 means 1 (default 1)
 *   --max-modules <n>    stop after n modules (default 0 = every module)
 *   --repos <a,b,c>      retrieval scope; default every indexed asset repository.
 *                        The dataset's tasks each name two to four assets, and a
 *                        narrower scope also keeps one module search inside the
 *                        production 60s budget while another repository is indexing.
 *   --dry-run            plan + retrieval only: no translation, no writes to the target
 *   --out <json>         report path (default results/target-module-pipeline.json)
 *
 * Gates. Nothing here shortens a host gate. The compile command is the one
 * ADAPTATION_WORKSPACE_COMPILE_COMMAND carries when it is set — the same variable the
 * extension passes to its backend — and otherwise it is derived from the target's own
 * build file. Behavioural verification is active only when
 * ADAPTATION_WORKSPACE_VERIFICATION is set, exactly as in production, where the host
 * declares criteria and the runtime may never supply its own; without it the module
 * is compilation-gated only and the report says so. The hidden acceptance suites are
 * deliberately *not* wired here: they run after translation, as the outer gate.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { chmod, cp, mkdir, readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import type { RowDataPacket } from 'mysql2';
import { parse as parseEnvironmentFile } from 'dotenv';
import type { Language, ModuleTarget, ProjectModule, ProjectModuleProposal, SearchCandidate, WorkspaceCompileCommand } from '@forexplore/contracts';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  codeIntelligenceHostInternals,
  type RepositoryIdentityStore,
} from '../apps/vscode-extension/src/code-intelligence-host.js';
import { requestSemanticModuleMigrationProposal } from '../apps/vscode-extension/src/module-plan-client.js';
import { HttpModuleHierarchyPlanner } from '../apps/vscode-extension/src/module-hierarchy-client.js';
import { prepareModuleTranslationScope } from '../apps/vscode-extension/src/module-translation-handoff.js';
import { WorkspaceTranslationHost } from '../apps/vscode-extension/src/workspace-translation-host.js';
import { CodexWorkspaceTranslationRuntime } from '../services/adaptation-service/src/codex-workspace-translation-runtime.js';
import { createHttpServer } from '../services/adaptation-service/src/http-server.js';
import { createAgentHost } from '../services/translation-verifier/src/host/runtime.js';
import { createTranslationVerifierModelClient } from '../services/translation-verifier/src/host/model-client.js';
import { createFunctionGroupVerifier } from '../services/translation-verifier/src/function-group-verify.js';
import type { SingleAgentFunctionGroupTerminalResult } from '../services/translation-verifier/src/strategies/single-agent-function-group/strategy.js';
import type { FunctionGroupVerificationInput, FunctionGroupVerificationResult } from '../services/translation-verifier/src/types.js';

const argument = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

if (flag('help')) {
  console.log('usage: npx tsx scripts/run-target-module-pipeline.mts --target <path> [--database <name>] ' +
    '[--top-k <n>] [--max-modules <n>] [--dry-run] [--out <json>]');
  process.exit(0);
}

const targetArgument = argument('target');
if (!targetArgument) throw new Error('--target <path> is required.');
const targetRoot = resolve(targetArgument);
if (!existsSync(targetRoot) || !statSync(targetRoot).isDirectory()) throw new Error(`Target project root is not a directory: ${targetRoot}`);
const database = argument('database', process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE ?? 'forexplore_asset_upgrade_20261004')!;
const topK = Number(argument('top-k', '1'));
if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new Error('--top-k must be between 1 and 10 (Top-1 means 1).');
const maxModules = Number(argument('max-modules', '0'));
if (!Number.isInteger(maxModules) || maxModules < 0) throw new Error('--max-modules must be a non-negative integer.');
const dryRun = flag('dry-run');
const outputPath = resolve(argument('out', 'results/target-module-pipeline.json')!);
const adaptationApiUrl = argument('adaptation', process.env.ADAPTATION_API_URL ?? 'http://127.0.0.1:8788')!;
const semanticPort = Number(argument('semantic-port', process.env.FOREXPLORE_SEMANTIC_QUERY_PORT ?? '8790'));
const assetRoot = resolve('experiments/enterprise-asset-upgrade/source-repositories');

/** History views are intentionally read-only while an Agent can see them. */
async function removeReadOnlyTree(root: string): Promise<void> {
  try {
    await chmod(root, 0o755);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = join(root, entry.name);
      if (entry.isDirectory()) await removeReadOnlyTree(child);
      else await chmod(child, 0o644);
    }
    await rm(root, { recursive: true, force: true });
  } catch {
    // Cleanup is best effort; the verifier result remains valid if the host
    // process cannot remove an already detached temporary tree.
  }
}

/**
 * SeekDB may have been populated by the Windows extension host while this
 * driver is running under WSL.  Repository rows then carry an E:\\... path,
 * which is semantically the same checkout as the current Linux workspace but
 * cannot be passed directly to existsSync or the indexer.  Resolve the known
 * workspace suffix against the current checkout first, then fall back to the
 * conventional /mnt/<drive> mapping.
 */
function resolveRegisteredPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const workspaceMarker = /[\\/]weichai[\\/]/i.exec(normalized);
  if (workspaceMarker && workspaceMarker.index !== undefined) {
    const suffix = normalized.slice(workspaceMarker.index + workspaceMarker[0].length);
    const local = resolve(process.cwd(), suffix);
    if (existsSync(local)) return local;
  }
  if (/^[A-Za-z]:\//.test(normalized)) {
    const drive = normalized[0]!.toLowerCase();
    const local = resolve(`/mnt/${drive}${normalized.slice(2)}`);
    if (existsSync(local)) return local;
  }
  return resolve(value);
}

// The model key normally arrives through the service environment file; keep the
// offline driver independent of a shell that exported it.
const environmentFile = resolve('services/adaptation-service/.env');
if (existsSync(environmentFile)) {
  for (const [key, value] of Object.entries(parseEnvironmentFile(readFileSync(environmentFile)))) {
    if (!process.env[key]?.trim()) process.env[key] = value;
  }
}
// Resolve model settings once for the retrieval/rerank side. The translation
// Agent itself is Codex CLI and uses the user's Codex credential/configuration.
const modelApiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? readEnvironmentFileValue('DEEPSEEK_API_KEY');
const workspaceAgent = process.env.ADAPTATION_WORKSPACE_AGENT?.trim().toLowerCase() || 'codex';
if (!dryRun && workspaceAgent === 'legacy' && !modelApiKey) throw new Error('A configured DEEPSEEK_API_KEY is required for the legacy workspace Agent loop.');
function readEnvironmentFileValue(key: string): string | undefined {
  if (!existsSync(environmentFile)) return undefined;
  return parseEnvironmentFile(readFileSync(environmentFile))[key]?.trim();
}

process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = database;
process.env.CODE_INTELLIGENCE_EMBEDDING_URL ??= 'http://127.0.0.1:4021/v1/embeddings';
process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ??= 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78';
process.env.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS ??= 'false';
process.env.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ??= 'query: ';
process.env.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ??= 'passage: ';
process.env.CODE_INTELLIGENCE_EMBEDDING_VARIANT ??= 'dml-fp16';
process.env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ??= '384';

/** The runtime between modules; every gap is a chance for SeekDB to checkpoint. */
async function waitForSeekDb(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reachable = await new Promise<boolean>((resolveProbe) => {
      const socket = connect({ host: '127.0.0.1', port: 2881 });
      socket.once('connect', () => { socket.destroy(); resolveProbe(true); });
      socket.once('error', () => { socket.destroy(); resolveProbe(false); });
      socket.setTimeout(5_000, () => { socket.destroy(); resolveProbe(false); });
    });
    if (reachable) return;
    if (Date.now() >= deadline) throw new Error('SeekDB is not listening on 127.0.0.1:2881.');
    console.log('    waiting for SeekDB on 127.0.0.1:2881 ...');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
}

/**
 * Host-owned command resolution. The extension passes JSON through these two
 * variables; when no compile command is configured the driver derives one from the
 * target's own build file rather than inventing a no-op gate.
 */
function resolveCompileCommand(): WorkspaceCompileCommand {
  const configured = process.env.ADAPTATION_WORKSPACE_COMPILE_COMMAND?.trim();
  if (configured) {
    const parsed = JSON.parse(configured) as WorkspaceCompileCommand;
    if (!parsed?.executable || !Array.isArray(parsed.args)) throw new Error('ADAPTATION_WORKSPACE_COMPILE_COMMAND must carry executable and args.');
    return parsed;
  }
  const entries = readdirSync(targetRoot);
  const solution = entries.find((name) => name.endsWith('.sln'));
  const project = entries.find((name) => name.endsWith('.csproj')) ??
    readdirSync(targetRoot).map((name) => join('src', name)).find((candidate) => existsSync(join(targetRoot, candidate, '')) );
  if (solution) return { executable: 'dotnet', args: ['build', solution, '--nologo', '--verbosity', 'quiet'], timeoutMs: 900_000 };
  if (project && !project.includes('/') && entries.includes(project)) return { executable: 'dotnet', args: ['build', project, '--nologo', '--verbosity', 'quiet'], timeoutMs: 900_000 };
  if (entries.includes('pom.xml')) return { executable: 'mvn', args: ['-q', '-DskipTests', 'package'], timeoutMs: 1_200_000 };
  if (entries.includes('package.json')) return { executable: 'npm', args: ['run', '--silent', 'build'], timeoutMs: 900_000 };
  throw new Error(`No compile command is configured and none could be derived from ${targetRoot}. ` +
    'Set ADAPTATION_WORKSPACE_COMPILE_COMMAND, the same variable the extension passes to its backend.');
}

function resolveVerification(): { command: WorkspaceCompileCommand; protectedFiles: string[] } | undefined {
  const configured = process.env.ADAPTATION_WORKSPACE_VERIFICATION?.trim();
  if (!configured) return undefined;
  const parsed = JSON.parse(configured) as { command?: WorkspaceCompileCommand; protectedFiles?: unknown };
  if (!parsed?.command?.executable || !Array.isArray(parsed.command.args)) throw new Error('ADAPTATION_WORKSPACE_VERIFICATION must carry a command.');
  if (!Array.isArray(parsed.protectedFiles) || !parsed.protectedFiles.length || parsed.protectedFiles.some((path) => typeof path !== 'string')) {
    throw new Error('ADAPTATION_WORKSPACE_VERIFICATION must carry a non-empty protectedFiles list.');
  }
  return { command: parsed.command, protectedFiles: parsed.protectedFiles as string[] };
}

/**
 * Dependency/plan order over the modules that actually own files. Split nodes carry
 * no file list of their own, so only leaves become translation targets; a dependency
 * cycle keeps the traversal order instead of failing the whole plan.
 */
function orderModules(modules: readonly ProjectModule[]): ProjectModule[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const leaves = modules.filter((module) => (module.sourceFiles ?? []).length > 0);
  const ordered: ProjectModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (module: ProjectModule) => {
    const seen = state.get(module.id);
    if (seen === 'done' || seen === 'visiting') return;
    state.set(module.id, 'visiting');
    for (const dependency of module.dependsOn ?? []) {
      const next = byId.get(dependency);
      if (next && (next.sourceFiles ?? []).length > 0) visit(next);
    }
    state.set(module.id, 'done');
    ordered.push(module);
  };
  for (const module of leaves) visit(module);
  return ordered;
}

interface ModuleReport {
  moduleId: string;
  module: string;
  language?: string;
  sourceFiles: string[];
  requirement: string;
  writeFiles?: string[];
  candidate?: { repository: string; name: string; moduleId: string; language: string; score: number; hybrid?: number; rerank?: number; title: string };
  candidatesConsidered?: number;
  /** Set when the first history search hit the store's query budget and was retried. */
  retrievalRetry?: string;
  status: 'planned' | 'retrieved' | 'completed' | 'failed' | 'skipped';
  turns?: number;
  acceptance?: string;
  changedPaths?: string[];
  /** Why a still-running module was stopped early, e.g. an accepted-plan/change drought. */
  stoppedEarly?: string;
  /** Runtime event tail, kept for non-completed runs: tool choice, tool failure, nudges. */
  events?: string[];
  wallMs?: number;
  error?: string;
  translationVerification?: FunctionGroupVerificationResult;
}

const report = {
  generatedAt: new Date().toISOString(),
  dryRun,
  database,
  targetRoot,
  topK,
  gates: {} as { compile: string; verification: string | undefined; hiddenSuite: string },
  target: {} as { repositoryId?: string; analysisRevision?: string; projectId?: string; project?: string; modules?: number; hierarchy?: unknown },
  modules: [] as ModuleReport[],
};

await waitForSeekDb(Number(argument('wait-db', '600')) * 1000);
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 2 });
await pool.query('SET SESSION ob_query_timeout = 120000000');

/** Stands in for `context.globalState`: registered paths keep their repository identity. */
class MemoryState implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

const [registered] = await pool.query<Array<RowDataPacket & { repositoryId: string; localPath: string; activeRevision: string | null; displayName: string; role: string }>>(
  `SELECT repository_id AS repositoryId, local_path AS localPath, active_revision AS activeRevision,
     display_name AS displayName, role FROM repositories`);
const identityStore = new MemoryState();
const nativeIdentityKeys = new Set<string>();
// A previous WSL run may have left a second POSIX registration with no active
// revision next to the Windows-hosted row. Prefer the active persisted row when
// both resolve to the same local checkout, otherwise the null revision would
// shadow the usable historical identity.
const identityRows = [...registered].sort((left, right) => Number(Boolean(right.activeRevision)) - Number(Boolean(left.activeRevision)));
for (const row of identityRows) {
  // Preserve the persisted identity across Windows-hosted database rows and
  // the WSL path that the current process can actually open.
  identityStore.values.set(codeIntelligenceHostInternals.stableIdentityKey(row.localPath), row.repositoryId);
  const localPath = resolveRegisteredPath(row.localPath);
  const localKey = codeIntelligenceHostInternals.stableIdentityKey(localPath);
  // Prefer a path written by the current platform when the shared database
  // also contains a translated path from the other worktree. This matters for
  // a target that was first indexed by Windows: retaining that ID here would
  // make the WSL scanner reopen the inaccessible E:\\ path.
  const normalizedStored = row.localPath.replaceAll('\\', '/');
  const nativePath = process.platform === 'win32'
    ? normalizedStored.length >= 3 && normalizedStored[1] === ':' && normalizedStored[2] === '/'
    : normalizedStored.startsWith('/');
  if (!identityStore.values.has(localKey) || (nativePath && !nativeIdentityKeys.has(localKey))) {
    identityStore.values.set(localKey, row.repositoryId);
    if (nativePath) nativeIdentityKeys.add(localKey);
  }
}

// Retrieval may only draw on history revisions that are actually queryable; a
// repository that is mid-scan has no active revision and cannot serve candidates.
const historyRepositories = registered
  .map((row) => ({ ...row, localPath: resolveRegisteredPath(row.localPath) }))
  .filter((row) => row.role === 'history' && row.activeRevision && existsSync(row.localPath))
  .map((row) => ({ localPath: row.localPath, displayName: row.displayName, repositoryId: row.repositoryId }));
const assetNames = argument('repos')?.split(',').map((value) => value.trim()).filter(Boolean);
const assets = historyRepositories.filter((row) => row.localPath.startsWith(assetRoot) &&
  (!assetNames || assetNames.includes(row.localPath.replaceAll('\\', '/').split('/').at(-1) ?? '')));
if (assetNames) {
  const availableAssets = historyRepositories.filter((row) => row.localPath.startsWith(assetRoot))
    .map((row) => row.localPath.replaceAll('\\', '/').split('/').at(-1));
  const unknown = assetNames.filter((name) => !availableAssets.includes(name));
  if (unknown.length) throw new Error(`--repos names repositories without an active revision: ${unknown.join(', ')}. Indexed assets: ${availableAssets.join(', ')}`);
}
// Retrieval draws on exactly the repositories named by --repos (or every indexed
// asset). The target is not a retrieval source, so it is never in this list.
const retrievalRepositories = assetNames ? assets : historyRepositories;
console.log(`database=${database}  history repositories=${historyRepositories.length}（asset ${assets.length}）`);
for (const row of assets) console.log(`  asset: ${row.displayName}`);

let semanticEndpoint: string | undefined;
const codeIntelligence = new CodeIntelligenceHost({
  runtimeOptions: codeIntelligenceRuntimeOptionsFromEnvironment(process.env, { allowInMemory: false }),
  identityStore,
  planProject: async (scope) => {
    // The revision-scoped query port must exist before the service will plan; the
    // workbench starts it the same way before asking for a plan.
    semanticEndpoint = await codeIntelligence.startSemanticQueryServer({
      port: semanticPort,
      bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN?.trim() || undefined,
    });
    return requestSemanticModuleMigrationProposal(adaptationApiUrl, scope, undefined, AbortSignal.timeout(600_000));
  },
  hierarchyPlanner: new HttpModuleHierarchyPlanner(() => adaptationApiUrl),
  output: { appendLine: (line: string) => console.log(`    ${line}`) },
});

const cleanups: Array<() => Promise<unknown>> = [];
try {
  // The target registers and scans first; the assets are only made visible so
  // retrieval can see them, which is why they are synchronized without a scan.
  console.log('\n=== target: register/index ===');
  await codeIntelligence.synchronize({ repositories: [{ localPath: targetRoot, role: 'target' }], scan: true });
  // Read the registered row back from the database: the presentation payload is a
  // panel view, while the registry row carries the identity this run must pin.
  const [targetRows] = await pool.query<Array<RowDataPacket & { repositoryId: string; localPath: string; activeRevision: string | null; displayName: string; analysisStatus: string }>>(
    `SELECT repository_id AS repositoryId, local_path AS localPath, active_revision AS activeRevision, display_name AS displayName,
       analysis_status AS analysisStatus FROM repositories WHERE role='target'`);
  // The shared SeekDB may contain the same checkout registered by Windows and
  // WSL. Compare the host-resolved paths instead of the persisted spelling.
  const targetRepositoryId = identityStore.get<string>(codeIntelligenceHostInternals.stableIdentityKey(targetRoot));
  const targetRepository = targetRows.find((row) => row.repositoryId === targetRepositoryId) ??
    targetRows.find((row) => resolveRegisteredPath(row.localPath) === targetRoot);
  if (!targetRepository) throw new Error('The target project was not registered.');
  console.log(`  ${targetRepository.displayName} status=${targetRepository.analysisStatus} revision=${targetRepository.activeRevision ?? '(none)'}`);
  if (!targetRepository.activeRevision) throw new Error(`The target project has no active revision after indexing (status ${targetRepository.analysisStatus}).`);

  if (retrievalRepositories.length) {
    // scan:false is essential here. Synchronization defaults to scanning, and a scan
    // of seven large assets (camel alone is 8,265 files) would run for a very long
    // time just to make them visible to retrieval.
    await codeIntelligence.synchronize({
      repositories: retrievalRepositories.map((row) => ({ localPath: row.localPath, role: 'history' as const })),
      scan: false,
    });
    const visible = await codeIntelligence.explorerData();
    console.log(`  可见仓库：${visible.map((entry) => `${entry.repository.displayName}:${entry.repository.repositoryId}:${entry.repository.activeRevision ?? 'none'}`).join(', ')}`);
  }

  const targetScope = { repositoryId: targetRepository.repositoryId, analysisRevision: targetRepository.activeRevision };
  const [projectRows] = await pool.query<Array<RowDataPacket & { projectId: string; displayName: string | null; files: number }>>(
    `SELECT p.project_id AS projectId, p.display_name AS displayName, COUNT(f.file_id) AS files
     FROM projects p LEFT JOIN files f ON f.project_id = p.project_id AND f.analysis_revision = p.analysis_revision
     WHERE p.repository_id=? AND p.analysis_revision=? GROUP BY p.project_id, p.display_name ORDER BY files DESC`,
    [targetScope.repositoryId, targetScope.analysisRevision]);
  // The synthetic bucket holds files no project claims. It is only a target of last
  // resort, because a real project always describes the implementation better.
  const real = projectRows.filter((project) => !/未归属|unassigned/i.test(project.displayName ?? ''));
  const chosen = (real.length ? real : projectRows)[0];
  if (!chosen) throw new Error('The target revision has no project to plan.');
  console.log(`  project: ${chosen.displayName ?? chosen.projectId}（${chosen.files} 文件）`);

  console.log('\n=== target: module plan ===');
  const projectScope = { ...targetScope, projectId: chosen.projectId };
  const [previousPlanRows] = await pool.query<Array<RowDataPacket & { updatedAt: string }>>(
    `SELECT updated_at AS updatedAt FROM module_artifacts
       WHERE repository_id=? AND analysis_revision=? AND module_artifact_id=? AND status='current'`,
    [targetScope.repositoryId, targetScope.analysisRevision, `project-job:${chosen.projectId}:code-understanding/v1`]);
  const previousPlanUpdatedAt = previousPlanRows[0]?.updatedAt ? String(previousPlanRows[0].updatedAt) : undefined;
  await codeIntelligence.retryProject(projectScope, true);
  // retryProject schedules the analysis and returns; waitForProjects() can observe an
  // empty run set before the scheduled run registers itself, so the published record
  // is polled for instead of trusting a single idle() call.
  const planDeadline = Date.now() + Number(argument('plan-timeout-ms', '1200000'));
  let record: { projectId?: string; state?: string; error?: string; proposal?: ProjectModuleProposal; updatedAt?: string } | undefined;
  for (;;) {
    const [artifactRows] = await pool.query<Array<RowDataPacket & { payload: unknown; updatedAt: string }>>(
      `SELECT payload, updated_at AS updatedAt FROM module_artifacts WHERE repository_id=? AND analysis_revision=?
         AND kind IN ('module-summary', 'other') AND status='current' ORDER BY updated_at DESC`,
      [targetScope.repositoryId, targetScope.analysisRevision]);
    record = artifactRows
      .map((row) => ({ ...(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as {
        projectId?: string; state?: string; error?: string; proposal?: ProjectModuleProposal;
      }, updatedAt: String(row.updatedAt) }))
      .find((payload) => payload?.projectId === chosen.projectId);
    if (record && (record.state === 'ready' || record.state === 'failed') && record.updatedAt !== previousPlanUpdatedAt) break;
    if (Date.now() >= planDeadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  if (!record || record.state !== 'ready' || !record.proposal) {
    throw new Error(`Module plan did not publish for ${chosen.projectId}: ${record?.error ?? record?.state ?? 'no artifact'}`);
  }
  const proposal = record.proposal;
  const ordered = orderModules(proposal.modules ?? []);
  report.target = { repositoryId: targetScope.repositoryId, analysisRevision: targetScope.analysisRevision,
    projectId: chosen.projectId, project: chosen.displayName ?? chosen.projectId,
    modules: ordered.length, hierarchy: proposal.hierarchy };
  console.log(`  模块 ${proposal.modules?.length ?? 0} 个，其中有文件清单（可翻译）${ordered.length} 个`);
  console.log(`  层级: ${JSON.stringify(proposal.hierarchy)}`);

  const selected = maxModules > 0 ? ordered.slice(0, maxModules) : ordered;
  const compileCommand = resolveCompileCommand();
  const verification = resolveVerification();
  report.gates = { compile: `${compileCommand.executable} ${compileCommand.args.join(' ')}`,
    verification: verification ? `${verification.command.executable} ${verification.command.args.join(' ')}` : undefined,
    hiddenSuite: 'run after translation: experiments/enterprise-asset-upgrade/evaluation/run-hidden-evaluation.sh' };
  console.log(`\n  编译门槛: ${report.gates.compile}`);
  console.log(`  行为验证: ${report.gates.verification ?? '未配置（本轮只做编译门槛；隐藏验收套件在翻译后单独跑）'}`);

  // The translation side is built once and reused, exactly like the backend the
  // extension owns; it is only created for a real run.
  let translation: { host: WorkspaceTranslationHost } | undefined;
  if (!dryRun) {
    if (workspaceAgent !== 'codex') throw new Error(`Unsupported pipeline workspace agent: ${workspaceAgent}. Set ADAPTATION_WORKSPACE_AGENT=codex.`);
    const runtime = new CodexWorkspaceTranslationRuntime({
      workspaceRoot: targetRoot,
      compileCommand,
      ...(verification ? { verification } : {}),
      codexCommand: process.env.ADAPTATION_CODEX_COMMAND?.trim() || process.env.CODEX_BIN?.trim() || 'codex',
      codexModel: process.env.ADAPTATION_CODEX_MODEL?.trim() || process.env.CODEX_MODEL?.trim() || undefined,
      maxModelTurns: Number(process.env.ADAPTATION_WORKSPACE_MAX_TURNS ?? 4),
      timeoutMs: Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000),
    });
    cleanups.push(() => runtime.shutdown());
    const token = randomBytes(32).toString('hex');
    const server = createHttpServer({ adapter: { adapt: async () => { throw new Error('Not used by workspace translation'); } },
      workspaceTranslation: { runtime, bearerToken: token } });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())));
    translation = { host: new WorkspaceTranslationHost(() => ({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token })) };
  }

  console.log(`\n=== module pipeline（${dryRun ? 'dry-run' : 'real'}，topK=${topK}，模块 ${selected.length}）===`);
  for (const [index, module] of selected.entries()) {
    const started = Date.now();
    const language = (module.language ?? 'CSharp') as Language;
    const requirement = [module.purpose ?? module.description, `目标语言：${language}`, `目标工程：${report.target.project}`]
      .filter(Boolean).join('\n');
    const entry: ModuleReport = { moduleId: module.id, module: module.name, language, sourceFiles: module.sourceFiles,
      requirement, status: 'planned' };
    report.modules.push(entry);
    console.log(`\n[${index + 1}/${selected.length}] ${module.name}（${module.sourceFiles.length} 文件, ${language}）`);
    try {
      const target: ModuleTarget = {
        id: module.id, name: module.name, kind: 'module', path: module.sourceFiles[0]!, language,
        signature: module.coreApis?.[0] ?? module.name,
        module: { repositoryId: targetScope.repositoryId, analysisRevision: targetScope.analysisRevision,
          projectId: chosen.projectId, sourceFiles: module.sourceFiles, coreApis: module.coreApis ?? [], dependsOn: module.dependsOn ?? [] },
      };
      // The first search in a fresh process can exceed the store's 60s query budget
      // while the query embedding and module index warm up. Retry that specific
      // timeout once and record it, so the fragility stays visible instead of
      // looking like a missing candidate.
      let candidates: SearchCandidate[] = [];
      const retrievalStart = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          candidates = await codeIntelligence.searchHistoricalImplementations({ target, requirement, topK });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt > 0 || !/timeout|aborted/i.test(message)) throw error;
          entry.retrievalRetry = message.slice(0, 200);
          console.log(`    ! 首次检索超时，重试一次：${message.slice(0, 120)}`);
          await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
        }
      }
      entry.candidatesConsidered = candidates.length;
      entry.retrievalMs = Date.now() - retrievalStart;
      // A parent/subsystem hit can carry no concrete files in an older module
      // projection. It cannot produce a history-view, so select the first
      // usable module within the requested retrieval width and report a clean
      // skip when none is available.
      const top = candidates.find((candidate) => candidate.kind === 'module' &&
        Boolean(candidate.sourceModule?.sourceFiles?.length));
      if (!top) {
        entry.status = 'skipped';
        entry.error = 'no history candidate with source files';
        console.log('  ✗ 历史候选没有可读取的源文件清单');
        continue;
      }
      if (top.kind !== 'module' || !top.sourceModule) { entry.status = 'skipped'; entry.error = `candidate kind ${top.kind}`; console.log(`  ✗ 候选不是模块：${top.kind}`); continue; }
      entry.status = 'retrieved';
      entry.candidate = { repository: top.repository, name: top.sourceModule.name, moduleId: top.sourceModule.moduleId,
        language: top.language, score: top.score.overall, ...(top.score.hybrid === undefined ? {} : { hybrid: top.score.hybrid }),
        ...(top.score.rerank === undefined ? {} : { rerank: top.score.rerank }), title: top.title };
      console.log(`  Top-1: ${top.repository} / ${top.sourceModule.name}  score=${top.score.overall.toFixed(3)}` +
        `${top.score.hybrid === undefined ? '' : ` hybrid=${top.score.hybrid.toFixed(3)}`}（候选 ${candidates.length}）`);

      let verifierSourceRoot: string | undefined;
      let historyViewRoot: string | undefined;
      try {
        const historyView = dryRun ? undefined : await codeIntelligence.createHistoryModuleView({
          workspaceRoot: targetRoot,
          repositoryId: top.sourceModule.repositoryId,
          analysisRevision: top.sourceModule.analysisRevision,
          projectId: top.sourceModule.projectId,
          moduleId: top.sourceModule.moduleId,
          sourceFiles: top.sourceModule.sourceFiles ?? [top.path],
        });
        historyViewRoot = historyView?.root;
        // The translation host removes its history view as soon as the run is
        // completed. Keep a separate read-only copy for the post-translation
        // #43 verifier; it contains only the selected module files.
        verifierSourceRoot = historyView ? await mkdtemp(join(tmpdir(), 'forexplore-verifier-history-')) : undefined;
        if (historyView && verifierSourceRoot) await cp(join(historyView.root, 'source'), verifierSourceRoot, { recursive: true });
      const scope = await prepareModuleTranslationScope({ workspaceRoot: targetRoot, target, candidate: top,
        requirement, decisionNotes: '',
        evidenceScopes: [{ repositoryId: top.sourceModule.repositoryId, analysisRevision: top.sourceModule.analysisRevision }],
        ...(historyView ? { historyView } : {}) });
      // Experiment hook, off by default. The product scope makes the module's own files the
      // only readable ones, so an Analyzer cannot read the types those files reference and
      // reports a blocker. RECAST_EXPERIMENT_WIDEN_READ_SCOPE=1 adds the rest of the target
      // project as readable while the write scope stays the module's own files (variant A1).
      if (process.env.RECAST_EXPERIMENT_WIDEN_READ_SCOPE === '1') {
        const [projectFiles] = await pool.query<Array<{ relativePath: string }>>(
          `SELECT f.relative_path AS relativePath FROM files f
           JOIN repositories r ON r.repository_id = f.repository_id
           WHERE r.local_path = ? AND f.analysis_revision = r.active_revision`, [targetRoot]);
        const known = new Set(scope.workspaceFiles ?? []);
        const extra = projectFiles.map((row) => row.relativePath).filter((path) => !known.has(path));
        (scope as { workspaceFiles?: string[] }).workspaceFiles = [...(scope.workspaceFiles ?? []), ...extra];
        console.log(`    [experiment A1] 读范围放宽到整个工程：+${extra.length} 文件（写范围不变）`);
      }
      entry.writeFiles = scope.profile.writeFiles;
      if (entry.writeFiles.length === 0) { entry.status = 'skipped'; entry.error = 'empty write scope'; console.log('  ✗ 写范围为空'); continue; }

      if (dryRun) {
        entry.wallMs = Date.now() - started;
        console.log(`  ✓ 范围已准备：writeFiles=${entry.writeFiles.join(', ')}`);
        for (const warning of scope.warnings ?? []) console.log(`    ! ${warning}`);
        continue;
      }

      const host = translation!.host;
      const moduleScopeId = host.rememberModuleScope(scope);
      const described = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `describe-${index}`, action: 'describe', moduleScopeId });
      if (described.type !== 'WORKSPACE_TRANSLATION_RESULT' || !described.profile) throw new Error(`describe failed: ${JSON.stringify(described)}`);
      const startedRun = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `start-${index}`, action: 'start',
        moduleScopeId, profileId: described.profile.profileId });
      if (startedRun.type !== 'WORKSPACE_TRANSLATION_RESULT' || !startedRun.run) throw new Error(`start failed: ${JSON.stringify(startedRun)}`);
      let run = startedRun.run;
      const deadline = Date.now() + Number(process.env.ADAPTATION_WORKSPACE_TIMEOUT_MS ?? 1_800_000);
      // The runtime records every tool choice, tool failure and no-tool-call nudge in
      // run.events, but nothing surfaced them, so a zero-change run could only be read
      // as "budget exhausted". A drought of turns with neither an accepted plan nor a
      // file change is not going to recover; on a 65-module target it would burn hours.
      const noProgressTurns = Number(process.env.ADAPTATION_WORKSPACE_NO_PROGRESS_TURNS ?? 24);
      let lastProgress = '';
      while (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
        const polled = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `read-${index}`, action: 'read', runId: run.id });
        if (polled.type !== 'WORKSPACE_TRANSLATION_RESULT' || !polled.run) throw new Error(`read failed: ${JSON.stringify(polled)}`);
        run = polled.run;
        const progress = `${run.status} turns=${run.modelTurns} changes=${run.changes.length}${run.plan ? ` plan=${run.plan.steps.length}` : ''}`;
        if (progress !== lastProgress) { console.log(`    ${progress}`); lastProgress = progress; }
        if (noProgressTurns > 0 && run.modelTurns >= noProgressTurns && !run.plan && run.changes.length === 0) {
          if (run.events?.length) for (const event of run.events.slice(-8)) console.log(`      · ${event.phase}: ${event.message}`);
          const cancelled = await host.handle({ type: 'WORKSPACE_TRANSLATION', requestId: `cancel-${index}`, action: 'cancel', runId: run.id });
          if (cancelled.type === 'WORKSPACE_TRANSLATION_RESULT' && cancelled.run) run = cancelled.run;
          entry.stoppedEarly = `stopped after ${run.modelTurns} turns with no accepted plan and no file change`;
          console.log(`    ⏹ ${entry.stoppedEarly}`);
          break;
        }
      }
      entry.status = run.status === 'completed' ? 'completed' : 'failed';
      entry.turns = run.modelTurns;
      entry.acceptance = run.acceptance;
      entry.changedPaths = [...new Set(run.changes.map((change) => change.path))];
      if (run.status === 'completed' && verifierSourceRoot && modelApiKey) {
        const apiName = (value: string | undefined, fallback: string): string => {
          const raw = value?.trim() || fallback;
          const base = raw.split('(')[0]!.split(/::|[.#]/).at(-1)!.trim();
          return base.replace(/<.*>$/, '').split(/\s+/).at(-1) || fallback;
        };
        const targetApi = apiName(module.coreApis?.[0], module.name);
        const sourceApi = apiName(top.sourceModule.coreApis?.[0], targetApi);
        const verificationHost = createAgentHost<SingleAgentFunctionGroupTerminalResult>({
          modelClient: createTranslationVerifierModelClient({
            apiKey: () => modelApiKey!,
            apiBase: process.env.DEEPSEEK_API_BASE,
            model: process.env.DEEPSEEK_MODEL,
          }),
          limits: {
            maxDurationMs: Number(process.env.TRANSLATION_VERIFIER_MAX_DURATION_MS ?? 300_000),
            maxTurns: Number(process.env.TRANSLATION_VERIFIER_MAX_TURNS ?? 20),
            maxToolCalls: Number(process.env.TRANSLATION_VERIFIER_MAX_TOOL_CALLS ?? 80),
            maxToolCallsPerTurn: 8,
          },
        });
        const verifyFunctionGroup = createFunctionGroupVerifier(verificationHost);
        const verificationInput: FunctionGroupVerificationInput = {
          schemaVersion: '3.0', sourceLanguage: top.language, targetLanguage: language,
          sourceProjectPath: verifierSourceRoot, targetProjectPath: targetRoot, requirement,
          functions: [{
            source: { path: top.sourceModule.sourceFiles?.[0] ?? top.path, name: sourceApi },
            target: { path: module.sourceFiles[0]!, name: targetApi },
          }],
          translationRun: {
            id: run.id, plan: run.plan, changes: run.changes, compilations: run.compilations,
            acceptance: run.acceptance,
          },
        };
        try {
          entry.translationVerification = await verifyFunctionGroup(verificationInput, 'single-agent-function-group', 'verify');
        } catch (error) {
          const description = error instanceof Error ? error.message : String(error);
          entry.translationVerification = {
            status: 'failure',
            issue: { kind: 'environment', description: `函数组验证器未能完成：${description.slice(0, 600)}` },
            functions: verificationInput.functions.map(({ source, target }) => ({
              source, target, status: 'unverified', executed: false, lineCoverage: null, branchCoverage: null,
            })),
          };
        }
        console.log(`    #43 函数组验证：${entry.translationVerification.status}（${entry.translationVerification.functions.map((item) => `${item.target.name}:${item.executed ? 'executed' : 'unverified'}`).join(', ')}）`);
      }
      if (run.error) entry.error = run.error;
      if (run.status !== 'completed' && run.events?.length) {
        entry.events = run.events.map((event) => `${event.phase}: ${event.message}`).slice(-40);
        console.log('    事件尾巴（运行时的逐轮记录）:');
        for (const line of entry.events.slice(-10)) console.log(`      ${line.slice(0, 200)}`);
      }
      entry.wallMs = Date.now() - started;
      console.log(`  ${entry.status === 'completed' ? '✓' : '✗'} ${entry.status} turns=${run.modelTurns} acceptance=${run.acceptance ?? '-'} ` +
        `files=${entry.changedPaths.join(',')} ${(entry.wallMs / 1000).toFixed(0)}s`);
      } finally {
        if (verifierSourceRoot) await removeReadOnlyTree(verifierSourceRoot);
        if (historyViewRoot) await removeReadOnlyTree(historyViewRoot);
      }
    } catch (error) {
      entry.status = 'failed';
      entry.error = error instanceof Error ? error.message : String(error);
      entry.wallMs = Date.now() - started;
      console.log(`  ✗ ${entry.error.slice(0, 240)}`);
    }
  }
} finally {
  codeIntelligence.dispose();
  for (const cleanup of cleanups.reverse()) await cleanup();
  await pool.end();
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
const completed = report.modules.filter((module) => module.status === 'completed').length;
const failed = report.modules.filter((module) => module.status === 'failed').length;
console.log(`\n模块 ${report.modules.length} 个：completed ${completed}，failed ${failed}，其余为 dry-run/跳过`);
console.log(`报告: ${outputPath}`);
if (failed) process.exitCode = 1;
