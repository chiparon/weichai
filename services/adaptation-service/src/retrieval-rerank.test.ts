import { afterEach, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
import { createHttpServer } from './http-server';
import { resolveModelApiKey } from './model-credential';
import { modelSettingsScope } from './model-request';
import { parseRetrievalRerank } from './retrieval-rerank';
import { HttpWorkspaceEvidencePort } from './http-workspace-evidence-port';

const servers: ReturnType<typeof createHttpServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });
const input = { requirement: 'upload', candidates: ['a', 'b'].map(id => ({ id, name: id, granularity: 'function', relativePath: 'a.py' })) };
it('uses request-scoped panel credentials and model configuration in backend reranking', async () => {
  const rerank = vi.fn(async () => { expect(resolveModelApiKey('fallback')).toBe('test-panel-key');
    expect(modelSettingsScope.getStore()?.model).toBe('panel-model'); return ['b', 'a']; });
  const server = createHttpServer({ adapter: { adapt: vi.fn() }, retrievalRerank: rerank }); servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/v1/retrieval-rerank`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-recast-model-key': 'test-panel-key', 'x-recast-model-config': encodeURIComponent(JSON.stringify({ ...DEFAULT_LLM_SETTINGS, model: 'panel-model' })) }, body: JSON.stringify(input) });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ order: ['b', 'a'], model: 'panel-model' });
  const denied = await fetch(`${base}/v1/retrieval-rerank`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:4173' }, body: JSON.stringify(input) });
  expect(denied.status).toBe(403); expect(rerank).toHaveBeenCalledOnce();
  expect(await (await fetch(`${base}/v1/capabilities`)).json()).toMatchObject({ retrievalRerank: true, workspaceTranslation: false });
});
it('rejects duplicate identities, oversized content, and unknown fields', () => {
  expect(() => parseRetrievalRerank({ ...input, candidates: [input.candidates[0], input.candidates[0]] })).toThrow();
  expect(() => parseRetrievalRerank({ ...input, apiKey: 'never-accept-in-body' })).toThrow();
  expect(() => parseRetrievalRerank({ ...input, requirement: 'x'.repeat(8001) })).toThrow();
});
it('sends all nine evidence scopes and refuses overflow without making a request', async () => {
  const transport = vi.fn(async () => Response.json({ status: 'complete', evidence: [], gaps: [] }));
  const port = new HttpWorkspaceEvidencePort({ endpoint: 'http://127.0.0.1:8790', fetch: transport });
  const scopes = Array.from({ length: 9 }, (_, i) => ({ repositoryId: `repo-${i}`, analysisRevision: 'v1' }));
  await port.query({ requirement: 'upload', scopes, limit: 12 });
  expect(JSON.parse((transport.mock.calls[0] as any)[1].body).scopes).toHaveLength(9);
  await expect(port.query({ requirement: 'upload', limit: 12, scopes: Array.from({ length: 65 }, () => scopes[0]!) })).rejects.toThrow('64');
  expect(transport).toHaveBeenCalledOnce();
});
