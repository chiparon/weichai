import type {
  IndexedCodeDocument,
  IndexedModuleDocument,
  Language,
  ModuleSearchCandidate,
  ModuleSearchRequest,
  ModuleSymbolSearchRequest,
  SearchCandidate,
  SearchRequest,
} from '@forexplore/contracts';

export type { IndexedCodeDocument, IndexedModuleDocument } from '@forexplore/contracts';

export interface RetrievedCodeDocument extends IndexedCodeDocument {
  semanticScore?: number;
  textScore?: number;
  /** Weighted reciprocal-rank fusion score, after any retrieval prior. */
  hybridScore?: number;
}

export interface RetrievedModuleDocument extends IndexedModuleDocument {
  semanticScore?: number;
  textScore?: number;
  structuralScore?: number;
  hybridScore?: number;
}

export interface SearchFilters {
  repositories: string[];
  languages: Language[];
  /** Retrieval granularity is always identical to the selected target kind. */
  kinds: IndexedCodeDocument['kind'][];
}

export interface SearchStore {
  ping(): Promise<void>;
  initialize(): Promise<void>;
  clear(): Promise<void>;
  upsert(documents: Array<IndexedCodeDocument & { embedding: number[] }>): Promise<void>;
  refreshIndex(): Promise<void>;
  semanticSearch(
    embedding: number[],
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]>;
  textSearch(
    query: string,
    filters: SearchFilters,
    limit: number,
  ): Promise<RetrievedCodeDocument[]>;
  close(): Promise<void>;
}

export interface EmbeddingProvider {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface SearchEngine {
  search(request: SearchRequest): Promise<SearchCandidate[]>;
}

export interface ModuleSearchFilters {
  repositories: string[];
  languages: Language[];
  excludeRepositories: string[];
}

export interface ModuleSearchStore {
  clearModules(repositories?: string[]): Promise<void>;
  upsertModules(
    documents: Array<IndexedModuleDocument & { embedding: number[] }>,
  ): Promise<void>;
  semanticModuleSearch(
    embedding: number[],
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]>;
  textModuleSearch(
    query: string,
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]>;
  structuralModuleSearch(
    query: string,
    filters: ModuleSearchFilters,
    limit: number,
  ): Promise<RetrievedModuleDocument[]>;
  moduleById(id: string, repositories: string[]): Promise<RetrievedModuleDocument | null>;
  symbolsByIds(ids: string[], repositories: string[]): Promise<RetrievedCodeDocument[]>;
}

export interface ModuleSearchEngine {
  searchModules(request: ModuleSearchRequest): Promise<ModuleSearchCandidate[]>;
  searchModuleSymbols(request: ModuleSymbolSearchRequest): Promise<SearchCandidate[]>;
}

export interface ModuleRerankResult {
  id: string;
  score: number;
  reason: string;
}

export interface LlmModuleReranker {
  readonly model: string;
  rerankModules(
    request: ModuleSearchRequest,
    candidates: ModuleSearchCandidate[],
  ): Promise<ModuleRerankResult[]>;
}

/** A single reranking result produced by the LLM. */
export interface RerankResult {
  id: string;
  score: number;
  reason: string;
}

/** Validator feedback passed to DeepSeek when a prior rerank response broke the contract. */
export interface RerankValidationFeedback {
  message: string;
  attempt: number;
}

/** LLM-based reranker — scores and reorders search candidates by behavioural semantics. */
export interface LlmReranker {
  readonly model: string;
  rerank(
    request: SearchRequest,
    candidates: SearchCandidate[],
    feedback?: RerankValidationFeedback,
  ): Promise<RerankResult[]>;
}
