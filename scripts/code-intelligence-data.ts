/**
 * Backup, restore, retention and health checks for code-intelligence data.
 *
 *   stats   [--database <db>]
 *   doctor  [--database <db>] [--stale-hours <h>]
 *   backup  [--database <db>] [--out <dir>]
 *   restore --from <dir> --database <new-db> [--apply]
 *   gc      [--database <db>] [--keep-superseded <n>] [--stale-hours <h>] [--apply]
 *   files   --workspace <root> [--days <d>] [--extension-storage <dir>] [--apply]
 *   scratch [--apply]
 *
 * stats and doctor are read-only; doctor exits 1 when it finds an error.
 * A backup is one gzipped JSONL file per table plus manifest.json. It is taken
 * inside one read-only transaction, so all tables come from one snapshot, and
 * it survives SeekDB image upgrades (unlike copying the Docker volume).
 * Restore only targets a database that does not exist yet. It builds the schema
 * with the current SeekDbIndexStore, refuses a different embedding identity,
 * and drops the half-restored database on any failure.
 *
 * gc keeps each repository's active revision, its newest superseded revisions
 * and its newest failed revision; it deletes older ones, abandoned `building`
 * revisions and unreferenced embedding-cache rows. files deletes old records
 * that reached a final state; anything a recovery or resume can still use is
 * kept. scratch drops leftover verification databases. All three only preview
 * without --apply.
 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { createGunzip, createGzip } from 'node:zlib';
import mysql from 'mysql2/promise';
import type { Connection as CoreConnection } from 'mysql2';
import { SeekDbIndexStore, seekDbSchemaVersion } from '../services/code-intelligence-service/src/seekdb-index-store';
import { codeIntelligenceRuntimeOptionsFromEnvironment } from '../apps/vscode-extension/src/code-intelligence-host';

const FORMAT = 'forexplore-code-intelligence-backup';
const FORMAT_VERSION = 1;
const ownedTables = new Set(['repositories', 'analysis_revisions', 'projects', 'files', 'symbols',
  'dependency_edges', 'module_artifacts', 'search_documents', 'index_diagnostics',
  'search_embedding_configuration', 'search_embedding_cache', 'schema_migrations']);
/** Rebuilt by SeekDbIndexStore.initialize() from the current embedding configuration. */
const identityTable = 'search_embedding_configuration';
/** Written by SeekDbIndexStore.initialize() for the schema of the restoring build. */
const migrationsTable = 'schema_migrations';
const batchRows = 500;
const batchBytes = 4 * 1024 * 1024;

interface ColumnManifest { name: string; type: string }
interface TableManifest { name: string; file: string; rows: number; sha256: string; columns: ColumnManifest[] }
interface BackupManifest {
  format: typeof FORMAT;
  formatVersion: number;
  database: string;
  createdAt: string;
  seekdbVersion: string;
  embeddingIdentity: string | null;
  vectorDimension: number | null;
  tables: TableManifest[];
}

function connect(database: string) {
  assert(/^[A-Za-z_][A-Za-z0-9_]*$/.test(database), `Invalid database name: ${database}`);
  assert(!['mysql', 'information_schema', 'performance_schema', 'sys', 'oceanbase', 'test'].includes(database.toLowerCase()),
    'System and shared default databases are not code-intelligence databases.');
  const { seekdb: config } = codeIntelligenceRuntimeOptionsFromEnvironment({ ...process.env, CODE_INTELLIGENCE_SEEKDB_DATABASE: database });
  assert(config && ['127.0.0.1', 'localhost', '::1'].includes(config.host), 'This tool supports the local database only.');
  const pool = mysql.createPool({ host: config.host, port: config.port, user: config.user, password: config.password, connectionLimit: 4 });
  return { config, pool };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function listTables(pool: mysql.Pool, database: string): Promise<string[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [database]);
  return rows.map((row) => String(row.TABLE_NAME));
}

async function assertDatabaseExists(pool: mysql.Pool, database: string) {
  const [existing] = await pool.query<mysql.RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
  assert.equal(existing.length, 1, `Database ${database} does not exist.`);
}

async function backup(database: string, out: string | undefined) {
  const { pool } = connect(database);
  try {
    const tables = await listTables(pool, database);
    assert(tables.length > 0, `Database ${database} has no tables.`);
    const unknown = tables.filter((name) => !ownedTables.has(name));
    assert.equal(unknown.length, 0, `Database contains unrelated tables; backup refused: ${unknown.join(', ')}`);
    const target = path.resolve(out ?? path.join('backups', `${database}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
    const partial = `${target}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    const connection = await pool.getConnection();
    try {
      // One read-only transaction: every table is read from the same snapshot.
      await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION READ ONLY');
      const [[version]] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
      const identity = tables.includes(identityTable)
        ? (await connection.query<mysql.RowDataPacket[]>(`SELECT config_hash FROM \`${database}\`.\`${identityTable}\` WHERE slot = 1`))[0][0]?.config_hash
        : undefined;
      const [columnRows] = await connection.query<mysql.RowDataPacket[]>(
        'SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
        [database]);
      const manifest: BackupManifest = {
        format: FORMAT, formatVersion: FORMAT_VERSION, database, createdAt: new Date().toISOString(),
        seekdbVersion: String(version?.version ?? ''), embeddingIdentity: identity ? String(identity) : null,
        vectorDimension: null, tables: [],
      };
      for (const name of tables) {
        const columns = columnRows.filter((row) => row.TABLE_NAME === name)
          .map((row) => ({ name: String(row.COLUMN_NAME), type: String(row.DATA_TYPE) }));
        const vector = columns.map((column) => /^vector\((\d+)\)$/i.exec(column.type)).find(Boolean);
        if (vector) manifest.vectorDimension = Number(vector[1]);
        const file = `${name}.jsonl.gz`;
        let rows = 0;
        const select = `SELECT ${columns.map((column) => `\`${column.name}\``).join(', ')} FROM \`${database}\`.\`${name}\``;
        // Row arrays in manifest column order; JSON columns arrive parsed, VECTOR as '[..]' text.
        await pipeline(
          // mysql2 types `.connection` as the promise wrapper; at runtime it is the core connection that streams.
          (connection.connection as unknown as CoreConnection).query({ sql: select, rowsAsArray: true }).stream({ highWaterMark: 256 }),
          new Transform({ writableObjectMode: true, transform(row: unknown[], _encoding, done) {
            rows++;
            done(null, `${JSON.stringify(row)}\n`);
          } }),
          createGzip(),
          createWriteStream(path.join(partial, file), { flags: 'wx' }),
        );
        manifest.tables.push({ name, file, rows, sha256: await sha256File(path.join(partial, file)), columns });
        console.log(JSON.stringify({ table: name, rows }));
      }
      await connection.query('COMMIT');
      await writeFile(path.join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    } finally { connection.release(); }
    await rename(partial, target);
    console.log(JSON.stringify({ backup: target, database }));
  } finally { await pool.end(); }
}

async function restore(from: string, database: string, apply: boolean) {
  const directory = path.resolve(from);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as BackupManifest;
  assert(manifest.format === FORMAT && manifest.formatVersion === FORMAT_VERSION, `${directory} is not a supported backup.`);
  for (const table of manifest.tables) {
    assert(ownedTables.has(table.name), `Backup contains an unknown table: ${table.name}`);
    assert.equal(await sha256File(path.join(directory, table.file)), table.sha256, `Checksum mismatch: ${table.file}`);
  }
  const { config, pool } = connect(database);
  let created = false;
  try {
    const [existing] = await pool.query<mysql.RowDataPacket[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    assert.equal(existing.length, 0, `Database ${database} already exists; restore only creates a new database.`);
    if (manifest.vectorDimension !== null) {
      assert.equal(config.vectorDimension, manifest.vectorDimension,
        'CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION differs from the backup; configure the same embedding settings.');
    }
    if (manifest.embeddingIdentity === null) {
      assert(!config.embedding, 'Backup predates embedding identity (hash embeddings); unset CODE_INTELLIGENCE_EMBEDDING_* to restore it.');
    }
    const plan = manifest.tables.filter((table) => table.name !== identityTable && table.name !== migrationsTable);
    console.log(JSON.stringify({ action: apply ? 'restore' : 'preview', from: directory, database, source: manifest.database,
      createdAt: manifest.createdAt, seekdbVersion: manifest.seekdbVersion,
      rows: Object.fromEntries(plan.map((table) => [table.name, table.rows])) }));
    if (!apply) return;

    created = true;
    const store = new SeekDbIndexStore(config, pool);
    await store.initialize();
    const [[identity]] = await pool.query<mysql.RowDataPacket[]>(`SELECT config_hash FROM \`${database}\`.\`${identityTable}\` WHERE slot = 1`);
    if (manifest.embeddingIdentity !== null) {
      assert.equal(String(identity?.config_hash), manifest.embeddingIdentity,
        'Current embedding configuration differs from the backup; vectors would be meaningless. Configure the same embedding model.');
    }
    const [targetColumns] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [database]);
    const available = new Set(targetColumns.map((row) => `${row.TABLE_NAME}.${row.COLUMN_NAME}`));
    for (const table of plan) {
      const missing = table.columns.filter((column) => !available.has(`${table.name}.${column.name}`));
      assert.equal(missing.length, 0, `Current schema lacks backed-up columns ${table.name}.${missing.map((c) => c.name).join(', ')}`);
      const json = new Set(table.columns.flatMap((column, index) => column.type.toLowerCase() === 'json' ? [index] : []));
      const insert = `INSERT INTO \`${database}\`.\`${table.name}\` (${table.columns.map((column) => `\`${column.name}\``).join(', ')}) VALUES ?`;
      let batch: unknown[][] = [];
      let bytes = 0;
      let rows = 0;
      const lines = createInterface({ input: createReadStream(path.join(directory, table.file)).pipe(createGunzip()), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        const row = (JSON.parse(line) as unknown[]).map((value, index) => json.has(index) && value !== null ? JSON.stringify(value) : value);
        batch.push(row);
        bytes += line.length;
        if (batch.length >= batchRows || bytes >= batchBytes) {
          await pool.query(insert, [batch]);
          rows += batch.length;
          batch = [];
          bytes = 0;
        }
      }
      if (batch.length) {
        await pool.query(insert, [batch]);
        rows += batch.length;
      }
      const [[count]] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${database}\`.\`${table.name}\``);
      assert.equal(Number(count?.count), table.rows, `Row count mismatch after restoring ${table.name}.`);
      console.log(JSON.stringify({ table: table.name, rows }));
    }
    // Backups taken before schema migration 2 carry no search_documents.project_id.
    await store.backfillSearchDocumentProjects();
    created = false;
    console.log(JSON.stringify({ restored: true, database,
      nextStep: `Set CODE_INTELLIGENCE_SEEKDB_DATABASE=${database} and reload the extension.` }));
  } finally {
    if (created) await pool.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => undefined);
    await pool.end();
  }
}

async function gc(database: string, keepSuperseded: number, staleHours: number, apply: boolean) {
  assert(Number.isInteger(keepSuperseded) && keepSuperseded >= 0, '--keep-superseded must be a non-negative integer.');
  assert(Number.isFinite(staleHours) && staleHours > 0, '--stale-hours must be a positive number.');
  const { config, pool } = connect(database);
  try {
    await assertDatabaseExists(pool, database);
    const store = new SeekDbIndexStore(config, pool);
    // Verifies the configured embedding identity before anything is deleted.
    await store.initialize();
    const staleBefore = Date.now() - staleHours * 3_600_000;
    const plan: { repositoryId: string; analysisRevision: string; status: string; createdAt: string; reason: string }[] = [];
    for (const repository of await store.listRepositories()) {
      let superseded = 0;
      let failed = 0;
      // Newest first; the active revision is never a candidate.
      for (const revision of await store.listRevisions(repository.repositoryId)) {
        if (revision.analysisRevision === repository.activeRevision) continue;
        const reason = revision.status === 'superseded' ? ++superseded > keepSuperseded ? `older than the newest ${keepSuperseded} superseded` : null
          : revision.status === 'failed' ? ++failed > 1 ? 'older than the newest failed' : null
          : revision.status === 'building' && Date.parse(revision.createdAt) < staleBefore ? `building for over ${staleHours}h` : null;
        if (reason) plan.push({ repositoryId: revision.repositoryId, analysisRevision: revision.analysisRevision,
          status: revision.status, createdAt: revision.createdAt, reason });
      }
    }
    console.log(JSON.stringify({ action: apply ? 'gc' : 'preview', database, keepSuperseded, staleHours, revisions: plan }, null, 2));
    if (!apply) return;
    for (const revision of plan) await store.deleteRevision(revision);
    const embeddingCacheRows = await store.pruneEmbeddingCache();
    console.log(JSON.stringify({ deletedRevisions: plan.length, embeddingCacheRows }));
  } finally { await pool.end(); }
}

interface RecordSource {
  kind: string;
  directory: string;
  include: (name: string) => boolean;
  /** Returns the record's age anchor when its state is final, otherwise null. */
  finalAt: (record: Record<string, unknown>) => unknown;
}

const finalState = (states: readonly string[], field: string, time: string) =>
  (record: Record<string, unknown>) => states.includes(String(record[field])) ? record[time] : null;

async function files(workspace: string, days: number, extensionStorage: string | undefined, apply: boolean) {
  assert(Number.isFinite(days) && days >= 0, '--days must be a non-negative number.');
  const root = path.resolve(workspace);
  assert((await stat(root)).isDirectory(), `${root} is not a directory.`);
  let gitDir: string | null = null;
  try {
    gitDir = path.resolve(root, execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch { /* Not a git repository: no wave journals. */ }
  const translations = path.join(root, '.forexplore', 'workspace-translations');
  const sources: RecordSource[] = [
    // prepared/committing checkpoints drive crash recovery.
    { kind: 'checkpoint', directory: path.join(root, '.forexplore', 'checkpoints'), include: (name) => name.endsWith('.json'),
      finalAt: finalState(['committed', 'rolled-back'], 'state', 'createdAt') },
    // failed, cancelled and interrupted runs can still resume.
    { kind: 'translation', directory: translations, include: (name) => /^[a-f0-9-]{36}\.json$/.test(name),
      finalAt: finalState(['completed', 'rolled-back'], 'status', 'updatedAt') },
    ...gitDir ? [{ kind: 'wave-journal', directory: path.join(gitDir, 'forexplore-wave-transactions'), include: (name: string) => name.endsWith('.json'),
      finalAt: finalState(['committed', 'rolled-back'], 'state', 'updatedAt') }] : [],
    // Extension undo checkpoints have no state; age alone decides.
    ...extensionStorage ? [{ kind: 'extension-checkpoint', directory: path.join(path.resolve(extensionStorage), 'checkpoints'),
      include: (name: string) => /^ws-[0-9a-f-]+\.json$/i.test(name), finalAt: (record: Record<string, unknown>) => record.createdAt }] : [],
  ];
  const cutoff = Date.now() - days * 86_400_000;
  const plan: { kind: string; file: string; finishedAt: string }[] = [];
  const skipped: string[] = [];
  for (const source of sources) {
    const names = await readdir(source.directory).catch(() => [] as string[]);
    for (const name of names) {
      const file = path.join(source.directory, name);
      if (source.kind === 'translation' && name.endsWith('.tmp')) {
        // Leftover of an interrupted atomic save.
        const { mtime } = await stat(file);
        if (mtime.getTime() < cutoff) plan.push({ kind: 'translation-temp', file, finishedAt: mtime.toISOString() });
        continue;
      }
      if (!source.include(name)) continue;
      let record: unknown;
      try { record = JSON.parse(await readFile(file, 'utf8')); } catch { skipped.push(file); continue; }
      if (typeof record !== 'object' || record === null) { skipped.push(file); continue; }
      const finishedAt = source.finalAt(record as Record<string, unknown>);
      if (typeof finishedAt === 'string' && Date.parse(finishedAt) < cutoff) plan.push({ kind: source.kind, file, finishedAt });
    }
  }
  console.log(JSON.stringify({ action: apply ? 'delete' : 'preview', workspace: root, days,
    scanned: sources.map((source) => source.directory), files: plan, unreadable: skipped }, null, 2));
  if (!apply) return;
  for (const { file } of plan) await rm(file, { force: true });
  console.log(JSON.stringify({ deletedFiles: plan.length }));
}

/** Databases created by verification scripts; never matches a product database. */
const scratchDatabase = /^(forexplore_task_scale_|project_live_|module_accept_)[A-Za-z0-9_]*$/;

async function scratch(database: string, apply: boolean) {
  const { pool } = connect(database);
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
    const plan = rows.map((row) => String(row.name)).filter((name) => scratchDatabase.test(name) && name !== database);
    console.log(JSON.stringify({ action: apply ? 'drop' : 'preview', databases: plan }, null, 2));
    if (!apply) return;
    for (const name of plan) await pool.query(`DROP DATABASE \`${name}\``);
    console.log(JSON.stringify({ droppedDatabases: plan.length }));
  } finally { await pool.end(); }
}

/** Keyed by (repository_id, analysis_revision); deleteRevision removes them with their revision row. */
const revisionTables = ['projects', 'files', 'symbols', 'dependency_edges', 'index_diagnostics', 'module_artifacts', 'search_documents'];

async function stats(database: string) {
  const { pool } = connect(database);
  try {
    await assertDatabaseExists(pool, database);
    const db = `\`${database}\``;
    const tables: Record<string, number> = {};
    for (const name of await listTables(pool, database)) {
      const [[row]] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${db}.\`${name}\``);
      tables[name] = Number(row!.n);
    }
    assert('repositories' in tables && 'analysis_revisions' in tables && 'search_documents' in tables,
      `Database ${database} is not an initialized code-intelligence database.`);
    const [migrations] = 'schema_migrations' in tables
      ? await pool.query<mysql.RowDataPacket[]>(`SELECT version, name, applied_at AS appliedAt FROM ${db}.schema_migrations ORDER BY version`)
      : [[]];
    const [repositoryRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT repository_id, display_name, analysis_status, active_revision FROM ${db}.repositories ORDER BY display_name`);
    const [revisionRows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT repository_id, status, COUNT(*) AS n FROM ${db}.analysis_revisions GROUP BY repository_id, status`);
    const [documentRows] = await pool.query<mysql.RowDataPacket[]>(`SELECT d.repository_id, d.kind, COUNT(*) AS n
      FROM ${db}.search_documents d JOIN ${db}.repositories r
      ON r.repository_id = d.repository_id AND r.active_revision = d.analysis_revision GROUP BY d.repository_id, d.kind`);
    const repositories = repositoryRows.map((repository) => ({
      repositoryId: String(repository.repository_id), displayName: repository.display_name,
      analysisStatus: repository.analysis_status, activeRevision: repository.active_revision,
      revisions: Object.fromEntries(revisionRows.filter((row) => row.repository_id === repository.repository_id).map((row) => [row.status, Number(row.n)])),
      activeSearchDocuments: Object.fromEntries(documentRows.filter((row) => row.repository_id === repository.repository_id).map((row) => [row.kind, Number(row.n)])),
    }));
    console.log(JSON.stringify({ database, schemaVersion: Math.max(0, ...migrations.map((row) => Number(row.version))),
      supportedSchemaVersion: seekDbSchemaVersion, migrations, rows: tables, repositories }, null, 2));
  } finally { await pool.end(); }
}

interface Finding { severity: 'error' | 'warning'; check: string; detail: string; fix?: string }

async function doctor(database: string, staleHours: number) {
  assert(Number.isFinite(staleHours) && staleHours > 0, '--stale-hours must be a positive number.');
  const { config, pool } = connect(database);
  try {
    await assertDatabaseExists(pool, database);
    const db = `\`${database}\``;
    const findings: Finding[] = [];
    const count = async (sql: string, values: unknown[] = []) => Number((await pool.query<mysql.RowDataPacket[]>(sql, values))[0][0]!.n);
    const tables = await listTables(pool, database);
    const unknown = tables.filter((name) => !ownedTables.has(name));
    if (unknown.length) findings.push({ severity: 'warning', check: 'unrelated-tables', detail: unknown.join(', '),
      fix: 'Move them to another database; backup and reset refuse databases with unrelated tables.' });
    const missing = [...ownedTables].filter((name) => name !== 'search_embedding_cache' && !tables.includes(name));
    if (missing.length) {
      findings.push({ severity: 'error', check: 'schema-initialized', detail: `Missing tables: ${missing.join(', ')}`,
        fix: 'Open the extension (or run any command that initializes the store) against this database.' });
    } else {
      const current = await count(`SELECT COALESCE(MAX(version), 0) AS n FROM ${db}.schema_migrations`);
      if (current > seekDbSchemaVersion) findings.push({ severity: 'error', check: 'schema-version',
        detail: `Database schema ${current} is newer than this build (${seekDbSchemaVersion}).`, fix: 'Upgrade ForeXplore.' });
      if (current < seekDbSchemaVersion) findings.push({ severity: 'warning', check: 'schema-version',
        detail: `Database schema ${current}; this build migrates it to ${seekDbSchemaVersion} on next start.`, fix: 'Take a backup first (npm run data:backup).' });
      // Constructing the store performs no I/O; it only derives the configured embedding identity.
      const expected = new SeekDbIndexStore(config, pool).embeddingIdentity;
      const [[identity]] = await pool.query<mysql.RowDataPacket[]>(`SELECT config_hash FROM ${db}.${identityTable} WHERE slot = 1`);
      if (identity && String(identity.config_hash) !== expected) findings.push({ severity: 'error', check: 'embedding-identity',
        detail: 'Stored vectors were produced by a different embedding model/configuration than CODE_INTELLIGENCE_EMBEDDING_* / vector dimension.',
        fix: 'Restore the original embedding settings, or use a separate database and re-analyse.' });
      const [activeRows] = await pool.query<mysql.RowDataPacket[]>(`SELECT r.repository_id, r.display_name, r.active_revision, v.status
        FROM ${db}.repositories r LEFT JOIN ${db}.analysis_revisions v
        ON v.repository_id = r.repository_id AND v.analysis_revision = r.active_revision
        WHERE r.active_revision IS NOT NULL AND (v.status IS NULL OR v.status <> 'ready')`);
      for (const row of activeRows) findings.push({ severity: 'error', check: 'active-revision',
        detail: `${row.display_name} (${row.repository_id}) points at revision ${row.active_revision}, which is ${row.status ?? 'missing'}.`,
        fix: 'Re-analyse the repository.' });
      const orphanRevisions = await count(`SELECT COUNT(*) AS n FROM ${db}.analysis_revisions v
        WHERE NOT EXISTS (SELECT 1 FROM ${db}.repositories r WHERE r.repository_id = v.repository_id)`);
      if (orphanRevisions) findings.push({ severity: 'warning', check: 'orphan-revisions', detail: `${orphanRevisions} revisions belong to no repository.` });
      for (const table of revisionTables) {
        const orphans = await count(`SELECT COUNT(*) AS n FROM ${db}.\`${table}\` x WHERE NOT EXISTS (SELECT 1 FROM ${db}.analysis_revisions v
          WHERE v.repository_id = x.repository_id AND v.analysis_revision = x.analysis_revision)`);
        if (orphans) findings.push({ severity: 'warning', check: 'orphan-rows', detail: `${table}: ${orphans} rows belong to no analysis revision.` });
      }
      const unscoped = await count(`SELECT COUNT(*) AS n FROM ${db}.search_documents d JOIN ${db}.files f
        ON f.repository_id = d.repository_id AND f.analysis_revision = d.analysis_revision AND f.relative_path = d.relative_path
        WHERE d.kind <> 'summary' AND d.project_id IS NULL AND f.project_id IS NOT NULL`);
      if (unscoped) findings.push({ severity: 'warning', check: 'search-document-project',
        detail: `${unscoped} search documents lack project_id; project-scoped search misses them.`, fix: 'Re-analyse the affected repositories.' });
      const staleBuilding = await count(`SELECT COUNT(*) AS n FROM ${db}.analysis_revisions WHERE status = 'building' AND created_at < ?`,
        [new Date(Date.now() - staleHours * 3_600_000).toISOString()]);
      if (staleBuilding) findings.push({ severity: 'warning', check: 'stale-building',
        detail: `${staleBuilding} revisions have been building for over ${staleHours}h.`, fix: 'npm run data:gc -- --apply' });
      if (tables.includes('search_embedding_cache') && identity) {
        const unreferenced = await count(`SELECT COUNT(*) AS n FROM ${db}.search_embedding_cache WHERE content_hash NOT IN (
          SELECT SHA2(CONCAT(?, CHAR(0), search_text), 256) FROM ${db}.search_documents)`, [String(identity.config_hash)]);
        if (unreferenced) findings.push({ severity: 'warning', check: 'embedding-cache',
          detail: `${unreferenced} cached embeddings are referenced by no search document.`, fix: 'npm run data:gc -- --apply' });
      }
    }
    const healthy = !findings.some((finding) => finding.severity === 'error');
    console.log(JSON.stringify({ database, healthy, findings }, null, 2));
    if (!healthy) process.exitCode = 1;
  } finally { await pool.end(); }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    database: { type: 'string' }, out: { type: 'string' }, from: { type: 'string' }, apply: { type: 'boolean' },
    'keep-superseded': { type: 'string', default: '1' }, 'stale-hours': { type: 'string', default: '24' },
    workspace: { type: 'string' }, days: { type: 'string', default: '30' }, 'extension-storage': { type: 'string' },
  } });
  const apply = values.apply === true;
  if (positionals[0] === 'files') {
    assert(values.workspace, 'files needs --workspace <root>.');
    return files(values.workspace, Number(values.days), values['extension-storage'], apply);
  }
  const database = values.database ?? process.env.CODE_INTELLIGENCE_SEEKDB_DATABASE;
  assert(database, 'Specify --database or CODE_INTELLIGENCE_SEEKDB_DATABASE.');
  if (positionals[0] === 'backup') return backup(database, values.out);
  if (positionals[0] === 'restore') {
    assert(values.from && values.database, 'restore needs --from <backup-dir> and an explicit --database <new-db>.');
    return restore(values.from, values.database, apply);
  }
  if (positionals[0] === 'gc') return gc(database, Number(values['keep-superseded']), Number(values['stale-hours']), apply);
  if (positionals[0] === 'scratch') return scratch(database, apply);
  if (positionals[0] === 'stats') return stats(database);
  if (positionals[0] === 'doctor') return doctor(database, Number(values['stale-hours']));
  throw new Error('Usage: code-intelligence-data.ts stats | doctor | backup | restore | gc | files | scratch (see the header of this file for options)');
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
