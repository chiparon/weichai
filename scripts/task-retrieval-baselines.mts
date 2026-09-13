import assert from 'node:assert/strict';
import { formatContextMarkdown, type ContextPacket, type SourceRange, type TaskRetrievalRequest } from '@forexplore/contracts';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { IndexStore } from '../services/code-intelligence-service/src/index-store.js';
import { queryRows } from '../services/code-intelligence-service/src/abortable-query.js';
import { contextTokenCount, sourceContentHash } from '../services/code-intelligence-service/src/context-compiler.js';
import { ModelSearchEmbeddingProvider, type ModelSearchEmbeddingConfig } from '../services/code-intelligence-service/src/search-embedding.js';
import { seekDbIndexStoreInternals } from '../services/code-intelligence-service/src/seekdb-index-store.js';
import { validateTaskRetrievalRequest } from '../services/code-intelligence-service/src/task-retrieval.js';

export function serialRecallStore(store: IndexStore): IndexStore {
  let pending: Promise<unknown> = Promise.resolve();
  return new Proxy(store, { get(target, property) {
    if (property === 'searchSearchDocuments') return (...args: Parameters<NonNullable<IndexStore['searchSearchDocuments']>>) => {
      const result = pending.then(() => target.searchSearchDocuments!(...args));
      pending = result.then(() => undefined, () => undefined);
      return result;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

interface FragmentRow extends RowDataPacket {
  search_document_id: string;
  relative_path: string;
  symbol_key: string | null;
  source_range: SourceRange | string;
  title: string;
  semantic_score: number;
}

/** Single vector channel, followed by direct Top-K fragment delivery. */
export class VectorTopKBaseline {
  private readonly embeddings: ModelSearchEmbeddingProvider;
  constructor(private readonly store: IndexStore, private readonly pool: Pool, embedding: ModelSearchEmbeddingConfig) {
    this.embeddings = new ModelSearchEmbeddingProvider(384, embedding);
  }

  async search(request: TaskRetrievalRequest, parentSignal?: AbortSignal): Promise<ContextPacket> {
    validateTaskRetrievalRequest(request);
    assert.equal(request.scopes.length, 1, 'Pilot baseline requires one fixed repository scope.');
    assert.equal(request.granularity, 'function');
    for (const value of [request.budget.maxTokens, request.budget.maxFiles, request.budget.maxSourceLines]) assert.equal(value, undefined);
    const started = performance.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request.budget.maxLatencyMs ?? 10000), ...(parentSignal ? [parentSignal] : [])]);
    try {
      const scope = request.scopes[0]!;
      const repository = await this.store.getRepository(scope.repositoryId, signal);
      const revision = await this.store.getRevision(scope, signal);
      assert(repository && revision && ['ready', 'superseded'].includes(revision.status));
      if (scope.projectId) assert(await this.store.getProject!(scope, scope.projectId, signal));
      const snapshotMs = performance.now() - started;
      const recallStarted = performance.now();
      const vector = await this.embeddings.embedQuery(request.requirement, signal);
      const literal = seekDbIndexStoreInternals.vectorHex(vector);
      const projectFilter = scope.projectId ? ' AND relative_path IN (SELECT relative_path FROM files WHERE repository_id = ? AND analysis_revision = ? AND project_id = ?)' : '';
      const rows = await queryRows<FragmentRow[]>(this.pool, `
        SELECT search_document_id, relative_path, symbol_key, source_range, title,
          GREATEST(0, 1 - cosine_distance(embedding, ${literal})) AS semantic_score
        FROM search_documents
        WHERE repository_id = ? AND analysis_revision = ? AND kind = 'source-fragment'${projectFilter}
        ORDER BY cosine_distance(embedding, ${literal}) APPROXIMATE LIMIT 10
      `, [scope.repositoryId, scope.analysisRevision, ...(scope.projectId ? [scope.repositoryId, scope.analysisRevision, scope.projectId] : [])], signal);
      const recallMs = performance.now() - recallStarted;
      const readStarted = performance.now();
      const sources = await Promise.all(rows.map(async row => {
        const range = typeof row.source_range === 'string' ? JSON.parse(row.source_range) as SourceRange : row.source_range;
        assert(row.relative_path && range);
        const source = await this.store.getSourceSlice!(scope, row.relative_path, range, 32000, signal);
        assert(source && !source.truncated, 'The selected indexed fragment must be delivered in full.');
        assert.equal(source.file.repositoryId, scope.repositoryId);
        assert.equal(source.file.analysisRevision, scope.analysisRevision);
        assert.equal(source.file.relativePath, row.relative_path);
        assert.deepEqual(source.sourceRange, range);
        return { ...scope, evidenceId: `vector-${row.search_document_id}`, role: 'implementation' as const,
          name: row.title, relativePath: row.relative_path, sourceRange: source.sourceRange,
          contentHash: sourceContentHash(source.text), fileHash: source.file.sha256, content: source.text,
          reason: 'Source fragment selected by vector similarity.', provider: 'tree-sitter' as const,
          evidenceLevel: 'structural' as const, truncated: false, ...(row.symbol_key ? { symbolKey: row.symbol_key } : {}) };
      }));
      const finalRevision = await this.store.getRevision(scope, signal);
      assert(finalRevision && ['ready', 'superseded'].includes(finalRevision.status));
      assert.equal(finalRevision.analysisHash, revision.analysisHash);
      const expansionMs = performance.now() - readStarted;
      const compileStarted = performance.now();
      const packet: ContextPacket = {
        packetId: `vector-${request.requestId}`, requestId: request.requestId, requirement: request.requirement,
        status: 'partial', snapshots: [{ ...scope, repositoryName: repository.displayName, analysisHash: revision.analysisHash }],
        routing: { requestedGranularity: 'function', resolvedGranularities: ['function'], source: 'user',
          reason: 'Vector Top-K source fragments, without declaration expansion or graph neighbors.' },
        results: rows.map(row => ({ ...scope, id: row.search_document_id, granularity: 'function', name: row.title,
          relativePath: row.relative_path, score: Number(row.semantic_score), reason: 'Vector similarity.',
          ...(row.symbol_key ? { symbolKey: row.symbol_key } : {}) })),
        evidence: sources, declarations: [], relations: [],
        gaps: [{ code: 'FRAGMENT_ONLY_BASELINE', message: 'Top-K fragments only; surrounding declarations and dependencies are not expanded.' }],
        markdown: '', usage: { tokenizer: 'cl100k_base', tokens: 0, maxTokens: null, characters: 0,
          files: new Set(sources.map(source => source.relativePath)).size,
          sourceLines: sources.reduce((sum, source) => sum + source.content.split('\n').length, 0), latencyMs: 0 },
      };
      packet.markdown = formatContextMarkdown(packet);
      packet.usage.tokens = contextTokenCount(packet.markdown);
      packet.usage.characters = packet.markdown.length;
      const compilationMs = performance.now() - compileStarted;
      const bytes = sources.reduce((sum, source) => sum + Buffer.byteLength(source.content, 'utf8'), 0);
      packet.usage.retrieval = { sourceBytesRead: bytes, sourceBytesDelivered: bytes, sourceReadAmplification: bytes ? 1 : null,
        sourceExcerptsRead: sources.length, recallAndExpansionMs: snapshotMs + recallMs + expansionMs, compilationMs,
        stages: { snapshotMs, recallMs, candidateResolutionMs: 0, expansionMs, compilationMs } };
      packet.usage.latencyMs = performance.now() - started;
      signal.throwIfAborted();
      assert(packet.usage.latencyMs <= (request.budget.maxLatencyMs ?? 10000));
      return packet;
    } finally { controller.abort(); }
  }
}
