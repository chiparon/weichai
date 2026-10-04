import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assembleStructuralIndex } from './structural-assembly.js';

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('node:child_process', () => ({ fork }));
const roots: string[] = [];
afterEach(async () => {
  fork.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each([
  { complete: true, code: 0, succeeds: true },
  { complete: false, code: 0, succeeds: false },
  { complete: true, code: 1, succeeds: false },
])('drains completion IPC after exit before deciding success: %j', async ({ complete, code, succeeds }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'assembly-close-'));
  roots.push(root);
  const index = { repositoryId: 'repo', analysisRevision: 'revision', analysisHash: 'hash',
    chunks: { files: [], projects: [], symbols: [], dependencyEdges: [], diagnostics: [] } };
  await writeFile(path.join(root, 'assembly-result.json'), JSON.stringify({ index, stats: {} }));
  fork.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, pid: 123, stderr: new EventEmitter() });
    setImmediate(() => {
      child.emit('message', { type: 'building' });
      child.exitCode = code;
      child.emit('exit', code, null);
      if (complete) child.emit('message', { type: 'complete' });
      child.emit('close', code, null);
    });
    return child;
  });
  const result = assembleStructuralIndex(root, { repositoryId: 'repo', analysisRevision: 'revision', files: [], parsed: false });
  if (succeeds) await expect(result).resolves.toMatchObject({ index: { analysisHash: 'hash', files: [] } });
  else await expect(result).rejects.toThrow(`Structural assembly process exited (${code})`);
});
