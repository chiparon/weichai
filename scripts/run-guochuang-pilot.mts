import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import type { AddressInfo } from 'node:net';
import mysql from 'mysql2/promise';
import type { ContextPacket, TaskRetrievalRequest } from '@forexplore/contracts';
import type { IndexStore } from '../services/code-intelligence-service/src/index-store.js';
import { SeekDbIndexStore } from '../services/code-intelligence-service/src/seekdb-index-store.js';
import { SemanticQueryService } from '../services/code-intelligence-service/src/semantic-query-service.js';
import { createSemanticQueryHttpServer } from '../services/code-intelligence-service/src/semantic-query-http-server.js';
import { TaskRetrievalService } from '../services/code-intelligence-service/src/task-retrieval.js';
import { evaluateRetrieval, summarizeRetrievalEvaluation, type RetrievalEvaluationTask, type RetrievalEvaluationResult } from '../services/code-intelligence-service/src/retrieval-evaluation.js';
import { contextTokenCount } from '../services/code-intelligence-service/src/context-compiler.js';
import { serialRecallStore, VectorTopKBaseline } from './task-retrieval-baselines.mjs';

const { values } = parseArgs({ options: {
  tasks: { type: 'string', default: 'experiments/guochuang-pilot/tasks.json' },
  database: { type: 'string', default: 'forexplore_task_context_dev_20260908' },
  output: { type: 'string', default: `logs/experiments/guochuang-pilot-${new Date().toISOString().replace(/[:.]/g, '-')}` },
  repeats: { type: 'string', default: '3' },
  budgets: { type: 'string', default: 'none' },
  variants: { type: 'string', default: 'full' },
} });
const repeats = Number(values.repeats);
assert(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 10);
const output = path.resolve(values.output!);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(values.tasks!, 'utf8')) as {
  labelSource: string;
  repositories: Record<string, { displayName: string; language: string }>;
  tasks: Array<{ id: string; repository: string; requirement: string; path: string; symbol: string }>;
};
assert.equal(new Set(manifest.tasks.map(task => task.id)).size, manifest.tasks.length);
const environment = parseEnv(await readFile('services/retrieval-service/.env', 'utf8'));
const database = values.database!;
assert(/^[a-zA-Z0-9_]+$/.test(database));
const pool = mysql.createPool({ host: process.env.CODE_INTELLIGENCE_SEEKDB_HOST ?? '127.0.0.1', port: 2881,
  user: environment.SEEKDB_USER ?? 'root', password: environment.SEEKDB_PASSWORD ?? '', database, connectionLimit: 8 });
const embedding = { url: 'http://127.0.0.1:4021/v1/embeddings', apiKey: '',
  model: 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78', queryPrefix: 'query: ', documentPrefix: 'passage: ' };
const store = new SeekDbIndexStore({ host: '127.0.0.1', port: 2881, user: environment.SEEKDB_USER ?? 'root',
  password: environment.SEEKDB_PASSWORD ?? '', database, vectorDimension: 384, embedding }, pool);
const queryPort = new SemanticQueryService(store);
type Variant = 'full' | 'without-dependencies' | 'serial-hybrid' | 'vector-topk';
const variants = values.variants!.split(',') as Variant[];
assert(variants.length && variants.every(value => ['full', 'without-dependencies', 'serial-hybrid', 'vector-topk'].includes(value)));
let variant: Variant = 'full';
const withoutDependencies = new Proxy(store, { get(target, property) {
  if (property === 'queryDependencies') return async () => ({ dependencies: [], truncated: false });
  const value = Reflect.get(target, property);
  return typeof value === 'function' ? value.bind(target) : value;
} }) as IndexStore;
const retrieval = { full: new TaskRetrievalService(store), 'without-dependencies': new TaskRetrievalService(withoutDependencies),
  'serial-hybrid': new TaskRetrievalService(serialRecallStore(store)), 'vector-topk': new VectorTopKBaseline(store, pool, embedding) };
const server = createSemanticQueryHttpServer({ queryPort, taskRetrieval: { search: (request, signal) => retrieval[variant].search(request, signal) } });
const budgets = values.budgets!.split(',').map(value => value === 'none' ? null : Number(value));
assert(budgets.length && budgets.every(value => value === null || Number.isSafeInteger(value) && value >= 256));
assert(!variants.includes('vector-topk') || budgets.every(value => value === null), 'Vector Top-K comparison must not impose content limits.');
type Observation = RetrievalEvaluationResult & { variant: Variant; budget: number | null; repeat: number; baseTask: string; packetStatus?: string };
const observations: Observation[] = [];
const tasks: RetrievalEvaluationTask[] = [];
const manifestScopes: Record<string, { repositoryId: string; analysisRevision: string; projectId: string }> = {};
const startedAt = new Date().toISOString();
try {
  const health = await fetch('http://127.0.0.1:4021/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { model: string }).model, embedding.model);
  const [configuration] = await pool.query('SELECT * FROM search_embedding_configuration');
  const repositories = await store.listRepositories();
  for (const [alias, input] of Object.entries(manifest.repositories)) {
    const matches = repositories.filter(repository => repository.displayName === input.displayName);
    assert.equal(matches.length, 1, `Repository identity: ${input.displayName}`);
    const repository = matches[0]!;
    assert(repository.activeRevision);
    const scope = { repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision };
    const projects = await store.listProjects(scope);
    assert.equal(projects.length, 1, `Project scope: ${input.displayName}`);
    manifestScopes[alias] = { ...scope, projectId: projects[0]!.projectId };
  }
  // Resolve labels from the fixed symbol index before issuing any task query.
  for (const input of manifest.tasks) {
    const scope = manifestScopes[input.repository]!;
    const page = await store.querySymbols(scope, { relativePaths: [input.path], kinds: ['method', 'function'], limit: 200 });
    assert(!page.truncated, `Incomplete label lookup: ${input.id}`);
    const matches = page.symbols.filter(symbol => symbol.qualifiedName === input.symbol);
    assert.equal(matches.length, 1, `Ambiguous label: ${input.id}`);
    const symbol = matches[0]!;
    const source = await store.getSourceSlice(scope, input.path, symbol.sourceRange, 32000);
    assert(source && !source.truncated, `Incomplete label source: ${input.id}`);
    const label = { repositoryId: scope.repositoryId, relativePath: input.path, symbolKey: symbol.symbolKey, relevance: 3 as const };
    tasks.push({ id: input.id, request: { requestId: `pilot-${input.id}`, requirement: input.requirement,
      granularity: 'function', scopes: [scope], budget: { maxLatencyMs: 10000 } },
      relevant: [label], requiredEvidence: [{ repositoryId: scope.repositoryId, relativePath: input.path, relevance: 3,
        startLine: symbol.sourceRange.startLine,
        endLine: symbol.sourceRange.endLine - Number(symbol.sourceRange.endColumn === 1) }] });
  }
  await writeFile(path.join(output, 'tasks.resolved.json'), JSON.stringify(tasks, null, 2) + '\n');
  const metadata = { startedAt, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(), database, embedding: { ...embedding, apiKey: undefined },
    vectorConfiguration: configuration, node: process.version, cpu: cpus()[0]?.model, memoryBytes: totalmem(),
    labelSource: manifest.labelSource, taskCount: tasks.length, independentIntents: 6, repeats, budgets, variants,
    scope: 'Function retrieval pilot over existing Java and TypeScript snapshots. Required evidence is the complete annotated implementation. Index construction and generation are excluded.',
    ablation: 'without-dependencies returns no graph neighbors; candidate recall and context compiler are unchanged.',
    strategies: {
      full: 'Parallel hybrid recall across symbol, source-fragment and summary views, followed by current dependency expansion and context construction.',
      'serial-hybrid': 'The same three hybrid views execute sequentially. The store, per-view full-text/vector fusion, candidate limits, dependencies and context compiler are identical to full.',
      'vector-topk': 'One HNSW vector query over the same indexed source fragments; return Top-10 fragments directly, without full-text fusion, declaration expansion or graph traversal.',
    },
    cache: 'Warm embedding and database caches after one excluded pass per task and variant; serial HTTP queries; rotated configuration order.',
    metric: 'Recall@10 is single-label Hit@10; taskSuccess denotes retrieval with required source coverage, not successful code generation.' };
  await writeFile(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  await writeFile(path.join(output, 'implementation.patch'), execFileSync('git', ['diff', '--',
    'packages/contracts/src/task-retrieval.ts', 'services/code-intelligence-service/src/task-retrieval.ts',
    'services/code-intelligence-service/src/context-compiler.ts'], { encoding: 'utf8' }));
  for (const file of ['scripts/run-guochuang-pilot.mts', 'scripts/task-retrieval-baselines.mts']) {
    await writeFile(path.join(output, path.basename(file)), await readFile(file));
  }
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/task-search`;
  const query = async (request: TaskRetrievalRequest) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as ContextPacket;
  };
  console.log(JSON.stringify({ stage: 'warmup', tasks: tasks.length, output }));
  for (const task of tasks) for (const mode of variants) { variant = mode; await query(task.request); }
  const configurations = budgets.flatMap(budget => variants.map(mode => ({ budget, mode })));
  for (let repeat = 0; repeat < repeats; repeat++) for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
    const base = tasks[taskIndex]!;
    for (let offset = 0; offset < configurations.length; offset++) {
      const { budget, mode } = configurations[(offset + repeat + taskIndex) % configurations.length]!;
      variant = mode;
      const task = { ...base, id: `${base.id}-${mode}-${budget}-${repeat}`, request: { ...base.request,
        requestId: `pilot-${base.id}-${mode}-${budget}-${repeat}`, budget: { ...base.request.budget, ...(budget === null ? {} : { maxTokens: budget }) } } };
      const started = performance.now();
      let observation: Observation;
      try {
        const packet = await query(task.request);
        const latencyMs = performance.now() - started;
        assert.equal(packet.usage.tokens, contextTokenCount(packet.markdown));
        if (budget !== null) assert(packet.usage.tokens <= budget, 'Context exceeds budget');
        observation = { ...evaluateRetrieval(task, packet, 10), latencyMs, variant, budget, repeat, baseTask: base.id, packetStatus: packet.status };
        await writeFile(path.join(output, `${task.id}.json`), JSON.stringify({ task, observation, packet }, null, 2) + '\n');
        if (repeat === 0) await writeFile(path.join(output, `${base.id}-${mode}-${budget ?? 'none'}.md`), packet.markdown + '\n');
      } catch (error) {
        observation = { taskId: task.id, status: 'error', error: error instanceof Error ? error.message : String(error),
          latencyMs: performance.now() - started, recallAtK: 0, reciprocalRank: 0, ndcgAtK: 0, evidenceCoverage: 0,
          taskSuccess: false, tokens: 0, duplicateSourceLineRatio: 0, sourceReadAmplification: null, variant, budget, repeat, baseTask: base.id };
      }
      observations.push(observation);
      console.log(JSON.stringify({ completed: observations.length, total: tasks.length * configurations.length * repeats,
        task: base.id, variant, budget, hit: observation.recallAtK, coverage: observation.evidenceCoverage, error: observation.error }));
      await writeFile(path.join(output, 'observations.json'), JSON.stringify(observations, null, 2) + '\n');
    }
  }
  const summaries = configurations.map(({ mode, budget }) => {
    const group = observations.filter(item => item.variant === mode && item.budget === budget);
    return { variant: mode, budget, ...summarizeRetrievalEvaluation(group),
      meanTokens: group.reduce((sum, item) => sum + item.tokens, 0) / group.length };
  });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ metadata, completedAt: new Date().toISOString(), summaries, observations }, null, 2) + '\n');
  const columns = ['variant', 'budget', 'tasks', 'failures', 'recallAtK', 'mrr', 'ndcgAtK', 'evidenceCoverage', 'taskSuccessRate', 'meanLatencyMs', 'p95LatencyMs', 'meanTokens'] as const;
  await writeFile(path.join(output, 'summary.csv'), [columns.join(','), ...summaries.map(row => columns.map(key => row[key]).join(','))].join('\n') + '\n');
  await writeFile(path.join(output, 'summary.md'), [
    '# Context construction check', '', `${tasks.length} tasks, ${repeats} repeats. Source coverage measures the annotated target implementation.`, '',
    '| Configuration | Target source coverage | Mean context tokens | Mean latency | Errors |',
    '| --- | --- | --- | --- | --- |',
    ...summaries.map(row => `| ${row.variant}, ${row.budget ?? 'no content limit'} | ${(row.evidenceCoverage * 100).toFixed(1)}% | ${Math.round(row.meanTokens)} | ${Math.round(row.meanLatencyMs)} ms | ${row.failures} / ${row.tasks} |`), '',
  ].join('\n'));
  console.log(JSON.stringify({ output, summaries }, null, 2));
  if (observations.some(item => item.status === 'error')) process.exitCode = 1;
} finally {
  if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await store.close();
}
