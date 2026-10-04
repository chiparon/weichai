import childProcess from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseSourceFiles } from './structural-parse-pool.js';

describe('bounded native parser scheduling', () => {
  it('applies byte backpressure across workers and preserves the same parsed results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'huawei-parse-pool-'));
    try {
      const source = 'export function sample() { return 123; }';
      const tasks = Array.from({ length: 4 }, (_, i) => ({ sourcePath: join(root, `source-${i}.txt`), resultPath: join(root, `result-${i}.json`), relativePath: `${i}.ts`, sizeBytes: Buffer.byteLength(source) }));
      await Promise.all(tasks.map(task => writeFile(task.sourcePath, source)));
      const serial = await parseSourceFiles(tasks, undefined, { maxWorkers: 2, maxInFlightBytes: tasks[0]!.sizeBytes });
      expect(serial.peakInFlightTasks).toBe(1);
      expect(serial.peakInFlightBytes).toBe(tasks[0]!.sizeBytes);
      const first = await Promise.all(tasks.map(async task => JSON.parse(await readFile(task.resultPath, 'utf8'))));
      const concurrent = await parseSourceFiles(tasks, undefined, { maxWorkers: 2, maxInFlightBytes: tasks[0]!.sizeBytes * 2 });
      expect(concurrent.peakInFlightTasks).toBe(2);
      expect(concurrent.peakInFlightBytes).toBeLessThanOrEqual(tasks[0]!.sizeBytes * 2);
      const second = await Promise.all(tasks.map(async task => JSON.parse(await readFile(task.resultPath, 'utf8'))));
      expect(second).toEqual(first);
      const oversized = await parseSourceFiles(tasks.slice(0, 2), undefined, { maxWorkers: 2, maxInFlightBytes: 1 });
      expect(oversized.peakInFlightTasks).toBe(1);
      expect(oversized.peakInFlightBytes).toBe(tasks[0]!.sizeBytes);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('degrades a crashed file and starts a new worker for subsequent files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-exit-'));
    const fork = childProcess.fork;
    let workers = 0;
    const spawned = vi.spyOn(childProcess, 'fork').mockImplementation((...args) => {
      const child = fork(...args);
      if (++workers === 1) child.on('message', (message: any) => { if (message.id === 0) child.kill(); });
      return child;
    });
    syncBuiltinESMExports();
    try {
      const sourcePath = join(root, 'source.java');
      const source = 'public class Example {}';
      await writeFile(sourcePath, source);
      const tasks = [0, 1, 2].map(index => ({
        sourcePath, resultPath: join(root, `result-${index}.json`),
        relativePath: `Example${index}.java`, sizeBytes: Buffer.byteLength(source),
      }));
      await parseSourceFiles(tasks, undefined, { maxWorkers: 1 });
      expect(JSON.parse(await readFile(tasks[0]!.resultPath, 'utf8')).result.declarations)
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Example' })]));
      expect(JSON.parse(await readFile(tasks[1]!.resultPath, 'utf8')).error).toContain('Structural parser failed');
      expect(JSON.parse(await readFile(tasks[2]!.resultPath, 'utf8')).result.declarations)
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Example' })]));
    } finally {
      spawned.mockRestore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('fails broken worker startup or repeated native crashes (ready=%s)', async (ready) => {
    const root = await mkdtemp(join(tmpdir(), 'worker-broken-'));
    const fork = childProcess.fork;
    const spawned = vi.spyOn(childProcess, 'fork').mockImplementation((...args) => {
      const child = fork(...args);
      if (ready) child.once('message', () => child.kill());
      else child.once('spawn', () => child.kill());
      return child;
    });
    syncBuiltinESMExports();
    try {
      const sourcePath = join(root, 'source.java');
      await writeFile(sourcePath, 'class Example {}');
      const tasks = [0, 1, 2, 3].map(i => ({ sourcePath, resultPath: join(root, `${i}.json`), relativePath: `${i}.java`, sizeBytes: 16 }));
      await expect(parseSourceFiles(tasks, undefined, { maxWorkers: 1 })).rejects.toThrow('Structural parser failed');
      expect(spawned).toHaveBeenCalledTimes(ready ? 3 : 1);
    } finally {
      spawned.mockRestore(); syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects cancellation and invalid budgets before starting workers', async () => {
    await expect(parseSourceFiles([], undefined, { maxWorkers: 0 })).rejects.toThrow('budget');
    await expect(parseSourceFiles([{ sourcePath: 'unused', resultPath: 'unused', relativePath: 'x.ts', sizeBytes: 1 }], AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
  });

  it('preserves the abort reason when cancelled during a worker request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'worker-cancel-'));
    const controller = new AbortController();
    const reason = new DOMException('cancel indexing', 'AbortError');
    const fork = childProcess.fork;
    const spawned = vi.spyOn(childProcess, 'fork').mockImplementation((...args) => {
      const child = fork(...args);
      const send = child.send.bind(child);
      child.send = ((...sendArgs: Parameters<typeof child.send>) => {
        const result = send(...sendArgs);
        queueMicrotask(() => controller.abort(reason));
        return result;
      }) as typeof child.send;
      return child;
    });
    syncBuiltinESMExports();
    try {
      const sourcePath = join(root, 'source.ts');
      await writeFile(sourcePath, 'export const value = 1;');
      await expect(parseSourceFiles([{ sourcePath, resultPath: join(root, 'parsed.json'),
        relativePath: 'source.ts', sizeBytes: 23 }], controller.signal)).rejects.toBe(reason);
    } finally {
      spawned.mockRestore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
});
