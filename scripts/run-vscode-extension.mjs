#!/usr/bin/env node

/**
 * Cross-platform development launcher for the VS Code extension.
 *
 * This owns the same pieces as the former PowerShell entry point:
 * development defaults, SeekDB, local embedding/reranking, retrieval and
 * adaptation services, the extension build, and the Extension Development
 * Host. Child services are detached and write to files so the launcher does
 * not depend on a platform-specific terminal window implementation.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(repoRoot, 'apps', 'vscode-extension');
const composeFile = path.join(repoRoot, 'services', 'retrieval-service', 'docker-compose.yml');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vscodeCommand = process.env.FOREXPLORE_VSCODE_COMMAND?.trim() || 'code';
const logDir = process.env.RECAST_EXTENSION_LOG_DIR?.trim() || path.join(os.tmpdir(), 'recast-extension');

const DEFAULT_TRANSLATION_TOKEN = 'java-fileupload-flow-token-0123456789abcdef';

function usage() {
  console.log(`Usage: npm run dev:extension -- [options]

Options:
  --skip-seek-db       Do not run docker compose for SeekDB.
  --skip-services      Do not start retrieval or adaptation services.
  --folder <path>      Folder to open in the Extension Development Host.
  --wait-services      Open the host only after every dependency reports ready.
  --help               Show this help.

The Extension Development Host opens as soon as the extension is built; the
dependency services keep starting in parallel and report their status in this
terminal. Use --wait-services for the old strict order.

The legacy PowerShell spellings (-SkipSeekDb, -SkipServices and -Folder) are
also accepted so existing Windows command lines remain compatible.`);
}

function parseArgs(argv) {
  const options = { skipSeekDb: false, skipServices: false, waitServices: false, folder: undefined };
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
    if (['--wait-services', '--waitservices', '-waitservices'].includes(normalized)) {
      options.waitServices = true;
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
  setDefault('CODE_INTELLIGENCE_EMBEDDING_URL', 'http://127.0.0.1:4021/v1/embeddings');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_MODEL', 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_SUPPORTS_DIMENSIONS', 'false');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_QUERY_PREFIX', 'query: ');
  setDefault('CODE_INTELLIGENCE_EMBEDDING_DOCUMENT_PREFIX', 'passage: ');
  setDefault('CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION', '384');

  if (process.env.ADAPTATION_PROJECT_ROOT?.trim()) {
    process.env.ADAPTATION_PROJECT_ROOT = path.resolve(process.env.ADAPTATION_PROJECT_ROOT);
  }
  setDefault('ADAPTATION_WORKSPACE_TRANSLATION_TOKEN', DEFAULT_TRANSLATION_TOKEN);
  setDefault(
    'FOREXPLORE_JUNIT_CLASSES',
    'org.apache.commons.fileupload.DefaultFileItemTest,org.apache.commons.fileupload.DiskFileItemSerializeTest,' +
      'org.apache.commons.fileupload.DiskFileUploadTest,org.apache.commons.fileupload.FileItemHeadersTest,' +
      'org.apache.commons.fileupload.FileUploadTest,org.apache.commons.fileupload.MultipartStreamTest,' +
      'org.apache.commons.fileupload.ParameterParserTest,org.apache.commons.fileupload.ProgressListenerTest,' +
      'org.apache.commons.fileupload.SizesTest,org.apache.commons.fileupload.StreamingTest,' +
      'org.apache.commons.fileupload.portlet.PortletFileUploadTest,org.apache.commons.fileupload.servlet.ServletFileUploadTest',
  );
  // ADAPTATION_PROJECT_ROOT and FOREXPLORE_TRANSLATION_PROFILE are optional.
  // Module migration supplies a host-owned profile after the user selects a
  // target and candidate; an invented temporary path would block startup.
  // configureWorkspaceTranslation() derives the root from --folder once it is known.

  // The adaptation process receives only the host's loopback query port. The
  // extension binds this port when the workbench is first opened.
  process.env.ADAPTATION_SEMANTIC_INDEX_ENABLED = 'true';
  process.env.SEMANTIC_QUERY_PORT_URL = 'http://127.0.0.1:8790';
  process.env.ADAPTATION_PORT = '8788';
  process.env.ADAPTATION_WORKSPACE_TRANSLATION_ENABLED = 'true';
  process.env.ADAPTATION_WORKSPACE_MAX_TURNS = '40';
  process.env.ADAPTATION_WORKSPACE_COMPILE_COMMAND = JSON.stringify({
    executable: 'node',
    args: ['tools/compile.mjs'],
    timeoutMs: 900_000,
  });
  // ADAPTATION_WORKSPACE_VERIFICATION is set by configureWorkspaceTranslation
  // below, once the workspace root is known.
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

async function waitForPort(port, seconds, label) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await listening(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.warn(`${label} did not listen on ${port} within ${seconds}s.`);
  return await listening(port);
}

function startDetached(label, args) {
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${label}.log`);
  const descriptor = openSync(logPath, 'a');
  const child = spawn(npmCommand, shellArgs(args), {
    cwd: repoRoot,
    env: process.env,
    detached: true,
    windowsHide: true,
    shell: process.platform === 'win32',
    stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  child.once('error', (error) => {
    console.error(`${label} service failed to start: ${error.message}`);
  });
  child.unref();
  return logPath;
}

async function translationEndpointReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/workspace-translations/configuration`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok || response.status === 401;
  } catch {
    return false;
  }
}

function resolveFolder(folder) {
  const resolved = path.resolve(repoRoot, folder);
  if (!existsSync(resolved)) throw new Error(`Folder does not exist: ${resolved}`);
  return resolved;
}

function comparablePath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

async function startServices(options) {
  if (options.skipServices) return;

  const adaptationEnvFile = path.join(repoRoot, 'services', 'adaptation-service', '.env');
  if (!process.env.DEEPSEEK_API_KEY?.trim() && !existsSync(adaptationEnvFile)) {
    console.warn('DEEPSEEK_API_KEY is unset and services/adaptation-service/.env is missing; model calls will fail.');
  }

  const servicesStatus = runSync(npmCommand, ['run', 'services:up']);
  if (servicesStatus !== 0) {
    console.warn('Some dependency services are unavailable; retrieval may report fetch failures.');
  }

  if (await listening(8787)) {
    console.log('Retrieval service is already listening on http://127.0.0.1:8787.');
  } else {
    const log = startDetached('retrieval', ['run', 'dev:retrieval']);
    if (await waitForPort(8787, 90, 'Retrieval service')) {
      console.log('Retrieval service is ready at http://127.0.0.1:8787.');
    } else {
      console.warn(`Start log: ${log}`);
    }
  }

  if (await listening(8788)) {
    console.log('Adaptation service is already listening on http://127.0.0.1:8788.');
  } else {
    const log = startDetached('adaptation', ['run', 'start', '--workspace', '@forexplore/adaptation-service']);
    if (await waitForPort(8788, 120, 'Adaptation service')) {
      console.log('Adaptation service is listening on http://127.0.0.1:8788.');
    } else {
      console.warn(`Start log: ${log}`);
    }
  }

  if (await listening(8788)) {
    if (await translationEndpointReady(8788)) {
      console.log('Workspace translation endpoint is ready at http://127.0.0.1:8788/v1/workspace-translations.');
    } else {
      console.warn('Port 8788 is not serving the workspace translation endpoint; inspect the adaptation log.');
    }
  }
}

/**
 * SeekDB must be up before the services use it, but an unavailable Docker is not
 * a reason to withhold the development host: the extension reports the missing
 * index itself, and this terminal keeps the reason.
 */
async function startSeekDb(options) {
  if (options.skipSeekDb) return true;
  if (!existsSync(composeFile)) {
    console.warn(`SeekDB compose file does not exist: ${composeFile}. Retrieval will report fetch failures.`);
    return false;
  }
  try {
    ensureCommand('docker', ['--version']);
  } catch (error) {
    console.warn(`${error.message} SeekDB stays down; retrieval will report fetch failures.`);
    return false;
  }
  const status = runSync('docker', ['compose', '-f', composeFile, 'up', '-d']);
  if (status !== 0) {
    console.warn(`SeekDB startup failed with exit code ${status}. Retrieval will report fetch failures.`);
    return false;
  }
  return true;
}

const verificationCriteria = ['tools/verify.mjs', 'tools/compile.mjs', 'tools/jdk.mjs'];

/**
 * Behavioral verification is optional and host-owned, but the service reads every
 * criteria file from the workspace root while it starts: declaring criteria for a
 * workspace that does not contain them is what kept the translation endpoint from
 * ever listening under `npm run dev:extension` (the default root is the skeleton
 * fixture, which carries no tools/). Derive the root from the opened folder, keep
 * the criteria only where they exist, and let translation serve without them.
 */
function configureWorkspaceTranslation(options) {
  if (!process.env.ADAPTATION_PROJECT_ROOT?.trim() && options.folder) {
    process.env.ADAPTATION_PROJECT_ROOT = options.folder;
  }
  const projectRoot = process.env.ADAPTATION_PROJECT_ROOT?.trim();
  if (!projectRoot) {
    delete process.env.ADAPTATION_WORKSPACE_VERIFICATION;
    console.warn('No ADAPTATION_PROJECT_ROOT and no --folder: workspace translation starts without behavioral verification.');
    return;
  }
  const missing = verificationCriteria.filter((relative) => !existsSync(path.join(projectRoot, relative)));
  if (missing.length) {
    delete process.env.ADAPTATION_WORKSPACE_VERIFICATION;
    console.warn(`Workspace ${projectRoot} has no ${missing.join(', ')}: workspace translation starts without behavioral verification.`);
    return;
  }
  process.env.ADAPTATION_WORKSPACE_VERIFICATION = JSON.stringify({
    command: { executable: 'node', args: ['tools/verify.mjs'], timeoutMs: 900_000 },
    protectedFiles: verificationCriteria,
  });
  console.log(`Workspace translation root: ${projectRoot} (behavioral verification enabled).`);
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

  if (process.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN.length < 32) {
    throw new Error('ADAPTATION_WORKSPACE_TRANSLATION_TOKEN must contain at least 32 characters.');
  }
  if (!options.skipServices && process.env.ADAPTATION_PROJECT_ROOT && !existsSync(process.env.ADAPTATION_PROJECT_ROOT)) {
    throw new Error(`ADAPTATION_PROJECT_ROOT does not exist: ${process.env.ADAPTATION_PROJECT_ROOT}`);
  }

  ensureVsCodeExtension('redhat.java');
  await startSeekDb(options);

  requireSuccess(npmCommand, ['run', 'build:extension'], 'Extension build');

  if (options.folder) {
    const folderRoot = resolveFolder(options.folder);
    if (process.env.ADAPTATION_PROJECT_ROOT && comparablePath(folderRoot) !== comparablePath(process.env.ADAPTATION_PROJECT_ROOT)) {
      console.warn(`Opened folder (${folderRoot}) differs from ADAPTATION_PROJECT_ROOT (${process.env.ADAPTATION_PROJECT_ROOT}); translation may be rejected.`);
    }
    options.folder = folderRoot;
  }
  configureWorkspaceTranslation(options);

  // The host opens as soon as the extension is built. Waiting for every service
  // first made a working launch look like nothing happened: a cold start spent
  // the full readiness budget of each dependency (minutes) before any window
  // appeared, and a single broken dependency consumed the whole budget.
  if (options.waitServices) {
    await startServices(options);
    await launchHost(options);
    return;
  }

  const host = launchHost(options);
  const services = startServices(options);
  console.log('The development host is opening; dependency services continue in this terminal.');
  console.log('VS Code keeps one development host per extension path: close the existing window to get a new one.');
  await host;
  await services;
}

main().catch((error) => {
  console.error(`dev:extension failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
