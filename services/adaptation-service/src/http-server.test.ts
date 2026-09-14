import type { AddressInfo } from 'node:net';
import { ModuleHierarchyDecisionError } from '@forexplore/code-intelligence-service/module-hierarchy-planner';
import { resolveModelApiKey } from './model-credential';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
import { modelSettingsScope } from './model-request';
import type {
  AdaptationRequest,
  AdaptationResult,
  ModuleMigrationProposal,
  ModuleHierarchyPlanner,
  RepositoryArchitectureRequest,
  RepositoryStaticAnalysis,
  SearchCandidate,
} from '@forexplore/contracts';
import type {
  CodeAdaptationPort,
  RepositoryArchitecturePort,
} from '@forexplore/workflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHttpServer,
  type HttpServerOptions,
  type StaticAnalysisSnapshotStore,
} from './http-server';
import type {
  RevisionScopedArchitecturePort,
  ToolCallingArchitectPlanResult,
} from './tool-calling-architect-runtime';

const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(
  adapter: CodeAdaptationPort,
  options: {
    architecturePort?: RepositoryArchitecturePort;
    staticAnalysisSnapshots?: StaticAnalysisSnapshotStore;
    semanticArchitecturePort?: RevisionScopedArchitecturePort;
    moduleHierarchyPlanner?: ModuleHierarchyPlanner;
    moduleGeneration?: HttpServerOptions['moduleGeneration'];
  } = {},
): Promise<string> {
  const server = createHttpServer({
    adapter,
    ...options,
    corsOrigin: 'http://localhost:4173',
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const javaCandidate: SearchCandidate = {
  id: 'java-candidate',
  title: 'calculate',
  repository: 'fixture/java',
  license: 'Apache-2.0',
  language: 'Java',
  kind: 'function',
  path: 'src/Calculator.java',
  signature: 'public double calculate()',
  summary: 'Calculates a value.',
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: 'public double calculate() { return 1.0; }',
  dependencies: [],
  compatibility: [],
  risks: [],
};

const adaptationRequest: AdaptationRequest = {
  target: {
    id: 'target',
    name: 'Calculate',
    kind: 'function',
    path: 'src/Calculator.cs',
    language: 'C#',
    signature: 'public decimal Calculate()',
  },
  candidate: javaCandidate,
  requirement: 'Translate the calculation.',
  strategy: 'translate',
  decisionNotes: '',
};

const adaptationResult: AdaptationResult = {
  strategy: 'translate',
  targetLanguage: 'C#',
  generatedCode: 'public decimal Calculate() { return 1.0m; }',
  interfaceMappings: [],
  validation: [
    {
      id: 'compile',
      label: '独立编译',
      status: 'pass',
      required: true,
      command: 'dotnet build --nologo -v q',
      summary: '编译通过。编译通过不证明业务行为正确。',
    },
  ],
  files: [
    {
      path: 'src/Calculator.cs',
      status: 'modified',
      expectedOriginalSha256: 'a'.repeat(64),
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -1,1 +1,1 @@',
          lines: [
            { type: 'remove', content: 'throw new NotImplementedException();' },
            { type: 'add', content: 'return 1.0m;' },
          ],
        },
      ],
    },
  ],
};

const staticAnalysis: RepositoryStaticAnalysis = {
  schemaVersion: '1.0',
  snapshotId: 'snapshot-http-1',
  contentHash: 'a'.repeat(64),
  analyzerVersion: 'code-indexer/1.0',
  createdAt: '2026-08-26T00:00:00.000Z',
  repository: { revision: 'abc123' },
  files: [{
    path: 'src/Quote.java',
    sha256: 'b'.repeat(64),
    role: 'source',
    language: 'Java',
  }],
  symbols: [{
    id: 'quote-symbol',
    name: 'Quote',
    qualifiedName: 'example.Quote',
    kind: 'class',
    language: 'Java',
    path: 'src/Quote.java',
  }],
  dependencies: [],
  diagnostics: [],
};

const modulePlan: ModuleMigrationProposal = {
  schemaVersion: '1.0',
  snapshotId: staticAnalysis.snapshotId,
  objective: 'Plan quote migration modules.',
  modules: [{
    id: 'quote',
    name: 'Quote',
    kind: 'feature',
    description: 'Quote feature.',
    sourceFiles: ['src/Quote.java'],
    symbolIds: ['quote-symbol'],
    dependsOn: [],
    writeSet: ['src/Quote.java'],
    resourceLocks: [],
    evidenceIds: ['quote-symbol'],
  }],
  fileAssignments: [{ path: 'src/Quote.java', kind: 'module', moduleId: 'quote' }],
  dependencies: [],
  risks: [],
};

const semanticModulePlan: ToolCallingArchitectPlanResult = {
  proposal: {
    schemaVersion: '1.0',
    repositoryId: 'history-quote',
    analysisRevision: 'revision-20260904',
    analysisHash: 'c'.repeat(64),
    objective: 'Plan quote migration modules.',
    modules: [{
      id: 'quote',
      name: 'Quote',
      kind: 'feature',
      description: 'Quote feature.',
      sourceFiles: ['src/Quote.java'],
      symbolKeys: ['java:example.Quote'],
      dependsOn: [],
      writeSet: ['src/Quote.java'],
      resourceLocks: [],
      evidenceIds: ['symbol:symbol-quote'],
    }],
    dependencies: [],
  },
  evidence: {
    repositoryId: 'history-quote',
    analysisRevision: 'revision-20260904',
    analysisHash: 'c'.repeat(64),
    planHash: `sha256:${'d'.repeat(64)}`,
    evidenceIds: ['symbol:symbol-quote'],
  },
};

describe('adaptation HTTP API', () => {
  it('carries validated model settings through concurrent HTTP calls and rejects browser config overrides', async () => {
    const observed: number[] = [];
    const adapter: CodeAdaptationPort = { adapt: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      observed.push(modelSettingsScope.getStore()?.maxOutputTokens ?? 0);
      return adaptationResult;
    }) };
    const url = await listen(adapter);
    const send = (limit: number, extra: Record<string, string> = {}) => fetch(`${url}/v1/adapt`, {
      method: 'POST', body: JSON.stringify(adaptationRequest), headers: {
        'content-type': 'application/json',
        'x-recast-model-config': encodeURIComponent(JSON.stringify({ ...DEFAULT_LLM_SETTINGS, maxOutputTokens: limit })), ...extra,
      },
    });
    expect((await Promise.all([send(1024), send(4096)])).map(r => r.status)).toEqual([200, 200]);
    expect(observed.sort((a, b) => a - b)).toEqual([1024, 4096]);
    expect((await send(4096, { origin: 'http://localhost' })).status).toBe(403);
    expect((await send(0)).status).toBe(403);
    expect(adapter.adapt).toHaveBeenCalledTimes(2);
  });
  it('keeps request credentials isolated and rejects browser overrides before model execution', async () => {
    const observed: string[] = [];
    const adapter: CodeAdaptationPort = { adapt: vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      observed.push(resolveModelApiKey('backend-key'));
      return adaptationResult;
    }) };
    const url = await listen(adapter);
    const send = (headers: Record<string, string>) => fetch(`${url}/v1/adapt`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(adaptationRequest),
    });
    const responses = await Promise.all([send({ 'x-recast-model-key': 'first-key' }), send({ 'x-recast-model-key': 'second-key' }), send({})]);
    expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
    expect(observed.sort()).toEqual(['backend-key', 'first-key', 'second-key']);
    expect((await send({ 'x-recast-model-key': 'browser-key', origin: 'http://localhost:4173' })).status).toBe(403);
    expect(adapter.adapt).toHaveBeenCalledTimes(3);
  });

  it('returns typed hierarchy validation details without leaking generic provider failures', async () => {
    const snapshot = { repositoryId: 'repo', analysisRevision: 'rev', projectId: 'project', analysisHash: 'hash',
      nodeId: 'root', name: 'Root', depth: 0, metrics: { fileCount: 0, sourceBytes: 0, symbolCount: 0 },
      candidates: [], dependencies: [], excerpts: [] };
    const detail = 'group assignment: missing [g1]; duplicate []; unknown positions [0:1]. Each candidate must be assigned exactly once.';
    const decide = vi.fn().mockRejectedValueOnce(new ModuleHierarchyDecisionError(detail)).mockRejectedValueOnce(new Error('private-provider-body'));
    const url = await listen({ adapt: vi.fn() }, { moduleHierarchyPlanner: { decide } });
    const send = () => fetch(`${url}/module-hierarchy/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
    const failed = await send();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ code: 'MODULE_DECISION_INVALID', detail });
    expect(await (await send()).text()).not.toContain('private-provider-body');
  });
  it('serves health check', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', provider: 'deepseek',
      capabilities: { semanticModulePlanning: false, moduleHierarchyPlanning: false, moduleGeneration: false } });
  });

  it.each([[true, false], [false, true], [true, true]])('reports configured planning capabilities without invoking them: semantic=%s hierarchy=%s', async (semantic, hierarchy) => {
    const proposeModulePlanWithEvidence = vi.fn();
    const decide = vi.fn();
    const url = await listen({ adapt: vi.fn() }, {
      ...(semantic ? { semanticArchitecturePort: { proposeModulePlanWithEvidence } } : {}),
      ...(hierarchy ? { moduleHierarchyPlanner: { decide } } : {}),
    });
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', provider: 'deepseek',
      capabilities: { semanticModulePlanning: semantic, moduleHierarchyPlanning: hierarchy, moduleGeneration: false } });
    expect(proposeModulePlanWithEvidence).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('routes adaptation requests to the adapter', async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => adaptationResult),
    };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(adaptationRequest),
    });

    expect(response.status).toBe(200);
    expect(adapter.adapt).toHaveBeenCalledWith(
      adaptationRequest,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(adaptationResult);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4173',
    );
  });

  it('plans modules from a server-owned snapshot without accepting repository source', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const architecturePort: RepositoryArchitecturePort = {
      proposeModulePlan: vi.fn(async () => modulePlan),
    };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = {
      getSnapshot: vi.fn(async (snapshotId) => (
        snapshotId === staticAnalysis.snapshotId ? staticAnalysis : null
      )),
    };
    const url = await listen(adapter, { architecturePort, staticAnalysisSnapshots });

    const response = await fetch(`${url}/v1/module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        snapshotId: staticAnalysis.snapshotId,
        objective: modulePlan.objective,
        immutableConstraints: ['Keep the public contract stable.'],
      }),
    });

    expect(response.status).toBe(200);
    expect(staticAnalysisSnapshots.getSnapshot).toHaveBeenCalledWith(
      staticAnalysis.snapshotId,
      expect.any(AbortSignal),
    );
    expect(architecturePort.proposeModulePlan).toHaveBeenCalledWith(
      {
        schemaVersion: '1.0',
        analysis: staticAnalysis,
        objective: modulePlan.objective,
        immutableConstraints: ['Keep the public contract stable.'],
      } satisfies RepositoryArchitectureRequest,
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(modulePlan);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects module-plan bodies that try to upload analysis, source, or paths', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const architecturePort: RepositoryArchitecturePort = { proposeModulePlan: vi.fn() };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = { getSnapshot: vi.fn() };
    const url = await listen(adapter, { architecturePort, staticAnalysisSnapshots });

    for (const body of [
      { snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective, analysis: staticAnalysis },
      { snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective, source: 'class Secret {}' },
      { snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective, path: 'src/Secret.java' },
    ]) {
      const response = await fetch(`${url}/v1/module-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(staticAnalysisSnapshots.getSnapshot).not.toHaveBeenCalled();
    expect(architecturePort.proposeModulePlan).not.toHaveBeenCalled();
  });

  it('does not expose module planning when the read-only host port is absent', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: staticAnalysis.snapshotId, objective: modulePlan.objective }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Module planning is not configured.' });
  });

  it('routes revision-scoped semantic planning without accepting snapshots, hashes, or source', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const semanticArchitecturePort: RevisionScopedArchitecturePort = {
      proposeModulePlanWithEvidence: vi.fn(async () => semanticModulePlan),
    };
    const url = await listen(adapter, { semanticArchitecturePort });

    const response = await fetch(`${url}/v1/semantic-module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryId: 'history-quote',
        analysisRevision: 'revision-20260904',
        objective: semanticModulePlan.proposal.objective,
        immutableConstraints: ['Keep public contracts stable.'],
      }),
    });

    expect(response.status).toBe(200);
    expect(semanticArchitecturePort.proposeModulePlanWithEvidence).toHaveBeenCalledWith(
      {
        schemaVersion: '1.0',
        repositoryId: 'history-quote',
        analysisRevision: 'revision-20260904',
        objective: semanticModulePlan.proposal.objective,
        immutableConstraints: ['Keep public contracts stable.'],
      },
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(semanticModulePlan);

    for (const body of [
      { repositoryId: 'history-quote', analysisRevision: 'revision-20260904', objective: 'Plan', analysisHash: 'c'.repeat(64) },
      { repositoryId: 'history-quote', analysisRevision: 'revision-20260904', objective: 'Plan', snapshotId: 'legacy' },
      { repositoryId: 'history-quote', analysisRevision: 'revision-20260904', objective: 'Plan', source: 'class Secret {}' },
      { repositoryId: 'history-quote', analysisRevision: 'revision-20260904', objective: 'Plan', path: 'C:/secret' },
    ]) {
      const invalid = await fetch(`${url}/v1/semantic-module-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
    }
  });

  it('does not expose revision-scoped semantic planning without a semantic architecture port', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/semantic-module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryId: 'history-quote', analysisRevision: 'revision-20260904', objective: 'Plan' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Revision-scoped semantic module planning is not configured.' });
  });

  it('returns 404 when the requested server-owned snapshot does not exist', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const architecturePort: RepositoryArchitecturePort = { proposeModulePlan: vi.fn() };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = { getSnapshot: vi.fn(async () => null) };
    const url = await listen(adapter, { architecturePort, staticAnalysisSnapshots });

    const response = await fetch(`${url}/v1/module-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshotId: 'unknown', objective: modulePlan.objective }),
    });

    expect(response.status).toBe(404);
    expect(architecturePort.proposeModulePlan).not.toHaveBeenCalled();
  });

  it('disables bare HTTP write-back', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/backfill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      error: 'HTTP write-back is disabled. Apply an approved migration from the VS Code host.',
    });
  });

  it('rejects malformed adaptation requests', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'translate' }),
    });

    expect(response.status).toBe(400);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('requires JSON content type and valid JSON', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const noContentType = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      body: JSON.stringify(adaptationRequest),
    });
    expect(noContentType.status).toBe(415);

    const invalidJson = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toEqual({ error: 'Request body must be valid JSON.' });
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('rejects oversized request bodies', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);

    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(adapter.adapt).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown routes and handles OPTIONS', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);
    expect((await fetch(`${url}/unknown`)).status).toBe(404);
    expect((await fetch(`${url}/v1/adapt`, { method: 'OPTIONS' })).status).toBe(204);
  });

  it('returns 502 when the adapter throws', async () => {
    const adapter: CodeAdaptationPort = {
      adapt: vi.fn(async () => {
        throw new Error('DeepSeek API timeout');
      }),
    };
    const url = await listen(adapter);
    const response = await fetch(`${url}/v1/adapt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(adaptationRequest),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toBe('DeepSeek API timeout');
  });
});

describe('module generation model turns', () => {
  const token = 'module-generation-token-with-32-characters';
  const turn = { messages: [{ role: 'system', content: 'plan' }, { role: 'user', content: '{"module":"limit"}' }], tools: [{ name: 'write_file', description: 'Write a file', inputSchema: { type: 'object' } }] };
  const generation = () => ({
    bearerToken: token,
    complete: vi.fn(async () => ({ content: '', toolCalls: [{ id: 'call-1', name: 'write_file', arguments: '{"path":"src/Limit.cs"}' }] })),
  });

  it('performs an authenticated bounded model turn', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const moduleGeneration = generation();
    const url = await listen(adapter, { moduleGeneration });
    const response = await fetch(`${url}/v1/module-generation/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(turn),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ toolCalls: [{ name: 'write_file' }] });
    expect(moduleGeneration.complete).toHaveBeenCalledWith(turn, expect.any(AbortSignal));
    const health = await (await fetch(`${url}/health`)).json() as { capabilities: Record<string, boolean> };
    expect(health.capabilities.moduleGeneration).toBe(true);
  });

  it('requires the bearer token and refuses browser origins', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const moduleGeneration = generation();
    const url = await listen(adapter, { moduleGeneration });
    const anonymous = await fetch(`${url}/v1/module-generation/turn`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(turn),
    });
    expect(anonymous.status).toBe(401);
    const browser = await fetch(`${url}/v1/module-generation/turn`, {
      method: 'POST',
      // A browser sets Origin; the local IDE does not.
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: 'http://localhost:4173' },
      body: JSON.stringify(turn),
    });
    expect(browser.status).toBe(403);
    expect(moduleGeneration.complete).not.toHaveBeenCalled();
  });

  it('accepts only bounded conversation turns and never path or command authority', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const moduleGeneration = generation();
    const url = await listen(adapter, { moduleGeneration });
    const post = (body: unknown) => fetch(`${url}/v1/module-generation/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    expect((await post({ ...turn, repositoryRoot: 'C:/repository' })).status).toBe(400);
    expect((await post({ ...turn, workspaceFiles: ['src/Limit.cs'] })).status).toBe(400);
    expect((await post({ messages: turn.messages, tools: [], compileCommand: { executable: 'rm' } })).status).toBe(400);
    expect((await post({ messages: [], tools: [] })).status).toBe(400);
    expect((await post({ messages: [{ role: 'system', content: 'x', command: 'echo' }], tools: [] })).status).toBe(400);
    expect((await post({ messages: [{ role: 'root', content: 'x' }], tools: [] })).status).toBe(400);
    expect((await post({ messages: [{ role: 'system', content: 'x'.repeat(600_000) }], tools: [] })).status).toBe(400);
    expect((await post({ messages: turn.messages, tools: [{ name: 'bad name!', description: '', inputSchema: {} }] })).status).toBe(400);
    expect(moduleGeneration.complete).not.toHaveBeenCalled();
  });

  it('is unavailable unless the host configures it', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const url = await listen(adapter);
    const response = await fetch(`${url}/v1/module-generation/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(turn),
    });
    expect(response.status).toBe(404);
  });
});
