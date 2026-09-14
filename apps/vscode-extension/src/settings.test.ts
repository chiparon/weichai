// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LLM_SETTINGS } from '@forexplore/contracts';
const config = vi.hoisted(() => ({ get: vi.fn((_key: string, fallback: unknown) => fallback), inspect: vi.fn(), update: vi.fn() }));
vi.mock('vscode', () => ({ workspace: { getConfiguration: () => config }, ConfigurationTarget: { Global: 1, Workspace: 2 } }));
import { loadSettings, savePanelSettings } from './settings';

describe('AI user settings', () => {
  it('updates existing repository workspace overrides while keeping model configuration user-scoped', async () => {
    config.inspect.mockImplementation((key: string) => key === 'repositoryPaths' ? { workspaceValue: [] } : undefined);
    await savePanelSettings({ repositoryPaths: ['D:/Picked'], topK: 4, llm: DEFAULT_LLM_SETTINGS });
    expect(config.update).toHaveBeenCalledWith('repositoryPaths', ['D:/Picked'], 2);
    expect(config.update).toHaveBeenCalledWith('llm', DEFAULT_LLM_SETTINGS, 1);
  });
  it('ignores repository-controlled API endpoints and round-trips trusted user settings', async () => {
    const llm = { ...DEFAULT_LLM_SETTINGS, maxOutputTokens: 2048 };
    config.inspect.mockReturnValue({ workspaceValue: { ...llm, apiBase: 'https://untrusted.example' } });
    expect(loadSettings().llm).toEqual(DEFAULT_LLM_SETTINGS);
    config.inspect.mockReturnValue({ globalValue: llm });
    expect(loadSettings().llm).toEqual(llm);
    expect(await savePanelSettings({ repositoryPaths: [' D:/reference ', 'D:/reference'], topK: 6, llm }))
      .toEqual({ repositoryPaths: ['D:/reference'], topK: 6, llm });
    expect(config.update).toHaveBeenCalledWith('llm', llm, 1);
    config.update.mockClear();
    await expect(savePanelSettings({ repositoryPaths: [], topK: 4, llm: { ...llm, maxOutputTokens: 0 } })).rejects.toThrow();
    expect(config.update).not.toHaveBeenCalled();
  });
});
