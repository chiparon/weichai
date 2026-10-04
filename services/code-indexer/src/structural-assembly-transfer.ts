import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { setImmediate } from 'node:timers/promises';
import type { StructuralIndex } from '@forexplore/contracts';

const collections = ['files', 'projects', 'symbols', 'dependencyEdges', 'diagnostics'] as const;
type Collection = typeof collections[number];
export interface StructuralIndexTransfer {
  repositoryId: string;
  analysisRevision: string;
  analysisHash: string;
  chunks: Record<Collection, string[]>;
}

/** Keep serialization/deserialization work bounded on the calling event loop. */
export async function writeStructuralIndexTransfer(
  directory: string, prefix: string, index: StructuralIndex, signal?: AbortSignal,
): Promise<StructuralIndexTransfer> {
  const chunks = Object.fromEntries(collections.map(key => [key, []])) as unknown as Record<Collection, string[]>;
  for (const key of collections) {
    for (let offset = 0; offset < index[key].length; offset += 512) {
      signal?.throwIfAborted();
      const name = `${prefix}-${key}-${offset}.bin`;
      await writeFile(path.join(directory, name), serialize(index[key].slice(offset, offset + 512)));
      chunks[key].push(name);
      await setImmediate();
    }
  }
  return { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, analysisHash: index.analysisHash, chunks };
}

export async function readStructuralIndexTransfer(
  directory: string, transfer: StructuralIndexTransfer, signal?: AbortSignal,
): Promise<StructuralIndex> {
  const index: StructuralIndex = { repositoryId: transfer.repositoryId, analysisRevision: transfer.analysisRevision,
    analysisHash: transfer.analysisHash, files: [], projects: [], symbols: [], dependencyEdges: [], diagnostics: [] };
  for (const key of collections) {
    for (const name of transfer.chunks[key]) {
      signal?.throwIfAborted();
      const values = deserialize(await readFile(path.join(directory, name))) as StructuralIndex[typeof key];
      (index[key] as unknown[]).push(...values);
      await setImmediate();
    }
  }
  signal?.throwIfAborted();
  return index;
}
