import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StructuralIndex } from '@forexplore/contracts';
import type { StructuralIndexBuild, StructuralIndexBuildStats } from './structural-index.js';
import { readStructuralIndexTransfer, writeStructuralIndexTransfer, type StructuralIndexTransfer } from './structural-assembly-transfer.js';

export interface AssemblySource {
  relativePath: string;
  sha256?: string;
  sizeBytes?: number;
  unavailableReason?: string;
  sourcePath?: string;
}
export interface AssemblyRequest {
  repositoryId: string;
  analysisRevision: string;
  files: AssemblySource[];
  parsed: boolean;
  changedPaths?: readonly string[];
  previous?: StructuralIndexTransfer;
}
export interface AssemblyResponse {
  index: StructuralIndexTransfer;
  changedPaths?: string[];
  stats: StructuralIndexBuildStats;
}

/** Only small control messages cross IPC; index records use bounded disk chunks. */
export async function assembleStructuralIndex(
  directory: string,
  request: Omit<AssemblyRequest, 'previous'> & { previousIndex?: StructuralIndex },
  signal?: AbortSignal,
): Promise<StructuralIndexBuild> {
  signal?.throwIfAborted();
  const { previousIndex, ...input } = request;
  const previous = previousIndex ? await writeStructuralIndexTransfer(directory, 'previous', previousIndex, signal) : undefined;
  const requestPath = path.join(directory, 'assembly-request.json');
  await writeFile(requestPath, JSON.stringify({ ...input, ...(previous ? { previous } : {}) } satisfies AssemblyRequest));
  signal?.throwIfAborted();
  const packagedPath = typeof __dirname === 'string' ? path.join(__dirname, 'structural-assembly-worker.cjs') : undefined;
  const workerPath = packagedPath && existsSync(packagedPath) ? packagedPath
    : fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './structural-assembly-worker.ts' : './structural-assembly-worker.js', import.meta.url));
  const child = fork(workerPath, [requestPath], {
    execArgv: workerPath.endsWith('.ts') ? ['--import', 'tsx'] : [],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2048); });
  let finished = false;
  let failure: Error | undefined;
  const aborted = () => { child.kill('SIGTERM'); };
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('message', (message: { type?: string; error?: string }) => {
        if (message.type === 'complete') finished = true;
        else if (message.type === 'error') failure = new Error(message.error ?? 'Structural assembly failed.');
      });
      child.once('error', reject);
      // IPC may still be draining when exit fires, especially on Windows.
      child.once('close', (code, reason) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        if (failure) { reject(failure); return; }
        if (!finished || code !== 0) { reject(new Error(`Structural assembly process exited (${code ?? reason}). ${stderr}`)); return; }
        resolve();
      });
    });
    signal?.throwIfAborted();
    const response = JSON.parse(await readFile(path.join(directory, 'assembly-result.json'), 'utf8')) as AssemblyResponse;
    const index = await readStructuralIndexTransfer(directory, response.index, signal);
    return { index, stats: response.stats, changedPaths: response.changedPaths, sourceFiles: new Map() };
  } finally {
    signal?.removeEventListener('abort', aborted);
    await stop(child);
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
}
