import type {
  IndexedModuleDocument,
  ModuleSearchRequest,
} from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import { SeekDbModuleSearchEngine, moduleSearchInternals } from './module-search-engine.js';
import type {
  EmbeddingProvider,
  ModuleSearchStore,
  RetrievedCodeDocument,
  RetrievedModuleDocument,
} from './types.js';

function module(overrides: Partial<RetrievedModuleDocument> = {}): RetrievedModuleDocument {
  const base: IndexedModuleDocument = {
    id: 'fixture/upload:multipart',
    repository: 'fixture/upload',
    moduleId: 'multipart',
    name: 'Multipart upload',
    kind: 'feature',
    language: 'Python',
    license: 'Apache-2.0',
    purpose: 'Parse multipart requests, preserve part order and enforce size limits.',
    domain: 'multipart upload',
    coreApis: ['parseRequest(context)', 'readBodyData()', 'getBoundary()'],
    sourceFiles: ['src/upload.py'],
    symbolIds: ['parse', 'container'],
    dependencies: [],
    structureTerms: ['feature', 'parse', 'request', 'boundary', 'stream'],
    representativeSymbols: [{
      id: 'parse', title: 'parseRequest', kind: 'function', path: 'src/upload.py',
      signature: 'parse_request(context)', summary: 'Parse ordered multipart fields.', preview: 'def parse_request(): pass',
    }],
    compatibility: ['cross-language'],
    risks: [],
    snapshotId: 'module-1',
    contentHash: 'hash-1',
  };
  return { ...base, semanticScore: 0.9, textScore: 0.8, structuralScore: 0.85, ...overrides };
}

const request: ModuleSearchRequest = {
  target: {
    id: 'target:multipart',
    name: 'Multipart core',
    language: 'Java',
    kind: 'feature',
    purpose: 'Parse multipart requests and enforce item size limits.',
    domain: 'file upload',
    coreApis: ['parseRequest(context)', 'readBodyData()'],
    dependencies: [],
  },
  requirement: 'preserve part order and reject oversized items',
  topK: 4,
  repositoryScopes: ['fixture/upload', 'fixture/other'],
};

function symbol(overrides: Partial<RetrievedCodeDocument> = {}): RetrievedCodeDocument {
  return {
    id: 'parse', title: 'parseRequest', repository: 'fixture/upload', license: 'Apache-2.0',
    language: 'Python', kind: 'function', path: 'src/upload.py', signature: 'parse_request(context)',
    summary: 'Parse ordered multipart parts.', preview: 'def parse_request(context): pass', dependencies: [],
    compatibility: [], risks: [], ...overrides,
  };
}

function store(): ModuleSearchStore {
  const relevant = module();
  const other = module({
    id: 'fixture/other:audit', repository: 'fixture/other', moduleId: 'audit', name: 'Audit',
    purpose: 'Append audit records.', domain: 'audit', coreApis: ['append(record)'],
    symbolIds: ['audit-class'], structureTerms: ['audit', 'append'], semanticScore: 0.2,
    textScore: 0.1, structuralScore: 0.1,
  });
  return {
    clearModules: vi.fn(async () => undefined),
    upsertModules: vi.fn(async () => undefined),
    semanticModuleSearch: vi.fn(async () => [relevant, other]),
    textModuleSearch: vi.fn(async () => [relevant]),
    structuralModuleSearch: vi.fn(async () => [relevant]),
    moduleById: vi.fn(async (id) => id === relevant.id ? relevant : null),
    symbolsByIds: vi.fn(async () => [symbol(), symbol({ id: 'container', title: 'Upload', kind: 'class' })]),
  };
}

const embeddings: EmbeddingProvider = {
  dimension: 3,
  embed: vi.fn(async () => [[1, 0, 0]]),
};

describe('SeekDbModuleSearchEngine', () => {
  it('runs semantic, full-text, and structural recall and ranks by module coverage', async () => {
    const searchStore = store();
    const engine = new SeekDbModuleSearchEngine(searchStore, embeddings);

    const candidates = await engine.searchModules(request);

    expect(candidates[0]?.id).toBe('fixture/upload:multipart');
    expect(candidates[0]?.matchedApis).toEqual(request.target.coreApis);
    expect(searchStore.semanticModuleSearch).toHaveBeenCalledOnce();
    expect(searchStore.textModuleSearch).toHaveBeenCalledOnce();
    expect(searchStore.structuralModuleSearch).toHaveBeenCalledOnce();
  });

  it('pushes language and repository exclusions into every recall channel', async () => {
    const searchStore = store();
    const engine = new SeekDbModuleSearchEngine(searchStore, embeddings);
    await engine.searchModules({
      ...request,
      candidateLanguages: ['Python'],
      excludeRepositories: ['fixture/other'],
    });

    expect(searchStore.semanticModuleSearch).toHaveBeenCalledWith(
      [1, 0, 0],
      expect.objectContaining({ languages: ['Python'], excludeRepositories: ['fixture/other'] }),
      32,
    );
  });

  it('restricts second-stage symbols to the selected module and target kind', async () => {
    const searchStore = store();
    const engine = new SeekDbModuleSearchEngine(searchStore, embeddings);
    const candidates = await engine.searchModuleSymbols({
      moduleId: 'fixture/upload:multipart',
      target: {
        id: 'target-method', name: 'parseRequest', kind: 'function', path: 'Multipart.java',
        language: 'Java', signature: 'List<Item> parseRequest(Context context)',
      },
      requirement: 'parse ordered fields',
      topK: 3,
      repositoryScopes: ['fixture/upload'],
    });

    expect(candidates.map((item) => item.id)).toEqual(['parse']);
    expect(searchStore.symbolsByIds).toHaveBeenCalledWith(['parse', 'container'], ['fixture/upload']);
  });

  it('limits near-duplicate modules from one repository before backfilling', () => {
    const candidates = [
      module({ id: 'repo:a', moduleId: 'a' }),
      module({ id: 'repo:b', moduleId: 'b' }),
      module({ id: 'repo:c', moduleId: 'c' }),
      module({ id: 'other:d', repository: 'fixture/other', moduleId: 'd', coreApis: ['differentApi'] }),
    ].map((item, index) => ({
      ...item,
      score: { overall: 1 - index * 0.1, semantic: 1, lexical: 1, structural: 1, apiCoverage: 1, adaptability: 1, quality: 1, hybrid: 1 },
      matchedApis: [], missingApis: [], matchedRequirements: [],
    }));

    expect(moduleSearchInternals.diversify(candidates, 3).map((item) => item.id))
      .toEqual(['repo:a', 'other:d', 'repo:b']);
  });
});
