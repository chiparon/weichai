import type { DependencyEdgeRecord, EvidenceLevel, EvidenceProvider, RepositoryRevisionScope, SourceRange } from './code-intelligence';

export type RetrievalGranularity = 'auto' | 'function' | 'class' | 'module' | 'subsystem';
export type ConcreteRetrievalGranularity = Exclude<RetrievalGranularity, 'auto'>;
export interface TaskRetrievalScope extends RepositoryRevisionScope { projectId?: string; role?: 'target' | 'reference' }
export interface TaskRetrievalRequest {
  requestId: string;
  requirement: string;
  granularity?: RetrievalGranularity;
  scopes: TaskRetrievalScope[];
  /** Content limits are opt-in; an empty budget retains all selected context. */
  budget: { maxTokens?: number; maxLatencyMs?: number; maxFiles?: number; maxSourceLines?: number };
  knownEvidence?: Array<{ evidenceId: string; contentHash: string }>;
}
export interface TaskRetrievalRouting {
  requestedGranularity: RetrievalGranularity;
  resolvedGranularities: ConcreteRetrievalGranularity[];
  source: 'user' | 'automatic';
  reason: string;
  confidence?: null;
}
export interface TaskRetrievalResult extends RepositoryRevisionScope {
  id: string;
  granularity: ConcreteRetrievalGranularity;
  name: string;
  projectId?: string;
  relativePath?: string;
  symbolKey?: string;
  moduleId?: string;
  score: number;
  reason: string;
}
export interface TaskContextEvidence extends RepositoryRevisionScope {
  evidenceId: string;
  role: 'implementation' | 'interface' | 'dependency' | 'configuration';
  name: string;
  relativePath: string;
  sourceRange: SourceRange;
  contentHash: string;
  fileHash: string;
  content: string;
  reason: string;
  provider: EvidenceProvider;
  evidenceLevel: EvidenceLevel;
  truncated: boolean;
  /** How much of the declaration body this excerpt carries. Absent means full; `region` is a verbatim contiguous slice carrying its own source range. */
  renderLevel?: 'full' | 'region' | 'skeleton' | 'signature';
  symbolKey?: string;
}
export interface TaskRetrievalGap { code: string; message: string; repositoryId?: string; relativePath?: string }
/** Indexed signatures, not verbatim source excerpts. The range locates the original declaration. */
export interface TaskContextDeclaration extends RepositoryRevisionScope {
  symbolKey: string;
  name: string;
  relativePath: string;
  sourceRange: SourceRange;
  signature: string;
  reason: string;
}
export interface TaskRetrievalSnapshot extends TaskRetrievalScope { repositoryName: string; analysisHash: string; sourceRevision?: string }
export interface ContextPacket {
  packetId: string;
  requestId: string;
  requirement: string;
  status: 'complete' | 'partial' | 'unavailable';
  snapshots: TaskRetrievalSnapshot[];
  routing: TaskRetrievalRouting;
  results: TaskRetrievalResult[];
  evidence: TaskContextEvidence[];
  declarations?: TaskContextDeclaration[];
  relations: DependencyEdgeRecord[];
  gaps: TaskRetrievalGap[];
  markdown: string;
  usage: { tokenizer: 'cl100k_base'; tokens: number; maxTokens: number | null; characters: number; files: number; sourceLines: number; latencyMs: number;
    /** Source payload only; excludes database internals and transport overhead. */
    retrieval?: { sourceBytesRead: number; sourceBytesDelivered: number; sourceReadAmplification: number | null;
      sourceExcerptsRead: number; recallAndExpansionMs: number; compilationMs: number;
      /** Disjoint wall-clock stages; recall includes query encoding inside the storage adapter. */
      stages?: { snapshotMs: number; recallMs: number; candidateResolutionMs: number; expansionMs: number; compilationMs: number };
      /** Local offline query expansion applied to the recall query; never involves a model call. */
      expansion?: { enabled: boolean; version: string; lexiconSha256: string; matched: string[]; terms: string[]; expansionMs: number };
      /** Context compiler accounting: how the budget was spent and what was downgraded. */
      compiler?: { mode: 'adaptive' | 'legacy'; framingTokens: number; codeTokens: number; codeShare: number;
        downgraded: number; omitted: number; levels: { full: number; skeleton: number; signature: number } } };
  };
}

/** Markdown rendering caps: machine-readable fields stay complete; the exported text stays compact. */
export const CONTEXT_MARKDOWN_LIMITS = { relations: 12, gaps: 4, gapMessage: 100, resultReason: 120 } as const;

function clamp(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Shared serialization for the service and user-selected evidence exports. */
export function formatContextMarkdown(packet: Pick<ContextPacket, 'requirement' | 'snapshots' | 'routing' | 'results' | 'evidence' | 'declarations' | 'relations' | 'gaps'>): string {
  const sections = ['# Code Context', packet.requirement, '## Snapshots', ...packet.snapshots.map((snapshot) =>
    `- ${snapshot.repositoryName}: ${snapshot.repositoryId}@${snapshot.analysisRevision}${snapshot.projectId ? ` project=${snapshot.projectId}` : ''} analysis=${snapshot.analysisHash}`),
  `## Retrieval\n${packet.routing.requestedGranularity} -> ${packet.routing.resolvedGranularities.join(', ') || 'unavailable'} (${packet.routing.source})`];
  if (packet.results.length) sections.push('## Relevant Implementations', ...packet.results.map((result) =>
    `- ${result.name} [${result.granularity}] ${result.repositoryId}@${result.analysisRevision}${result.relativePath ? `:${result.relativePath}` : ''}\n  ${clamp(result.reason, CONTEXT_MARKDOWN_LIMITS.resultReason)}`));
  if (packet.relations.length) sections.push('## Relations', ...packet.relations.slice(0, CONTEXT_MARKDOWN_LIMITS.relations).map((edge) =>
    `- ${edge.repositoryId}@${edge.analysisRevision}: ${edge.sourceSymbolKey ?? edge.sourceRelativePath} --${edge.kind} (${edge.resolution}, ${edge.evidenceLevel})--> ${edge.targetSymbolKey ?? edge.targetRelativePath ?? edge.targetReference ?? 'unknown'}`),
  ...(packet.relations.length > CONTEXT_MARKDOWN_LIMITS.relations ? [`- … 另有 ${packet.relations.length - CONTEXT_MARKDOWN_LIMITS.relations} 条关系未在此列出（结构化字段 relations 中完整保留）`] : []));
  const titles = { implementation: 'Core Implementations', interface: 'Type Definitions', dependency: 'Supporting Implementations', configuration: 'Build Configuration' };
  for (const role of ['implementation', 'interface', 'dependency', 'configuration'] as const) {
    const items = packet.evidence.filter(item => item.role === role);
    if (items.length) sections.push(`## ${titles[role]}`);
    for (const item of items) {
      const level = item.renderLevel && item.renderLevel !== 'full' ? `; render=${item.renderLevel}` : '';
      sections.push(`### ${item.name} [${item.role}]\n${item.relativePath}:${item.sourceRange.startLine}-${item.sourceRange.endLine}\nEvidence: ${item.evidenceId}; sha256=${item.contentHash.slice(0, 12)}; ${item.evidenceLevel}${item.truncated ? '; truncated' : ''}${level}\n${clamp(item.reason, CONTEXT_MARKDOWN_LIMITS.resultReason)}\n\n${fenced(item.content)}`);
    }
  }
  if (packet.declarations?.length) sections.push('## Supporting Declarations', ...packet.declarations.map(item =>
    `### ${item.name}\n${item.repositoryId}@${item.analysisRevision}:${item.relativePath}:${item.sourceRange.startLine}\nIndexed declaration signatures; implementation bodies are not included.\n${clamp(item.reason, CONTEXT_MARKDOWN_LIMITS.resultReason)}\n\n${fenced(item.signature)}`));
  if (packet.gaps.length) sections.push('## Gaps', ...packet.gaps.slice(0, CONTEXT_MARKDOWN_LIMITS.gaps).map((gap) => `- ${gap.code}: ${clamp(gap.message, CONTEXT_MARKDOWN_LIMITS.gapMessage)}`),
    ...(packet.gaps.length > CONTEXT_MARKDOWN_LIMITS.gaps ? [`- … 另有 ${packet.gaps.length - CONTEXT_MARKDOWN_LIMITS.gaps} 条缺口记录未在此列出（结构化字段 gaps 中完整保留）`] : []));
  return sections.join('\n\n');
}

function fenced(content: string): string {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${content}\n${fence}`;
}
