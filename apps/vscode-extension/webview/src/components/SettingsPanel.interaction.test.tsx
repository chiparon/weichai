import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS, LLM_PRESETS } from '@forexplore/contracts';
import { isWebviewToHostMessage } from '../../../src/protocol/messages';
import { SettingsPanel } from './SettingsPanel';

let unmount: (() => void) | undefined;
afterEach(() => { if (unmount) act(unmount); document.body.innerHTML = ''; });

it('browses into an unsaved draft, preserves cancellation, and saves provider/model/token together', async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container); unmount = () => root.unmount();
  const save = vi.fn();
  const browse = vi.fn().mockResolvedValueOnce(['D:/Legacy', 'D:/Added']).mockResolvedValueOnce([]);
  await act(async () => root.render(<SettingsPanel llm={DEFAULT_LLM_SETTINGS} topK={4} repositoryPaths={['D:/Legacy']} repositoryStatuses={[]} saving={false}
    onCheckRepositories={vi.fn()} onSelectCodeIntelligenceProject={vi.fn()} onSelectCodeIntelligenceRevision={vi.fn()}
    onBrowseReferenceFolders={browse} onConfigureModelKey={vi.fn()} onSave={save} onCancel={vi.fn()} />));
  const clickBrowse = () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('浏览文件夹'))!.click();
  await act(async () => clickBrowse());
  expect([...container.querySelectorAll<HTMLInputElement>('.repository-path-fields input')].map(i => i.value)).toEqual(['D:/Legacy', 'D:/Added']);
  await act(async () => clickBrowse());
  expect(container.querySelectorAll('.repository-path-fields input')).toHaveLength(2);
  expect(save).not.toHaveBeenCalled();
  for (const [label, value] of [['AI 服务商', 'anthropic'], ['每次最大输出 Token', '4096']]) {
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
      select.value = value!; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  expect(container.querySelector<HTMLInputElement>('[aria-label="模型名称"]')!.value).toBe(LLM_PRESETS.anthropic.model);
  expect([...container.querySelectorAll('button')].find(b => b.textContent?.includes('配置 API Key'))!.disabled).toBe(true);
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith({ topK: 4, repositoryPaths: ['D:/Legacy', 'D:/Added'], llm: {
    provider: 'anthropic', model: LLM_PRESETS.anthropic.model, apiBase: LLM_PRESETS.anthropic.apiBase, maxOutputTokens: 4096,
  } });
  expect(isWebviewToHostMessage({ type: 'SAVE_SETTINGS', settings: save.mock.calls[0]![0] })).toBe(true);
  expect(isWebviewToHostMessage({ type: 'SAVE_SETTINGS', settings: { ...save.mock.calls[0]![0], llm: { ...DEFAULT_LLM_SETTINGS, apiKey: 'secret' } } })).toBe(false);
  expect(isWebviewToHostMessage({ type: 'BROWSE_REFERENCE_FOLDERS', requestId: 'picker-1', paths: ['untrusted'] })).toBe(false);
});
