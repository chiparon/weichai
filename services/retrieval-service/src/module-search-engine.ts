import type {
  ModuleSearchCandidate,
  ModuleSearchRequest,
  ModuleSymbolSearchRequest,
  SearchCandidate,
} from '@forexplore/contracts';
import { expandedSearchText, overlap, searchTokens } from './text-analysis.js';
import { normalizeRepositoryId, RepositoryScopeError, requireRepositoryScopes } from './repository-scope.js';
import type {
  EmbeddingProvider,
  LlmModuleReranker,
  LlmReranker,
  ModuleSearchEngine,
  ModuleSearchFilters,
  ModuleSearchStore,
  RetrievedCodeDocument,
  RetrievedModuleDocument,
} from './types.js';

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function excludedRepositories(values: string[] | undefined): string[] {
  return unique((values ?? []).map((value) => {
    const normalized = normalizeRepositoryId(value);
    if (!normalized) throw new RepositoryScopeError(`Invalid excluded repository identifier: ${JSON.stringify(value)}.`);
    return normalized;
  }));
}

function queryText(request: ModuleSearchRequest): string {
  const symbols = [request.target.focusSymbol, ...(request.target.incompleteSymbols ?? [])]
    .filter((symbol): symbol is NonNullable<typeof symbol> => Boolean(symbol));
  const raw = [
    request.target.name,
    request.target.kind ?? '',
    request.target.purpose,
    request.target.domain ?? '',
    request.target.language,
    ...request.target.coreApis,
    ...request.target.dependencies,
    ...symbols.flatMap((symbol) => [symbol.name, symbol.signature, symbol.documentation ?? '']),
    request.requirement,
  ].join('\n');
  return `${raw}\n${expandedSearchText(raw)}`;
}

function structuralQuery(request: ModuleSearchRequest): string {
  const raw = [
    request.target.kind ?? '',
    ...request.target.coreApis,
    ...request.target.dependencies,
    request.target.focusSymbol?.signature ?? '',
    ...(request.target.incompleteSymbols ?? []).map((symbol) => symbol.signature),
  ].join('\n');
  return `${raw}\n${expandedSearchText(raw)}`;
}

function jaccard(left: Iterable<string>, right: Iterable<string>): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function normalizedTerms(values: string[]): Set<string> {
  return new Set(values.flatMap((value) => [...searchTokens(value)]));
}

function mergeRecall(
  semantic: RetrievedModuleDocument[],
  lexical: RetrievedModuleDocument[],
  structural: RetrievedModuleDocument[],
): RetrievedModuleDocument[] {
  const merged = new Map<string, { document: RetrievedModuleDocument; rrf: number }>();
  const add = (
    documents: RetrievedModuleDocument[],
    weight: number,
    score: 'semanticScore' | 'textScore' | 'structuralScore',
  ) => documents.forEach((document, rank) => {
    const current = merged.get(document.id);
    merged.set(document.id, {
      document: { ...(current?.document ?? document), [score]: document[score] },
      rrf: (current?.rrf ?? 0) + weight / (60 + rank + 1),
    });
  });
  add(semantic, 0.45, 'semanticScore');
  add(lexical, 0.25, 'textScore');
  add(structural, 0.30, 'structuralScore');
  const maximum = Math.max(...[...merged.values()].map((item) => item.rrf), 1 / 61);
  return [...merged.values()].map(({ document, rrf }) => ({
    ...document,
    hybridScore: clamp(rrf / maximum),
  }));
}

function apiMatches(targetApis: string[], candidateApis: string[]): {
  matched: string[];
  missing: string[];
  coverage: number;
} {
  if (targetApis.length === 0) return { matched: [], missing: [], coverage: 0.5 };
  const matched: string[] = [];
  const missing: string[] = [];
  for (const target of targetApis) {
    const best = Math.max(0, ...candidateApis.map((candidate) => overlap(target, candidate)));
    (best >= 0.25 ? matched : missing).push(target);
  }
  return { matched, missing, coverage: matched.length / targetApis.length };
}

function candidate(
  document: RetrievedModuleDocument,
  request: ModuleSearchRequest,
): ModuleSearchCandidate {
  const query = queryText(request);
  const moduleText = [
    document.name, document.purpose, document.domain, document.kind,
    ...document.coreApis, ...document.dependencies,
    ...document.representativeSymbols.flatMap((symbol) => [symbol.title, symbol.signature, symbol.summary]),
  ].join('\n');
  const semantic = clamp(document.semanticScore ?? overlap(query, moduleText));
  const lexical = clamp(document.textScore ?? overlap(query, moduleText));
  const targetStructure = normalizedTerms([
    request.target.kind ?? '',
    ...request.target.coreApis,
    ...request.target.dependencies,
  ]);
  const structuralLocal = jaccard(targetStructure, normalizedTerms(document.structureTerms));
  const structural = clamp(
    document.structuralScore === undefined
      ? structuralLocal
      : 0.65 * document.structuralScore + 0.35 * structuralLocal,
  );
  const apis = apiMatches(request.target.coreApis, document.coreApis);
  const behavioral = overlap(
    [request.target.purpose, request.target.domain ?? '', request.requirement].join('\n'),
    [document.purpose, document.domain, ...document.representativeSymbols.map((item) => item.summary)].join('\n'),
  );
  const dependencyBurden = Math.min(0.2, document.dependencies.length * 0.015);
  const adaptability = clamp((request.target.language === document.language ? 0.9 : 0.75) - dependencyBurden);
  const quality = clamp(
    Math.min(1, document.representativeSymbols.length / 8) -
      (document.risks.includes('Synthetic evaluation fixture') ? 0.1 : 0),
  );
  const hybrid = clamp(document.hybridScore ?? 0);
  const riskPenalty = Math.min(0.15, document.risks.length * 0.025);
  const overall = clamp(
    0.25 * behavioral +
    0.20 * apis.coverage +
    0.15 * structural +
    0.15 * semantic +
    0.10 * adaptability +
    0.05 * quality +
    0.05 * lexical +
    0.05 * hybrid -
    riskPenalty,
  );
  const requirementTokens = searchTokens(request.requirement);
  const moduleTokens = searchTokens(moduleText);
  const matchedRequirements = [...requirementTokens]
    .filter((token) => token.length > 2 && moduleTokens.has(token))
    .slice(0, 12);
  return {
    ...document,
    score: { overall, semantic, lexical, structural, apiCoverage: apis.coverage, adaptability, quality, hybrid },
    matchedApis: apis.matched,
    missingApis: apis.missing,
    matchedRequirements,
  };
}

function deterministicOrder(candidates: ModuleSearchCandidate[]): ModuleSearchCandidate[] {
  return [...candidates].sort((left, right) =>
    right.score.overall - left.score.overall ||
    right.score.hybrid - left.score.hybrid ||
    left.id.localeCompare(right.id),
  );
}

function diversify(candidates: ModuleSearchCandidate[], topK: number): ModuleSearchCandidate[] {
  const selected: ModuleSearchCandidate[] = [];
  const deferred: ModuleSearchCandidate[] = [];
  const repositoryCounts = new Map<string, number>();
  for (const item of candidates) {
    const duplicate = selected.some((existing) =>
      jaccard(normalizedTerms(existing.coreApis), normalizedTerms(item.coreApis)) >= 0.9,
    );
    if ((repositoryCounts.get(item.repository) ?? 0) >= 2 || duplicate) {
      deferred.push(item);
      continue;
    }
    selected.push(item);
    repositoryCounts.set(item.repository, (repositoryCounts.get(item.repository) ?? 0) + 1);
    if (selected.length === topK) return selected;
  }
  for (const item of deferred) {
    if (!selected.some((existing) => existing.id === item.id)) selected.push(item);
    if (selected.length === topK) break;
  }
  return selected;
}

function symbolCandidate(
  document: RetrievedCodeDocument,
  request: ModuleSymbolSearchRequest,
): SearchCandidate {
  const query = [
    request.target.name, request.target.signature, request.target.documentation ?? '', request.requirement,
  ].join('\n');
  const text = [document.title, document.signature, document.summary, document.preview].join('\n');
  const semantic = overlap(query, text);
  const symbol = clamp(0.55 * overlap(request.target.name, document.title) + 0.45 * overlap(request.target.signature, document.signature));
  const contract = clamp(
    (request.target.kind === document.kind ? 0.65 : 0) +
    (request.target.language === document.language ? 0.2 : 0.15) +
    (document.dependencies.length === 0 ? 0.15 : 0.05),
  );
  const overall = clamp(0.5 * semantic + 0.3 * symbol + 0.2 * contract);
  return {
    id: document.id,
    title: document.title,
    repository: document.repository,
    license: document.license,
    language: document.language,
    kind: document.kind,
    path: document.path,
    signature: document.signature,
    summary: document.summary,
    score: { overall, semantic, symbol, contract, hybrid: overall },
    preview: document.preview,
    dependencies: document.dependencies,
    compatibility: document.compatibility,
    risks: document.risks,
  };
}

export class SeekDbModuleSearchEngine implements ModuleSearchEngine {
  constructor(
    private readonly store: ModuleSearchStore,
    private readonly embeddings: EmbeddingProvider,
    private readonly moduleReranker?: LlmModuleReranker,
    private readonly symbolReranker?: LlmReranker,
  ) {}

  async searchModules(request: ModuleSearchRequest): Promise<ModuleSearchCandidate[]> {
    const repositories = requireRepositoryScopes(request.repositoryScopes);
    const filters: ModuleSearchFilters = {
      repositories,
      languages: unique(request.candidateLanguages ?? []),
      excludeRepositories: excludedRepositories(request.excludeRepositories),
    };
    const semanticText = queryText(request);
    const structureText = structuralQuery(request);
    const [embedding] = await this.embeddings.embed([semanticText]);
    if (!embedding) throw new Error('Embedding provider returned no module query vector.');
    const limit = Math.min(100, Math.max(30, request.topK * 8));
    const [semantic, lexical, structural] = await Promise.all([
      this.store.semanticModuleSearch(embedding, filters, limit),
      this.store.textModuleSearch(semanticText, filters, limit),
      this.store.structuralModuleSearch(structureText, filters, limit),
    ]);
    let ranked = deterministicOrder(mergeRecall(semantic, lexical, structural)
      .filter((document) => !filters.excludeRepositories.includes(document.repository))
      .map((document) => candidate(document, request)));

    if (this.moduleReranker && request.rerank !== false && ranked.length > 1) {
      const pool = ranked.slice(0, 20);
      try {
        const results = await this.moduleReranker.rerankModules(request, pool);
        const expected = new Set(pool.map((item) => item.id));
        if (results.length !== expected.size || results.some((item) => !expected.delete(item.id)) || expected.size > 0) {
          throw new Error('Module reranker returned an incomplete or duplicate candidate set.');
        }
        const byId = new Map(results.map((item) => [item.id, item]));
        const rerankedPool = pool.map((item) => {
          const result = byId.get(item.id);
          return {
            ...item,
            score: { ...item.score, rerank: result?.score },
            rerankReason: result?.reason,
          };
        }).sort((left, right) =>
          (right.score.rerank ?? 0) - (left.score.rerank ?? 0) ||
          right.score.overall - left.score.overall,
        );
        ranked = [...rerankedPool, ...ranked.slice(20)];
      } catch (error) {
        console.warn('Module reranking failed; using deterministic module ranking.', error);
      }
    }
    return diversify(ranked, request.topK);
  }

  async searchModuleSymbols(request: ModuleSymbolSearchRequest): Promise<SearchCandidate[]> {
    const repositories = requireRepositoryScopes(request.repositoryScopes);
    const module = await this.store.moduleById(request.moduleId, repositories);
    if (!module) throw new Error(`Unknown or unauthorized module: ${request.moduleId}.`);
    const languages = new Set(request.candidateLanguages ?? []);
    let ranked = (await this.store.symbolsByIds(module.symbolIds, repositories))
      .filter((document) =>
        document.repository === module.repository &&
        document.kind === request.target.kind &&
        (languages.size === 0 || languages.has(document.language)),
      )
      .map((document) => symbolCandidate(document, request))
      .sort((left, right) => right.score.overall - left.score.overall || left.id.localeCompare(right.id));
    if (this.symbolReranker && request.rerank !== false && ranked.length > 1) {
      const pool = ranked.slice(0, 20);
      try {
        const results = await this.symbolReranker.rerank(
          { ...request, target: request.target, repositoryScopes: repositories },
          pool,
        );
        const byId = new Map(results.map((item) => [item.id, item]));
        if (byId.size === pool.length && pool.every((item) => byId.has(item.id))) {
          ranked = [
            ...pool.map((item) => {
              const result = byId.get(item.id);
              return { ...item, score: { ...item.score, rerank: result?.score }, rerankReason: result?.reason };
            }).sort((left, right) => (right.score.rerank ?? 0) - (left.score.rerank ?? 0)),
            ...ranked.slice(20),
          ];
        }
      } catch (error) {
        console.warn('Module symbol reranking failed; using deterministic symbol ranking.', error);
      }
    }
    return ranked.slice(0, request.topK);
  }
}

export const moduleSearchInternals = {
  apiMatches,
  diversify,
  jaccard,
  mergeRecall,
  queryText,
  structuralQuery,
};
