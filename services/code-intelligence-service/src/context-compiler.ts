import { createHash, randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { formatContextMarkdown, type ContextPacket, type TaskContextEvidence, type TaskRetrievalRequest } from '@forexplore/contracts';

const tokenizer = getEncoding('cl100k_base');
export function contextTokenCount(text: string): number { return tokenizer.encode(text, [], []).length; }

type ContextInput = Omit<ContextPacket, 'packetId' | 'requestId' | 'requirement' | 'markdown' | 'usage'>;
const priority = { implementation: 0, interface: 1, dependency: 2, configuration: 3 };
/** Rendering levels tried in order; the highest level that fits the budget wins. */
export type RenderLevel = 'full' | 'skeleton' | 'signature';
const renderLevels: readonly RenderLevel[] = ['full', 'skeleton', 'signature'];
/** Structural keywords that survive skeletonisation; everything else in a long run is elided. */
const structural = /^(?:[{}()[\];,]+|[}\])].*|.*\b(?:if|else|for|while|do|switch|case|default|try|catch|finally|throw|throws|return|await|yield|break|continue|new|extends|implements|interface|class|enum|struct|func|function|=>)\b.*)$/;
const SKELETON_MIN_LINES = 14;
const SKELETON_ELISION_RUN = 2;

function lineCount(item: TaskContextEvidence): number { return item.content.split('\n').length; }
/** Token cost of one evidence/declaration payload. */
function contentTokens(value: { content: string }): number { return contextTokenCount(value.content); }
function contained(inner: TaskContextEvidence, outer: TaskContextEvidence): boolean {
  const a = inner.sourceRange; const b = outer.sourceRange;
  return inner.repositoryId === outer.repositoryId && inner.analysisRevision === outer.analysisRevision && inner.relativePath === outer.relativePath && inner.fileHash === outer.fileHash &&
    (a.startLine > b.startLine || a.startLine === b.startLine && a.startColumn >= b.startColumn) &&
    (a.endLine < b.endLine || a.endLine === b.endLine && a.endColumn <= b.endColumn);
}

/**
 * Signature plus control-flow skeleton. The result is explicitly NOT compilable:
 * elided runs are replaced by a visible marker so a reader (or agent) always
 * knows that code is missing rather than mistaking the excerpt for the body.
 */
export function skeletonize(content: string): string | null {
  const lines = content.split('\n');
  if (lines.length < SKELETON_MIN_LINES) return null;
  const kept: string[] = [];
  let elided = 0;
  const flush = (): void => { if (elided > 0) { kept.push(`… 省略 ${elided} 行 …`); elided = 0; } };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const boundary = index === 0 || index === 1 || index === lines.length - 1;
    if (boundary || structural.test(trimmed)) { flush(); kept.push(line); return; }
    elided += 1;
  });
  flush();
  if (kept.length >= lines.length - SKELETON_ELISION_RUN) return null;
  const skeleton = kept.join('\n');
  return skeleton.length < content.length * 0.85 ? skeleton : null;
}

/** First declaration line only; used when even the skeleton does not fit. */
export function signatureOf(content: string): string | null {
  const first = content.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return null;
  const signature = first.length > 300 ? `${first.slice(0, 299)}…` : first;
  return signature.length < content.length * 0.6 ? `${signature}\n… 仅签名，正文省略 …` : null;
}

function rendering(item: TaskContextEvidence, level: RenderLevel): string | null {
  if (level === 'full') return item.content;
  if (level === 'skeleton') return skeletonize(item.content);
  return signatureOf(item.content);
}

function withLevel(item: TaskContextEvidence, level: RenderLevel, content: string): TaskContextEvidence {
  if (level === 'full') return item;
  // A downgraded excerpt is no longer verbatim source: it carries its own hash
  // and is flagged as truncated so consumers never treat it as the full body.
  return { ...item, content, contentHash: sourceContentHash(content), truncated: true, renderLevel: level };
}

interface CompileOptions { mode?: 'adaptive' | 'legacy' }

/**
 * Adaptive context compiler.
 *
 * Differences from the legacy first-fit packer:
 *  - token accounting is incremental (each rendered block is measured once), so
 *    selection is O(candidates) instead of O(candidates x whole document);
 *  - oversized evidence is delivered at a lower render level instead of being
 *    dropped, and every downgrade/omission is recorded in `gaps`;
 *  - the ranked primary results are never removed to make room for evidence.
 */
export function compileTaskContextAdaptive(request: TaskRetrievalRequest, input: ContextInput, latencyMs: number): ContextPacket {
  const maxTokens = request.budget.maxTokens ?? Infinity;
  const maxFiles = request.budget.maxFiles ?? Infinity;
  const maxLines = request.budget.maxSourceLines ?? Infinity;
  const known = new Map(request.knownEvidence?.map((item) => [item.evidenceId, item.contentHash]));
  const knownRanges = input.evidence.filter(item => known.get(item.evidenceId) === item.contentHash);
  const candidates = [...input.evidence].sort((a, b) => priority[a.role] - priority[b.role])
    .filter(item => !knownRanges.some(previous => contained(item, previous)));

  const downgraded: string[] = [];
  const omitted: string[] = [];
  const downgradeGap = { code: 'CONTEXT_EVIDENCE_DOWNGRADED', message: '' };
  const omittedGap = { code: 'CONTEXT_BUDGET_EXCEEDED', message: '' };
  const metadataGap = { code: 'CONTEXT_METADATA_OVER_BUDGET', message: 'Metadata and ranked results alone approach the token budget; evidence is limited.' };
  const packet: ContextPacket = { ...input, requestId: request.requestId, packetId: `context-${randomUUID()}`, requirement: request.requirement,
    evidence: [], declarations: [], results: [...input.results], relations: [], gaps: [], markdown: '',
    usage: { tokenizer: 'cl100k_base', tokens: 0, maxTokens: request.budget.maxTokens ?? null, characters: 0, files: 0, sourceLines: 0, latencyMs } };
  if (input.gaps.length) packet.gaps.push(...input.gaps);
  if (packet.gaps.length && packet.status === 'complete') packet.status = 'partial';

  // Every rendered block is tokenized at most once; selection sums cached costs.
  const blockCost = new Map<string, number>();
  const costOf = (item: TaskContextEvidence, level: RenderLevel, content: string): number => {
    const key = `${item.evidenceId}\u0000${level}`;
    const cached = blockCost.get(key);
    if (cached !== undefined) return cached;
    const cost = contextTokenCount(content) + FRAMING_PER_EVIDENCE;
    blockCost.set(key, cost);
    return cost;
  };
  const evidenceCost = (): number => packet.evidence.reduce((sum, entry) => {
    const level = entry.renderLevel ?? 'full';
    return sum + (blockCost.get(`${entry.evidenceId}\u0000${level}`) ?? costOf(entry, level, entry.content));
  }, 0);

  let framingTokens = framingCost(packet);
  let metadataTrimmed = false;
  if (Number.isFinite(maxTokens) && framingTokens > maxTokens * 0.5) {
    // Ranked results are never removed; only their rendered reason is shortened.
    packet.results = packet.results.map(result => ({ ...result, reason: result.reason.length > 60 ? `${result.reason.slice(0, 59)}…` : result.reason }));
    framingTokens = framingCost(packet);
    metadataTrimmed = true;
    if (framingTokens > maxTokens * 0.5) packet.gaps.push(metadataGap);
  }

  const levels: Record<RenderLevel, number> = { full: 0, skeleton: 0, signature: 0 };
  let extraTokens = 0;
  const budgetUsed = (): number => framingTokens + extraTokens + evidenceCost();
  for (const item of candidates) {
    if (packet.evidence.some(previous => contained(item, previous))) continue;
    let placed = false;
    for (const level of renderLevels) {
      const content = rendering(item, level);
      if (content === null) continue;
      const rendered = withLevel(item, level, content);
      const trial = [...packet.evidence.filter(selected => priority[item.role] > priority[selected.role] || !contained(selected, rendered)), rendered];
      const trialFiles = new Set(trial.map(entry => `${entry.repositoryId}\0${entry.analysisRevision}\0${entry.relativePath}`));
      if (trialFiles.size > maxFiles || trial.reduce((sum, entry) => sum + lineCount(entry), 0) > maxLines) continue;
      const previousEvidence = packet.evidence;
      packet.evidence = trial;
      if (Number.isFinite(maxTokens) && budgetUsed() > maxTokens) {
        if (process.env.RECAST_COMPILER_DEBUG === '1') console.error(JSON.stringify({ skip: item.name, role: item.role, level,
          used: Math.round(budgetUsed()), maxTokens, framingTokens, evidence: packet.evidence.length, contentChars: content.length }));
        packet.evidence = previousEvidence; continue;
      }
      levels[level] += 1;
      if (level !== 'full') downgraded.push(`${item.name}→${level}`);
      placed = true;
      break;
    }
    if (!placed) omitted.push(item.name);
  }

  const declSet = new Set<string>();
  for (const item of input.declarations ?? []) {
    const identity = `${item.repositoryId}\0${item.analysisRevision}\0${item.symbolKey}`;
    if (declSet.has(identity) || [...packet.evidence, ...knownRanges].some(source => source.repositoryId === item.repositoryId && source.analysisRevision === item.analysisRevision &&
      source.relativePath === item.relativePath && !source.truncated && (source.symbolKey === item.symbolKey ||
        contained({ ...source, sourceRange: item.sourceRange }, source)))) continue;
    declSet.add(identity);
    packet.declarations!.push(item);
    const cost = contextTokenCount(`### ${item.name}\n${item.repositoryId}@${item.analysisRevision}:${item.relativePath}:${item.sourceRange.startLine}\nIndexed declaration signatures; implementation bodies are not included.\n${item.reason}\n\n${item.signature}`);
    const trialFiles = new Set([...packet.evidence, ...packet.declarations!].map(entry => `${entry.repositoryId}\0${entry.analysisRevision}\0${entry.relativePath}`));
    if (trialFiles.size > maxFiles || Number.isFinite(maxTokens) && budgetUsed() + cost > maxTokens) { packet.declarations!.pop(); omitted.push(item.name); continue; }
    extraTokens += cost;
  }
  for (const edge of input.relations) {
    packet.relations.push(edge);
    const cost = contextTokenCount(`- ${edge.repositoryId}@${edge.analysisRevision}: ${edge.sourceSymbolKey ?? edge.sourceRelativePath} --${edge.kind} (${edge.resolution}, ${edge.evidenceLevel})--> ${edge.targetSymbolKey ?? edge.targetRelativePath ?? edge.targetReference ?? 'unknown'}`);
    if (Number.isFinite(maxTokens) && budgetUsed() + cost > maxTokens) { packet.relations.pop(); omitted.push(edge.dependencyEdgeId); continue; }
    extraTokens += cost;
  }

  if (metadataTrimmed && !packet.gaps.includes(metadataGap)) packet.gaps.push(metadataGap);
  if (packet.gaps.length && packet.status === 'complete') packet.status = 'partial';
  const refreshGaps = (): void => {
    if (downgraded.length) {
      downgradeGap.message = `${downgraded.length} 条证据因预算降级交付（未整条丢弃）：${downgraded.slice(0, 12).join('、')}${downgraded.length > 12 ? '…' : ''}`;
      if (!packet.gaps.includes(downgradeGap)) packet.gaps.push(downgradeGap);
    }
    if (omitted.length) {
      omittedGap.message = `${omitted.length} 项内容因内容上限未交付：${omitted.slice(0, 12).join('、')}${omitted.length > 12 ? '…' : ''}`;
      if (!packet.gaps.includes(omittedGap)) packet.gaps.push(omittedGap);
    }
  };
  refreshGaps();

  // Exact final accounting; the incremental estimate only differs by section headers.
  packet.markdown = formatContextMarkdown(packet);
  let tokens = contextTokenCount(packet.markdown);
  let repaired = 0;
  while (Number.isFinite(maxTokens) && tokens > maxTokens && repaired < 24) {
    const last = packet.evidence.at(-1);
    if (last) {
      if (last.renderLevel === 'signature') { packet.evidence.pop(); omitted.push(last.name); }
      else {
        const nextLevel: RenderLevel = last.renderLevel === 'skeleton' ? 'signature' : 'skeleton';
        const content = rendering(last, nextLevel);
        if (content !== null) { packet.evidence[packet.evidence.length - 1] = withLevel(last, nextLevel, content); downgraded.push(`${last.name}→${nextLevel}(repair)`); }
        else { packet.evidence.pop(); omitted.push(last.name); }
      }
    } else if (packet.relations.length) packet.relations.pop();
    else if (packet.declarations?.length) { packet.declarations.pop(); omitted.push('declaration'); }
    else break;
    repaired += 1;
    refreshGaps();
    packet.markdown = formatContextMarkdown(packet);
    tokens = contextTokenCount(packet.markdown);
  }
  if (Number.isFinite(maxTokens) && tokens > maxTokens) throw new Error('The token budget is too small for the task and snapshot metadata.');

  const codeTokens = packet.evidence.reduce((sum, item) => sum + contentTokens(item), 0);
  const prior = (input as { usage?: ContextPacket['usage'] }).usage?.retrieval;
  packet.usage = { ...packet.usage, tokens, characters: packet.markdown.length,
    files: new Set([...packet.evidence, ...packet.declarations!].map(item => `${item.repositoryId}\0${item.analysisRevision}\0${item.relativePath}`)).size,
    sourceLines: packet.evidence.reduce((sum, item) => sum + lineCount(item), 0),
    retrieval: { ...(prior ?? { sourceBytesRead: 0, sourceBytesDelivered: 0, sourceReadAmplification: null, sourceExcerptsRead: 0, recallAndExpansionMs: 0, compilationMs: 0 }),
      compiler: { mode: 'adaptive', framingTokens, codeTokens, codeShare: tokens > 0 ? codeTokens / tokens : 0,
        downgraded: downgraded.length, omitted: omitted.length, levels: { ...levels } } } };
  return packet;
}

/** Token cost of everything the packet renders except evidence, declarations and relations. */
function framingCost(packet: ContextPacket): number {
  return contextTokenCount(formatContextMarkdown({ ...packet, evidence: [], declarations: [], relations: [] }));
}

/** Per-evidence framing overhead (heading, location line, evidence line, fence). */
const FRAMING_PER_EVIDENCE = 45;

/** Legacy first-fit packer, kept byte-for-byte for the acceptance control run. */
export function compileTaskContextLegacy(request: TaskRetrievalRequest, input: ContextInput, latencyMs: number): ContextPacket {
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

/** Dispatches on RECAST_CONTEXT_COMPILER (default: adaptive). */
export function compileTaskContext(request: TaskRetrievalRequest, input: ContextInput, latencyMs: number, options: CompileOptions = {}): ContextPacket {
  const mode = options.mode ?? (process.env.RECAST_CONTEXT_COMPILER?.trim().toLowerCase() === 'legacy' ? 'legacy' : 'adaptive');
  return mode === 'legacy' ? compileTaskContextLegacy(request, input, latencyMs) : compileTaskContextAdaptive(request, input, latencyMs);
}

export function sourceContentHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
