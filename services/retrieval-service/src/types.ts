import type {
  IndexedCodeDocument,
  Language,
  SearchCandidate,
  SearchRequest,
} from '@forexplore/contracts';

export type { IndexedCodeDocument } from '@forexplore/contracts';

export interface RetrievedCodeDocument extends IndexedCodeDocument {
  semanticScore?: number;
  textScore?: number;
  /** Weighted reciprocal-rank fusion score, after any retrieval prior. */
  hybridScore?: number;
}

export interface SearchFilters {
  repositories: string[];
  languages: Language[];
  /** Retrieval granularity is always identical to the selected target kind. */
  kinds: IndexedCodeDocument['kind'][];
}

/** A corpus directory discovered from the indexed store: repository id + language. */
export interface RepositoryDirectory {
  repository: string;
  language: Language;
}

export interface DirectorySelectionConfig {
  /** Whether the coarse directory-name selection stage runs at all. */
  enabled: boolean;
  /** Number of top-scoring directories kept before fine-grained retrieval. */
  topM: number;
  /** Below this best score the selector falls back to every authorized directory. */
  minScore: number;
}

export interface SearchStore {
  ping(): Promise<void>;
  initialize(): Promise<void>;
  /** Removes the table (schema included); recreate via initialize(). */
  drop(): Promise<void>;
  clear(): Promise<void>;
  upsert(documents: Array<IndexedCodeDocument & { embedding: number[] }>): Promise<void>;
  refreshIndex(): Promise<void>;
  /** Distinct repository + language pairs currently indexed, for directory selection. */
  listRepositories(): Promise<RepositoryDirectory[]>;
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
