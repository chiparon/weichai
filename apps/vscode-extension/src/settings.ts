import * as vscode from 'vscode';
import type { ExecutionMode } from './ui-types';
import {
  parseModuleWaveValidationCommands,
  type ModuleWaveValidationCommand,
} from './module-wave-validation';

export const DEFAULT_RETRIEVAL_API_URL = 'http://127.0.0.1:8787';
export const DEFAULT_ADAPTATION_API_URL = 'http://127.0.0.1:8788';

export interface ExtensionSettings {
  executionMode: ExecutionMode;
  repositoryPaths: string[];
  retrievalApiUrl: string;
  adaptationApiUrl: string;
  modelApiUrl: string;
  model: string;
  translationTimeoutSeconds: number;
  maxTranslationAttempts: number;
}

export function loadSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration('forexplore');
  return {
    executionMode: 'real',
    repositoryPaths: config.get<string[]>('repositoryPaths', []),
    retrievalApiUrl:
      config.get<string>('retrievalApiUrl', DEFAULT_RETRIEVAL_API_URL).trim() ||
      DEFAULT_RETRIEVAL_API_URL,
    adaptationApiUrl:
      config.get<string>('adaptationApiUrl', DEFAULT_ADAPTATION_API_URL).trim() ||
      DEFAULT_ADAPTATION_API_URL,
    modelApiUrl: normalizeHttpUrl(
      config.get<string>('modelApiUrl', 'https://api.deepseek.com/v1'),
      'forexplore.modelApiUrl',
    ),
    model: config.get<string>('model', 'deepseek-v4-flash').trim() || 'deepseek-v4-flash',
    translationTimeoutSeconds: clamp(
      config.get<number>('translationTimeoutSeconds', 120),
      30,
      300,
    ),
    maxTranslationAttempts: clamp(config.get<number>('maxTranslationAttempts', 4), 1, 4),
  };
}

function normalizeHttpUrl(value: string, setting: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${setting} 必须是有效的 HTTP(S) 地址。`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${setting} 必须使用 HTTP 或 HTTPS。`);
  }
  return trimmed;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
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
