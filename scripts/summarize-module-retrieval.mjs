/** Render a saved benchmark report; this makes no database or model requests. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const input = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node scripts/summarize-module-retrieval.mjs <report.json>');
const report = JSON.parse(await readFile(input, 'utf8'));
const serial = report.reports.filter(r => r.mode === 'serial');
const mean = values => values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;
const seconds = value => value == null ? '—' : (value / 1000).toFixed(2);
const stages = ['queueMs', 'recallAndAggregateMs', 'candidatePrepareMs', 'rerankMs', 'revisionCheckMs', 'executionMs', 'totalMs'];
const summary = [];
for (const language of ['C#', 'Java']) for (const variant of report.variants) {
  const rows = serial.filter(r => r.language === language && r.variant === variant);
  const success = rows.filter(r => r.status === 'success');
  summary.push({ language, variant, attempted: rows.length, successful: success.length,
    successWithin60Seconds: success.filter(r => r.timing.totalMs <= 60000).length,
    meanElapsedMsAllAttempts: mean(rows.map(r => r.timing.totalMs)),
    meanSuccessTotalMs: mean(success.map(r => r.timing.totalMs)),
    p95SuccessTotalMs: p95(success.map(r => r.timing.totalMs)),
    meanStagesAllAttempts: Object.fromEntries(stages.map(stage => [stage, mean(rows.map(r => r.timing[stage]))])) });
}
const modules = [];
for (const task of report.tasks) {
  const rows = serial.filter(r => r.moduleId === task.moduleId);
  const byVariant = Object.fromEntries(report.variants.map(variant => {
    const selected = rows.filter(r => r.variant === variant);
    return [variant, { attempted: selected.length, successful: selected.filter(r => r.status === 'success').length,
      meanElapsedMsAllAttempts: mean(selected.map(r => r.timing.totalMs)),
      meanStages: Object.fromEntries(stages.map(stage => [stage, mean(selected.map(r => r.timing[stage]))])),
      candidates: selected.map(r => ({ run: r.run, status: r.status, repository: r.candidate?.repository, module: r.candidate?.module })) }];
  }));
  modules.push({ language: task.language, moduleId: task.moduleId, module: task.module, byVariant });
}
const pairs = serial.filter(r => r.variant === 'original').map(before => {
  const after = serial.find(r => r.variant === 'optimized' && r.moduleId === before.moduleId && r.run === before.run);
  if (!after) return null;
  const comparable = before.status === 'success' && after.status === 'success';
  const identity = r => JSON.stringify([r.candidate?.sourceModule?.repositoryId, r.candidate?.sourceModule?.moduleId]);
  return { module: before.module, language: before.language, run: before.run, comparable,
    sameTop1: comparable ? identity(before) === identity(after) : null,
    beforeMs: before.timing.totalMs, afterMs: after.timing.totalMs };
}).filter(Boolean);
const failures = report.reports.filter(r => r.status !== 'success').map(r => ({ mode: r.mode, variant: r.variant,
  language: r.language, module: r.module, run: r.run, error: r.error ?? r.status,
  failedStage: r.timing.failedStage, totalMs: r.timing.totalMs }));
const pairedComparison = ['C#', 'Java'].map(language => {
  const selected = pairs.filter(p => p.language === language && p.comparable);
  const beforeMs = mean(selected.map(p => p.beforeMs));
  const afterMs = mean(selected.map(p => p.afterMs));
  const afterRows = selected.map(p => serial.find(r => r.variant === 'optimized' && r.module === p.module && r.run === p.run));
  return { language, pairs: selected.length, beforeMs, afterMs,
    reduction: beforeMs ? 1 - afterMs / beforeMs : null,
    meanAfterStages: Object.fromEntries(stages.map(stage => [stage, mean(afterRows.map(r => r.timing[stage]))])) };
});
const tokens = report.modelCalls.reduce((sum, call) => {
  for (const [key, field] of [['input', 'prompt_tokens'], ['output', 'completion_tokens'], ['cacheHit', 'prompt_cache_hit_tokens']])
    sum[key] += call.usage?.[field] ?? 0;
  return sum;
}, { input: 0, output: 0, cacheHit: 0 });
const lines = [
  '# RECAST 模块检索：含真实模型重排的前后对比', '',
  `开始：${report.startedAt}；最后更新：${report.updatedAt}。`, '',
  `数据库：${report.database}；历史仓库 ${report.histories.length} 个；连接池 ${report.poolSize}。`,
  `模型请求：${report.model}；官方 API：${report.apiHost}；实际响应模型：${[...new Set(report.modelCalls.map(c => c.responseModel).filter(Boolean))].join(', ')}。`,
  `嵌入：${report.embeddingHealth.model}，${report.embeddingHealth.device}/${report.embeddingHealth.dtype}。`,
  `Top-1 输出；重排前最多 8 个候选；每模块每版本 ${report.rounds} 次。`, '',
  'original 是测试进程内恢复原始全文查询词和无全局排队限制；optimized 使用当前优化。其余代码、输入、索引、模型和预算相同；不是直接运行远端 main。',
  '顺序交替，保留所有失败；无索引重建、翻译或目标工程修改。两版本共享查询向量缓存，未清空数据库缓存。',
  '召回包含三视图全文/向量并行查询、文档回读和模块聚合。SQL 累计耗时不能与各阶段墙钟时间相加。',
  '并发优化后的排队时间在执行的 60 秒预算之外；totalMs 包含排队。重排保持产品默认 25 秒超时。', '',
  '## 串行总体结果', '',
  '| 语言 | 版本 | 成功/次数 | 全部尝试平均耗时(s) | 成功平均(s) | 成功 p95(s) | 平均召回(s) | 平均重排(s) |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
  ...summary.map(r => `| ${r.language} | ${r.variant} | ${r.successful}/${r.attempted} | ${seconds(r.meanElapsedMsAllAttempts)} | ${seconds(r.meanSuccessTotalMs)} | ${seconds(r.p95SuccessTotalMs)} | ${seconds(r.meanStagesAllAttempts.recallAndAggregateMs)} | ${seconds(r.meanStagesAllAttempts.rerankMs)} |`), '',
  'p95 使用最近秩法；样本较少时接近最大值。失败耗时不代表成功检索延迟。', '',
  '## 同一成功请求配对', '',
  '仅比较两版本均成功的同一模块、同一轮次，避免两版本成功样本不同造成平均值偏差。', '',
  '| 语言 | 成功配对数 | 优化前平均(s) | 优化后平均(s) | 降幅 | 优化后召回(s) | 优化后重排(s) |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...pairedComparison.map(r => `| ${r.language} | ${r.pairs} | ${seconds(r.beforeMs)} | ${seconds(r.afterMs)} | ${r.reduction == null ? '—' : (r.reduction * 100).toFixed(1) + '%'} | ${seconds(r.meanAfterStages.recallAndAggregateMs)} | ${seconds(r.meanAfterStages.rerankMs)} |`), '',
  '## 各模块串行结果', '',
  '| 语言 | 模块 | 优化前成功/次数 | 优化前平均(s) | 优化后成功/次数 | 优化后平均(s) | 优化后召回(s) | 优化后准备(s) | 优化后 rerankMs(s) |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ...modules.map(r => {
    const before = r.byVariant.original; const after = r.byVariant.optimized;
    return `| ${r.language} | ${r.module} | ${before ? `${before.successful}/${before.attempted}` : '—'} | ${seconds(before?.meanElapsedMsAllAttempts)} | ${after ? `${after.successful}/${after.attempted}` : '—'} | ${seconds(after?.meanElapsedMsAllAttempts)} | ${seconds(after?.meanStages.recallAndAggregateMs)} | ${seconds(after?.meanStages.candidatePrepareMs)} | ${seconds(after?.meanStages.rerankMs)} |`;
  }), '',
  '表中模块均值包含失败，成功数单列，避免隐藏不稳定性。完整 queueMs、revisionCheckMs 及单次记录见 report.json/report.csv。', '',
  '## 并发 4', '',
  '| 版本 | 最终成功/次数 | 60 秒内成功/次数 | 整批耗时(s) |',
  '|---|---:|---:|---:|',
  ...(report.batches ?? []).map(b => `| ${b.variant} | ${b.eventualSuccess}/${b.requests} | ${b.successWithin60Seconds}/${b.requests} | ${seconds(b.wallMs)} |`), '',
  ...report.reports.filter(r => r.mode !== 'serial').map(r => `- ${r.variant} / ${r.module}：${r.status}；排队 ${seconds(r.timing.queueMs)}s，执行 ${seconds(r.timing.executionMs)}s，总计 ${seconds(r.timing.totalMs)}s。`), '',
  '## 候选与失败', '',
  `成功配对 ${pairs.filter(p => p.comparable).length} 对，其中 Top-1 相同 ${pairs.filter(p => p.sameTop1).length} 对。候选变化本身不能证明召回质量变好或变差。`, '',
  ...failures.map(r => `- ${r.mode} / ${r.variant} / ${r.language} / ${r.module} / 第 ${r.run} 次：${r.error}；失败阶段 ${r.failedStage ?? 'empty'}；耗时 ${seconds(r.totalMs)}s。`), '',
  `模型调用 ${report.modelCalls.length} 次；输入 token ${tokens.input}，输出 token ${tokens.output}，cache hit token ${tokens.cacheHit}（包含在输入内，不能重复相加）。`, '',
];
await writeFile(resolve(dirname(input), 'summary.json'), JSON.stringify({ summary, modules, pairs, pairedComparison, failures, tokens, batches: report.batches }, null, 2));
await writeFile(resolve(dirname(input), 'report.md'), lines.join('\n'));
console.log(JSON.stringify({ output: dirname(input), summary, batches: report.batches, failures: failures.length }, null, 2));
