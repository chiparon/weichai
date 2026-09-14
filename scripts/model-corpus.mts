/**
 * Completes module modelling for every registered project.
 *
 * Indexing (structural scan + search projection) never needs a model; module
 * summaries do. A corpus imported while the adaptation service was down is
 * therefore fully indexed yet has no module summaries, which is exactly the state
 * that hides a repository from module-level retrieval. This script asks the
 * running workbench to model each project and polls the database until the
 * summary is published.
 */
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import mysql from 'mysql2/promise';

const { values } = parseArgs({ options: {
  database: { type: 'string', default: 'forexplore_javafileupload_flow_20260913' },
  workbench: { type: 'string', default: 'http://127.0.0.1:4042' },
  repositories: { type: 'string', default: '' },
  force: { type: 'boolean', default: false },
  'list-only': { type: 'boolean', default: false },
  'per-repo-timeout-ms': { type: 'string', default: '300000' },
  attempts: { type: 'string', default: '3' },
} });
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database: values.database, connectionLimit: 4 });
const perRepoTimeout = Number(values['per-repo-timeout-ms']);
const attempts = Number(values.attempts);
const filter = new Set(values.repositories!.split(',').map((name) => name.trim()).filter(Boolean));

interface Row { repositoryId: string; displayName: string; role: string; analysisRevision: string; projectId: string }
async function rows(): Promise<Row[]> {
  const [result] = await pool.query(`SELECT r.repository_id AS repositoryId, r.display_name AS displayName, r.role,
    r.active_revision AS analysisRevision, p.project_id AS projectId
    FROM repositories r JOIN projects p ON p.repository_id = r.repository_id AND p.analysis_revision = r.active_revision
    WHERE r.active_revision IS NOT NULL ORDER BY r.role, r.display_name`);
  return (result as Row[]).filter((row) => filter.size === 0 || filter.has(row.displayName));
}

async function summaryState(row: Row): Promise<{ state: string; modules: number | null; updatedAt: string }> {
  const [result] = await pool.query(`SELECT status, JSON_LENGTH(JSON_EXTRACT(payload, '$.proposal.modules')) AS modules,
    updated_at AS updatedAt
    FROM module_artifacts WHERE repository_id = ? AND kind = 'module-summary' AND status = 'current' LIMIT 1`, [row.repositoryId]);
  const current = (result as Array<{ status: string; modules: number | null; updatedAt: Date }>)[0];
  if (current) return { state: 'current', modules: current.modules, updatedAt: String(current.updatedAt) };
  return { ...await jobState(row), modules: null };
}

/** The durable job record is the only place a modelling failure is written down. */
async function jobState(row: Row): Promise<{ state: string; error?: string; updatedAt: string }> {
  const [jobs] = await pool.query(`SELECT JSON_UNQUOTE(JSON_EXTRACT(payload, '$.state')) AS state,
    JSON_UNQUOTE(JSON_EXTRACT(payload, '$.error')) AS error, updated_at AS updatedAt
    FROM module_artifacts WHERE repository_id = ? AND kind = 'other' LIMIT 1`, [row.repositoryId]);
  const job = (jobs as Array<{ state: string | null; error: string | null; updatedAt: Date }>)[0];
  return { state: job?.state ?? 'missing', ...(job?.error ? { error: job.error } : {}), updatedAt: String(job?.updatedAt ?? '') };
}

const targets = await rows();
console.log(`projects: ${targets.length}${filter.size ? ` (filtered)` : ''}`);
for (const row of targets) {
  const state = await summaryState(row);
  console.log(`${row.role.padEnd(8)} ${row.displayName.padEnd(28)} ${state.state.padEnd(10)} modules=${state.modules ?? '-'}`);
}
if (values['list-only']) { await pool.end(); process.exit(0); }
assert(targets.length > 0, 'No registered project to model.');

const started = Date.now();
const results: Array<Record<string, unknown>> = [];
for (const row of targets) {
  const before = await summaryState(row);
  if (before.state === 'current' && !values.force) {
    console.log(`skip   ${row.displayName} (already modelled, ${before.modules} modules)`);
    results.push({ ...row, outcome: 'skipped', modules: before.modules, ms: 0 });
    continue;
  }
  const repoStarted = Date.now();
  let state = before.state;
  let modules: number | null = null;
  let failure: string | undefined;
  for (let attempt = 1; attempt <= attempts && state !== 'current'; attempt++) {
    const attemptStarted = Date.now();
    const seen = (await jobState(row)).updatedAt;
    const response = await fetch(`${values.workbench}/v1/workbench/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'RETRY_PROJECT_ANALYSIS', repositoryId: row.repositoryId,
        analysisRevision: row.analysisRevision, projectId: row.projectId, force: values.force }),
      signal: AbortSignal.timeout(120_000),
    }).catch((error: unknown) => { failure = String((error as Error).message ?? error); return undefined; });
    if (!response) { if (attempt === attempts) state = 'failed'; continue; }
    if (!response.ok) {
      failure = `HTTP ${response.status} ${(await response.text()).slice(0, 120)}`;
      console.log(`reject ${row.displayName} attempt ${attempt}: ${failure}`);
      if (attempt === attempts) state = 'failed';
      continue;
    }
    // The workbench schedules modelling asynchronously; poll the published artifact.
    let printed = 0;
    while (Date.now() - attemptStarted < perRepoTimeout) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const now = await summaryState(row);
      if (now.state === 'current') { state = 'current'; modules = now.modules; break; }
      const job = await jobState(row);
      if (job.updatedAt !== seen && job.state === 'failed') { state = 'failed'; failure = job.error ?? 'unknown'; break; }
      if (job.updatedAt !== seen && job.state) state = job.state;
      if (Date.now() - printed > 20_000) {
        printed = Date.now();
        console.log(`...    ${row.displayName} attempt ${attempt} state=${state} ${((Date.now() - attemptStarted) / 1000).toFixed(0)}s`);
      }
    }
    if (state !== 'current' && Date.now() - attemptStarted >= perRepoTimeout) failure = `timeout after ${perRepoTimeout}ms`;
    if (state !== 'current' && attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  const ms = Date.now() - repoStarted;
  console.log(`${state === 'current' ? 'ok    ' : 'fail  '} ${row.displayName} state=${state} modules=${modules ?? '-'} ${(ms / 1000).toFixed(1)}s${failure ? ` error=${failure.slice(0, 110)}` : ''}`);
  results.push({ ...row, outcome: state, modules, ...(failure ? { failure } : {}), ms });
}
await pool.end();
const modelled = results.filter((row) => row.outcome === 'current').length + results.filter((row) => row.outcome === 'skipped').length;
console.log(JSON.stringify({ database: values.database, projects: targets.length, modelled, totalMs: Date.now() - started,
  failed: results.filter((row) => !['current', 'skipped'].includes(String(row.outcome))) }, null, 2));
