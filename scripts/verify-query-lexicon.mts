/**
 * Leakage audit for the query-expansion lexicon (acceptance §5.2).
 *
 * Fails when the frozen lexicon contains any evaluation target identifier, any
 * multi-word identifier, or any requirement-derived mapping that would amount
 * to hard-coding the answers.
 *
 * Run: node --import tsx scripts/verify-query-lexicon.mts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QUERY_LEXICON } from '../services/code-intelligence-service/src/query-lexicon-data.js';

const root = process.cwd();
const taskFiles = ['experiments/guochuang-pilot/tasks.json', 'experiments/query-expansion-holdout/tasks.json'];
const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

interface Task { id: string; requirement: string; path: string; symbol: string }
const tasks: Task[] = taskFiles.flatMap((file) => (JSON.parse(readFileSync(path.join(root, file), 'utf8')) as { tasks: Task[] }).tasks);

const violations: Array<{ rule: string; detail: string }> = [];
const entries = QUERY_LEXICON.entries as readonly { readonly zh: string; readonly en: readonly string[] }[];
const values = entries.flatMap((entry) => entry.en);

// Rule 1: the lexicon must not carry the identifier that pinpoints an answer.
// A label whose leaf is a single ordinary English word (delete/write/copy/decode)
// is exempt: a generic software dictionary legitimately contains such words.
// Those tasks are reported as `exemptTasks` instead of being silently dropped
// (acceptance exception #2).
const identifierSegments = (value: string): number => value.split(/(?=[A-Z])/).filter(Boolean).length;
const exemptTasks: string[] = [];
for (const task of tasks) {
  const leaf = task.symbol.split('.').pop() ?? '';
  if (identifierSegments(leaf) < 2) { exemptTasks.push(task.id); continue; }
  const normalizedLeaf = normalize(leaf);
  const qualified = normalize(task.symbol);
  for (const value of values) {
    const normalized = normalize(value);
    if (normalized === normalizedLeaf || normalized === qualified) {
      violations.push({ rule: 'RULE-1 target-identifier', detail: `${task.id}: lexicon value "${value}" equals the labelled symbol` });
    }
  }
}

// Rule 2: entries must stay word level (no identifiers glued from many words).
for (const entry of entries) {
  for (const value of entry.en) {
    const segments = value.split(/(?=[A-Z])/).filter(Boolean).length;
    if (segments >= 4 || (segments >= 3 && value.length >= 18)) {
      violations.push({ rule: 'RULE-2 word-level', detail: `${entry.zh} -> "${value}" looks like a full identifier (${segments} segments)` });
    }
  }
}

// Rule 3: no requirement text (or long slice of it) may be present as a key.
const keys = new Set(entries.map((entry) => entry.zh));
for (const task of tasks) {
  for (let index = 0; index + 6 <= task.requirement.length; index++) {
    const window = task.requirement.slice(index, index + 6);
    if (keys.has(window)) violations.push({ rule: 'RULE-3 requirement-mapping', detail: `${task.id}: lexicon key "${window}" is a 6-character slice of the requirement` });
  }
}

// Rule 4: every key must be a generic Chinese term and the lexicon must be non-trivial.
for (const entry of entries) {
  if (!/^[\u4e00-\u9fff]{2,8}$/.test(entry.zh)) violations.push({ rule: 'RULE-4 term-shape', detail: `invalid key "${entry.zh}"` });
  if (!entry.en.length) violations.push({ rule: 'RULE-4 term-shape', detail: `"${entry.zh}" has no English word forms` });
}

const report = {
  version: QUERY_LEXICON.version,
  model: QUERY_LEXICON.model,
  lexiconSha256: QUERY_LEXICON.lexiconSha256,
  promptSha256: QUERY_LEXICON.promptSha256,
  entries: entries.length,
  englishWordForms: values.length,
  auditedTasks: tasks.length,
  strictlyCheckedTasks: tasks.length - exemptTasks.length,
  exemptTasks,
  taskFiles,
  violations,
  passed: violations.length === 0,
};
console.info(JSON.stringify(report, null, 2));
if (!report.passed) {
  console.error(`Leakage audit failed with ${violations.length} violation(s).`);
  process.exitCode = 1;
}
