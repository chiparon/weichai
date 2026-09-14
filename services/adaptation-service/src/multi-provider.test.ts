import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { DEFAULT_LLM_SETTINGS, LLM_PRESETS, parseLlmSettings, type LlmProvider } from '@forexplore/contracts';
import { completeWithDeepSeek, completeWithDeepSeekTools } from './deepseek-client';
import { modelCredentialScope } from './model-credential';
import { modelSettingsScope, requestModelSettings } from './model-request';

function configured<T>(provider: LlmProvider, call: () => T) {
  const { apiBase, model } = LLM_PRESETS[provider];
  return modelSettingsScope.run({ provider, apiBase, model, maxOutputTokens: 2048 },
    () => modelCredentialScope.run(`key-${provider}`, call));
}

describe('multi-provider model routing', () => {
  it('isolates simultaneous providers, credentials and token limits', async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => {
      await new Promise(resolve => setTimeout(resolve, 2));
      return Response.json({ choices: [{ message: { content: 'done' } }] });
    });
    const providers = ['deepseek', 'openai', 'gemini', 'qwen', 'custom'] as const;
    await Promise.all(providers.map(provider => configured(provider, () => completeWithDeepSeek(
      [{ role: 'user', content: 'task' }], { apiKey: 'must-not-be-used', request },
    ))));
    providers.forEach((provider, index) => {
      const [url, init] = request.mock.calls[index]!;
      const body = JSON.parse(String(init!.body));
      expect(url).toBe(`${LLM_PRESETS[provider].apiBase}/chat/completions`);
      expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer key-${provider}`);
      expect(body.model).toBe(LLM_PRESETS[provider].model);
      expect(body[provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']).toBe(2048);
      expect('thinking' in body).toBe(provider === 'deepseek');
      expect(init!.redirect).toBe('error');
    });
  });

  it('maps Claude tools and results in both directions, including multiple tool results', async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json({
      content: [{ type: 'text', text: 'evidence' }, { type: 'tool_use', id: 'next', name: 'read_file', input: { path: 'main.ts' } }],
    }));
    const result = await configured('anthropic', () => completeWithDeepSeekTools([
      { role: 'system', content: 'Use source evidence.' },
      { role: 'user', content: 'Find callers.' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', arguments: '{"path":"a.ts"}' }, { id: 'b', name: 'read_file', arguments: '{"path":"b.ts"}' }] },
      { role: 'tool', toolCallId: 'a', content: 'file a' },
      { role: 'tool', toolCallId: 'b', content: 'file b' },
    ], [{ name: 'read_file', description: 'Read evidence', inputSchema: { type: 'object' } }], { apiKey: '', request }));
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init!.headers).get('x-api-key')).toBe('key-anthropic');
    expect(new Headers(init!.headers).has('Authorization')).toBe(false);
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ system: 'Use source evidence.', max_tokens: 2048, tools: [{ name: 'read_file', input_schema: { type: 'object' } }] });
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.ts' } });
    expect(body.messages[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'file a' }, { type: 'tool_result', tool_use_id: 'b', content: 'file b' },
    ] });
    expect(result).toEqual({ content: 'evidence', toolCalls: [{ id: 'next', name: 'read_file', arguments: '{"path":"main.ts"}' }] });
  });

  it('applies Claude JSON instructions and surfaces truncation for both API protocols', async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => Response.json({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    expect(await configured('anthropic', () => completeWithDeepSeek([{ role: 'user', content: 'Return JSON' }], { apiKey: '', request, jsonMode: true }))).toBe('{"ok":true}');
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).system).toContain('valid JSON');
    for (const provider of ['openai', 'anthropic'] as const) {
      const request = vi.fn(async () => Response.json(provider === 'openai'
        ? { choices: [{ finish_reason: 'length', message: { content: '{' } }] }
        : { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }));
      await expect(configured(provider, () => completeWithDeepSeek([{ role: 'user', content: 'task' }], { apiKey: '', request }))).rejects.toThrow('Token 上限');
    }
  });

  it('never sends a fallback DeepSeek credential to a different provider or endpoint', async () => {
    const request = vi.fn();
    for (const config of [
      { ...DEFAULT_LLM_SETTINGS, provider: 'openai' as const },
      { ...DEFAULT_LLM_SETTINGS, apiBase: 'https://another.example/v1' },
    ]) {
      await expect(modelSettingsScope.run(config, () => completeWithDeepSeek([{ role: 'user', content: 'task' }], { apiKey: 'fallback-secret', request }))).rejects.toThrow('当前 AI 服务');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('validates request settings at the local IDE boundary without accepting keys in config', () => {
    const base = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8788', 'x-recast-model-config': encodeURIComponent(JSON.stringify(DEFAULT_LLM_SETTINGS)) } };
    expect(requestModelSettings(base as unknown as IncomingMessage)).toEqual(DEFAULT_LLM_SETTINGS);
    for (const request of [
      { ...base, headers: { ...base.headers, origin: 'http://localhost' } },
      { ...base, socket: { remoteAddress: '192.0.2.1' } },
      { ...base, headers: { ...base.headers, 'x-recast-model-config': '%' } },
    ]) expect(() => requestModelSettings(request as unknown as IncomingMessage)).toThrow();
    for (const invalid of [
      { ...DEFAULT_LLM_SETTINGS, apiKey: 'secret' }, { ...DEFAULT_LLM_SETTINGS, maxOutputTokens: -1 },
      { ...DEFAULT_LLM_SETTINGS, apiBase: 'http://remote.example/v1' },
      { ...DEFAULT_LLM_SETTINGS, apiBase: 'https://example.com/v1?key=secret' },
      { ...DEFAULT_LLM_SETTINGS, provider: '__proto__' },
    ]) expect(() => parseLlmSettings(invalid)).toThrow();
  });
});
