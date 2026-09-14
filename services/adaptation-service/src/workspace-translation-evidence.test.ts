import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTranslationRequest } from '@forexplore/contracts';
import { WorkspaceTranslationRuntime } from './workspace-translation-runtime.js';
import type { WorkspaceTranslationModelClient } from './workspace-translation-agent.js';
import type { DeepSeekToolCompletion, DeepSeekToolDefinition, DeepSeekToolMessage } from './deepseek-client.js';
import type { WorkspaceEvidencePort, WorkspaceEvidenceQueryRequest } from './workspace-evidence-port.js';

const roots: string[] = [], runtimes: WorkspaceTranslationRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const call = (name: string, args: Record<string, unknown> = {}): DeepSeekToolCompletion =>
  ({ content: '', toolCalls: [{ id: `tool-${name}`, name, arguments: JSON.stringify(args) }] });

const good = 'export function limit(value) { if (value < 0) throw new Error("negative"); return value + 1; }\n';
const plan = { summary: 'Adapt from history', mappings: [{ source: 'limit', targetPath: 'target.mjs', targetSymbol: 'limit' }],
  dependencies: [], steps: [{ id: 'implement', description: 'Implement limit', files: ['target.mjs'], dependsOn: [] }] };

const evidenceScopes = [{ repositoryId: 'repo-history', analysisRevision: 'analysis-1', projectId: 'project-1' }];

function request(overrides: Partial<WorkspaceTranslationRequest> = {}): WorkspaceTranslationRequest {
  return {
    spec: 'Implement limit from the historical implementation.', sourceLanguage: 'Java', targetLanguage: 'JavaScript',
    context: [{ id: 'module-target', kind: 'summary', content: '目标模块：limit' }],
    workspaceFiles: ['target.mjs', 'verify.mjs'], writeFiles: ['target.mjs'],
    evidenceScopes,
    ...overrides,
  };
}

interface ModelCall { messages: readonly DeepSeekToolMessage[]; tools: readonly DeepSeekToolDefinition[] }

function scripted(steps: DeepSeekToolCompletion[], calls: ModelCall[]): WorkspaceTranslationModelClient {
  let turn = 0;
  return { complete: async (messages, tools) => {
    calls.push({ messages: [...messages], tools: [...tools] });
    const next = steps[turn++];
    if (!next) throw new Error('Unexpected model turn');
    return next;
  } };
}

async function setup(client: WorkspaceTranslationModelClient, evidence?: { port: WorkspaceEvidencePort; maxQueries?: number; maxTotalChars?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-evidence-'));
  roots.push(root);
  await writeFile(join(root, 'target.mjs'), '// original\n');
  await writeFile(join(root, 'verify.mjs'), 'import assert from "node:assert/strict"; import { limit } from "./target.mjs"; assert.equal(limit(0), 1); assert.throws(() => limit(-1));\n');
  const runtime = new WorkspaceTranslationRuntime({
    workspaceRoot: root, compileCommand: { executable: process.execPath, args: ['--check', 'target.mjs'] }, client, maxModelTurns: 30,
    verification: { command: { executable: process.execPath, args: ['verify.mjs'] }, protectedFiles: ['verify.mjs'] },
    ...(evidence ? { evidence } : {}),
  });
  runtimes.push(runtime);
  return { root, runtime };
}

async function finished(runtime: WorkspaceTranslationRuntime, id: string) {
  for (let index = 0; index < 200; index++) {
    const value = runtime.get(id);
    if (['completed', 'failed', 'cancelled'].includes(value.status)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Translation did not finish');
}

const query = (requirement: string) => call('query_evidence', { requirement });
const happyTail = [call('submit_plan', plan), call('read_file', { path: 'target.mjs' }),
  call('write_file', { path: 'target.mjs', expectedHash: hash('// original\n'), content: good }),
  call('complete_step', { stepId: 'implement' }), call('compile'), call('run_tests'), call('finish')];

const excerpt = 'public int ReadBodyData(Stream output) { ... }';

function port(result = { evidence: [{ id: 'evidence-1', repositoryId: 'repo-history', analysisRevision: 'analysis-1', relativePath: 'MultipartStream.cs', content: excerpt, truncated: false }], characters: excerpt.length }): { port: WorkspaceEvidencePort; query: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async (_request: WorkspaceEvidenceQueryRequest) => result);
  return { port: { query: spy as unknown as WorkspaceEvidencePort['query'] }, query: spy as unknown as ReturnType<typeof vi.fn> };
}

describe('on-demand translation evidence', () => {
  it('offers query_evidence only when history revisions are in scope', async () => {
    const calls: ModelCall[] = [];
    const { runtime } = await setup(scripted([call('submit_plan', plan), call('read_file', { path: 'target.mjs' }),
      call('write_file', { path: 'target.mjs', expectedHash: hash('// original\n'), content: good }),
      call('complete_step', { stepId: 'implement' }), call('compile'), call('run_tests'), call('finish')], calls));
    const run = runtime.start(request({ evidenceScopes: [] }));
    await finished(runtime, run.id);
    expect(calls.every((entry) => !entry.tools.some((tool) => tool.name === 'query_evidence'))).toBe(true);
  });

  it('does not offer query_evidence when no read-only index port is configured', async () => {
    const calls: ModelCall[] = [];
    const { runtime } = await setup(scripted(happyTail, calls));
    const run = runtime.start(request());
    await finished(runtime, id(run));
    expect(calls.every((entry) => !entry.tools.some((tool) => tool.name === 'query_evidence'))).toBe(true);
  });

  it('queries the host index with the scoped revisions and feeds the excerpt back to the agent', async () => {
    const calls: ModelCall[] = [];
    const evidence = port();
    const { runtime } = await setup(scripted([query('MultipartStream readBodyData boundary handling'), ...happyTail], calls), { port: evidence.port });
    const run = runtime.start(request());
    const result = await finished(runtime, run.id);

    expect(result).toMatchObject({ status: 'completed', acceptance: 'behavior-verified' });
    expect(evidence.query).toHaveBeenCalledTimes(1);
    const sent = evidence.query.mock.calls[0]![0] as WorkspaceEvidenceQueryRequest;
    expect(sent.requirement).toContain('readBodyData');
    expect(sent.scopes).toEqual(evidenceScopes);
    expect(sent.limit).toBeGreaterThan(0);

    // The agent offered the tool, and the excerpt reached the next model turn.
    expect(calls[0]!.tools.some((tool) => tool.name === 'query_evidence')).toBe(true);
    expect(JSON.stringify(calls[1]!.messages)).toContain('ReadBodyData');
    expect(result.evidenceQueries).toEqual([expect.objectContaining({
      requirement: 'MultipartStream readBodyData boundary handling',
      repositoryIds: ['repo-history'], excerptCount: 1, characters: excerpt.length,
    })]);
  });

  it('refuses to exceed the per-run evidence budget instead of growing the prompt without bound', async () => {
    const calls: ModelCall[] = [];
    const evidence = port();
    const { runtime } = await setup(scripted([
      query('first lookup'), query('second lookup'), query('third lookup'),
      ...happyTail,
    ], calls), { port: evidence.port, maxQueries: 1 });
    const run = runtime.start(request());
    const result = await finished(runtime, run.id);

    expect(result.status).toBe('completed');
    expect(evidence.query).toHaveBeenCalledTimes(1);
    expect(result.evidenceQueries).toHaveLength(1);
    const refusal = JSON.stringify(calls.slice(1, 3).map((entry) => entry.messages));
    expect(refusal).toContain('Evidence budget exhausted');
  });

  it('never re-delivers the same excerpt and records a failed query', async () => {
    const calls: ModelCall[] = [];
    const evidence = port();
    const { runtime } = await setup(scripted([query('lookup one'), query('lookup one again'), ...happyTail], calls), { port: evidence.port });
    const run = runtime.start(request());
    const result = await finished(runtime, run.id);
    expect(result.status).toBe('completed');
    const delivered = result.evidenceQueries ?? [];
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toMatchObject({ excerptCount: 0, characters: 0 });

    const failing: WorkspaceEvidencePort = { query: vi.fn(async () => { throw new Error('index unavailable'); }) };
    const failingCalls: ModelCall[] = [];
    const failingSetup = await setup(scripted([query('will fail'), ...happyTail], failingCalls), { port: failing });
    const failingRun = failingSetup.runtime.start(request());
    const failingResult = await finished(failingSetup.runtime, failingRun.id);
    expect(failingResult.status).toBe('completed');
    expect(failingResult.evidenceQueries?.[0]).toMatchObject({ error: 'index unavailable', excerptCount: 0 });
    expect(JSON.stringify(failingCalls[1]!.messages)).toContain('index unavailable');
  });
});

function id(run: { id: string }): string {
  return run.id;
}
