import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { modelCredentialScope, requestModelCredential, resolveModelApiKey } from './model-credential';
import { completeWithDeepSeek, completeWithDeepSeekTools } from './deepseek-client';

describe('request-scoped model credentials', () => {
  it('accepts only native loopback callers and rejects browser origins, remote peers and invalid keys', () => {
    const base = { headers: { host: '127.0.0.1:8788', 'x-recast-model-key': 'test-key' }, socket: { remoteAddress: '127.0.0.1' } };
    expect(requestModelCredential(base as unknown as IncomingMessage)).toBe('test-key');
    for (const request of [
      { ...base, headers: { ...base.headers, origin: 'http://localhost:4173' } },
      { ...base, headers: { ...base.headers, host: 'external.example' } },
      { ...base, socket: { remoteAddress: '192.168.1.1' } },
      { ...base, headers: { ...base.headers, 'x-recast-model-key': 'key with space' } },
    ]) expect(() => requestModelCredential(request as unknown as IncomingMessage)).toThrow();
  });

  it('isolates concurrent chat/tool calls, falls back to backend config and sanitizes provider errors', async () => {
    const seen: string[] = [];
    const request = vi.fn(async (_url, init) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.push(new Headers(init?.headers).get('authorization')!);
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }) as unknown as typeof fetch;
    const options = { apiKey: () => 'backend-key', request };
    await Promise.all([
      modelCredentialScope.run('chat-key', () => completeWithDeepSeek([{ role: 'user', content: 'test' }], options)),
      modelCredentialScope.run('tool-key', () => completeWithDeepSeekTools([{ role: 'user', content: 'test' }], [], options)),
      completeWithDeepSeek([{ role: 'user', content: 'test' }], options),
    ]);
    expect(seen.sort()).toEqual(['Bearer backend-key', 'Bearer chat-key', 'Bearer tool-key']);
    expect(() => resolveModelApiKey(() => '')).toThrow('API Key');
    await expect(completeWithDeepSeek([], { apiKey: 'test-key', request: async () => new Response('private-key-echo', { status: 401 }) }))
      .rejects.toThrow(/^DeepSeek API error 401$/);
  });
});
