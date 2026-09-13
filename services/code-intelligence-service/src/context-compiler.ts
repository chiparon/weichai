import { createHash, randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import { formatContextMarkdown, type ContextPacket, type TaskContextEvidence, type TaskRetrievalRequest } from '@forexplore/contracts';

const tokenizer = getEncoding('cl100k_base');
export function contextTokenCount(text: string): number { return tokenizer.encode(text, [], []).length; }

type ContextInput = Omit<ContextPacket, 'packetId' | 'requestId' | 'requirement' | 'markdown' | 'usage'>;
const priority = { implementation: 0, interface: 1, dependency: 2, configuration: 3 };
/** Rendering levels tried in order; the highest level that fits the budget wins. */
export type RenderLevel = 'full' | 'region' | 'skeleton' | 'signature';
const renderLevels: readonly RenderLevel[] = ['full', 'region', 'skeleton', 'signature'];
/** Cap on the share of the budget that indexed declaration signatures may take. */
const DECLARATION_BUDGET_SHARE = 0.2;
const DECLARATION_MEMBER_LIMIT = 12;
/**
 * Cap on the share of the budget one evidence item may take. A single large
 * declaration must not consume the whole budget: the excerpt that carries a
 * pattern only it has (for example the per-file limit exception, which in this
 * corpus exists only in the TypeScript mirror) still has to fit beside it.
 */
const PER_ITEM_BUDGET_SHARE = 0.35;
/** Rough characters per token, used only to size a region window before exact accounting. */
const CHARS_PER_TOKEN = 3.6;
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

/**
 * Verbatim windows of an oversized declaration, re-ranged to their own source
 * lines. Windows grow outwards from the lines that best match the query terms,
 * so a task that spans two distant methods (for example a size check and the
 * exception it throws) can be covered by one excerpt. Everything between
 * windows is replaced by an explicit elision marker; the excerpt stays flagged
 * as derived (`truncated`) because it is not the whole declaration.
 */
export function regionOf(item: TaskContextEvidence, terms: readonly string[], budgetChars: number, maxRegions = 3): { content: string; sourceRange: TaskContextEvidence['sourceRange']; regions: number } | null {
  const lines = item.content.split('\n');
  if (lines.length < 6 || budgetChars < 200) return null;
  const needles = [...new Set(terms.map((term) => term.toLowerCase()).filter((term) => term.length >= 3))];
  const score = (index: number): number => {
    if (!needles.length) return index === 0 ? 1 : 0;
    const lowered = lines[index]!.toLowerCase();
    return needles.reduce((total, needle) => total + (lowered.includes(needle) ? 1 : 0), 0);
  };
  // Seed one window per highest-value line. Lines are ranked by how many query
  // terms they cover, and seeds are forced apart so an excerpt can span distant
  // methods (a size check and the exception it throws often live apart).
  const separation = Math.max(4, Math.floor(lines.length / Math.max(1, maxRegions * 4)));
  const seeds: number[] = [];
  const covered = new Set<string>();
  const lineHits = (index: number): number => {
    const lowered = lines[index]!.toLowerCase();
    let hits = 0;
    for (const needle of needles) if (lowered.includes(needle)) hits += 1;
    return hits;
  };
  const addSeed = (index: number): void => {
    seeds.push(index);
    const lowered = lines[index]!.toLowerCase();
    for (const needle of needles) if (lowered.includes(needle)) covered.add(needle);
  };
  // Requirement slots first. A validation branch, the exception it raises and the
  // return path frequently live in different methods, so each slot gets its own
  // window instead of letting the densest method take all of them.
  const slotPredicates = [/\bthrow\b|\braise\b/, /\bif\s*\(|\bswitch\s*\(|\bcase\b/, /\breturn\b/];
  for (const predicate of slotPredicates) {
    if (seeds.length >= maxRegions) break;
    let best = -1;
    let bestHits = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (!predicate.test(lines[index]!.toLowerCase())) continue;
      const hits = lineHits(index);
      if (hits > bestHits) { bestHits = hits; best = index; }
    }
    if (best >= 0) addSeed(best);
  }
  // Then fill any remaining windows with the densest lines, forced apart.
  for (let pass = seeds.length; pass < maxRegions; pass += 1) {
    let best = -1;
    let bestScore = 0;
    for (let index = 0; index < lines.length; index += 1) {
      if (seeds.some((seed) => Math.abs(seed - index) < separation)) continue;
      const lowered = lines[index]!.toLowerCase();
      let fresh = 0;
      let hits = 0;
      for (const needle of needles) if (lowered.includes(needle)) { hits += 1; if (!covered.has(needle)) fresh += 1; }
      const value = fresh * 1000 + hits;
      if (value > bestScore) { bestScore = value; best = index; }
    }
    if (best < 0) break;
    addSeed(best);
  }
  if (!seeds.length) seeds.push(0);
  seeds.sort((left, right) => left - right);
  const perWindow = Math.max(200, Math.floor(budgetChars / seeds.length));
  const windows: Array<{ start: number; end: number }> = [];
  for (const seed of seeds) {
    let start = seed;
    let end = seed;
    let size = lines[seed]!.length + 1;
    while ((start > 0 || end < lines.length - 1) && size < perWindow) {
      const growStart = start > 0 ? lines[start - 1]!.length + 1 : Number.POSITIVE_INFINITY;
      const growEnd = end < lines.length - 1 ? lines[end + 1]!.length + 1 : Number.POSITIVE_INFINITY;
      if (growStart <= growEnd && size + growStart <= perWindow) { start -= 1; size += growStart; }
      else if (size + growEnd <= perWindow) { end += 1; size += growEnd; }
      else break;
    }
    const previous = windows.at(-1);
    if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
    else windows.push({ start, end });
  }
  if (windows.length === 1 && windows[0]!.start === 0 && windows[0]!.end === lines.length - 1) return null;
  const base = item.sourceRange.startLine;
  const content = windows.map((window, index) => {
    const gap = index === 0 ? 0 : window.start - windows[index - 1]!.end - 1;
    const marker = gap > 0 ? `… 省略 ${gap} 行 …\n` : '';
    return `${marker}${lines.slice(window.start, window.end + 1).join('\n')}`;
  }).join('\n');
  const first = windows[0]!;
  const last = windows.at(-1)!;
  return {
    content,
    regions: windows.length,
    sourceRange: {
      startLine: base + first.start,
      startColumn: first.start === 0 ? item.sourceRange.startColumn : 1,
      endLine: base + last.end,
      endColumn: last.end === lines.length - 1 ? item.sourceRange.endColumn : lines[last.end]!.length + 1,
    },
  };
}

function rendering(item: TaskContextEvidence, level: RenderLevel): string | null {
  if (level === 'full') return item.content;
  if (level === 'skeleton') return skeletonize(item.content);
  return signatureOf(item.content);
}

/**
 * Recall granularity sets an excerpt's floor; the budget buys depth above it.
 *
 * A concrete source-fragment hit located the lines that matched, so a window
 * around them is the honest minimum, and a symbol hit located a declaration, so
 * that declaration's body is. A summary or module hit only located a node, so
 * structure is the minimum. Dependency and configuration excerpts are small and
 * usually sit on the answer path, so they keep their whole body.
 */
function defaultLevelOf(item: TaskContextEvidence): RenderLevel {
  switch (item.recallChannel) {
    case 'source-fragment':
    case 'symbol':
    // A module hit delivers representative implementations of the node, not the
    // node projection itself, so its excerpts are still implementation bodies.
    case 'module': return 'region';
    case 'summary': return 'skeleton';
    default: return 'full';
  }
}

function withLevel(item: TaskContextEvidence, level: RenderLevel, content: string, sourceRange?: TaskContextEvidence['sourceRange']): TaskContextEvidence {
  if (level === 'full') return item;
  if (level === 'region') {
    // A narrower window of the declaration: the delivered slice carries its own
    // hash and range, and stays flagged truncated because it is not the whole
    // declaration a consumer may have been promised.
    return { ...item, content, contentHash: sourceContentHash(content), truncated: true, renderLevel: level, ...(sourceRange ? { sourceRange } : {}) };
  }
  // A skeleton/signature excerpt is no longer verbatim source: it carries its own
  // hash and is flagged as truncated so consumers never treat it as the full body.
  return { ...item, content, contentHash: sourceContentHash(content), truncated: true, renderLevel: level };
}

interface CompileOptions { mode?: 'adaptive' | 'legacy'; queryTerms?: readonly string[] }

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
export function compileTaskContextAdaptive(request: TaskRetrievalRequest, input: ContextInput, latencyMs: number, options: CompileOptions = {}): ContextPacket {
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
  let terseGaps = false;
  if (Number.isFinite(maxTokens) && framingTokens > maxTokens * 0.5) {
    // Ranked results are never removed; only their rendered reason is shortened.
    packet.results = packet.results.map(result => ({ ...result, reason: result.reason.length > 60 ? `${result.reason.slice(0, 59)}…` : result.reason }));
    framingTokens = framingCost(packet);
    metadataTrimmed = true;
    if (framingTokens > maxTokens * 0.5) packet.gaps.push(metadataGap);
  }

  const levels: Record<RenderLevel, number> = { full: 0, region: 0, skeleton: 0, signature: 0 };
  const terms = options.queryTerms ?? [];
  // The cap only makes sense where there is real competition for the budget; at
  // very small budgets delivering something beats reserving for others.
  const perItemCap = Number.isFinite(maxTokens) && maxTokens >= 1024 ? maxTokens * PER_ITEM_BUDGET_SHARE : Number.POSITIVE_INFINITY;
  let extraTokens = 0;
  const budgetUsed = (): number => framingTokens + extraTokens + evidenceCost();
  const withinLimits = (entries: TaskContextEvidence[]): boolean =>
    new Set(entries.map(entry => `${entry.repositoryId}\0${entry.analysisRevision}\0${entry.relativePath}`)).size <= maxFiles &&
    entries.reduce((sum, entry) => sum + lineCount(entry), 0) <= maxLines;
  /**
   * Trial placement of one excerpt at one render level. `index` is its position in
   * the current delivery (`-1` appends), and `reclaim` is the cost that same
   * excerpt already occupies — a deeper rendering may reuse it instead of
   * competing with its own cheaper rendering for the remaining budget.
   */
  const trialAt = (item: TaskContextEvidence, level: RenderLevel, index: number, reclaim: number): TaskContextEvidence[] | null => {
    let effective = level;
    let content: string | null;
    let sourceRange: TaskContextEvidence['sourceRange'] | undefined;
    if (level === 'region') {
      const remaining = Number.isFinite(maxTokens) ? Math.max(0, maxTokens - budgetUsed() + reclaim) : Number.POSITIVE_INFINITY;
      const window = regionOf(item, terms, Math.round(Math.min(remaining, perItemCap) * CHARS_PER_TOKEN), 3);
      // A null window means the allowance already covers the whole excerpt: that
      // is the excerpt's full body and must not be read as "region unavailable".
      if (!window) { effective = 'full'; content = item.content; }
      else { content = window.content; sourceRange = window.sourceRange; }
    } else content = rendering(item, level);
    if (content === null) return null;
    // Keep room for the rest of the delivery: an item larger than the per-item
    // cap is compacted (region/skeleton/signature) instead of taken whole.
    if (effective === 'full' && Number.isFinite(maxTokens) && contextTokenCount(content) > perItemCap) return null;
    const rendered = withLevel(item, effective, content, sourceRange);
    const trial = index < 0
      ? [...packet.evidence.filter(selected => priority[item.role] > priority[selected.role] || !contained(selected, rendered)), rendered]
      : [...packet.evidence.slice(0, index), rendered, ...packet.evidence.slice(index + 1)];
    if (!withinLimits(trial)) return null;
    const previousEvidence = packet.evidence;
    packet.evidence = trial;
    const affordable = !Number.isFinite(maxTokens) || budgetUsed() <= maxTokens;
    if (process.env.RECAST_COMPILER_DEBUG === '1' && !affordable) console.error(JSON.stringify({ skip: item.name, role: item.role, level,
      used: Math.round(budgetUsed()), maxTokens, framingTokens, evidence: trial.length, contentChars: content.length }));
    packet.evidence = previousEvidence;
    return affordable ? trial : null;
  };

  // A deeper rendering of an excerpt must re-render the original excerpt, never
  // the reduced form that is currently in the delivery.
  const originals = new Map(candidates.map(item => [item.evidenceId, item]));
  // Phase 1 — every candidate is placed at the level its recall granularity
  // implies, before any depth is bought, so the breadth the recall channels
  // earned is not spent by the first excerpt that happens to be large.
  for (const item of candidates) {
    if (packet.evidence.some(previous => contained(item, previous))) continue;
    // Granularity floors only exist because a budget forces a choice. An opt-out
    // budget (no maxTokens) must keep delivering every selected excerpt whole.
    const floor = Number.isFinite(maxTokens) ? defaultLevelOf(item) : 'full';
    let placed = false;
    // Cheaper renderings are the fallback only when the floor itself cannot fit.
    for (const level of renderLevels.slice(renderLevels.indexOf(floor))) {
      const trial = trialAt(item, level, -1, 0);
      if (!trial) continue;
      packet.evidence = trial;
      placed = true;
      break;
    }
    if (!placed) omitted.push(item.name);
  }
  // Phase 2 — the budget buys depth in delivery order, one level at a time, so
  // the highest-priority excerpts reach verbatim source first.
  for (let pass = 0; pass < renderLevels.length && Number.isFinite(maxTokens); pass++) {
    let progressed = false;
    for (const entry of [...packet.evidence]) {
      const index = packet.evidence.indexOf(entry);
      const current = renderLevels.indexOf(entry.renderLevel ?? 'full');
      const original = originals.get(entry.evidenceId);
      if (index < 0 || current <= 0 || !original) continue;
      // Charge the excerpt's own current cost as reclaimable, then confirm the
      // whole delivery still fits with the deeper rendering in place.
      const trial = trialAt(original, renderLevels[current - 1]!, index, costOf(original, entry.renderLevel ?? 'full', entry.content));
      if (!trial) continue;
      packet.evidence = trial;
      progressed = true;
    }
    if (!progressed) break;
  }

  const declSet = new Set<string>();
  const declarationCap = Number.isFinite(maxTokens) ? maxTokens * DECLARATION_BUDGET_SHARE : Number.POSITIVE_INFINITY;
  let declarationTokens = 0;
  for (const item of input.declarations ?? []) {
    if (declarationTokens >= declarationCap) { omitted.push(item.name); continue; }
    const identity = `${item.repositoryId}\0${item.analysisRevision}\0${item.symbolKey}`;
    if (declSet.has(identity) || [...packet.evidence, ...knownRanges].some(source => source.repositoryId === item.repositoryId && source.analysisRevision === item.analysisRevision &&
      source.relativePath === item.relativePath && !source.truncated && (source.symbolKey === item.symbolKey ||
        contained({ ...source, sourceRange: item.sourceRange }, source)))) continue;
    declSet.add(identity);
    // Signature outlines are supporting material: keep their heads bounded.
    const signatureLines = item.signature.split('\n');
    const entry = signatureLines.length > DECLARATION_MEMBER_LIMIT + 1
      ? { ...item, signature: [...signatureLines.slice(0, DECLARATION_MEMBER_LIMIT + 1), `… 另有 ${signatureLines.length - DECLARATION_MEMBER_LIMIT - 1} 个成员签名省略 …`].join('\n') }
      : item;
    packet.declarations!.push(entry);
    const cost = contextTokenCount(`### ${entry.name}\n${entry.repositoryId}@${entry.analysisRevision}:${entry.relativePath}:${entry.sourceRange.startLine}\nIndexed declaration signatures; implementation bodies are not included.\n${entry.reason}\n\n${entry.signature}`);
    const trialFiles = new Set([...packet.evidence, ...packet.declarations!].map(entryItem => `${entryItem.repositoryId}\0${entryItem.analysisRevision}\0${entryItem.relativePath}`));
    if (trialFiles.size > maxFiles || Number.isFinite(maxTokens) && budgetUsed() + cost > maxTokens ||
      declarationTokens + cost > declarationCap) { packet.declarations!.pop(); omitted.push(item.name); continue; }
    extraTokens += cost;
    declarationTokens += cost;
  }
  for (const edge of input.relations) {
    packet.relations.push(edge);
    const cost = contextTokenCount(`- ${edge.repositoryId}@${edge.analysisRevision}: ${edge.sourceSymbolKey ?? edge.sourceRelativePath} --${edge.kind} (${edge.resolution}, ${edge.evidenceLevel})--> ${edge.targetSymbolKey ?? edge.targetRelativePath ?? edge.targetReference ?? 'unknown'}`);
    if (Number.isFinite(maxTokens) && budgetUsed() + cost > maxTokens) { packet.relations.pop(); omitted.push(edge.dependencyEdgeId); continue; }
    extraTokens += cost;
  }

  // Render levels and the downgrade record are recomputed from the final
  // delivery, so they always describe what is actually being handed over.
  const resyncLevels = (): void => {
    for (const level of renderLevels) levels[level] = 0;
    downgraded.length = 0;
    for (const entry of packet.evidence) {
      const level = entry.renderLevel ?? 'full';
      levels[level] += 1;
      if (level !== 'full') downgraded.push(`${entry.name}→${level}`);
    }
  };
  resyncLevels();
  if (metadataTrimmed && !packet.gaps.includes(metadataGap)) packet.gaps.push(metadataGap);
  if (packet.gaps.length && packet.status === 'complete') packet.status = 'partial';
  const refreshGaps = (): void => {
    // Gap messages are metadata too, and they are written after the framing cost
    // was reserved. They stay bounded, and under budget pressure they degrade to
    // counts only: the machine-readable record lives in `usage.retrieval.compiler`.
    const enumerate = (entries: string[]): string => terseGaps ? ''
      : `：${entries.slice(0, 6).map(entry => entry.length > 60 ? `${entry.slice(0, 59)}…` : entry).join('、')}${entries.length > 6 ? '…' : ''}`;
    if (downgraded.length) {
      downgradeGap.message = `${downgraded.length} 条证据未以全文交付（按召回粒度与预算渲染，未整条丢弃）${enumerate(downgraded)}`;
      if (!packet.gaps.includes(downgradeGap)) packet.gaps.push(downgradeGap);
    }
    if (omitted.length) {
      omittedGap.message = `${omitted.length} 项内容因内容上限未交付${enumerate(omitted)}`;
      if (!packet.gaps.includes(omittedGap)) packet.gaps.push(omittedGap);
    }
  };
  refreshGaps();

  // Exact final accounting; the incremental estimate only differs by section headers.
  packet.markdown = formatContextMarkdown(packet);
  let tokens = contextTokenCount(packet.markdown);
  let repaired = 0;
  // The repair loop may only touch evidence, declarations and relations, and each
  // of them can need up to one step per render level plus a removal. A fixed step
  // cap silently gives up on large deliveries, so the cap scales with them.
  const repairLimit = 8 + 5 * packet.evidence.length + (packet.declarations?.length ?? 0) + packet.relations.length;
  while (Number.isFinite(maxTokens) && tokens > maxTokens && repaired < repairLimit) {
    const last = packet.evidence.at(-1);
    if (last) {
      const step = renderLevels.indexOf(last.renderLevel ?? 'full');
      const original = originals.get(last.evidenceId) ?? last;
      const nextLevel: RenderLevel = renderLevels[Math.min(step + 1, renderLevels.length - 1)] ?? 'signature';
      // Repair must make real progress. A compacted rendering of the *original*
      // excerpt can be larger than the window currently delivered (a declaration
      // skeleton is bigger than a slice of it), so only a strictly smaller
      // rendering is applied, and an excerpt that cannot shrink is dropped and
      // recorded instead of being retried until the step cap runs out.
      const window = nextLevel === 'region'
        ? regionOf(original, terms, Math.max(200, Math.round(contextTokenCount(last.content) * 0.6 * CHARS_PER_TOKEN)), 3)
        : null;
      const content = nextLevel === 'region' ? window?.content ?? null : rendering(original, nextLevel);
      if (content !== null && contextTokenCount(content) < contextTokenCount(last.content)) {
        packet.evidence[packet.evidence.length - 1] = withLevel(original, nextLevel, content, window?.sourceRange);
      } else { packet.evidence.pop(); omitted.push(last.name); }
    } else if (packet.relations.length) packet.relations.pop();
    else if (packet.declarations?.length) { packet.declarations.pop(); omitted.push('declaration'); }
    // Nothing left to trim but the diagnostic lists themselves: they are the last
    // metadata that can be given up, and only their names, never their counts.
    else if (!terseGaps) terseGaps = true;
    else break;
    repaired += 1;
    resyncLevels();
    refreshGaps();
    packet.markdown = formatContextMarkdown(packet);
    tokens = contextTokenCount(packet.markdown);
  }
  if (Number.isFinite(maxTokens) && tokens > maxTokens) throw new Error(`The token budget is too small for the task and snapshot metadata (tokens=${tokens}, maxTokens=${maxTokens}, framing=${framingTokens}, evidence=${packet.evidence.length}, declarations=${packet.declarations?.length ?? 0}, relations=${packet.relations.length}, gaps=${packet.gaps.length}, repairs=${repaired}).`);

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

/** Per-evidence framing overhead (heading, short location line, evidence line, fences). */
const FRAMING_PER_EVIDENCE = 28;

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
  return mode === 'legacy' ? compileTaskContextLegacy(request, input, latencyMs) : compileTaskContextAdaptive(request, input, latencyMs, options);
}

export function sourceContentHash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
