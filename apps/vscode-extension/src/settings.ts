import { DEFAULT_LLM_SETTINGS, parseLlmSettings, type LlmSettings } from '@forexplore/contracts';
import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';
import {
  parseModuleWaveValidationCommands,
  type ModuleWaveValidationCommand,
} from './module-wave-validation';

export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  topK: number;
  adaptationApiUrl: string;
  llm: LlmSettings;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  return {
    executionMode: 'real',
    llm: parseLlmSettings(config.inspect<LlmSettings>('llm')?.globalValue ?? DEFAULT_LLM_SETTINGS),
    repositoryPaths: config.get<string[]>('repositoryPaths', []),
    topK: boundedTopK(config.get<number>('topK', 4)),
    adaptationApiUrl:
      config.get<string>('adaptationApiUrl', DEFAULT_ADAPTATION_API_URL).trim() ||
      DEFAULT_ADAPTATION_API_URL,
  };
}

export async function savePanelSettings(input: {
  repositoryPaths: string[];
  topK: number;
  llm?: LlmSettings;
}): Promise<Pick<ExtensionSettings, 'repositoryPaths' | 'topK' | 'llm'>> {
  const llm = parseLlmSettings(input.llm ?? loadSettings().llm);
  const repositoryPaths = [...new Set(input.repositoryPaths.map((value) => value.trim()).filter(Boolean))];
  const topK = boundedTopK(input.topK);
  const config = vscode.workspace.getConfiguration('forexplore');
  // Update an existing workspace override so the newly saved value actually takes effect.
  const target = (key: string) => config.inspect(key)?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update('repositoryPaths', repositoryPaths, target('repositoryPaths'));
  await config.update('topK', topK, target('topK'));
  await config.update('llm', llm, vscode.ConfigurationTarget.Global);
  return { repositoryPaths, topK, llm };
}

function boundedTopK(value: number): number {
  if (!Number.isInteger(value)) return 4;
  return Math.min(10, Math.max(1, value));
}

/**
 * Read validation commands only from user settings. Workspace settings are
 * repository-controlled and must never become executable host configuration.
 */
export function loadModuleWaveValidationCommands(): ModuleWaveValidationCommand[] {
  const config = vscode.workspace.getConfiguration('forexplore');
  const setting = config.inspect<unknown>('moduleWaveValidationCommands');
  if (
    setting?.workspaceValue !== undefined ||
    setting?.workspaceFolderValue !== undefined ||
    setting?.workspaceLanguageValue !== undefined ||
    setting?.workspaceFolderLanguageValue !== undefined
  ) {
    throw new Error('forexplore.moduleWaveValidationCommands 只能在用户设置中配置，不能由工作区设置提供。');
  }
  return parseModuleWaveValidationCommands(setting?.globalValue ?? []);
}
