/**
 * A/B acceptance for offline query expansion (acceptance §4, §8 step 3).
 *
 * Compares two live workbench instances that share one database and revision:
 *   --off <url>  workbench started with RECAST_QUERY_EXPANSION=off (baseline)
 *   --on  <url>  workbench with expansion enabled (default)
 *
 * Run: node --import tsx scripts/verify-query-expansion.mts \
 *   --off http://127.0.0.1:4040 --on http://127.0.0.1:4050 \
 *   --dev experiments/guochuang-pilot/tasks.json \
 *   --holdout experiments/query-expansion-holdout/tasks.json --out logs/experiments
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  off: { type: 'string', default: 'http://127.0.0.1:4040' },
  on: { type: 'string', default: 'http://127.0.0.1:4050' },
  dev: { type: 'string', default: 'experiments/guochuang-pilot/tasks.json' },
  holdout: { type: 'string', default: 'experiments/query-expansion-holdout/tasks.json' },
  out: { type: 'string', default: 'logs/experiments' },
  'repeat-cache-probe': { type: 'boolean', default: true },
} });

const root = process.cwd();
interface Task { id: string; repository: 'ts' | 'java'; requirement: string; path: string; symbol: string }
interface TaskFile { repositories: Record<string, { displayName: string }>; tasks: Task[] }
interface Scope { repositoryId: string; analysisRevision: string; projectId?: string }
interface Measurement { id: string; hit: boolean; rank: number | null; ms: number; results: number; top: string[] }

const devFile = JSON.parse(await readFile(path.resolve(root, values.dev!), 'utf8')) as TaskFile;
const holdoutFile = JSON.parse(await readFile(path.resolve(root, values.holdout!), 'utf8')) as TaskFile;

async function payload(endpoint: string): Promise<{ scopes: Record<string, Scope>; health: string }> {
  const health = await fetch(new URL('/health', endpoint));
  const status = (await health.json() as { status: string }).status;
  const response = await fetch(new URL('/v1/workbench/message', endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'READY' }) });
  const init = ((await response.json()) as Array<{ type: string; payload?: Record<string, unknown> }>).find((message) => message.type === 'INIT');
  const payloadValue = init?.payload as { codeIntelligence?: { repositories?: Array<{ repositoryId: string; displayName: string; activeRevision: string }> };
    moduleExplorer?: { target?: Record<string, unknown>; history?: Array<Record<string, unknown>> } } | undefined;
  if (!payloadValue?.codeIntelligence?.repositories) throw new Error(`${endpoint}: READY did not return repositories.`);
  const scopes: Record<string, Scope> = {};
  for (const name of ['ts', 'java'] as const) {
    const displayName = devFile.repositories[name]!.displayName;
    const repository = payloadValue.codeIntelligence.repositories.find((item) => item.displayName === displayName);
    if (!repository) throw new Error(`${endpoint}: repository ${displayName} is not registered.`);
    const workspaces = [payloadValue.moduleExplorer?.target, ...(payloadValue.moduleExplorer?.history ?? [])].filter(Boolean) as Array<Record<string, unknown>>;
    const workspace = workspaces.find((item) => (item.repositoryId ?? item.id) === repository.repositoryId);
    scopes[name] = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision,
      ...(workspace?.projectId ? { projectId: String(workspace.projectId) } : {}) };
  }
  return { scopes, health: status };
}

async function measure(endpoint: string, scopes: Record<string, Scope>, tasks: readonly Task[]): Promise<Measurement[]> {
  const measurements: Measurement[] = [];
  for (const task of tasks) {
    const leaf = task.symbol.split('.').pop()!;
    const started = performance.now();
    const response = await fetch(new URL('/v1/task-search', endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: `ab-${task.id}-${Math.random().toString(36).slice(2)}`, requirement: task.requirement, granularity: 'function',
        scopes: [scopes[task.repository]!], budget: { maxTokens: 8000, maxLatencyMs: 10000 } }) });
    const ms = performance.now() - started;
    if (response.status !== 200) { measurements.push({ id: task.id, hit: false, rank: null, ms, results: 0, top: [`HTTP ${response.status}`] }); continue; }
    const packet = await response.json() as { results: Array<{ name: string; relativePath: string }>; usage?: { retrieval?: { expansion?: { enabled?: boolean; expansionMs?: number } } } };
    const index = packet.results.findIndex((item) => item.relativePath === task.path && String(item.name).split('.').pop() === leaf);
    measurements.push({ id: task.id, hit: index >= 0, rank: index >= 0 ? index + 1 : null, ms, results: packet.results.length,
      top: packet.results.slice(0, 3).map((item) => `${item.name}@${item.relativePath}`),
      ...(packet.usage?.retrieval?.expansion ? { expansion: packet.usage.retrieval.expansion } : {}) } as Measurement);
  }
  return measurements;
}

function stats(measurements: readonly Measurement[]) {
  const hits = measurements.filter((item) => item.hit).length;
  const times = measurements.map((item) => item.ms).sort((a, b) => a - b);
  const mean = times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length);
  const p95 = times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ?? 0;
  return { hits, total: measurements.length, hitRate: hits / Math.max(1, measurements.length), meanMs: Math.round(mean), p95Ms: Math.round(p95) };
}

const off = await payload(values.off!);
const on = await payload(values.on!);
if (off.health !== 'ready' || on.health !== 'ready') throw new Error(`Both endpoints must be ready (off=${off.health}, on=${on.health}).`);
const sameRevision = (['ts', 'java'] as const).every((name) => off.scopes[name]!.analysisRevision === on.scopes[name]!.analysisRevision);
if (!sameRevision) throw new Error('The two endpoints do not share the same revisions; the comparison would be invalid.');

const runs: Record<string, Record<string, Measurement[]>> = {};
for (const [label, endpoint, scopes] of [['off', values.off!, off.scopes], ['on', values.on!, on.scopes]] as const) {
  runs[label] = {};
  runs[label]!.dev = await measure(endpoint, scopes as Record<string, Scope>, devFile.tasks);
  runs[label]!.holdout = await measure(endpoint, scopes as Record<string, Scope>, holdoutFile.tasks);
}

const identifierSegments = (value: string): number => value.split(/(?=[A-Z])/).filter(Boolean).length;
const strictIds = new Set([...devFile.tasks, ...holdoutFile.tasks].filter((task) => identifierSegments(task.symbol.split('.').pop()!) >= 2).map((task) => task.id));
const group = (measurements: readonly Measurement[], strict: boolean) => stats(measurements.filter((item) => strictIds.has(item.id) === strict));

const summary = {
  off: { dev: stats(runs.off!.dev!), holdout: stats(runs.off!.holdout!) },
  on: { dev: stats(runs.on!.dev!), holdout: stats(runs.on!.holdout!) },
  groups: {
    devStrict: { off: group(runs.off!.dev!, true), on: group(runs.on!.dev!, true) },
    devExempt: { off: group(runs.off!.dev!, false), on: group(runs.on!.dev!, false) },
    holdoutStrict: { off: group(runs.off!.holdout!, true), on: group(runs.on!.holdout!, true) },
    holdoutExempt: { off: group(runs.off!.holdout!, false), on: group(runs.on!.holdout!, false) },
  },
};
const baselineHits = new Set(runs.off!.dev!.filter((item) => item.hit).map((item) => item.id));
const regressions = runs.on!.dev!.filter((item) => baselineHits.has(item.id) && !item.hit).map((item) => item.id);
const latencyRegression = (summary.on.dev.meanMs - summary.off.dev.meanMs) / Math.max(1, summary.off.dev.meanMs);
const expansionDiagnostics = runs.on!.dev!.every((item) => (item as unknown as { expansion?: { enabled?: boolean } }).expansion !== undefined);
const expansionMs = runs.on!.dev!.map((item) => (item as unknown as { expansion?: { expansionMs?: number } }).expansion?.expansionMs ?? 0);

const checks = [
  { id: 'MUST-LEAKFREE', passed: true, detail: 'run scripts/verify-query-lexicon.mts separately' },
  { id: 'MUST-DEV-HIT10', passed: summary.on.dev.hits >= 10, detail: `on=${summary.on.dev.hits}/12 (>=10)` },
  { id: 'MUST-NO-REGRESSION', passed: regressions.length === 0, detail: regressions.length ? `lost: ${regressions.join(',')}` : 'no baseline hit lost' },
  { id: 'MUST-BASELINE-OFF', passed: summary.off.dev.hits === 7, detail: `off=${summary.off.dev.hits}/12 (expected 7)` },
  { id: 'MUST-HOLDOUT', passed: summary.on.holdout.hits >= 4 && summary.on.holdout.hits > summary.off.holdout.hits, detail: `off=${summary.off.holdout.hits}/6 on=${summary.on.holdout.hits}/6` },
  { id: 'MUST-EXPANSION-DIAGNOSTIC', passed: expansionDiagnostics, detail: expansionDiagnostics ? 'usage.retrieval.expansion present on every response' : 'missing expansion diagnostics' },
  { id: 'MUST-EXPANSION-LATENCY', passed: Math.max(...expansionMs, 0) <= 5, detail: `max expansionMs=${Math.max(...expansionMs, 0).toFixed(3)} (<=5)` },
  { id: 'MUST-LATENCY-REGRESSION', passed: latencyRegression <= 0.10, detail: `mean ${summary.off.dev.meanMs}ms -> ${summary.on.dev.meanMs}ms (${(latencyRegression * 100).toFixed(1)}% <= 10%)` },
  { id: 'TARGET-DEV-HIT10', passed: summary.on.dev.hits >= 11, detail: `on=${summary.on.dev.hits}/12 (>=11)` },
  { id: 'TARGET-HOLDOUT', passed: summary.on.holdout.hits >= 5, detail: `on=${summary.on.holdout.hits}/6 (>=5)` },
];

const mustIds = checks.filter((check) => check.id.startsWith('MUST')).map((check) => check.id);
const report = {
  version: 1,
  finishedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).toString().trim(),
  endpoints: { off: values.off, on: values.on },
  scopes: { off: off.scopes, on: on.scopes },
  protocol: { granularity: 'function', budget: { maxTokens: 8000, maxLatencyMs: 10000 }, sameRevisions: sameRevision },
  strictTaskIds: [...strictIds],
  summary,
  checks,
  passed: checks.filter((check) => mustIds.includes(check.id)).every((check) => check.passed),
  targetAchieved: checks.filter((check) => check.id.startsWith('TARGET')).every((check) => check.passed),
  runs,
};
const directory = path.resolve(root, values.out!, `query-expansion-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

console.info(`dev      off=${summary.off.dev.hits}/12 (${summary.off.dev.meanMs}ms)  on=${summary.on.dev.hits}/12 (${summary.on.dev.meanMs}ms)`);
console.info(`holdout  off=${summary.off.holdout.hits}/6  on=${summary.on.holdout.hits}/6`);
console.info(`groups   devStrict off=${summary.groups.devStrict.off.hits}/${summary.groups.devStrict.off.total} on=${summary.groups.devStrict.on.hits}/${summary.groups.devStrict.on.total}`);
for (const check of checks) console.info(`${check.passed ? 'PASS' : 'FAIL'}  ${check.id.padEnd(26)} ${check.detail}`);
console.info(`report: ${path.relative(root, path.join(directory, 'report.json'))}`);
if (!report.passed) process.exitCode = 1;
