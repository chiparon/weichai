import { normaliseConfiguredPath } from '@forexplore/contracts';
import type { MessageBus } from './vscode-api';

export function browseReferenceFolders(bus: MessageBus): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const unsubscribe = bus.subscribe(message => {
      if (message.type !== 'REFERENCE_FOLDERS_SELECTED' || message.requestId !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      if (message.error) reject(new Error(message.error));
      else resolve(message.paths);
    });
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('目录选择超时，请重试。')); }, 300_000);
    bus.post({ type: 'BROWSE_REFERENCE_FOLDERS', requestId });
  });
}

export function mergeReferencePaths(current: string[], selected: string[]): string[] {
  const result: string[] = [];
  const keys = new Set<string>();
  for (const value of [...current, ...selected]) {
    // Windows' "Copy as path" pastes a quoted value, and an emptied input row
    // arrives as an empty string: neither is a directory the user chose.
    const path = normaliseConfiguredPath(value);
    if (path === undefined) continue;
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const key = /^(?:[A-Za-z]:|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
    if (!keys.has(key)) { keys.add(key); result.push(path); }
  }
  return result;
}
