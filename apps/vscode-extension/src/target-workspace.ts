import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { TargetWorkspaceAddMode, TargetWorkspacePhase } from './protocol/messages';

/** Phases this module can observe while applying an explicit directory choice. */
export type TargetWorkspaceProgressPhase = Extract<TargetWorkspacePhase, 'resolving' | 'attaching'>;

export interface TargetWorkspaceProgress {
  phase: TargetWorkspaceProgressPhase;
  message: string;
}

/**
 * A cancelled picker and an applied choice are different outcomes: only the
 * caller can tell the user which one happened, so both are reported here
 * instead of collapsing into `undefined`.
 */
export type TargetWorkspaceAddResult =
  | { status: 'cancelled' }
  /** The directory was already an open workspace folder and is now remembered. */
  | { status: 'remembered'; directory: string }
  /** VS Code was asked to add the folder; it may restart this extension host. */
  | { status: 'attached'; directory: string };

/** Recorded before a workspace mutation that can restart this extension host. */
export interface PendingTargetImport {
  requestedAt: string;
  mode: TargetWorkspaceAddMode;
}

export const pendingTargetImportKey = 'forexplore.pendingTargetImport';
const pendingTargetImportMaxAgeMs = 30 * 60_000;

/**
 * Adding a workspace folder can terminate this extension host, which kills the
 * import half-way and leaves the panel with a progress state nobody will ever
 * finish. The intent is persisted before the mutation, and this decides whether
 * a later activation should resume it. A stale marker is ignored so an
 * abandoned import never re-runs hours later.
 */
export function readPendingTargetImport(
  value: unknown,
  now: number = Date.now(),
  maxAgeMs: number = pendingTargetImportMaxAgeMs,
): PendingTargetImport | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.requestedAt !== 'string' || typeof record.mode !== 'string') return undefined;
  if (!['browse', 'input', 'workspace'].includes(record.mode)) return undefined;
  const requestedAt = Date.parse(record.requestedAt);
  if (!Number.isFinite(requestedAt) || requestedAt > now || now - requestedAt > maxAgeMs) return undefined;
  return { requestedAt: record.requestedAt, mode: record.mode as TargetWorkspaceAddMode };
}

/**
 * Every path form that may legitimately denote the same directory. A remembered
 * selection is persisted as a real path while `WorkspaceFolder.uri.fsPath`
 * keeps whatever spelling VS Code opened (a junction, a short name or a
 * differently cased drive), so comparing one single form silently drops an
 * explicitly selected target.
 */
function targetPathKeys(value: string): string[] {
  const keys = new Set<string>();
  const add = (candidate: string) => {
    const normalized = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    keys.add(normalized);
    // VS Code may report a Windows path with either separator.
    if (process.platform === 'win32') keys.add(normalized.replaceAll('\\', '/'));
  };
  const resolved = path.resolve(value);
  add(resolved);
  try {
    add(realpathSync(resolved));
  } catch {
    // An unreachable entry keeps its resolved form; an unusable directory is
    // reported separately when it is the newly chosen one.
  }
  return [...keys];
}

export function sameTargetPath(left: string, right: string): boolean {
  const leftKeys = targetPathKeys(left);
  return targetPathKeys(right).some((key) => leftKeys.includes(key));
}

export function selectedTargetWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const selected = vscode.workspace.getConfiguration('forexplore')
    .get<string[]>('targetRepositoryPaths', []);
  if (selected.length === 0) return [];
  return (vscode.workspace.workspaceFolders ?? []).filter((folder) =>
    folder.uri.scheme === 'file' && selected.some((entry) => sameTargetPath(entry, folder.uri.fsPath)));
}

export async function addTargetWorkspace(
  mode: TargetWorkspaceAddMode,
  options: { onProgress?(progress: TargetWorkspaceProgress): void } = {},
): Promise<TargetWorkspaceAddResult> {
  let directory: string | undefined;
  if (mode === 'workspace') {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file');
    const selected = await vscode.window.showQuickPick(folders.map((folder) => ({
      label: folder.name, description: folder.uri.fsPath, directory: folder.uri.fsPath,
    })), { title: '选择目标工程', placeHolder: '选择已打开的工程目录' });
    directory = selected?.directory;
  } else if (mode === 'browse') {
    const selected = await vscode.window.showOpenDialog({
      title: '添加目标工程', openLabel: '添加目标目录',
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    });
    directory = selected?.[0]?.fsPath;
  } else {
    directory = await vscode.window.showInputBox({
      title: '添加目标工程', prompt: '目标工程的绝对目录路径',
      ignoreFocusOut: true,
      validateInput: (value) => path.isAbsolute(value.trim()) ? undefined : '请输入绝对目录路径',
    });
  }
  if (directory === undefined) return { status: 'cancelled' };
  directory = directory.trim();
  if (!path.isAbsolute(directory)) throw new Error('请输入目标工程的绝对目录路径。');
  options.onProgress?.({ phase: 'resolving', message: '正在校验目标目录…' });
  let resolved: string;
  try {
    resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('目标目录不存在或不可访问，请检查路径。');
  }
  const config = vscode.workspace.getConfiguration('forexplore');
  const previous = config.get<string[]>('targetRepositoryPaths', []);
  const remember = async (workspacePath = resolved) => {
    if (!previous.some((entry) => sameTargetPath(entry, workspacePath))) {
      await config.update('targetRepositoryPaths', [...previous, workspacePath], vscode.ConfigurationTarget.Global);
    }
  };
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    if (folder.uri.scheme !== 'file') continue;
    if (sameTargetPath(folder.uri.fsPath, resolved)) {
      await remember(folder.uri.fsPath);
      return { status: 'remembered', directory: resolved };
    }
  }
  options.onProgress?.({ phase: 'attaching', message: '正在将目标目录加入工作区…' });
  // Selecting the first folder can restart the extension host. Persist the
  // explicit choice before asking VS Code to change the workspace.
  await remember();
  if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(resolved) })) {
    await config.update('targetRepositoryPaths', previous, vscode.ConfigurationTarget.Global);
    // An empty window has no workspace to splice a folder into, which is a
    // permanent condition rather than a transient one.
    throw new Error(folders.length === 0
      ? '当前窗口没有打开任何文件夹，VS Code 无法把该目录加入工作区；请先打开或保存一个工作区后再重试。'
      : 'VS Code 未接受该目录（工作区更新被取消或尚未就绪）；请稍后重试，或先手动把该目录添加到工作区。');
  }
  return { status: 'attached', directory: resolved };
}
