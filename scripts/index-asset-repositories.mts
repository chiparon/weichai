/**
 * Indexes the enterprise asset-upgrade repositories without the workbench.
 *
 * Indexing is normally driven by the extension host, so a crashed or closed
 * window leaves a repository registered as `indexing` with a `building` revision
 * and no searchable documents — exactly the state apache-camel was left in. This
 * command runs the same host path outside VS Code: register, scan, project, and
 * report what the database actually contains afterwards.
 *
 *   npx tsx scripts/index-asset-repositories.mts                       # every asset repository
 *   npx tsx scripts/index-asset-repositories.mts --repos apache-camel  # one repository
 *   npx tsx scripts/index-asset-repositories.mts --target experiments/enterprise-asset-upgrade/target-project
 *
 * No model is called: module analysis stays a separate, explicit step.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import {
  CodeIntelligenceHost,
  codeIntelligenceRuntimeOptionsFromEnvironment,
  type RepositoryIdentityStore,
} from '../apps/vscode-extension/src/code-intelligence-host.js';

const argument = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const database = argument('database', process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE ?? 'forexplore_javafileupload_flow_20260913')!;
process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE = database;
process.env.CODE_INTELLIGENCE_EMBEDDING_URL ??= 'http://127.0.0.1:4021/v1/embeddings';
process.env.CODE_INTELLIGENCE_EMBEDDING_MODEL ??= 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78';
process.env.CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS ??= 'false';
process.env.CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX ??= 'query: ';
process.env.CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX ??= 'passage: ';
process.env.CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION ??= '384';
// The inference device and precision change the produced vectors, so they belong to
// the model identity that scopes embedding reuse. Match whatever the serving
// process reports at /health; the default here is the GPU fp16 path.
process.env.CODE_INTELLIGENCE_EMBEDDING_VARIANT ??= argument('embedding-variant', 'dml-fp16');

const assetRoot = resolve('experiments/enterprise-asset-upgrade/source-repositories');

/**
 * A Docker restart in the middle of a queue used to fail every remaining
 * repository within seconds ("0 scanned, 1 failed" with a connection error),
 * which looked like an indexing problem instead of an infrastructure one.
 */
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
    if (Date.now() >= deadline) throw new Error('SeekDB is not listening on 127.0.0.1:2881; start the services and retry.');
    console.log('    waiting for SeekDB on 127.0.0.1:2881 ...');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
  }
}
const available = existsSync(assetRoot)
  ? readdirSync(assetRoot).filter((name) => {
    try { return statSync(join(assetRoot, name)).isDirectory(); } catch { return false; }
  })
  : [];
const requested = argument('repos')?.split(',').map((value) => value.trim()).filter(Boolean) ?? available;
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length) throw new Error(`Unknown asset repositories: ${unknown.join(', ')}. Available: ${available.join(', ')}`);

const inputs: Array<{ localPath: string; role: 'history' | 'target' }> = requested.map((name) => ({
  localPath: join(assetRoot, name), role: 'history' as const,
}));
const target = argument('target');
if (target) inputs.push({ localPath: resolve(target), role: 'target' });

/** Stands in for `context.globalState`: repository identity is resolved from the registry by path. */
class MemoryState implements RepositoryIdentityStore {
  readonly values = new Map<string, string>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: string): Promise<void> { this.values.set(key, value); }
}

console.log(`database=${database}`);
console.log(`indexing ${inputs.length} repositories:`);
for (const input of inputs) console.log(`  [${input.role}] ${input.localPath}`);
await waitForSeekDb(Number(argument('wait-db', '600')) * 1000);

const refusals: string[] = [];
const host = new CodeIntelligenceHost({
  runtimeOptions: codeIntelligenceRuntimeOptionsFromEnvironment(process.env, { allowInMemory: false }),
  identityStore: new MemoryState(),
  // Indexing must not spend model calls; module analysis is requested separately.
  modelKeyRefusal: async () => 'index-asset-repositories: indexing only, module analysis is a separate step',
  onModelRefusal: (reason) => { if (!refusals.includes(reason)) refusals.push(reason); },
  output: { appendLine: (line: string) => console.log(`    ${line}`) },
});

const started = Date.now();
try {
  const result = await host.synchronize({ repositories: inputs, scan: true, forceFull: argument('full') !== undefined });
  const { presentation, scannedRepositoryIds, failedRepositoryIds } = result;
  console.log(`\n同步完成：扫描 ${scannedRepositoryIds.length} 个，失败 ${failedRepositoryIds.length} 个，用时 ${Math.round((Date.now() - started) / 1000)}s`);
  console.log(`面板状态：${presentation.status}  存储=${presentation.storage}`);
  for (const repository of presentation.repositories) {
    const indexedFiles = repository.languages.reduce((sum, language) => sum + language.fileCount, 0);
    console.log(`  [${repository.role}] ${repository.analysisStatus}  ${repository.displayName}`);
    console.log(`      revision=${repository.activeRevision ?? '(none)'}  索引文件=${indexedFiles}  工程=${repository.projects.length}`);
  }
  if (failedRepositoryIds.length) console.log(`  失败：${failedRepositoryIds.join(', ')}`);
} finally {
  host.dispose();
}

// Read the database directly: a repository can report ready while its search
// projection is still missing, which is precisely how the stuck state hid.
const connection = await mysql.createConnection({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database });
console.log('\n数据库实际内容:');
for (const input of inputs) {
  const [repositories] = await connection.query(
    `SELECT repository_id, display_name, role, analysis_status, active_revision, updated_at
     FROM repositories WHERE local_path=?`, [input.localPath]);
  if (!repositories.length) { console.log(`  ${input.localPath} → 未登记`); continue; }
  const repository = repositories[0];
  const counts = {};
  for (const table of ['files', 'symbols', 'dependency_edges', 'search_documents']) {
    const [rows] = await connection.query(`SELECT COUNT(*) AS total FROM \`${table}\` WHERE repository_id=?`, [repository.repository_id]);
    counts[table] = rows[0].total;
  }
  const [revision] = await connection.query(
    `SELECT analysis_revision, status FROM analysis_revisions WHERE repository_id=? ORDER BY created_at DESC LIMIT 1`,
    [repository.repository_id]);
  console.log(`  ${repository.display_name} (${repository.role}) status=${repository.analysis_status} ` +
    `active=${repository.active_revision ?? '(none)'} latest=${revision[0]?.status ?? '-'}`);
  console.log(`      files=${counts.files} symbols=${counts.symbols} edges=${counts.dependency_edges} search_documents=${counts.search_documents}`);
}
await connection.end();
