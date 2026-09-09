import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS, LLM_PRESETS } from '@forexplore/contracts';
import { modelCredentialId, saveWithModelCredential } from './model-credential';
import { isWebviewToHostMessage } from './protocol/messages';

const endpoint = 'http://127.0.0.1:8791';
const llm = { ...DEFAULT_LLM_SETTINGS, provider: 'openai' as const, ...LLM_PRESETS.openai };
// Presets include a display label, so keep the public settings schema explicit.
const settings = { provider: llm.provider, apiBase: llm.apiBase, model: llm.model, maxOutputTokens: llm.maxOutputTokens };
const id = modelCredentialId(endpoint, settings);
function fixture(previous?: string) {
  const values = new Map(previous ? [[id, previous]] : []);
  const storage = {
    get: vi.fn(async (key: string) => values.get(key)),
    store: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  };
  return { values, storage };
}

describe('single-save credentials', () => {
  it('stores the selected provider key before activating settings and preserves other provider keys', async () => {
    const { storage, values } = fixture();
    const other = modelCredentialId(endpoint, DEFAULT_LLM_SETTINGS);
    values.set(other, 'existing-key');
    const activate = vi.fn(async () => { expect(values.get(id)).toBe('new-key'); return settings; });
    expect(await saveWithModelCredential(storage, endpoint, settings, ' new-key ', activate)).toEqual(settings);
    expect(values.get(other)).toBe('existing-key');
  });
  it('retains the key when no update was submitted', async () => {
    const { storage, values } = fixture('existing-key');
    await saveWithModelCredential(storage, endpoint, settings, undefined, async () => settings);
    expect(values.get(id)).toBe('existing-key');
    expect(storage.store).not.toHaveBeenCalled();
  });
  it('does not activate when secret storage fails, and hides storage error content', async () => {
    const { storage } = fixture();
    storage.store.mockRejectedValueOnce(new Error('sensitive-value'));
    const activate = vi.fn();
    await expect(saveWithModelCredential(storage, endpoint, settings, 'new-key', activate)).rejects.toThrow('密钥保存失败');
    expect(activate).not.toHaveBeenCalled();
  });
  it.each([undefined, 'old-key'])('restores previous secret %s after settings failure', async previous => {
    const { storage, values } = fixture(previous);
    await expect(saveWithModelCredential(storage, endpoint, settings, 'new-key', async () => { throw new Error('sensitive-value'); })).rejects.toThrow('已恢复原有密钥');
    expect(values.get(id)).toBe(previous);
  });
  it('stages deletion with activation and rolls it back if activation fails', async () => {
    const { storage, values } = fixture('old-key');
    await expect(saveWithModelCredential(storage, endpoint, settings, null, async () => {
      expect(values.has(id)).toBe(false); throw new Error('failed');
    })).rejects.toThrow('已恢复原有密钥');
    expect(values.get(id)).toBe('old-key');
    await saveWithModelCredential(storage, endpoint, settings, null, async () => settings);
    expect(values.has(id)).toBe(false);
  });
  it('reports a safe error if restoring the key also fails', async () => {
    const { storage } = fixture('old-key');
    await expect(saveWithModelCredential(storage, endpoint, settings, 'new-key', async () => {
      storage.store.mockRejectedValueOnce(new Error('sensitive-value')); throw new Error('failed');
    })).rejects.toThrow('密钥恢复失败');
  });
  it('accepts only valid transient credentials outside the public settings', () => {
    const message = { type: 'SAVE_SETTINGS', settings: { llm: settings, topK: 4, repositoryPaths: [] } };
    for (const modelKey of [undefined, null, 'test-key']) expect(isWebviewToHostMessage({ ...message, modelKey })).toBe(true);
    for (const modelKey of ['', ' ', 'a\nb', 'x'.repeat(513), {}, 123]) expect(isWebviewToHostMessage({ ...message, modelKey })).toBe(false);
    expect(isWebviewToHostMessage({ ...message, settings: { ...message.settings, modelKey: 'test-key' } })).toBe(false);
  });
});
