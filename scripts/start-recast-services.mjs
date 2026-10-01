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
//                               (default: <LOCALAPPDATA>/recast/embed-tools)
//   FOREXPLORE_MODEL_CACHE      model cache directory
//   FOREXPLORE_MODEL_HOST       model host for downloads (default: a mirror,
//                               because Node's fetch ignores the proxy here)
//   SEEKDB_CONTAINER            forexplore-seekdb
//   RECAST_SERVICES_LOG_DIR     where child logs go (default: <tmp>/recast-services)

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const runtimePackage = '@huggingface/transformers';
// Pinned to the version the service scripts assume: they rely on `env.cacheDir`,
// `env.allowRemoteModels` and `dtype: 'q8'`.
const runtimeVersion = '3.8.1';
const defaultModelHost = 'https://hf-mirror.com';
const embeddingPort = Number(process.env.FOREXPLORE_EMBEDDING_PORT ?? 4021);
const rerankPort = Number(process.env.FOREXPLORE_RERANK_PORT ?? 4022);
const seekdbPort = Number(process.env.SEEKDB_PORT ?? 2881);
const container = process.env.SEEKDB_CONTAINER ?? 'forexplore-seekdb';

/**
 * A durable per-user location, never `os.tmpdir()`: the system cleans the temp
 * directory, and when the runtime disappeared with it every start burned its full
 * readiness budget and then failed with a bare MODULE_NOT_FOUND, which reached the
 * workbench as an unexplained "fetch failed".
 */
function defaultToolsDirectory() {
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
    : path.join(homedir(), '.cache');
  return path.join(base, 'recast', 'embed-tools');
}

const tools = process.env.FOREXPLORE_EMBEDDING_TOOLS ?? defaultToolsDirectory();
const cache = process.env.FOREXPLORE_MODEL_CACHE ?? path.join(homedir(), '.cache', 'forexplore-model-cache');
const logDir = process.env.RECAST_SERVICES_LOG_DIR ?? path.join(tmpdir(), 'recast-services');
let waitMs = Number(process.env.RECAST_SERVICES_WAIT_MS ?? 180_000);
const maxLogBytes = 10 * 1024 * 1024;

const runtimeResolvable = (directory) => {
  try {
    createRequire(path.join(directory, 'package.json')).resolve(runtimePackage);
    return true;
  } catch {
    return false;
  }
};

/**
 * The inference runtime carries native ONNX binaries, so it lives outside the
 * workspace instead of in every install. A fresh machine — or one whose cache was
 * cleaned — therefore has nothing to launch: install it on demand rather than
 * reporting a probe timeout.
 */
function ensureEmbeddingRuntime() {
  if (runtimeResolvable(tools)) return true;
  if (process.env.FOREXPLORE_EMBEDDING_SKIP_INSTALL === '1') {
    console.error(`Embedding runtime ${runtimePackage} is missing from ${tools} and FOREXPLORE_EMBEDDING_SKIP_INSTALL=1.`);
    return false;
  }
  console.log(`Embedding runtime ${runtimePackage} is missing from ${tools}; installing ${runtimeVersion}.`);
  mkdirSync(tools, { recursive: true });
  const manifest = path.join(tools, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, `${JSON.stringify({ name: 'recast-embed-tools', private: true, version: '1.0.0' }, null, 2)}\n`);
  }
  const installed = spawnSync(npmCommand, ['install', '--prefix', tools, '--ignore-scripts', '--no-audit', '--no-fund',
    `${runtimePackage}@${runtimeVersion}`], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (installed.status !== 0 || !runtimeResolvable(tools)) {
    console.error(`Unable to install ${runtimePackage} into ${tools}.`);
    console.error('Install it by hand, or point FOREXPLORE_EMBEDDING_TOOLS at a directory that already contains it.');
    return false;
  }
  console.log(`Embedding runtime ready in ${tools}.`);
  return true;
}

const modelCachePopulated = () => {
  try {
    return existsSync(cache) && readdirSync(cache).length > 0;
  } catch {
    return false;
  }
};

/**
 * The library downloads from huggingface.co, which Node on this machine cannot
 * always reach (its fetch ignores the configured proxy). The mirror is therefore
 * the default whenever no host is set; a complete cache loads offline, and the
 * host is then never consulted.
 */
function modelHostEnvironment() {
  if (process.env.FOREXPLORE_MODEL_HOST) return { FOREXPLORE_MODEL_HOST: process.env.FOREXPLORE_MODEL_HOST };
  if (!modelCachePopulated()) console.log(`Model cache ${cache} is empty; downloading through ${defaultModelHost}.`);
  return { FOREXPLORE_MODEL_HOST: defaultModelHost };
}

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

/**
 * Detached so the service outlives this command; logs go to a file, never a pipe.
 * A log over 10 MiB moves to `<label>.log.1` (replacing the older one) first.
 */
function launch(label, script, env) {
  mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${label}.log`);
  try {
    if (statSync(log).size > maxLogBytes) renameSync(log, `${log}.1`);
  } catch {
    // No log yet, or it is still held open; keep appending.
  }
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

const runtimeReady = ensureEmbeddingRuntime();
if (!runtimeReady) {
  // Both local servers exit immediately without the runtime, so probing the full
  // readiness budget would only postpone the report.
  waitMs = Math.min(waitMs, 5_000);
  console.error('Local embedding and rerank servers cannot start without the inference runtime.');
}
const modelHost = modelHostEnvironment();

const embedding = await step('embedding', embeddingPort, () => launch('embedding', path.join('scripts', 'serve-local-embeddings.mjs'),
  { FOREXPLORE_EMBEDDING_TOOLS: tools, FOREXPLORE_MODEL_CACHE: cache, FOREXPLORE_EMBEDDING_PORT: String(embeddingPort), ...modelHost }));

const rerank = await step('rerank', rerankPort, () => launch('rerank', path.join('scripts', 'serve-local-rerank.mjs'),
  { FOREXPLORE_EMBEDDING_TOOLS: tools, FOREXPLORE_MODEL_CACHE: cache, FOREXPLORE_RERANK_PORT: String(rerankPort), ...modelHost }));

console.log('\nservice    port   status');
for (const [label, port, status] of results) console.log(`${label.padEnd(10)} ${String(port).padEnd(6)} ${status}`);
if (!seekdb || !embedding || !rerank) {
  console.error('\nRetrieval will not reach full recall until every service above is up.');
  process.exitCode = 1;
}
