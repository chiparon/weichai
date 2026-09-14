// One command to bring up everything RECAST retrieval needs.
//
// Retrieval depends on three processes that were previously started by hand, and
// that fragility is not theoretical: during development the embedding server and
// Docker both died mid-session, and because the local reranker is now the default,
// a rerank server that is not listening silently costs 6 points of recall (the
// delivery falls back to the fused order and records CONTEXT_RERANK_UNAVAILABLE).
//
// Idempotent: anything already listening is left alone. Safe to run repeatedly.
//
//   npm run services:up
//
// Environment (all optional):
//   FOREXPLORE_EMBEDDING_PORT   4021
//   FOREXPLORE_RERANK_PORT      4022
//   FOREXPLORE_EMBEDDING_TOOLS  directory holding @huggingface/transformers
//   FOREXPLORE_MODEL_CACHE      model cache directory
//   SEEKDB_CONTAINER            forexplore-seekdb
//   RECAST_SERVICES_LOG_DIR     where child logs go (default: <tmp>/recast-services)

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, openSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const embeddingPort = Number(process.env.FOREXPLORE_EMBEDDING_PORT ?? 4021);
const rerankPort = Number(process.env.FOREXPLORE_RERANK_PORT ?? 4022);
const seekdbPort = Number(process.env.SEEKDB_PORT ?? 2881);
const container = process.env.SEEKDB_CONTAINER ?? 'forexplore-seekdb';
const tools = process.env.FOREXPLORE_EMBEDDING_TOOLS ?? path.join(tmpdir(), 'recast-embed-tools');
const cache = process.env.FOREXPLORE_MODEL_CACHE ?? path.join(homedir(), '.cache', 'forexplore-model-cache');
const logDir = process.env.RECAST_SERVICES_LOG_DIR ?? path.join(tmpdir(), 'recast-services');
const waitMs = Number(process.env.RECAST_SERVICES_WAIT_MS ?? 180_000);

const listening = (port) => new Promise((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
  socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
});

async function waitFor(port, label) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (await listening(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.error(`${label}: not listening on ${port} after ${Math.round(waitMs / 1000)}s`);
  return false;
}

/** Detached so the service outlives this command; logs go to a file, never a pipe. */
function launch(label, script, env) {
  mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${label}.log`);
  const handle = openSync(log, 'a');
  const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', handle, handle], cwd: process.cwd(),
    env: { ...process.env, ...env } });
  child.unref();
  return log;
}

/** `docker info` only needs its exit status, so nothing is piped. */
const dockerReady = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

async function ensureDocker() {
  if (dockerReady()) return true;
  console.log('SeekDB: docker daemon is down, starting Docker Desktop');
  for (const candidate of [path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DockerDesktop', 'Docker Desktop.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Docker', 'Docker', 'Docker Desktop.exe')]) {
    if (!candidate || !candidate.includes('Docker')) continue;
    const result = spawnSync(candidate, [], { stdio: 'ignore', detached: true });
    if (result.error === undefined) break;
  }
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    if (dockerReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

const results = [];
const step = async (label, port, action) => {
  if (await listening(port)) { results.push([label, port, 'already up']); return true; }
  const log = action();
  const ok = await waitFor(port, label);
  results.push([label, port, ok ? `started${log ? ` (log: ${log})` : ''}` : 'FAILED']);
  return ok;
};

const seekdb = await step('SeekDB', seekdbPort, () => {
  if (!dockerReady()) { console.error(`SeekDB: docker daemon unavailable — start Docker Desktop and retry.`); return null; }
  spawnSync('docker', ['start', container], { stdio: 'ignore' });
  return null;
});

const embedding = await step('embedding', embeddingPort, () => launch('embedding', path.join('scripts', 'serve-local-embeddings.mjs'),
  { FOREXPLORE_EMBEDDING_TOOLS: tools, FOREXPLORE_MODEL_CACHE: cache, FOREXPLORE_EMBEDDING_PORT: String(embeddingPort) }));

const rerank = await step('rerank', rerankPort, () => launch('rerank', path.join('scripts', 'serve-local-rerank.mjs'),
  { FOREXPLORE_EMBEDDING_TOOLS: tools, FOREXPLORE_MODEL_CACHE: cache, FOREXPLORE_RERANK_PORT: String(rerankPort) }));

console.log('\nservice    port   status');
for (const [label, port, status] of results) console.log(`${label.padEnd(10)} ${String(port).padEnd(6)} ${status}`);
if (!seekdb || !embedding || !rerank) {
  console.error('\nRetrieval will not reach full recall until every service above is up.');
  process.exitCode = 1;
}
