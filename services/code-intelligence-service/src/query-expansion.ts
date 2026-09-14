import { QUERY_LEXICON } from './query-lexicon-data.js';

/**
 * Local, deterministic query expansion for natural-language requirements.
 *
 * The expansion is deliberately model-free and I/O-free: it maps Chinese
 * requirement terms to English code word forms using a frozen offline lexicon
 * and appends them to the recall query. See
 * docs/query-expansion-acceptance.zh-CN.md for the acceptance contract.
 */
export interface QueryExpansionResult {
  readonly enabled: boolean;
  readonly version: string;
  readonly lexiconSha256: string;
  /** Chinese lexicon terms found in the requirement, in text order. */
  readonly matched: readonly string[];
  /** English word forms appended to the recall query, in emission order. */
  readonly terms: readonly string[];
  /** Text handed to the recall channels. Equals the requirement when disabled or unmatched. */
  readonly expanded: string;
}

export interface QueryExpansionPort {
  expand(requirement: string): QueryExpansionResult;
}

/** Guard rails keep the recall query bounded (§4.5 of the acceptance document, exception #1). */
export const QUERY_EXPANSION_MAX_TERMS = 16;
export const QUERY_EXPANSION_MAX_CHARS = 600;
export const QUERY_EXPANSION_MIN_GROWTH_CHARS = 160;
export const QUERY_EXPANSION_MAX_GROWTH = 3;
/** Chinese terms shorter than this are not indexed, to avoid single-character noise. */
const MIN_TERM_LENGTH = 2;
/**
 * Ultra-generic word forms carry almost no discriminative signal but match many
 * unrelated symbols (for example `limit` matching FileCountLimit while the task
 * is about the per-file size limit). Measured on the dev set and the repository
 * contract check: dropping them removes evidence displacement without losing the
 * anchor benefit.
 */
const GENERIC_WORDS = new Set([
  'put', 'send', 'set', 'get', 'make', 'do', 'has', 'is', 'use', 'new', 'main', 'base', 'core', 'misc', 'info',
  'item', 'items', 'value', 'values', 'data', 'object', 'obj', 'code', 'no', 'num', 'err', 'doc', 'docs', 'mem',
  'thing', 'stuff', 'op', 'ops', 'fn', 'func', 'arg', 'args', 'str', 'val', 'buf', 'out', 'in', 'src', 'dst', 'res', 'req',
]);

interface CompiledLexicon {
  version: string;
  sha256: string;
  byFirstCharacter: Map<string, Array<{ zh: string; en: readonly string[] }>>;
  maxLength: number;
}

function compile(entries: readonly { readonly zh: string; readonly en: readonly string[] }[], version: string, sha256: string): CompiledLexicon {
  const byFirstCharacter = new Map<string, Array<{ zh: string; en: readonly string[] }>>();
  let maxLength = 0;
  for (const entry of entries) {
    if (entry.zh.length < MIN_TERM_LENGTH) continue;
    const key = entry.zh.slice(0, 1);
    const bucket = byFirstCharacter.get(key) ?? [];
    bucket.push({ zh: entry.zh, en: entry.en });
    byFirstCharacter.set(key, bucket);
    maxLength = Math.max(maxLength, entry.zh.length);
  }
  // Longest first: greedy matching must prefer 唯一编号 over 编号.
  for (const bucket of byFirstCharacter.values()) bucket.sort((left, right) => right.zh.length - left.zh.length || left.zh.localeCompare(right.zh, 'zh-Hans-CN'));
  return { version, sha256, byFirstCharacter, maxLength };
}

const compiled = compile(QUERY_LEXICON.entries, QUERY_LEXICON.version, QUERY_LEXICON.lexiconSha256);

/** Word forms already present in the requirement (camelCase/snake_case aware). */
function identifierWords(text: string): string[] {
  const words: string[] = [];
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    const split = token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2);
    words.push(...(split.length ? split : [token]));
  }
  return words;
}

function matchTerms(text: string): Array<{ zh: string; en: readonly string[] }> {
  const matched: Array<{ zh: string; en: readonly string[] }> = [];
  for (let index = 0; index < text.length;) {
    const bucket = compiled.byFirstCharacter.get(text.slice(index, index + 1));
    let hit: { zh: string; en: readonly string[] } | undefined;
    if (bucket) {
      for (const candidate of bucket) {
        if (text.startsWith(candidate.zh, index)) { hit = candidate; break; }
      }
    }
    if (!hit) { index += 1; continue; }
    matched.push(hit);
    index += hit.zh.length;
  }
  return matched;
}

/** Deterministic discriminative ranking: camelCase domain words beat short generic verbs. */
function specificity(term: string): number {
  return (/[A-Z]/.test(term) ? 2 : 0) + Math.min(3, Math.floor(term.length / 4));
}

function expand(requirement: string): QueryExpansionResult {
  const disabled: QueryExpansionResult = { enabled: false, version: compiled.version, lexiconSha256: compiled.sha256,
    matched: [], terms: [], expanded: requirement };
  const text = requirement.normalize('NFKC');
  if (!text.trim()) return disabled;
  const matched = matchTerms(text);
  const seen = new Set((text.match(/[A-Za-z0-9_]+/g) ?? []).map((value) => value.toLowerCase()));
  const terms: string[] = [];
  const add = (value: string): void => {
    const key = value.toLowerCase();
    if (key.length < 2 || GENERIC_WORDS.has(key) || seen.has(key)) return;
    seen.add(key);
    terms.push(value);
  };
  for (const entry of matched) for (const word of entry.en) add(word);
  for (const word of identifierWords(text)) add(word);
  const maxChars = Math.min(QUERY_EXPANSION_MAX_CHARS, Math.max(QUERY_EXPANSION_MIN_GROWTH_CHARS, text.length * QUERY_EXPANSION_MAX_GROWTH));
  const budget = Math.max(0, maxChars - text.length - 1);
  // Emit the most discriminative word forms first so a truncated budget never
  // spends itself on generic verbs such as "put" or "send" (acceptance §4.5).
  const ranked = [...terms].map((term, index) => ({ term, index }))
    .sort((left, right) => specificity(right.term) - specificity(left.term) || left.index - right.index);
  const selected: string[] = [];
  let used = 0;
  for (const { term } of ranked) {
    if (selected.length >= QUERY_EXPANSION_MAX_TERMS) break;
    const cost = term.length + (selected.length ? 1 : 0);
    if (used + cost > budget) break;
    selected.push(term);
    used += cost;
  }
  if (!selected.length) return { ...disabled, matched: matched.map((entry) => entry.zh) };
  // The requirement itself is never rewritten: expansion only appends terms.
  return { enabled: true, version: compiled.version, lexiconSha256: compiled.sha256,
    matched: matched.map((entry) => entry.zh), terms: selected, expanded: `${requirement} ${selected.join(' ')}` };
}

/** Always-on implementation backed by the frozen generated lexicon. */
export class LexiconQueryExpansion implements QueryExpansionPort {
  expand(requirement: string): QueryExpansionResult { return expand(requirement); }
}

/** Convenience export for callers and tests that do not need a port instance. */
export const expandQuery = expand;

/** Explicit off-switch used by the acceptance A/B and by hosts that must not expand. */
export class NoQueryExpansion implements QueryExpansionPort {
  expand(requirement: string): QueryExpansionResult {
    return { enabled: false, version: compiled.version, lexiconSha256: compiled.sha256, matched: [], terms: [], expanded: requirement };
  }
}

/**
 * Expansion is enabled by default and can be switched off explicitly
 * (RECAST_QUERY_EXPANSION=off/0/false/disabled) for baseline comparisons.
 * Acceptance: docs/query-expansion-result.zh-CN.md.
 */
export function queryExpansionFromEnvironment(environment: NodeJS.ProcessEnv = process.env): QueryExpansionPort | null {
  const raw = environment.RECAST_QUERY_EXPANSION?.trim().toLowerCase();
  return raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled' ? null : new LexiconQueryExpansion();
}

export const queryExpansionInternals = { compiled, matchTerms, identifierWords, expand };
