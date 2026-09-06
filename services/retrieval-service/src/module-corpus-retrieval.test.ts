import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractModuleCorpus } from '@forexplore/code-indexer';
import type { ModuleSearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SeekDbModuleSearchEngine, moduleSearchInternals } from './module-search-engine.js';
import { overlap } from './text-analysis.js';
import type { ModuleSearchStore, RetrievedModuleDocument } from './types.js';

const corpusRoot = fileURLToPath(
  new URL('../../../fixtures/code-corpus', import.meta.url),
);

function moduleText(module: RetrievedModuleDocument): string {
  return [
    module.name, module.purpose, module.domain, ...module.coreApis, ...module.dependencies,
    ...module.representativeSymbols.flatMap((symbol) => [symbol.title, symbol.signature, symbol.summary]),
  ].join('\n');
}

describe('bundled module corpus retrieval quality', () => {
  it('places behaviorally related multipart modules in the Top-4', async () => {
    expect(path.basename(corpusRoot)).toBe('code-corpus');
    const modules = await extractModuleCorpus(corpusRoot);
    const request: ModuleSearchRequest = {
      target: {
        id: 'target:fileupload-core',
        name: 'Commons FileUpload multipart core',
        language: 'Java',
        kind: 'feature',
        purpose: 'Parse multipart requests, preserve ordered fields, enforce request and item limits, and spill large items to disk.',
        domain: 'multipart file upload',
        coreApis: ['parseRequest()', 'readBodyData()', 'getInputStream()', 'DiskFileItem'],
        dependencies: ['stream', 'temporary file'],
      },
      requirement: 'reuse multipart boundary parsing and memory-to-disk threshold behavior',
      topK: 4,
      repositoryScopes: [...new Set(modules.map((module) => module.repository))],
    };
    const semanticQuery = moduleSearchInternals.queryText(request);
    const rank = (
      query: string,
      score: 'semanticScore' | 'textScore' | 'structuralScore',
    ) => modules
      .map((module) => ({ ...module, [score]: overlap(query, moduleText(module)) }))
      .sort((left, right) => (right[score] ?? 0) - (left[score] ?? 0));
    const searchStore: ModuleSearchStore = {
      clearModules: vi.fn(async () => undefined),
      upsertModules: vi.fn(async () => undefined),
      semanticModuleSearch: vi.fn(async () => rank(semanticQuery, 'semanticScore')),
      textModuleSearch: vi.fn(async (query) => rank(query, 'textScore')),
      structuralModuleSearch: vi.fn(async (query) => rank(query, 'structuralScore')),
      moduleById: vi.fn(async () => null),
      symbolsByIds: vi.fn(async () => []),
    };
    const engine = new SeekDbModuleSearchEngine(searchStore, {
      dimension: 3,
      embed: vi.fn(async () => [[1, 0, 0]]),
    });

    const candidates = await engine.searchModules(request);
    const relevant = candidates.filter((candidate) =>
      /commons-fileupload|multipart-vault/.test(candidate.repository),
    );

    expect(candidates).toHaveLength(4);
    expect(relevant.length).toBeGreaterThanOrEqual(3);
    expect(candidates[0]?.repository).toMatch(/commons-fileupload|multipart-vault/);
  });
});
