import { createHash, randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { formatContextMarkdown, type ContextPacket, type TaskContextEvidence, type TaskRetrievalRequest } from '@forexplore/contracts';

const tokenizer = getEncoding('cl100k_base');
export function contextTokenCount(text: string): number { return tokenizer.encode(text, [], []).length; }

type ContextInput = Omit<ContextPacket, 'packetId' | 'requestId' | 'requirement' | 'markdown' | 'usage'>;
const priority = { implementation: 0, interface: 1, dependency: 2, configuration: 3 };
function lineCount(item: TaskContextEvidence): number { return item.content.split('\n').length; }
function contained(inner: TaskContextEvidence, outer: TaskContextEvidence): boolean {
  const a = inner.sourceRange; const b = outer.sourceRange;
  return inner.repositoryId === outer.repositoryId && inner.analysisRevision === outer.analysisRevision && inner.relativePath === outer.relativePath && inner.fileHash === outer.fileHash &&
    (a.startLine > b.startLine || a.startLine === b.startLine && a.startColumn >= b.startColumn) &&
    (a.endLine < b.endLine || a.endLine === b.endLine && a.endColumn <= b.endColumn);
}

/** Preserve implementations first. Content limits apply only when the caller supplies them. */
export function compileTaskContext(request: TaskRetrievalRequest, input: ContextInput, latencyMs: number): ContextPacket {
  const maxTokens = request.budget.maxTokens ?? Infinity;
  const maxFiles = request.budget.maxFiles ?? Infinity;
  const maxLines = request.budget.maxSourceLines ?? Infinity;
  const known = new Map(request.knownEvidence?.map((item) => [item.evidenceId, item.contentHash]));
  const knownRanges = input.evidence.filter(item => known.get(item.evidenceId) === item.contentHash);
  const ordered = [...input.evidence].sort((a, b) => priority[a.role] - priority[b.role]);
  const candidates = ordered.filter(item => !knownRanges.some(previous => contained(item, previous)));
  const packet: ContextPacket = { ...input, requestId: request.requestId, packetId: `context-${randomUUID()}`, requirement: request.requirement,
    evidence: [], declarations: [], results: [...input.results], relations: [], gaps: [...input.gaps], markdown: '',
    usage: { tokenizer: 'cl100k_base', tokens: 0, maxTokens: request.budget.maxTokens ?? null, characters: 0, files: 0, sourceLines: 0, latencyMs } };
  const omittedGap = { code: 'CONTEXT_BUDGET_EXCEEDED', message: 'Some context was omitted by the caller-supplied content limits.' };
  const render = () => formatContextMarkdown({ ...packet, gaps: [...packet.gaps, omittedGap] });
  const fits = () => !Number.isFinite(maxTokens) || contextTokenCount(render()) <= maxTokens;
  let omitted = false;
  while (!fits() && packet.results.length) { packet.results.pop(); omitted = true; }
  if (!fits()) throw new Error('The token budget is too small for the task and snapshot metadata.');
  for (const item of candidates) {
    if (packet.evidence.some(previous => contained(item, previous))) continue;
    // Replace nested excerpts only after their containing declaration actually fits.
    const previous = packet.evidence;
    const trial = [...previous.filter(selected => priority[item.role] > priority[selected.role] || !contained(selected, item)), item];
    const files = new Set(trial.map(entry => `${entry.repositoryId}\0${entry.analysisRevision}\0${entry.relativePath}`));
    if (files.size > maxFiles || trial.reduce((sum, entry) => sum + lineCount(entry), 0) > maxLines) { omitted = true; continue; }
    packet.evidence = trial;
    if (!fits()) { packet.evidence = previous; omitted = true; }
  }
  const declarations = new Set<string>();
  for (const item of input.declarations ?? []) {
    const identity = `${item.repositoryId}\0${item.analysisRevision}\0${item.symbolKey}`;
    if (declarations.has(identity) || [...packet.evidence, ...knownRanges].some(source => source.repositoryId === item.repositoryId && source.analysisRevision === item.analysisRevision &&
      source.relativePath === item.relativePath && !source.truncated && (source.symbolKey === item.symbolKey ||
        contained({ ...source, sourceRange: item.sourceRange }, source)))) continue;
    declarations.add(identity);
    packet.declarations!.push(item);
    const files = new Set([...packet.evidence, ...packet.declarations!].map(entry => `${entry.repositoryId}\0${entry.analysisRevision}\0${entry.relativePath}`));
    if (files.size > maxFiles || !fits()) { packet.declarations!.pop(); omitted = true; }
  }
  for (const edge of input.relations) {
    packet.relations.push(edge);
    if (!fits()) { packet.relations.pop(); omitted = true; }
  }
  if (omitted) packet.gaps.push(omittedGap);
  if (packet.gaps.length && packet.status === 'complete') packet.status = 'partial';
  packet.markdown = formatContextMarkdown(packet);
  packet.usage = { ...packet.usage, tokens: contextTokenCount(packet.markdown), characters: packet.markdown.length,
    files: new Set([...packet.evidence, ...packet.declarations!].map(item => `${item.repositoryId}\0${item.analysisRevision}\0${item.relativePath}`)).size,
    sourceLines: packet.evidence.reduce((sum, item) => sum + lineCount(item), 0) };
  return packet;
}

export function sourceContentHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
