/** Real RECAST indexing/context code with its explicit lexical in-memory store.
 * This is an integration control, not a SeekDB/model-embedding benchmark.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createCodeIntelligenceRuntime, InMemoryIndexStore } from '../services/code-intelligence-service/src/index.js';
import { TaskRetrievalService } from '../services/code-intelligence-service/src/task-retrieval.js';
import type { ContextPacket, TaskRetrievalScope } from '@forexplore/contracts';

const { values } = parseArgs({ options: {
  dataset: { type: 'string', default: 'results/enterprise-history' },
  output: { type: 'string' }, k: { type: 'string', default: '10' },
  'max-lines': { type: 'string', default: '240' },
  url: { type: 'string' },
} });
const root = path.resolve(values.dataset!);
const k = Number(values.k), maxLines = Number(values['max-lines']);
assert(Number.isInteger(k) && k >= 1 && k <= 100 && Number.isInteger(maxLines) && maxLines >= 1);
interface Document { id: string; repository: string; path: string; sha256: string; lines: number }
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
  datasetHash: string; sourceRevision: string; repositories: string[]; documents: Document[];
};
// Keep evaluator labels out of the requests; the service receives only natural
// language, all eight revision scopes, granularity and the common budget.
const tasks = JSON.parse(await readFile(path.join(root, 'evaluation/tasks.json'), 'utf8')) as Array<{ id: string; requirement: string }>;
const store = new InMemoryIndexStore();
const runtime = values.url ? null : await createCodeIntelligenceRuntime({ store, queryExpansion: null });
const service = new TaskRetrievalService(store, { expansion: null, rerank: null });
const scopes: TaskRetrievalScope[] = [];
const observations: Array<Record<string, unknown>> = [];
const indexing: Array<Record<string, unknown>> = [];
const output = path.resolve(values.output ?? path.join(root, values.url ? 'evaluation/recast-live.json' : 'evaluation/recast-memory.json'));
const repositoryNames = new Map<string, string>();
async function query(route: string, body: unknown): Promise<any> {
  const base = new URL(values.url!);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Live evaluation requires a local query endpoint');
  const response = await fetch(new URL(route, base), { method: 'POST', headers: { 'content-type': 'application/json',
    ...(process.env.SEMANTIC_QUERY_PORT_TOKEN ? { authorization: `Bearer ${process.env.SEMANTIC_QUERY_PORT_TOKEN}` } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(65000) });
  assert(response.ok, `Query HTTP ${response.status}`);
  return response.json();
}
const packetsDirectory = output.replace(/\.json$/, '') + '-packets';
await mkdir(packetsDirectory, { recursive: true });
try {
  if (values.url) {
    const registered = await query('/v1/semantic-query/listRepositories', {});
    for (const name of manifest.repositories) {
      const matches = registered.repositories.filter((r: any) => r.displayName === name && r.role === 'history');
      assert.equal(matches.length, 1, `Unique live repository required: ${name}`);
      const repository = matches[0];
      assert.equal(repository.analysisStatus, 'ready', `Ready live index required: ${name}`);
      assert(repository.activeRevision);
      scopes.push({ repositoryId: repository.repositoryId, analysisRevision: repository.activeRevision, role: 'reference' });
      repositoryNames.set(repository.repositoryId, name);
    }
    for (const doc of manifest.documents) {
      const bytes = await readFile(path.join(root, 'repositories', doc.repository, doc.path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), doc.sha256, `Frozen source: ${doc.id}`);
    }
  } else {
  for (const name of manifest.repositories) {
    const started = performance.now();
    await runtime!.registry.register({ repositoryId: name, displayName: name, role: 'history', localPath: path.join(root, 'repositories', name) });
    const run = await runtime!.coordinator.run({ repositoryId: name });
    assert.equal(run.status, 'ready', `${name}: index must be ready`);
    const index = await store.getStructuralIndex(run.scope);
    assert(index);
    for (const doc of manifest.documents.filter(d => d.repository === name)) {
      const file = index.files.find(f => f.relativePath === doc.path);
      assert(file && file.sha256 === doc.sha256, `${doc.id}: frozen source must be indexed exactly`);
      assert(index.symbols.some(s => s.relativePath === doc.path), `${doc.id}: parser must extract symbols`);
    }
    scopes.push({ ...run.scope, role: 'reference' });
    repositoryNames.set(name, name);
    indexing.push({ repository: name, latencyMs: performance.now() - started, files: index.files.length,
      symbols: index.symbols.length, dependencies: index.dependencyEdges.length,
      unresolvedDependencies: index.dependencyEdges.filter(e => e.resolution !== 'resolved').length });
  }
  }
  await writeFile(path.join(path.dirname(output), values.url ? 'bindings.live.json' : 'bindings.memory.json'), JSON.stringify(Object.fromEntries(scopes.map(s => [repositoryNames.get(s.repositoryId), { repositoryId: s.repositoryId, analysisRevision: s.analysisRevision }])), null, 2));
  for (const task of tasks) {
    const started = performance.now();
    try {
      const request = { requestId: task.id, requirement: task.requirement,
        granularity: 'function' as const, scopes, budget: { maxFiles: k, maxSourceLines: maxLines, maxLatencyMs: 60000 } };
      const packet: ContextPacket = values.url ? await query('/v1/task-search', request) : await service.search(request);
      assert.equal(packet.requestId, task.id);
      assert.equal(packet.requirement, task.requirement);
      assert(packet.snapshots.every(s => scopes.some(scope => scope.repositoryId === s.repositoryId && scope.analysisRevision === s.analysisRevision)));
      const identity = (item: { repositoryId: string; relativePath?: string }) => manifest.documents.find(d => d.repository === repositoryNames.get(item.repositoryId) && d.path === item.relativePath);
      const ranked = [...new Set(packet.results.map(r => identity(r)?.id).filter((id): id is string => Boolean(id)))];
      const lines = new Map<string, Set<number>>();
      for (const item of packet.evidence) {
        const doc = identity(item);
        if (!doc) continue;
        assert.equal(item.fileHash, doc.sha256, 'Evidence must match the frozen corpus');
        assert.equal(item.contentHash, createHash('sha256').update(item.content).digest('hex'));
        // Skeleton renderings omit bodies and cannot cover a complete file.
        if (item.truncated || item.renderLevel && !['full', 'region'].includes(item.renderLevel)) continue;
        const source = await readFile(path.join(root, 'repositories', doc.repository, doc.path), 'utf8');
        const expected = source.split('\n').slice(item.sourceRange.startLine - 1, item.sourceRange.endLine).join('\n');
        if (expected.trimEnd() !== item.content.trimEnd()) continue;
        const covered = lines.get(doc.id) ?? new Set<number>();
        for (let n = item.sourceRange.startLine; n <= item.sourceRange.endLine; n++) covered.add(n);
        lines.set(doc.id, covered);
      }
      const covered = manifest.documents.filter(d => Array.from({ length: d.lines }, (_, n) => n + 1).every(n => lines.get(d.id)?.has(n))).map(d => d.id);
      observations.push({ taskId: task.id, status: 'ok', packetStatus: packet.status, ranked, covered,
        sourceLines: packet.usage.sourceLines, tokens: packet.usage.tokens, latencyMs: performance.now() - started,
        gapCodes: packet.gaps.map(gap => gap.code), expansion: packet.usage.retrieval?.expansion });
      await writeFile(path.join(packetsDirectory, `${task.id}.json`), JSON.stringify(packet, null, 2));
    } catch (error) {
      observations.push({ taskId: task.id, status: 'error', error: error instanceof Error ? error.message : String(error),
        ranked: [], covered: [], sourceLines: 0, latencyMs: performance.now() - started });
    }
  }
  const report = { datasetHash: manifest.datasetHash, sourceRevision: manifest.sourceRevision,
    variant: values.url ? 'recast-live-configured' : 'recast-memory-lexical',
    embedding: values.url ? 'not exposed by live endpoint' : 'none', queryExpansion: values.url ? 'see packet observations' : false,
    reranking: values.url ? 'not exposed; inspect packet gaps for fallback' : false, endpoint: values.url, k, maxLines, indexing, observations };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, indexing, tasks: observations.length, failures: observations.filter(r => r.status === 'error').length }, null, 2));
  if (observations.some(r => r.status === 'error')) process.exitCode = 1;
} finally { await runtime?.close(); }
