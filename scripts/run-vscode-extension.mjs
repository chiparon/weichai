#!/usr/bin/env node

/**
 * Cross-platform development launcher for the VS Code extension.
 *
 * This prepares SeekDB and local embedding/reranking, builds the extension,
 * and opens the Extension Development Host. The extension alone starts its
 * workspace-bound adaptation backend after its semantic endpoint is known.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'apps', 'vscode-extension');
const composeFile = path.join(repoRoot, 'services', 'code-intelligence-service', 'infra', 'docker-compose.yml');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vscodeCommand = process.env.FOREXPLORE_VSCODE_COMMAND?.trim() || 'code';

function usage() {
  console.log(`Usage: npm run dev:extension -- [options]

Options:
  --skip-seek-db       Do not run docker compose for SeekDB.
  --skip-services      Do not start local embedding/reranking dependencies.
  --folder <path>      Folder to open in the Extension Development Host.
  --help               Show this help.

The Extension Development Host opens after dependency services are ready.
Use --skip-services for externally managed embedding/reranking dependencies.

The legacy PowerShell spellings (-SkipSeekDb, -SkipServices and -Folder) are
also accepted so existing Windows command lines remain compatible.`);
}

function parseArgs(argv) {
  const options = { skipSeekDb: false, skipServices: false, folder: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const normalized = argument.toLowerCase();
    if (normalized === '--help' || normalized === '-help' || normalized === '-h') {
      usage();
      process.exit(0);
    }
    if (['--skip-seek-db', '--skipseekdb', '-skipseekdb'].includes(normalized)) {
      options.skipSeekDb = true;
      continue;
    }
    if (['--skip-services', '--skipservices', '-skipservices'].includes(normalized)) {
      options.skipServices = true;
      continue;
    }
    if (normalized === '--folder' || normalized === '-folder') {
      options.folder = argv[++index];
      if (!options.folder) throw new Error(`${argument} requires a path.`);
      continue;
    }
    if (normalized.startsWith('--folder=') || normalized.startsWith('-folder=')) {
      options.folder = argument.slice(argument.indexOf('=') + 1);
      if (!options.folder) throw new Error(`${argument} requires a path.`);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function shellArgs(args) {
  if (process.platform !== 'win32') return args;
  // npm.cmd and the VS Code launcher need cmd.exe on Windows. Quote only
  // arguments that need it so repository paths containing spaces survive the
  // shell boundary.
  return args.map((argument) => /[\s"]/.test(argument)
    ? `"${argument.replace(/"/g, '\\"')}"`
    : argument);
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, process.platform === 'win32' && options.shell !== false ? shellArgs(args) : args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requireSuccess(command, args, label) {
  const status = runSync(command, args);
  if (status !== 0) throw new Error(`${label} failed with exit code ${status}.`);
}

function ensureCommand(command, args = ['--version']) {
  const result = spawnSync(command, shellArgs(args), {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Required command '${command}' is not available on PATH.`);
  }
  return result;
}

function ensureVsCodeExtension(extensionId) {
  ensureCommand(vscodeCommand, ['--version']);
  const listed = spawnSync(vscodeCommand, shellArgs(['--list-extensions']), {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(`Unable to list VS Code extensions using '${vscodeCommand}'.`);
  }
  const installed = listed.stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase());
  if (installed.includes(extensionId.toLowerCase())) return;

  console.log(`Installing required VS Code extension: ${extensionId}`);
  requireSuccess(vscodeCommand, ['--install-extension', extensionId], `VS Code extension ${extensionId} installation`);
}

function setDefault(name, value) {
  if (!process.env[name]) process.env[name] = value;
}

function configureEnvironment() {
  setDefault('CODE_INTELLIGENCE_SEEKDB_DATABASE', 'forexplore_javafileupload_flow_20260913');
  setDefault('CODE_INTELLIGENCE_SEEKDB_PORT', process.env.SEEKDB_PORT || '2881');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_URL', `http://127.0.0.1:${process.env.FOREXPLORE_EMBEDDING_PORT || '4021'}/v1/embeddings`);
  setDefault('CODE_INTELLIGENCE_EMBEDDING_MODEL', 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS', 'false');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX', 'query: ');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX', 'passage: ');
  setDefault('CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION', '384');
  // Device and precision change the produced vectors, so the workbench must declare
  // the same embedding variant as the offline ingestion: the store scopes embedding
  // reuse by model identity, and a mismatch would mix providers inside one index.
  setDefault('CODE_INTELLIGENCE_EMBEDDING_VARIANT', 'dml-fp16');
}


function resolveFolder(folder) {
  const resolved = path.resolve(repoRoot, folder);
  if (!existsSync(resolved)) throw new Error(`Folder does not exist: ${resolved}`);
  return resolved;
}


async function startServices(options) {
  if (options.skipServices) return;
  const servicesStatus = runSync(npmCommand, ['run', 'services:up', ...(options.skipSeekDb ? ['--', '--skip-seek-db'] : [])]);
  if (servicesStatus !== 0) {
    throw new Error('Dependency startup failed; inspect the diagnostics above. The development host was not opened.');
  }
}

/** Start the configured SeekDB container without changing its durable volume. */
async function startSeekDb(options) {
  if (options.skipSeekDb) return true;
  const host = process.env.CODE_INTELLIGENCE_SEEKDB_HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return true;
  if (!existsSync(composeFile)) {
    console.warn(`SeekDB compose file does not exist: ${composeFile}. Code intelligence will report fetch failures.`);
    return false;
  }
  try {
    ensureCommand('docker', ['--version']);
  } catch (error) {
    console.warn(`${error.message} SeekDB stays down; code intelligence will report fetch failures.`);
    return false;
  }
  const status = runSync('docker', ['compose', '-f', composeFile, 'up', '-d']);
  if (status !== 0) {
    console.warn(`SeekDB startup failed with exit code ${status}. Code intelligence will report fetch failures.`);
    return false;
  }
  return true;
}


/** Open the Extension Development Host and settle when its launcher process exits. */
function launchHost(options) {
  const args = [`--extensionDevelopmentPath=${extensionRoot}`];
  if (options.folder) args.push(options.folder);
  const vscode = spawn(vscodeCommand, shellArgs(args), {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return new Promise((resolve, reject) => {
    vscode.once('error', reject);
    vscode.once('exit', (code, signal) => {
      if (signal) reject(new Error(`VS Code exited due to signal ${signal}.`));
      else if (code !== 0) reject(new Error(`VS Code exited with code ${code}.`));
      else resolve();
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  process.chdir(repoRoot);
  configureEnvironment();


  ensureVsCodeExtension('redhat.java');
  if (!await startSeekDb(options)) throw new Error('SeekDB startup failed; resolve the Docker error above before opening the development host.');

  requireSuccess(npmCommand, ['run', 'build:extension'], 'Extension build');

  if (options.folder) options.folder = resolveFolder(options.folder);

  await startServices(options);
  console.log('Dependencies are ready; opening the development host.');
  console.log('VS Code keeps one development host per extension path: close the existing window to get a new one.');
  await launchHost(options);
}

main().catch((error) => {
  console.error(`dev:extension failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
