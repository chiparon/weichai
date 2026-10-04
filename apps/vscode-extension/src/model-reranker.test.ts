import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
import { ConfiguredModelReranker } from './model-reranker';
import { createModelCredentialProvider } from './model-credential';
import { setModelCredentialProvider } from './local-fetch';

afterEach(() => setModelCredentialProvider(undefined));
const candidates = [0, 1].map(id => ({ id: String(id), name: 'feature', granularity: 'function', relativePath: 'a.py', preview: 'def feature(): pass' }));
it('forwards fresh panel keys and model settings for module reranking', async () => {
  const requests: any[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers); req.resume();
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ order: requests.length === 1 ? ['1', '0'] : ['c1', 'c0'] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let key = 'test-panel-key-one'; let settings = { ...DEFAULT_LLM_SETTINGS };
  setModelCredentialProvider(createModelCredentialProvider({ get: async () => key, store: async () => {}, delete: async () => {} }, () => url, () => settings));
  try {
    const ensure = vi.fn(async () => {}); const ranker = new ConfiguredModelReranker(() => url, ensure);
    expect((await ranker.rerank('feature', candidates)).map(c => c.id)).toEqual(['1', '0']);
    key = 'test-panel-key-two'; settings = { ...settings, model: 'changed-model' };
    expect((await ranker.rank('feature', ['one', 'two'], new AbortController().signal)).map(c => c.index)).toEqual([1, 0]);
    expect(requests.map(r => r['x-recast-model-key'])).toEqual(['test-panel-key-one', 'test-panel-key-two']);
    expect(JSON.parse(decodeURIComponent(requests[1]['x-recast-model-config'])).model).toBe('changed-model');
    expect(ensure).toHaveBeenCalledTimes(2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
it('rejects fabricated or repeated candidate IDs and honors cancellation', async () => {
  const ranker = new ConfiguredModelReranker(() => 'http://127.0.0.1:8788', async () => {}, async () => Response.json({ order: ['0', '0'] }));
  await expect(ranker.rerank('feature', candidates)).rejects.toThrow('无效候选');
  const controller = new AbortController(); controller.abort();
  await expect(ranker.rerank('feature', candidates, controller.signal)).rejects.toThrow();
});
