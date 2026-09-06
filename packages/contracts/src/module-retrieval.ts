import type { FunctionalModuleKind } from './module-migration';
import type { Language, ModuleTarget } from './module';

export interface ModuleSymbolEvidence {
  id: string;
  title: string;
  kind: 'class' | 'function';
  path: string;
  signature: string;
  summary: string;
  preview: string;
}

/** A repository-owned functional module stored as the first-stage retrieval unit. */
export interface IndexedModuleDocument {
  id: string;
  repository: string;
  moduleId: string;
  name: string;
  kind: FunctionalModuleKind;
  language: Language;
  license: string;
  purpose: string;
  domain: string;
  coreApis: string[];
  sourceFiles: string[];
  symbolIds: string[];
  dependencies: string[];
  structureTerms: string[];
  representativeSymbols: ModuleSymbolEvidence[];
  compatibility: string[];
  risks: string[];
  snapshotId: string;
  contentHash: string;
}

export interface TargetModuleQuery {
  id: string;
  name: string;
  language: Language;
  kind?: FunctionalModuleKind;
  purpose: string;
  domain?: string;
  coreApis: string[];
  dependencies: string[];
  /** The incomplete or currently selected class/method that initiated retrieval. */
  focusSymbol?: ModuleTarget;
  /** Other incomplete symbols used to measure module-level behavioral coverage. */
  incompleteSymbols?: ModuleTarget[];
}

export interface ModuleSearchRequest {
  target: TargetModuleQuery;
  requirement: string;
  topK: number;
  repositoryScopes?: string[];
  candidateLanguages?: Language[];
  excludeRepositories?: string[];
  rerank?: boolean;
}

export interface ModuleCandidateScore {
  overall: number;
  semantic: number;
  lexical: number;
  structural: number;
  apiCoverage: number;
  adaptability: number;
  quality: number;
  hybrid: number;
  rerank?: number;
}

export interface ModuleSearchCandidate extends IndexedModuleDocument {
  score: ModuleCandidateScore;
  matchedApis: string[];
  missingApis: string[];
  matchedRequirements: string[];
  rerankReason?: string;
}

/** Second-stage retrieval, constrained to one selected historical module. */
export interface ModuleSymbolSearchRequest {
  moduleId: string;
  target: ModuleTarget;
  requirement: string;
  topK: number;
  repositoryScopes?: string[];
  candidateLanguages?: Language[];
  rerank?: boolean;
}
