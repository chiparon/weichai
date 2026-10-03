import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildStructuralIndex } from './structural-index.js';
import { readStructuralIndexTransfer, writeStructuralIndexTransfer } from './structural-assembly-transfer.js';
import type { AssemblyRequest, AssemblyResponse } from './structural-assembly.js';
import type { TreeSitterFileIndex } from './tree-sitter-indexer.js';

// Losing the extension host must not leave a detached large assembly running.
process.once('disconnect', () => process.exit(1));

async function run(): Promise<void> {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('Structural assembly request is missing.');
  const directory = path.dirname(requestPath);
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as AssemblyRequest;
  const previousIndex = request.previous ? await readStructuralIndexTransfer(directory, request.previous) : undefined;
  const byPath = new Map(request.files.map(file => [file.relativePath, file]));
  process.send?.({ type: 'building' });
  const result = buildStructuralIndex({ repositoryId: request.repositoryId, analysisRevision: request.analysisRevision,
    files: request.files.map(file => ({ ...file, get content() { return file.sourcePath ? readFileSync(file.sourcePath, 'utf8') : ''; } })),
    retainSourceTexts: false, changedPaths: request.changedPaths, previousIndex,
    ...(request.parsed ? { indexFile: (input: { relativePath: string }) => {
      const source = byPath.get(input.relativePath);
      const payload = JSON.parse(readFileSync(`${source?.sourcePath}.parsed.json`, 'utf8')) as { result?: TreeSitterFileIndex; error?: string };
      if (!payload.result) throw new Error(payload.error ?? 'Parser worker did not produce a result.');
      return payload.result;
    } } : {}),
  });
  const index = await writeStructuralIndexTransfer(directory, 'assembled', result.index);
  await writeFile(path.join(directory, 'assembly-result.json'), JSON.stringify({ index, stats: result.stats,
    changedPaths: result.changedPaths } satisfies AssemblyResponse));
}

run().then(() => {
  process.send?.({ type: 'complete' }, () => process.exit(0));
}, error => {
  process.send?.({ type: 'error', error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
});
