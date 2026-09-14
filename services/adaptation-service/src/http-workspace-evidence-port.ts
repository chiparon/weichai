import type { ContextPacket, TaskRetrievalRequest, WorkspaceEvidenceScope } from "@forexplore/contracts";
import type {
  WorkspaceEvidenceExcerpt,
  WorkspaceEvidencePort,
  WorkspaceEvidenceQueryRequest,
  WorkspaceEvidenceResult,
} from "./workspace-evidence-port";

export interface HttpWorkspaceEvidencePortOptions {
  /** Host-owned read-only semantic query endpoint, without a required trailing slash. */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  /** Optional bearer credential issued by the local VS Code host. */
  bearerToken?: string;
  /** Content budget for one query; the host enforces its own ceiling as well. */
  maxTokensPerQuery?: number;
  timeoutMs?: number;
}

interface ErrorPayload {
  error?: { message?: unknown };
}

/**
 * Uses the host's existing task-retrieval route, so on-demand evidence follows
 * exactly the same revision, visibility and budgeting rules as the UI search:
 * the host validates every scope against its visible, published revisions.
 */
export class HttpWorkspaceEvidencePort implements WorkspaceEvidencePort {
  readonly #endpoint: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #bearerToken?: string;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;

  constructor(options: HttpWorkspaceEvidencePortOptions) {
    const endpoint = options.endpoint.trim();
    if (!/^https?:\/\//i.test(endpoint)) throw new Error("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
    this.#endpoint = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#bearerToken = options.bearerToken?.trim() || undefined;
    this.#maxTokens = options.maxTokensPerQuery ?? 6_000;
    this.#timeoutMs = options.timeoutMs ?? 45_000;
    if (!Number.isInteger(this.#maxTokens) || this.#maxTokens < 256 || this.#maxTokens > 32_000) {
      throw new Error("Workspace evidence tokens per query must be 256..32000.");
    }
  }

  async query(request: WorkspaceEvidenceQueryRequest, signal?: AbortSignal): Promise<WorkspaceEvidenceResult> {
    const scopes = request.scopes.slice(0, 8);
    if (scopes.length === 0) return { evidence: [], characters: 0, notes: ["No history revision is in scope."] };
    const body: TaskRetrievalRequest = {
      requestId: `evidence-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      requirement: request.requirement,
      granularity: "auto",
      scopes: scopes.map((scope) => ({
        repositoryId: scope.repositoryId,
        analysisRevision: scope.analysisRevision,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        role: "reference" as const,
      })),
      budget: { maxTokens: this.#maxTokens, maxLatencyMs: 30_000, maxFiles: 12, maxSourceLines: 800 },
    };
    const response = await this.#fetch(new URL("v1/task-search", this.#endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#bearerToken ? { authorization: `Bearer ${this.#bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#timeoutMs)]),
    });
    if (!response.ok) {
      let detail: ErrorPayload | undefined;
      try { detail = await response.json() as ErrorPayload; } catch { /* a host error need not be JSON */ }
      const message = typeof detail?.error?.message === "string"
        ? detail.error.message
        : `Semantic evidence query failed with status ${response.status}.`;
      throw new Error(message.slice(0, 512));
    }
    const packet = await response.json() as ContextPacket;
    const evidence: WorkspaceEvidenceExcerpt[] = packet.evidence.map((item) => ({
      id: item.evidenceId,
      repositoryId: item.repositoryId,
      analysisRevision: item.analysisRevision,
      relativePath: item.relativePath,
      content: item.content,
      truncated: item.truncated,
    }));
    const notes = [...new Set([...(packet.gaps ?? []).map((gap) => gap.code), ...(packet.status === "partial" ? ["RETRIEVAL_PARTIAL"] : [])])];
    return {
      evidence,
      characters: evidence.reduce((sum, item) => sum + item.content.length, 0),
      ...(notes.length ? { notes } : {}),
    };
  }
}
