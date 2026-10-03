import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodeIntelligenceRuntime, InMemoryIndexStore, RepositoryStructuralScanner } from './index.js';
import type { AnalysisProgress, StructuralScanRequest } from './analysis-coordinator.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'recast-index-recovery-'));
  roots.push(root);
  await writeFile(path.join(root, 'main.ts'), Array.from({ length: 150 }, (_, i) => `export function work${i}() { return ${i}; }`).join('\n'));
  await writeFile(path.join(root, 'stable.ts'), 'export function stable() { return 1; }');
  const store = new InMemoryIndexStore();
  const scanner = new RepositoryStructuralScanner({ readSourceRevision: async () => undefined });
  const scan = vi.spyOn(scanner, 'scan');
  const runtime = await createCodeIntelligenceRuntime({ store, scanner });
  await runtime.registry.register({ repositoryId: 'recover', localPath: root, role: 'target' });
  const append = store.appendSearchDocuments.bind(store);
  let batch = 0;
  vi.spyOn(store, 'appendSearchDocuments').mockImplementation(async (...args) => {
    if (++batch === 2) throw new Error('embedding unavailable');
    await append(...args);
  });
  return { root, store, scanner, scan, runtime };
}

describe('failed projection recovery', () => {
  it('reuses durable parsing after reopening without rewriting the failed revision', async () => {
    const { store, scanner, scan, runtime } = await setup();
    const progress: AnalysisProgress[] = [];
    await expect(runtime.coordinator.run({ repositoryId: 'recover', onProgress: value => progress.push(value) }))
      .rejects.toThrow('batch 2 failed');
    const failed = (await store.listRevisions('recover'))[0]!;
    expect(failed).toMatchObject({ status: 'failed', failureStage: 'search-projection' });
    expect((await store.getRepository('recover'))?.activeRevision).toBeNull();
    expect(progress.map(value => value.stage)).toContain('search-projection');
    const reopened = await createCodeIntelligenceRuntime({ store, scanner });
    const result = await reopened.coordinator.run({ repositoryId: 'recover', reuseFailedProjection: true,
      onProgress: value => progress.push(value) });
    expect(scan.mock.calls[1]![0]).toMatchObject({ mode: 'incremental', previousIndex: { analysisRevision: failed.analysisRevision } });
    expect(result.reusedFileCount).toBe(2);
    expect(result.scope.analysisRevision).not.toBe(failed.analysisRevision);
    expect(await store.getRevision(failed)).toEqual(failed);
    expect((await store.getRepository('recover'))?.activeRevision).toBe(result.scope.analysisRevision);
    expect(progress.map(value => value.stage)).toContain('recover');
    expect(progress.at(-1)?.stage).toBe('activation');
  });

  it('rechecks changed, added and deleted files rather than activating stale source', async () => {
    const { root, store, runtime } = await setup();
    await writeFile(path.join(root, 'removed.ts'), 'export function removed() {}');
    await expect(runtime.coordinator.run({ repositoryId: 'recover' })).rejects.toThrow('embedding unavailable');
    await writeFile(path.join(root, 'main.ts'), 'export function changed() { return 42; }');
    await writeFile(path.join(root, 'added.ts'), 'export function added() {}');
    await rm(path.join(root, 'removed.ts'));
    const result = await runtime.coordinator.run({ repositoryId: 'recover', reuseFailedProjection: true });
    expect(result.reusedFileCount).toBe(1);
    const index = (await store.getStructuralIndex(result.scope))!;
    expect(index.files.map(file => file.relativePath).sort()).toEqual(['added.ts', 'main.ts', 'stable.ts']);
    expect(index.symbols.map(symbol => symbol.name).sort()).toEqual(['added', 'changed', 'stable']);
    expect(await store.getSourceText(result.scope, 'main.ts')).toContain('return 42');
  });

  it('never reuses a partially persisted structural index', async () => {
    const { store, scan, runtime } = await setup();
    const write = vi.spyOn(store, 'putStructuralIndexFromSource').mockRejectedValueOnce(new Error('disk write failed'));
    await expect(runtime.coordinator.run({ repositoryId: 'recover' })).rejects.toThrow('disk write failed');
    expect((await store.listRevisions('recover'))[0]).toMatchObject({ failureStage: 'structural-write' });
    write.mockRestore();
    await expect(runtime.coordinator.run({ repositoryId: 'recover', reuseFailedProjection: true })).rejects.toThrow('embedding unavailable');
    expect((scan.mock.calls[1]![0] as StructuralScanRequest).previousIndex).toBeUndefined();
  });

  it('keeps an explicit full rebuild independent of failed parsing', async () => {
    const { scan, runtime } = await setup();
    await expect(runtime.coordinator.run({ repositoryId: 'recover' })).rejects.toThrow();
    await runtime.coordinator.run({ repositoryId: 'recover', mode: 'full' });
    expect(scan.mock.calls[1]![0].previousIndex).toBeUndefined();
  });
});
