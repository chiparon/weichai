import {
  DEFAULT_LLM_SETTINGS,
  normaliseConfiguredPath,
  normaliseConfiguredPaths,
  parseLlmSettings,
  type LlmSettings,
} from '@forexplore/contracts';
import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';
import {
  parseModuleWaveValidationCommands,
  type ModuleWaveValidationCommand,
} from './module-wave-validation';

export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';

function adaptationEndpoint(config: vscode.WorkspaceConfiguration): string {
  const configured = normaliseConfiguredPath(config.get<string>('adaptationApiUrl', DEFAULT_ADAPTATION_API_URL));
  const inspected = config.inspect<string>('adaptationApiUrl');
  const explicit = inspected?.workspaceFolderValue !== undefined || inspected?.workspaceValue !== undefined ||
    inspected?.globalValue !== undefined;
  if (explicit || configured !== DEFAULT_ADAPTATION_API_URL) return configured ?? DEFAULT_ADAPTATION_API_URL;
  const value = process.env.ADAPTATION_PORT?.trim();
  if (!value) return DEFAULT_ADAPTATION_API_URL;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ADAPTATION_PORT must be a valid TCP port (1–65535).');
  return `http://127.0.0.1:${port}`;
}

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
    // A hand-written array can hold quoted or empty entries; an empty one would
    // otherwise resolve to this extension host's working directory.
    repositoryPaths: normaliseConfiguredPaths(config.get<unknown[]>('repositoryPaths', [])),
    topK: boundedTopK(config.get<number>('topK', 4)),
    adaptationApiUrl: adaptationEndpoint(config),
  };
}

export async function savePanelSettings(input: {
  repositoryPaths: string[];
  topK: number;
  llm?: LlmSettings;
}): Promise<Pick<ExtensionSettings, 'repositoryPaths' | 'topK' | 'llm'>> {
  const llm = parseLlmSettings(input.llm ?? loadSettings().llm);
  // Saved values are stored unquoted so the settings file stays the same shape a
  // hand-written one takes, and so the next read cannot see a literal path.
  const repositoryPaths = normaliseConfiguredPaths(input.repositoryPaths);
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
