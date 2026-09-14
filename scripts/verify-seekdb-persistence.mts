/** Read-only audit of the isolated database produced by verify-module-pipeline-smoke.mts. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import mysql, { type RowDataPacket } from 'mysql2/promise';

const { values } = parseArgs({ options: {
  database: { type: 'string' }, output: { type: 'string', default: 'tmp/pipeline-verification/seekdb-persistence.json' },
} });
assert(values.database, '--database is required.');
const connection = await mysql.createConnection({ host: '127.0.0.1', port: 2881, user: 'root',
  password: '', database: values.database, connectTimeout: 10_000 });
const query = async (sql: string) => (await connection.query<RowDataPacket[]>({ sql, timeout: 15_000 }))[0];
const report: Record<string, unknown> = { database: values.database, generatedAt: new Date().toISOString(), passed: false };
try {
  report.version = (await query('SELECT VERSION() AS version'))[0]!.version;
  const counts: Record<string, number> = {};
  for (const table of ['repositories', 'analysis_revisions', 'projects', 'files', 'symbols',
    'module_artifacts', 'search_documents', 'search_embedding_configuration', 'search_embedding_cache']) {
    counts[table] = Number((await query(`SELECT COUNT(*) AS count FROM ${table}`))[0]!.count);
    assert(counts[table] > 0, `${table} must be populated.`);
  }
  report.counts = counts;
  report.repositories = await query('SELECT repository_id, role, active_revision FROM repositories');
  report.documents = await query('SELECT kind, COUNT(*) AS count FROM search_documents GROUP BY kind');
  const indexes = await query('SHOW INDEX FROM search_documents');
  report.indexes = indexes.map(row => ({ name: row.Key_name, column: row.Column_name, type: row.Index_type }));
  assert(indexes.some(row => row.Key_name === 'idx_search_documents_embedding'));
  assert(indexes.some(row => row.Key_name === 'idx_search_documents_text'));
  const vectors = await query('SELECT embedding FROM search_embedding_cache');
  for (const row of vectors) {
    const vector = typeof row.embedding === 'string' ? JSON.parse(row.embedding) : row.embedding;
    assert(Array.isArray(vector) && vector.length === 384 && vector.every(Number.isFinite));
    const norm = Math.sqrt(vector.reduce((sum: number, value: number) => sum + value * value, 0));
    assert(Math.abs(norm - 1) < 0.001, 'E5 embeddings must be normalized.');
  }
  report.vectors = { count: vectors.length, dimensions: 384, normalized: true };
  report.fulltextMatches = await query("SELECT search_document_id FROM search_documents WHERE repository_id = 'smoke-history' AND MATCH(search_text) AGAINST('LimitPolicy' IN NATURAL LANGUAGE MODE) LIMIT 5");
  assert((report.fulltextMatches as unknown[]).length > 0, 'Persisted history must be searchable by the fulltext index.');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await connection.end();
  const output = path.resolve(values.output!);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
