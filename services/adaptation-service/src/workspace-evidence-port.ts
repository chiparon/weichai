import type { WorkspaceEvidenceScope } from "@forexplore/contracts";

/** One bounded source excerpt returned by the read-only history index. */
export interface WorkspaceEvidenceExcerpt {
  id: string;
  repositoryId: string;
  analysisRevision: string;
  relativePath: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceEvidenceResult {
  evidence: WorkspaceEvidenceExcerpt[];
  characters: number;
  /** Revision-level notes such as truncation, kept out of the source text. */
  notes?: string[];
}

export interface WorkspaceEvidenceQueryRequest {
  requirement: string;
  limit: number;
  scopes: readonly WorkspaceEvidenceScope[];
}

/**
 * Read-only on-demand evidence boundary for the translation runtime. The host
 * owns the index and the visibility rules; this port only carries a bounded
 * query and returns bounded excerpts, never a path, credential or filesystem
 * handle.
 */
export interface WorkspaceEvidencePort {
  query(request: WorkspaceEvidenceQueryRequest, signal?: AbortSignal): Promise<WorkspaceEvidenceResult>;
}
