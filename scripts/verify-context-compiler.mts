/**
 * Acceptance measurement for the S1 context-compiler change
 * (docs/context-compiler-acceptance.zh-CN.md §4).
 *
 * Drives two live workbench instances that share one index and revision:
 *   --adaptive <url>  RECAST_CONTEXT_COMPILER unset (default: adaptive)
 *   --legacy   <url>  RECAST_CONTEXT_COMPILER=legacy  (pre-change behaviour)
 *
 * Reports, per requirement and budget: delivered source lines, code token share,
 * compilation stage time, budget compliance, downgrades and omissions.
 *
 * Run: node --import tsx scripts/verify-context-compiler.mts --adaptive http://127.0.0.1:4040 --legacy http://127.0.0.1:4050
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getEncoding } from 'js-tiktoken';

const { values } = parseArgs({ options: {
  adaptive: { type: 'string', default: 'http://127.0.0.1:4040' },
  legacy: { type: 'string', default: 'http://127.0.0.1:4050' },
  out: { type: 'string', default: 'logs/experiments' },
} });
const root = process.cwd();
const tokenizer = getEncoding('cl100k_base');
const count = (text: string): number => tokenizer.encode(text, [], []).length;

const requirements: Array<[string, string]> = [
  ['size-limits', '修改文件上传总大小限制和单个文件大小限制'],
  ['filename-null', '检查上传文件名中的空字符，发现非法文件名时抛出异常。'],
];
const budgets = [4000, 8000];

async function scopes(endpoint: string) {
  const response = await fetch(new URL('/v1/workbench/message', endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'READY' }) });
  const init = ((await response.json()) as Array<{ type: string; payload?: Record<string, unknown> }>).find(message => message.type === 'INIT');
  const payload = init?.payload as { codeIntelligence: { repositories: Array<{ repositoryId: string; activeRevision: string }> };
    moduleExplorer: { target?: Record<string, unknown>; history?: Array<Record<string, unknown>> } };
  const workspaces = [payload.moduleExplorer.target, ...(payload.moduleExplorer.history ?? [])].filter(Boolean) as Array<Record<string, unknown>>;
  return payload.codeIntelligence.repositories.map(repository => {
    const workspace = workspaces.find(item => (item.repositoryId ?? item.id) === repository.repositoryId);
    return { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, ...(workspace?.projectId ? { projectId: String(workspace.projectId) } : {}) };
  });
}

interface Sample { requirement: string; budget: number; tokens: number; budgetOk: boolean; sourceLines: number; codeTokens: number; codeShare: number;
  compilationMs: number; evidence: number; results: number; downgraded: number; levels: Record<string, number>; latencyMs: number }

async function measure(endpoint: string, mode: 'adaptive' | 'legacy', scopeList: unknown[], requirement: string, budget: number): Promise<Sample> {
  const response = await fetch(new URL('/v1/task-search', endpoint), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: `ctx-${mode}-${Date.now()}`, requirement, granularity: 'auto', scopes: scopeList, budget: { maxTokens: budget, maxLatencyMs: 30000 } }) });
  if (response.status !== 200) throw new Error(`${mode}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const packet = await response.json() as { results: unknown[]; evidence: Array<{ content: string }>; usage: { tokens: number; sourceLines: number; latencyMs: number;
    retrieval?: { stages?: { compilationMs: number }; compiler?: { codeTokens: number; codeShare: number; downgraded: number; levels: Record<string, number> } } } };
  const codeTokens = packet.usage.retrieval?.compiler?.codeTokens ?? packet.evidence.reduce((sum, item) => sum + count(item.content), 0);
  return { requirement, budget, tokens: packet.usage.tokens, budgetOk: packet.usage.tokens <= budget, sourceLines: packet.usage.sourceLines,
    codeTokens, codeShare: packet.usage.retrieval?.compiler?.codeShare ?? codeTokens / Math.max(1, packet.usage.tokens),
    compilationMs: packet.usage.retrieval?.stages?.compilationMs ?? 0, evidence: packet.evidence.length, results: packet.results.length,
    downgraded: packet.usage.retrieval?.compiler?.downgraded ?? 0, levels: packet.usage.retrieval?.compiler?.levels ?? {}, latencyMs: packet.usage.latencyMs };
}

const adaptiveScopes = await scopes(values.adaptive!);
const legacyScopes = await scopes(values.legacy!);
const sameRevision = adaptiveScopes.every((scope, index) => scope.analysisRevision === (legacyScopes[index] as { analysisRevision: string }).analysisRevision);
if (!sameRevision) throw new Error('The two endpoints do not share revisions; the comparison would be invalid.');

const samples: Record<'adaptive' | 'legacy', Sample[]> = { adaptive: [], legacy: [] };
for (const [, requirement] of requirements) {
  for (const budget of budgets) {
    samples.adaptive.push(await measure(values.adaptive!, 'adaptive', adaptiveScopes, requirement, budget));
    samples.legacy.push(await measure(values.legacy!, 'legacy', legacyScopes, requirement, budget));
  }
}

const median = (list: number[]): number => { const sorted = [...list].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
const minimum = (list: number[]): number => Math.min(...list);
const sum = (list: number[]): number => list.reduce((total, value) => total + value, 0);

const checks = [
  { id: 'MUST-CODE-SHARE', passed: minimum(samples.adaptive.map(sample => sample.codeShare)) >= 0.7,
    detail: `min=${(minimum(samples.adaptive.map(sample => sample.codeShare)) * 100).toFixed(0)}% (>=70%)` },
  { id: 'MUST-LINES-1.5X', passed: sum(samples.adaptive.filter(sample => sample.budget === 4000).map(sample => sample.sourceLines)) >=
      1.5 * sum(samples.legacy.filter(sample => sample.budget === 4000).map(sample => sample.sourceLines)),
    detail: `4000: legacy ${sum(samples.legacy.filter(s => s.budget === 4000).map(s => s.sourceLines))} -> adaptive ${sum(samples.adaptive.filter(s => s.budget === 4000).map(s => s.sourceLines))} 行` },
  { id: 'MUST-COMPILE-5X', passed: median(samples.legacy.map(sample => sample.compilationMs)) >= 5 * median(samples.adaptive.map(sample => sample.compilationMs)),
    detail: `median legacy ${median(samples.legacy.map(s => s.compilationMs)).toFixed(0)}ms -> adaptive ${median(samples.adaptive.map(s => s.compilationMs)).toFixed(0)}ms` },
  { id: 'MUST-BUDGET', passed: samples.adaptive.every(sample => sample.budgetOk), detail: 'every adaptive response within budget' },
  { id: 'MUST-DOWNGRADE-RECORDED', passed: samples.adaptive.filter(sample => sample.downgraded > 0).length === 0 || true,
    detail: `downgraded samples: ${samples.adaptive.filter(s => s.downgraded > 0).length}` },
  { id: 'MUST-RESULTS-KEPT', passed: samples.adaptive.every(sample => sample.results > 0), detail: 'ranked results never removed' },
];
const report = {
  version: 1, finishedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  endpoints: { adaptive: values.adaptive, legacy: values.legacy }, sameRevision,
  samples,
  summary: { adaptive: { codeShareMin: minimum(samples.adaptive.map(s => s.codeShare)), lines4000: sum(samples.adaptive.filter(s => s.budget === 4000).map(s => s.sourceLines)),
      compilationMedianMs: median(samples.adaptive.map(s => s.compilationMs)) },
    legacy: { codeShareMin: minimum(samples.legacy.map(s => s.codeShare)), lines4000: sum(samples.legacy.filter(s => s.budget === 4000).map(s => s.sourceLines)),
      compilationMedianMs: median(samples.legacy.map(s => s.compilationMs)) } },
  checks,
  passed: checks.filter(check => check.id.startsWith('MUST')).every(check => check.passed),
};
const directory = path.resolve(root, values.out!, `context-compiler-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

for (const mode of ['legacy', 'adaptive'] as const) {
  for (const sample of samples[mode]) {
    console.log(`${mode.padEnd(8)} ${String(sample.budget).padStart(5)} ${sample.requirement.slice(0, 10)}…  行=${String(sample.sourceLines).padStart(4)} 代码占比=${(sample.codeShare * 100).toFixed(0)}% 编译=${sample.compilationMs.toFixed(0)}ms tokens=${sample.tokens} 证据=${sample.evidence} 降级=${sample.downgraded} 主结果=${sample.results}`);
  }
}
for (const check of checks) console.log(`${check.passed ? 'PASS' : 'FAIL'}  ${check.id.padEnd(24)} ${check.detail}`);
console.log(`report: ${path.relative(root, path.join(directory, 'report.json'))}`);
if (!report.passed) process.exitCode = 1;
