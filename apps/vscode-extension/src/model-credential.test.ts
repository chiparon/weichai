import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelCredentialProvider, modelCredentialId, validateModelKey } from './model-credential';
import { localFetch, setModelCredentialProvider } from './local-fetch';

afterEach(() => setModelCredentialProvider(undefined));

describe('model credential boundary', () => {
  it('scopes saved credentials to the configured loopback origin and model routes', async () => {
    const storage = { get: vi.fn(async () => 'test-key'), store: vi.fn(), delete: vi.fn() };
    let endpoint = 'http://127.0.0.1:8788';
    const provider = createModelCredentialProvider(storage, () => endpoint);
    for (const route of ['/module-hierarchy/decision', '/v1/semantic-module-plan', '/v1/module-plan', '/v1/adapt']) {
      expect(await provider(new URL(endpoint + route))).toBe('test-key');
    }
    expect(storage.get).toHaveBeenCalledWith('recast.modelKey:http://127.0.0.1:8788');
    storage.get.mockClear();
    for (const url of ['http://example.com/v1/adapt', 'http://127.0.0.1:8790/v1/adapt',
      'http://127.0.0.1:8788/health', 'http://127.0.0.1:8788/v1/backfill', 'http://user:pass@127.0.0.1:8788/v1/adapt']) {
      expect(await provider(new URL(url))).toBeUndefined();
    }
    endpoint = 'http://remote.example:8788';
    expect(await provider(new URL(endpoint + '/v1/adapt'))).toBeUndefined();
    expect(storage.get).not.toHaveBeenCalled();
    expect(() => modelCredentialId(endpoint)).toThrow();
    expect(() => modelCredentialId('file:///private')).toThrow();
    expect(modelCredentialId('http://[::1]:8788')).toContain('[::1]');
    expect(validateModelKey(' key-without-spaces ')).toBeUndefined();
    expect(validateModelKey('key\r\ninjected')).toBeTruthy();
    expect(validateModelKey('')).toBeTruthy();
  });

  it('loads changed/deleted secrets per request and never follows a credential-bearing redirect', async () => {
    const received: Array<{ path: string; key: string | string[] | undefined }> = [];
    const server = createServer((request, response) => {
      received.push({ path: request.url!, key: request.headers['x-recast-model-key'] });
      if (request.url === '/v1/adapt') { response.writeHead(302, { location: '/untrusted' }); response.end(); }
      else { response.writeHead(200); response.end('ok'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let key: string | undefined = 'first-key';
    setModelCredentialProvider(createModelCredentialProvider({ get: async () => key, store: async () => {}, delete: async () => {} }, () => endpoint));
    try {
      expect((await localFetch(endpoint + '/v1/adapt')).status).toBe(302);
      key = 'changed-key';
      await localFetch(endpoint + '/module-hierarchy/decision');
      key = undefined;
      await localFetch(endpoint + '/module-hierarchy/decision');
      await localFetch(endpoint + '/health', { headers: { 'x-recast-model-key': 'untrusted' } });
      expect(received).toEqual([
        { path: '/v1/adapt', key: 'first-key' },
        { path: '/module-hierarchy/decision', key: 'changed-key' },
        { path: '/module-hierarchy/decision', key: undefined },
        { path: '/health', key: undefined },
      ]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
