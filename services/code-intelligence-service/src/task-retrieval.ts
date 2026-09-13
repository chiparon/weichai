import { createHash } from 'node:crypto';
import { indexModuleHierarchy } from '@forexplore/contracts';
import type {
  ContextPacket, ConcreteRetrievalGranularity, DependencyEdgeRecord, ProjectAnalysisRecord, ProjectModule,
  SearchDocumentRecord, SourceRange, SymbolRecord, TaskContextDeclaration, TaskContextEvidence, TaskRetrievalGap, TaskRetrievalRequest,
  TaskRetrievalResult, TaskRetrievalScope, TaskRetrievalSnapshot,
} from '@forexplore/contracts';
import type { TaskRetrievalPort } from '@forexplore/workflow-core';
import type { IndexStore } from './index-store.js';
import { compileTaskContext, sourceContentHash } from './context-compiler.js';
import { projectAnalysisProfile, projectPlanHash } from './project-analysis.js';
import { queryExpansionFromEnvironment, type QueryExpansionPort, type QueryExpansionResult } from './query-expansion.js';

const functionKinds = ['function', 'method', 'constructor'];
const classKinds = ['class', 'interface', 'struct', 'record', 'trait', 'enum'];
const granularities = ['auto', 'function', 'class', 'module', 'subsystem'];
const candidateLimit = 32;
const maxResults = 10;
interface Hit {
  result: TaskRetrievalResult; scope: TaskRetrievalScope; symbol?: SymbolRecord; sourceRange?: SourceRange;
  module?: ProjectModule; modulePaths?: string[]; modulePathsTruncated?: boolean; implementationDocuments?: SearchDocumentRecord[];
}
function key(scope: TaskRetrievalScope): string { return `${scope.repositoryId}\0${scope.analysisRevision}\0${scope.projectId ?? ''}`; }
function id(parts: string[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value); }
function integer(value: unknown, minimum: number, maximum: number): boolean { return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum; }

/**
 * Weight of the raw-requirement recall channels when expansion is active, chosen
 * by a dev-side sweep (12-task dev set + the repository contract check at 4000
 * and 8000 tokens): 0 -> 11/12 with a contract failure, 0.1 -> 12/12 with a
 * contract failure, 0.15 -> 12/12 with the contract satisfied, >=0.2 -> the dev
 * score falls. The sweep is recorded in docs/query-expansion-result.zh-CN.md.
 */
export const DEFAULT_BASELINE_RECALL_WEIGHT = 0.15;

export function baselineRecallWeightFromEnvironment(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(environment.RECAST_QUERY_EXPANSION_BASELINE_WEIGHT);
  return Number.isFinite(raw) && raw >= 0 && raw <= 4 ? raw : DEFAULT_BASELINE_RECALL_WEIGHT;
}

export function validateTaskRetrievalRequest(value: unknown): asserts value is TaskRetrievalRequest {
  if (!record(value) || !identifier(value.requestId) || typeof value.requirement !== 'string' || !value.requirement.trim() || value.requirement.length > 8000) throw new Error('Task retrieval requires requestId and a requirement of 1..8000 characters.');
  if (value.granularity !== undefined && (typeof value.granularity !== 'string' || !granularities.includes(value.granularity))) throw new Error('Invalid retrieval granularity.');
  if (!Array.isArray(value.scopes) || value.scopes.length < 1 || value.scopes.length > 8 || value.scopes.some((scope) =>
    !record(scope) || !identifier(scope.repositoryId) || !identifier(scope.analysisRevision) || scope.projectId !== undefined && !identifier(scope.projectId) || scope.role !== undefined && !['target', 'reference'].includes(String(scope.role)))) throw new Error('Task retrieval requires 1..8 revision-scoped repositories.');
  if (!record(value.budget) || value.budget.maxTokens !== undefined && !integer(value.budget.maxTokens, 256, Number.MAX_SAFE_INTEGER) ||
    value.budget.maxLatencyMs !== undefined && !integer(value.budget.maxLatencyMs, 100, 60000) ||
    value.budget.maxFiles !== undefined && !integer(value.budget.maxFiles, 1, Number.MAX_SAFE_INTEGER) ||
    value.budget.maxSourceLines !== undefined && !integer(value.budget.maxSourceLines, 1, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid task retrieval budget.');
  if (value.knownEvidence !== undefined && (!Array.isArray(value.knownEvidence) || value.knownEvidence.length > 200 || value.knownEvidence.some((item) => !record(item) || !identifier(item.evidenceId) || !identifier(item.contentHash)))) throw new Error('Invalid known evidence.');
}

/** Task retrieval consumes bounded, authoritative reads after projection recall. */
export class TaskRetrievalService implements TaskRetrievalPort {
  readonly #expansion: QueryExpansionPort | null;
  readonly #baselineRecallWeight: number;
  /** `expansion: undefined` follows RECAST_QUERY_EXPANSION; `null` disables it explicitly. */
  constructor(private readonly store: IndexStore, options: { expansion?: QueryExpansionPort | null; baselineRecallWeight?: number } = {}) {
    this.#expansion = options.expansion === undefined ? queryExpansionFromEnvironment() : options.expansion;
    this.#baselineRecallWeight = options.baselineRecallWeight ?? baselineRecallWeightFromEnvironment();
  }

  async search(request: TaskRetrievalRequest, parentSignal?: AbortSignal): Promise<ContextPacket> {
    validateTaskRetrievalRequest(request);
    const started = performance.now();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(request.budget.maxLatencyMs ?? 10000), ...(parentSignal ? [parentSignal] : [])]);
    try { return await this.retrieve(request, signal, started); }
    finally { controller.abort(); }
  }

  private async retrieve(request: TaskRetrievalRequest, signal: AbortSignal, started: number): Promise<ContextPacket> {
    signal.throwIfAborted();
    if (!this.store.searchSearchDocuments || !this.store.querySymbols || !this.store.queryDependencies || !this.store.getSourceSlice || !this.store.getModuleArtifacts || !this.store.getProject) throw new Error('Task retrieval requires bounded search, symbol, dependency, artifact, project and source queries.');
    const scopes = [...new Map(request.scopes.map((scope) => [key(scope), scope])).values()];
    const snapshots: TaskRetrievalSnapshot[] = [];
    const revisionStatuses = new Map<string, string>();
    for (const scope of scopes) {
      signal.throwIfAborted();
      const repository = await this.store.getRepository(scope.repositoryId, signal);
      const revision = await this.store.getRevision(scope, signal);
      if (!repository || !revision || !['ready', 'superseded'].includes(revision.status)) throw new Error('Requested repository revision is unavailable.');
      if (scope.projectId && !await this.store.getProject(scope, scope.projectId, signal)) throw new Error('Requested project does not belong to the selected revision.');
      snapshots.push({ ...scope, repositoryName: repository.displayName, analysisHash: revision.analysisHash, ...(revision.sourceRevision ? { sourceRevision: revision.sourceRevision } : {}) });
      revisionStatuses.set(key(scope), revision.status);
    }
    const snapshotMs = performance.now() - started;
    // Local, offline expansion of the recall query. Runs after the version
    // snapshot so stage timings stay disjoint; never performs I/O.
    const queryExpansionStarted = performance.now();
    const expansion = this.#expansion?.expand(request.requirement);
    const queryExpansionMs = performance.now() - queryExpansionStarted;
    let recallMs = 0;
    const candidateStarted = performance.now();
    const requestedGranularity = request.granularity ?? 'auto';
    const gaps: TaskRetrievalGap[] = [];
    const evidence: TaskContextEvidence[] = [];
    const declarations: TaskContextDeclaration[] = [];
    const relations: DependencyEdgeRecord[] = [];
    const hits: Hit[] = [];
    const availableNodeKinds = new Set<string>();
    for (const scope of scopes) {
      const snapshot = snapshots.find((item) => key(item) === key(scope))!;
      // Reuse the cached query embedding across channels and cap each channel independently.
      const documents: SearchDocumentRecord[] = [];
      const documentRanks = new Map<string, number>();
      const recallStarted = performance.now();
      // Expansion normally replaces the recall query. A non-zero baseline weight
      // additionally keeps the raw requirement's candidates in the fusion, which
      // prevents evidence displacement (acceptance §4.6) at the cost of ranking.
      const plans = expansion?.enabled && this.#baselineRecallWeight > 0
        ? [{ query: request.requirement, weight: this.#baselineRecallWeight }, { query: expansion.expanded, weight: 1 }]
        : [{ query: expansion?.enabled ? expansion.expanded : request.requirement, weight: 1 }];
      const channelKinds = ['symbol', 'source-fragment', 'summary'] as const;
      const channelSets = await Promise.all(plans.flatMap((plan) =>
        channelKinds.map((kind) => this.store.searchSearchDocuments!(scope, plan.query, candidateLimit, kind, signal))));
      recallMs += performance.now() - recallStarted;
      channelSets.forEach((channel, index) => {
        const weight = plans[Math.floor(index / channelKinds.length)]!.weight;
        channel.forEach((document, rank) => documentRanks.set(document.searchDocumentId, (documentRanks.get(document.searchDocumentId) ?? 0) + weight / (61 + rank)));
        documents.push(...channel);
      });
      for (const document of documents) if (document.repositoryId !== scope.repositoryId || document.analysisRevision !== scope.analysisRevision) throw new Error('Search returned a document from another revision.');
      const symbolKeys = [...new Set(documents.flatMap((item) => item.symbolKey ? [item.symbolKey] : []))];
      const paths = [...new Set(documents.filter((item) => !item.symbolKey).flatMap((item) => item.relativePath ? [item.relativePath] : []))];
      const kinds = requestedGranularity === 'function' ? functionKinds : requestedGranularity === 'class' ? classKinds : [...functionKinds, ...classKinds];
      if (requestedGranularity !== 'module' && requestedGranularity !== 'subsystem' && (symbolKeys.length || paths.length)) {
        // Symbol-key hits and path-only implementation blocks have distinct
        // result sets. Combining both filters under one limit lets a noisy
        // path consume the quota before the exact declaration is examined.
        const [exact, byPath] = await Promise.all([
          symbolKeys.length ? this.store.querySymbols(scope, { symbolKeys, projectId: scope.projectId, limit: 120 }, signal) : Promise.resolve({ symbols: [], truncated: false }),
          paths.length ? this.store.querySymbols(scope, { relativePaths: paths, kinds, projectId: scope.projectId, limit: 120 }, signal) : Promise.resolve({ symbols: [], truncated: false }),
        ]);
        if (exact.truncated || byPath.truncated) gaps.push({ code: 'SYMBOL_CANDIDATES_TRUNCATED', message: 'Additional declarations matched the bounded candidate scope.', repositoryId: scope.repositoryId });
        const declarations = new Map([...exact.symbols, ...byPath.symbols].map((symbol) => [symbol.symbolKey, symbol]));
        let frontier = exact.symbols.filter((symbol) => !kinds.includes(symbol.kind));
        // A local-variable hit identifies its containing implementation. Follow
        // authoritative declaration ownership without widening to the whole file.
        for (let depth = 0; depth < 4 && frontier.length; depth++) {
          const ownerKeys = [...new Set(frontier.flatMap((symbol) => symbol.containerSymbolKey && !declarations.has(symbol.containerSymbolKey) ? [symbol.containerSymbolKey] : []))];
          if (ownerKeys.length) {
            const owners = await this.store.querySymbols(scope, { symbolKeys: ownerKeys, projectId: scope.projectId, limit: 120 }, signal);
            for (const owner of owners.symbols) { this.assertSymbol(scope, owner); declarations.set(owner.symbolKey, owner); }
            if (owners.truncated || owners.symbols.length < ownerKeys.length) gaps.push({ code: 'DECLARATION_OWNER_UNAVAILABLE', message: 'Some recalled declarations could not be expanded to their indexed owners.', repositoryId: scope.repositoryId });
          }
          frontier = frontier.flatMap((symbol) => {
            const owner = symbol.containerSymbolKey ? declarations.get(symbol.containerSymbolKey) : undefined;
            return owner && !kinds.includes(owner.kind) ? [owner] : [];
          });
        }
        const documentOwners = new Map<string, string>();
        for (const original of exact.symbols) {
          let owner: SymbolRecord | undefined = original;
          const visited = new Set<string>();
          while (owner && !kinds.includes(owner.kind) && !visited.has(owner.symbolKey)) {
            visited.add(owner.symbolKey);
            owner = owner.containerSymbolKey ? declarations.get(owner.containerSymbolKey) : undefined;
          }
          if (owner && kinds.includes(owner.kind)) documentOwners.set(original.symbolKey, owner.symbolKey);
        }
        const foundSymbols = [...declarations.values()].filter((symbol) => kinds.includes(symbol.kind));
        for (const symbol of foundSymbols) {
          this.assertSymbol(scope, symbol);
          const matched = documents.filter((document) => document.symbolKey && documentOwners.get(document.symbolKey) === symbol.symbolKey || !document.symbolKey && document.relativePath === symbol.relativePath && (document.sourceRange === undefined || rangesOverlap(document.sourceRange, symbol.sourceRange)));
          if (!matched.length) continue;
          const score = Math.max(...matched.map((document) => documentRanks.get(document.searchDocumentId) ?? 1 / 61));
          const sourceHit = matched.filter((document) => document.kind === 'source-fragment' && document.symbolKey === symbol.symbolKey && document.sourceRange)
            .sort((a, b) => (b.retrievalScore?.fusion ?? 0) - (a.retrievalScore?.fusion ?? 0))[0];
          hits.push({ scope: { ...scope, ...(symbol.projectId ? { projectId: symbol.projectId } : {}) }, symbol, sourceRange: sourceHit?.sourceRange, result: { ...scope, ...(symbol.projectId ? { projectId: symbol.projectId } : {}), id: `symbol-${id([key(scope), symbol.symbolKey])}`,
            granularity: functionKinds.includes(symbol.kind) ? 'function' : 'class', name: symbol.qualifiedName || symbol.name,
            relativePath: symbol.relativePath, symbolKey: symbol.symbolKey, score,
            reason: `Matched indexed ${matched.some((item) => item.kind === 'source-fragment') ? 'implementation and declaration' : 'declaration'} evidence.` } });
        }
      }
      if (requestedGranularity === 'auto' || requestedGranularity === 'module' || requestedGranularity === 'subsystem') {
        // Activation currently retires the prior revision's summary projection.
        // Retained artifacts alone do not make that snapshot searchable.
        if (revisionStatuses.get(key(scope)) === 'superseded') {
          gaps.push({ code: 'MODULE_PROJECTION_UNAVAILABLE', message: 'The selected historical revision has no retained searchable module projection.', repositoryId: scope.repositoryId });
          continue;
        }
        const ids = [...new Set(documents.flatMap((item) => item.moduleArtifactId ? [item.moduleArtifactId] : []))];
        if (scope.projectId) ids.push(`project-summary:${scope.projectId}:${projectAnalysisProfile}`);
        const artifacts = await this.store.getModuleArtifacts(scope, [...new Set(ids)], signal);
        for (const artifact of artifacts) {
          const item = artifact.payload as ProjectAnalysisRecord | undefined;
          if (artifact.repositoryId !== scope.repositoryId || artifact.analysisRevision !== scope.analysisRevision) throw new Error('Module artifact belongs to another revision.');
          if (artifact.kind !== 'module-summary' || artifact.status !== 'current' || artifact.analysisHash !== snapshot.analysisHash || !item?.proposal || item.state !== 'ready' ||
            item.repositoryId !== scope.repositoryId || item.analysisRevision !== scope.analysisRevision || item.proposal.analysisHash !== snapshot.analysisHash ||
            scope.projectId && item.projectId !== scope.projectId || !artifact.planHash || artifact.planHash !== projectPlanHash(item.proposal)) continue;
          let tree: ReturnType<typeof indexModuleHierarchy>;
          try { tree = indexModuleHierarchy(item.proposal.modules); }
          catch { gaps.push({ code: 'MODULE_HIERARCHY_INVALID', message: 'The pinned module artifact contains an invalid hierarchy.', repositoryId: scope.repositoryId }); continue; }
          const summaries = documents.flatMap((document) => {
            if (document.kind !== 'summary' || document.moduleArtifactId !== artifact.moduleArtifactId) return [];
            try {
              const identity = JSON.parse(document.text);
              return identity.projectId === item.projectId && tree.byId.has(identity.moduleId) &&
                (identity.planHash === undefined && !item.proposal!.hierarchy || identity.planHash === artifact.planHash)
                ? [{ document, moduleId: String(identity.moduleId) }] : [];
            } catch { return []; }
          });
          const parents = (moduleId: string): string[] => {
            const ids: string[] = [];
            for (let node = tree.byId.get(moduleId); node; node = node.parentId ? tree.byId.get(node.parentId) : undefined) ids.push(node.id);
            return ids;
          };
          const pathOwners = new Map(item.proposal.modules.flatMap((module) => module.sourceFiles.map((path) => [path, module.id] as const)));
          const matchedByNode = new Map<string, SearchDocumentRecord[]>();
          const queryNames = new Set(request.requirement.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
          for (const summary of summaries) {
            const lineage = parents(summary.moduleId);
            const directKind = tree.byId.get(summary.moduleId)!.nodeKind ?? 'module';
            // One recalled leaf must not fill the result quota with its entire
            // ancestor chain. Cross-kind routing needs only the nearest owner.
            const nearest = lineage.slice(1).find((moduleId) => {
              const kind = tree.byId.get(moduleId)!.nodeKind ?? 'module';
              return requestedGranularity === 'auto' ? kind !== directKind : directKind !== requestedGranularity && kind === requestedGranularity;
            });
            const named = lineage.slice(1).filter((moduleId) => queryNames.has(tree.byId.get(moduleId)!.name.normalize('NFKC').toLocaleLowerCase()));
            for (const moduleId of new Set([summary.moduleId, ...(nearest ? [nearest] : []), ...named])) {
              const matched = matchedByNode.get(moduleId) ?? [];
              matched.push(summary.document); matchedByNode.set(moduleId, matched);
            }
          }
          for (const module of item.proposal.modules) {
            const nodeKind = module.nodeKind ?? 'module';
            availableNodeKinds.add(nodeKind);
            if (requestedGranularity !== 'auto' && requestedGranularity !== nodeKind) continue;
            const matched = matchedByNode.get(module.id) ?? [];
            if (!matched.length) continue;
            const implementationDocuments = documents.filter((document) => document.relativePath && pathOwners.has(document.relativePath) && parents(pathOwners.get(document.relativePath)!).includes(module.id));
            const samples = tree.sourceFiles(module.id, 20);
            const modulePaths = [...new Set([...implementationDocuments.flatMap((document) => document.relativePath ? [document.relativePath] : []), ...samples.files])].slice(0, 20);
            if (!modulePaths.length) { gaps.push({ code: 'MODULE_SOURCE_UNAVAILABLE', message: `No owned source files are available for ${module.name}.`, repositoryId: scope.repositoryId }); continue; }
            const directMatch = summaries.some((summary) => summary.moduleId === module.id);
            hits.push({ scope: { ...scope, projectId: item.projectId }, module, modulePaths, modulePathsTruncated: samples.truncated, implementationDocuments,
              result: { ...scope, projectId: item.projectId,
                id: `module-${id([key(scope), item.projectId, module.id])}`, granularity: nodeKind, name: module.name,
                moduleId: module.id, relativePath: modulePaths[0], score: Math.max(...matched.map((document) => documentRanks.get(document.searchDocumentId) ?? 1 / 61)) * (directMatch ? 1 : 0.95),
                reason: `${directMatch ? 'Matched this node summary.' : 'Matched a descendant summary within this node.'} ${module.description}`.slice(0, 800) } });
          }
        }
      }
    }
    hits.sort((a, b) => b.result.score - a.result.score || a.result.id.localeCompare(b.result.id));
    const unique = [...new Map(hits.map((hit) => [hit.result.id, hit])).values()];
    const reserved = requestedGranularity === 'auto' ? [...unique.filter((hit) => hit.result.granularity === 'function').slice(0, 4),
      ...unique.filter((hit) => hit.result.granularity === 'class').slice(0, 3), ...unique.filter((hit) => hit.result.granularity === 'module').slice(0, 1),
      ...unique.filter((hit) => hit.result.granularity === 'subsystem').slice(0, 1)] : [];
    const selected = [...new Map([...reserved, ...unique].map((hit) => [hit.result.id, hit])).values()].slice(0, maxResults)
      .sort((a, b) => b.result.score - a.result.score || a.result.id.localeCompare(b.result.id));
    if (requestedGranularity === 'module' || requestedGranularity === 'subsystem') {
      if (!availableNodeKinds.has(requestedGranularity)) gaps.push({ code: 'GRANULARITY_UNAVAILABLE', message: `No validated ${requestedGranularity} nodes are available in the selected revision and project.` });
      else if (!selected.length) gaps.push({ code: 'NO_MODULE_CANDIDATE', message: `The ${requestedGranularity} index is available, but the bounded recall returned no matching node or descendant summary.` });
    }
    const unavailable = gaps.some((gap) => gap.code === 'GRANULARITY_UNAVAILABLE');
    const resolvedGranularities: ConcreteRetrievalGranularity[] = requestedGranularity === 'auto'
      ? [...new Set(selected.map((hit) => hit.result.granularity))] : unavailable ? [] : [requestedGranularity];
    const routing = { requestedGranularity, resolvedGranularities, source: requestedGranularity === 'auto' ? 'automatic' as const : 'user' as const,
      reason: requestedGranularity === 'auto' ? 'Automatic granularity follows the highest-ranked available declaration and module evidence; dependency context may cross granularities.' :
        unavailable ? 'The requested granularity is unavailable; no other granularity was substituted.' : 'The user-selected granularity determines primary results; supporting evidence may cross granularities.',
      ...(requestedGranularity === 'auto' ? { confidence: null } : {}) };
    const expansionStarted = performance.now();
    const candidateResolutionMs = Math.max(0, expansionStarted - candidateStarted - recallMs);
    const seeds: Array<{ scope: TaskRetrievalScope; symbol: SymbolRecord }> = [];
    for (const hit of selected.filter((candidate) => candidate.symbol)) {
      signal.throwIfAborted();
      await this.readEvidence(hit.scope, hit.symbol!.relativePath, hit.symbol, 'implementation', hit.result.reason, evidence, gaps, signal);
      seeds.push({ scope: hit.scope, symbol: hit.symbol! });
    }
    for (const hit of selected) {
      signal.throwIfAborted();
      if (hit.module) {
        const keys = [...new Set(hit.implementationDocuments!.flatMap((document) => document.symbolKey ? [document.symbolKey] : []))].slice(0, 12);
        const exact = keys.length ? await this.store.querySymbols(hit.scope, { symbolKeys: keys, projectId: hit.scope.projectId, kinds: [...functionKinds, ...classKinds], limit: 12 }, signal) : { symbols: [], truncated: false };
        const found = await this.store.querySymbols(hit.scope, { relativePaths: hit.modulePaths!, projectId: hit.scope.projectId, kinds: [...functionKinds, ...classKinds], limit: 12 }, signal);
        const symbols = [...new Map([...exact.symbols, ...found.symbols].filter((symbol) => hit.modulePaths!.includes(symbol.relativePath)).map((symbol) => [symbol.symbolKey, symbol])).values()];
        const representatives = symbols.filter((symbol, index) => symbols.findIndex((candidate) => candidate.relativePath === symbol.relativePath) === index).slice(0, 3);
        for (const symbol of representatives) {
          this.assertSymbol(hit.scope, symbol);
          await this.readEvidence(hit.scope, symbol.relativePath, symbol, 'implementation', `Representative implementation within ${hit.module.name}.`, evidence, gaps, signal);
          seeds.push({ scope: hit.scope, symbol });
        }
        if (!representatives.length) for (const path of hit.modulePaths!.slice(0, 2)) await this.readEvidence(hit.scope, path, undefined, 'implementation', `Indexed source within ${hit.module.name}.`, evidence, gaps, signal);
        if (hit.modulePathsTruncated || hit.modulePaths!.length > representatives.length || symbols.length > representatives.length || found.truncated || exact.truncated) gaps.push({ code: 'MODULE_CONTEXT_PARTIAL', message: `Only bounded representative implementation excerpts from ${hit.module.name} were included; this is not its complete source subtree.`, repositoryId: hit.scope.repositoryId });
      }
    }
    await this.expandContext(seeds, evidence, declarations, relations, gaps, signal);
    for (const scope of [...new Map(selected.filter((hit) => hit.scope.projectId).map((hit) => [key(hit.scope), hit.scope])).values()]) {
      const project = await this.store.getProject(scope, scope.projectId!, signal);
      for (const path of project?.manifestPaths ?? []) await this.readEvidence(scope, path, undefined, 'configuration', 'Project build and dependency configuration.', evidence, gaps, signal);
    }
    for (const snapshot of snapshots) {
      const revision = await this.store.getRevision(snapshot, signal);
      if (!revision || !['ready', 'superseded'].includes(revision.status) || revision.analysisHash !== snapshot.analysisHash) throw new Error('Pinned revision changed or became unavailable during retrieval.');
    }
    signal.throwIfAborted();
    const compileStarted = performance.now();
    const packet = compileTaskContext(request, { snapshots, routing, results: selected.map((hit) => hit.result), evidence, declarations, relations,
      gaps: [...new Map(gaps.map((gap) => [JSON.stringify(gap), gap])).values()].slice(0, 32), status: unavailable ? 'unavailable' : 'complete' }, Math.round(performance.now() - started),
      { queryTerms: expansion?.terms ?? [] });
    signal.throwIfAborted();
    const sourceBytesRead = evidence.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0);
    const sourceBytesDelivered = packet.evidence.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0);
    const compiler = packet.usage.retrieval?.compiler;
    packet.usage.retrieval = { sourceBytesRead, sourceBytesDelivered, sourceReadAmplification: sourceBytesDelivered ? sourceBytesRead / sourceBytesDelivered : null,
      stages: { snapshotMs, recallMs, candidateResolutionMs, expansionMs: compileStarted - expansionStarted, compilationMs: performance.now() - compileStarted },
      ...(expansion ? { expansion: { enabled: expansion.enabled, version: expansion.version, lexiconSha256: expansion.lexiconSha256,
        matched: [...expansion.matched], terms: [...expansion.terms], expansionMs: Math.round(queryExpansionMs * 1000) / 1000 } } : {}),
      ...(compiler ? { compiler } : {}),
      sourceExcerptsRead: evidence.length, recallAndExpansionMs: Math.round(compileStarted - started), compilationMs: Math.round(performance.now() - compileStarted) };
    packet.usage.latencyMs = Math.round(performance.now() - started);
    if (packet.usage.latencyMs > (request.budget.maxLatencyMs ?? 10000)) throw new Error('Task retrieval deadline exceeded during context compilation.');
    return packet;
  }

  private assertSymbol(scope: TaskRetrievalScope, symbol: SymbolRecord, requireProject = true): void {
    if (symbol.repositoryId !== scope.repositoryId || symbol.analysisRevision !== scope.analysisRevision || requireProject && scope.projectId && symbol.projectId !== scope.projectId) throw new Error('Symbol does not belong to the requested scope.');
  }

  private async expandContext(seeds: Array<{ scope: TaskRetrievalScope; symbol: SymbolRecord }>, evidence: TaskContextEvidence[],
    declarations: TaskContextDeclaration[], relations: DependencyEdgeRecord[], gaps: TaskRetrievalGap[], signal: AbortSignal): Promise<void> {
    const queue = [...seeds];
    const visited = new Set<string>();
    const outlined = new Set<string>();
    const fileEdges = new Map<string, Awaited<ReturnType<NonNullable<IndexStore['queryDependencies']>>>>();
    const fileSymbols = new Map<string, Awaited<ReturnType<NonNullable<IndexStore['querySymbols']>>>>();
    const identity = (scope: TaskRetrievalScope, value: string) => `${scope.repositoryId}\0${scope.analysisRevision}\0${value}`;
    const queued = new Set(seeds.map(({ scope, symbol }) => identity(scope, symbol.symbolKey)));
    const outline = async (scope: TaskRetrievalScope, symbol: SymbolRecord, reason: string) => {
      const symbolId = identity(scope, symbol.symbolKey);
      if (outlined.has(symbolId)) return;
      outlined.add(symbolId);
      let signature = symbol.signature ?? symbol.name;
      if (classKinds.includes(symbol.kind)) {
        const fileId = identity(scope, symbol.relativePath);
        let members = fileSymbols.get(fileId);
        if (!members) { members = await this.store.querySymbols!(scope, { relativePaths: [symbol.relativePath], limit: 200 }, signal); fileSymbols.set(fileId, members); }
        for (const member of members.symbols) this.assertSymbol(scope, member, false);
        signature = [signature, ...members.symbols.filter(member => member.containerSymbolKey === symbol.symbolKey)
          .map(member => member.signature ?? member.name)].join('\n');
        if (members.truncated) gaps.push({ code: 'DECLARATION_OUTLINE_PARTIAL', message: `Some member signatures of ${symbol.qualifiedName} were not available in the local query.`, repositoryId: scope.repositoryId, relativePath: symbol.relativePath });
      }
      declarations.push({ repositoryId: scope.repositoryId, analysisRevision: scope.analysisRevision, symbolKey: symbol.symbolKey,
        name: symbol.qualifiedName || symbol.name, relativePath: symbol.relativePath, sourceRange: symbol.sourceRange, signature, reason });
    };
    // Traverse implementation dependencies; type declarations form explicit expansion boundaries.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      signal.throwIfAborted();
      const { scope, symbol } = queue[cursor]!;
      const symbolId = identity(scope, symbol.symbolKey);
      if (visited.has(symbolId)) continue;
      if (visited.size >= 200) { gaps.push({ code: 'DEPENDENCY_EXPANSION_LIMIT', message: 'Dependency traversal reached 200 implementation symbols; additional dependencies remain.' }); break; }
      visited.add(symbolId);
      if (symbol.containerSymbolKey) {
        const owners = await this.store.querySymbols!(scope, { symbolKeys: [symbol.containerSymbolKey], limit: 1 }, signal);
        for (const owner of owners.symbols) { this.assertSymbol(scope, owner, false); await outline(scope, owner, `Enclosing declaration of ${symbol.qualifiedName}.`); }
      }
      const direct = await this.store.queryDependencies!(scope, { symbolKeys: [symbol.symbolKey], direction: 'outgoing', limit: 200 }, signal);
      const fileId = identity(scope, symbol.relativePath);
      let local = fileEdges.get(fileId);
      if (!local) { local = await this.store.queryDependencies!(scope, { relativePaths: [symbol.relativePath], direction: 'outgoing', limit: 200 }, signal); fileEdges.set(fileId, local); }
      if (direct.truncated || local.truncated) gaps.push({ code: 'DEPENDENCY_QUERY_PARTIAL', message: `The local dependency query for ${symbol.qualifiedName} reached its page limit.`, repositoryId: scope.repositoryId, relativePath: symbol.relativePath });
      const edges = [...new Map([...direct.dependencies, ...local.dependencies].filter(edge =>
        edge.sourceSymbolKey === symbol.symbolKey || edge.sourceRelativePath === symbol.relativePath &&
        (edge.kind === 'import' || (!edge.sourceSymbolKey || classKinds.includes(symbol.kind)) && edge.evidenceRanges.some(range => rangesOverlap(range, symbol.sourceRange))))
        .map(edge => [edge.dependencyEdgeId, edge])).values()];
      if (symbol.provider === 'tree-sitter' && functionKinds.includes(symbol.kind) && !edges.some(edge => !['import', 'export'].includes(edge.kind)) &&
        !gaps.some(gap => gap.code === 'CALL_DEPENDENCIES_UNAVAILABLE' && gap.repositoryId === scope.repositoryId && gap.relativePath === symbol.relativePath)) {
        gaps.push({ code: 'CALL_DEPENDENCIES_UNAVAILABLE', message: 'The available index has no call/type relations for this implementation; dependency completeness is not established.', repositoryId: scope.repositoryId, relativePath: symbol.relativePath });
      }
      const targets = new Map<string, DependencyEdgeRecord>();
      for (const edge of edges) {
        if (edge.repositoryId !== scope.repositoryId || edge.analysisRevision !== scope.analysisRevision) throw new Error('Dependency belongs to another revision.');
        if (!relations.some(item => identity(item, item.dependencyEdgeId) === identity(edge, edge.dependencyEdgeId))) relations.push(edge);
        if (edge.resolution !== 'resolved') {
          if (edge.internal) gaps.push({ code: 'UNRESOLVED_DEPENDENCY', message: `${symbol.qualifiedName}: ${edge.targetReference ?? edge.kind} is ${edge.resolution}.`, repositoryId: scope.repositoryId });
        } else if (edge.targetSymbolKey && edge.targetSymbolKey !== symbol.symbolKey) {
          const previous = targets.get(edge.targetSymbolKey);
          if (!previous || previous.kind === 'import' && edge.kind !== 'import') targets.set(edge.targetSymbolKey, edge);
        }
        else if (edge.internal && edge.targetRelativePath && edge.targetRelativePath !== symbol.relativePath) {
          gaps.push({ code: 'DEPENDENCY_TARGET_UNRESOLVED', message: `The ${edge.kind} relation from ${symbol.qualifiedName} identifies ${edge.targetRelativePath}, but no specific declaration.`, repositoryId: scope.repositoryId, relativePath: edge.targetRelativePath });
        }
      }
      const targetKeys = [...targets.keys()];
      for (let offset = 0; offset < targetKeys.length; offset += 200) {
        const keys = targetKeys.slice(offset, offset + 200);
        const found = await this.store.querySymbols!(scope, { symbolKeys: keys, limit: 200 }, signal);
        if (found.symbols.length < keys.length) gaps.push({ code: 'DEPENDENCY_SYMBOL_UNAVAILABLE', message: `Some declarations referenced by ${symbol.qualifiedName} are unavailable.`, repositoryId: scope.repositoryId });
        for (const target of found.symbols) {
          this.assertSymbol(scope, target, false);
          const edge = targets.get(target.symbolKey)!;
          const reason = `${symbol.qualifiedName} --${edge.kind}--> ${target.qualifiedName}.`;
          if (classKinds.includes(target.kind) || edge.kind === 'import') await outline(scope, target, reason);
          else if (functionKinds.includes(target.kind)) {
            const targetId = identity(scope, target.symbolKey);
            if (!queued.has(targetId)) {
              if (queued.size >= 200) {
                if (!gaps.some(gap => gap.code === 'DEPENDENCY_EXPANSION_LIMIT')) gaps.push({ code: 'DEPENDENCY_EXPANSION_LIMIT', message: 'Dependency traversal reached 200 implementation symbols; additional dependencies remain.' });
                continue;
              }
              queued.add(targetId);
              await this.readEvidence(scope, target.relativePath, target, 'dependency', reason, evidence, gaps, signal);
              queue.push({ scope, symbol: target });
            }
          } else await this.readEvidence(scope, target.relativePath, target, 'interface', reason, evidence, gaps, signal);
        }
      }
    }
  }

  private async readEvidence(scope: TaskRetrievalScope, path: string, symbol: SymbolRecord | undefined, role: TaskContextEvidence['role'], reason: string,
    output: TaskContextEvidence[], gaps: TaskRetrievalGap[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const range = symbol?.sourceRange;
    const evidenceId = `source-${id([scope.repositoryId, scope.analysisRevision, path, JSON.stringify(range ?? null)])}`;
    if (output.some((item) => item.evidenceId === evidenceId)) return;
    const source = await this.store.getSourceSlice!(scope, path, range, 32000, signal);
    if (!source) { gaps.push({ code: 'SOURCE_UNAVAILABLE', message: `Indexed source is unavailable: ${path}`, repositoryId: scope.repositoryId, relativePath: path }); return; }
    if (source.file.repositoryId !== scope.repositoryId || source.file.analysisRevision !== scope.analysisRevision || source.file.relativePath !== path) throw new Error('Source evidence belongs to another revision or path.');
    // Keep local reads bounded while assembling the complete indexed declaration.
    while (range && source.truncated) {
      signal.throwIfAborted();
      const nextRange = { ...range, startLine: source.sourceRange.endLine, startColumn: source.sourceRange.endColumn };
      if (nextRange.startLine === range.endLine && nextRange.startColumn === range.endColumn) { source.truncated = false; break; }
      const next = await this.store.getSourceSlice!(scope, path, nextRange, 32000, signal);
      if (!next || !next.text) break;
      if (next.file.repositoryId !== scope.repositoryId || next.file.analysisRevision !== scope.analysisRevision || next.file.relativePath !== path || next.file.sha256 !== source.file.sha256 ||
        next.sourceRange.startLine !== nextRange.startLine || next.sourceRange.startColumn !== nextRange.startColumn) throw new Error('Source continuation does not match its pinned declaration.');
      source.text += next.text;
      source.sourceRange = { ...source.sourceRange, endLine: next.sourceRange.endLine, endColumn: next.sourceRange.endColumn };
      source.truncated = next.truncated;
    }
    if (source.truncated) gaps.push({ code: 'SOURCE_TRUNCATED', message: `Source excerpt is truncated: ${path}`, repositoryId: scope.repositoryId, relativePath: path });
    if (['failed', 'partial'].includes(source.file.parseStatus)) gaps.push({ code: 'PARSE_INCOMPLETE', message: `Structural parsing is ${source.file.parseStatus}: ${path}`, repositoryId: scope.repositoryId, relativePath: path });
    output.push({ ...scope, evidenceId, role, name: symbol?.qualifiedName ?? path, relativePath: path, sourceRange: source.sourceRange,
      contentHash: sourceContentHash(source.text), fileHash: source.file.sha256, content: source.text, reason,
      provider: symbol?.provider ?? 'tree-sitter', evidenceLevel: symbol?.evidenceLevel ?? 'structural', truncated: source.truncated,
      ...(symbol ? { symbolKey: symbol.symbolKey } : {}) });
  }
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  const before = (line: number, column: number, otherLine: number, otherColumn: number) => line < otherLine || line === otherLine && column < otherColumn;
  return before(left.startLine, left.startColumn, right.endLine, right.endColumn) && before(right.startLine, right.startColumn, left.endLine, left.endColumn);
}
