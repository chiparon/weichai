// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  showOpenDialog: vi.fn(), showInputBox: vi.fn(), showInformationMessage: vi.fn(), showQuickPick: vi.fn(),
  update: vi.fn(), selectedPaths: [] as string[],
  updateWorkspaceFolders: vi.fn(), folders: [] as Array<{ uri: { scheme: string; fsPath: string } }>,
}));
vi.mock('vscode', () => ({
  window: api,
  workspace: { get workspaceFolders() { return api.folders; }, updateWorkspaceFolders: api.updateWorkspaceFolders,
    getConfiguration: () => ({ get: () => api.selectedPaths, update: api.update }) },
  ConfigurationTarget: { Global: 1 },
  Uri: { file: (fsPath: string) => ({ scheme: 'file', fsPath }) },
}));
import { addTargetWorkspace, readPendingTargetImport, sameTargetPath, selectedTargetWorkspaceFolders } from './target-workspace';

let root: string;
beforeEach(async () => {
  vi.resetAllMocks(); api.folders = []; api.selectedPaths = [];
  api.update.mockImplementation(async (_key, value) => { api.selectedPaths = value; });
  api.updateWorkspaceFolders.mockReturnValue(true);
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'forexplore-target-dir-')));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('adds the directory selected in the native picker', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  expect(await addTargetWorkspace('browse')).toEqual({ status: 'attached', directory: root });
  expect(api.updateWorkspaceFolders).toHaveBeenCalledWith(0, 0, { uri: { scheme: 'file', fsPath: root } });
});

it('accepts an entered path and prevents duplicate folders', async () => {
  api.showInputBox.mockResolvedValue(` ${root} `);
  await addTargetWorkspace('input');
  expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce();
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  expect(await addTargetWorkspace('input')).toEqual({ status: 'remembered', directory: root });
  expect(api.updateWorkspaceFolders).toHaveBeenCalledOnce();
});

it('rejects files and nonexistent directories without changing the workspace', async () => {
  const file = path.join(root, 'file.txt');
  await writeFile(file, 'test');
  for (const value of [file, path.join(root, 'missing')]) {
    api.showInputBox.mockResolvedValue(value);
    await expect(addTargetWorkspace('input')).rejects.toThrow('目标目录');
  }
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

it('reports a cancelled picker as an outcome instead of a silent no-op', async () => {
  api.showOpenDialog.mockResolvedValue(undefined);
  expect(await addTargetWorkspace('browse')).toEqual({ status: 'cancelled' });
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
});

it('reports the phases a slow selection passes through', async () => {
  const phases: string[] = [];
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  await addTargetWorkspace('browse', { onProgress: (update) => phases.push(update.phase) });
  expect(phases).toEqual(['resolving', 'attaching']);
});

it('does not treat an open parent workspace as a selected target', async () => {
  api.folders = [{ uri: { scheme: 'file', fsPath: root } }];
  expect(selectedTargetWorkspaceFolders()).toEqual([]);
  api.showQuickPick.mockResolvedValue({ directory: root });
  expect(await addTargetWorkspace('workspace')).toEqual({ status: 'remembered', directory: root });
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
  expect(api.updateWorkspaceFolders).not.toHaveBeenCalled();
});

/**
 * A remembered selection is stored as a real path while VS Code keeps the
 * spelling it opened. Comparing a single form silently dropped the target, so
 * the folder stayed open but was never indexed.
 */
it('matches a remembered target through a directory link', async () => {
  const real = path.join(root, 'real-project');
  const link = path.join(root, 'linked-project');
  await mkdir(real);
  await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  api.selectedPaths = [await realpath(real)];
  api.folders = [{ uri: { scheme: 'file', fsPath: link } }];
  expect(selectedTargetWorkspaceFolders()).toEqual(api.folders);
  expect(sameTargetPath(await realpath(real), link)).toBe(true);
});

it('compares Windows targets case- and separator-insensitively', () => {
  const target = process.platform === 'win32' ? 'C:\\Projects\\Engine' : '/projects/engine';
  const equivalent = process.platform === 'win32' ? 'c:/projects/engine' : '/projects/engine/';
  expect(sameTargetPath(target, equivalent)).toBe(true);
  expect(sameTargetPath(target, `${equivalent}-other`)).toBe(false);
});

it('explains that an empty window cannot accept the folder', async () => {
  api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
  api.updateWorkspaceFolders.mockReturnValue(false);
  await expect(addTargetWorkspace('browse')).rejects.toThrow('没有打开任何文件夹');
  expect(api.selectedPaths).toEqual([]);
});

it('restores target selections when VS Code declines the workspace update', async () => {
  const other = await realpath(await mkdtemp(path.join(tmpdir(), 'forexplore-other-dir-')));
  try {
    api.folders = [{ uri: { scheme: 'file', fsPath: other } }];
    api.showOpenDialog.mockResolvedValue([{ fsPath: root }]);
    api.updateWorkspaceFolders.mockReturnValue(false);
    await expect(addTargetWorkspace('browse')).rejects.toThrow('VS Code 未接受该目录');
    expect(api.selectedPaths).toEqual([]);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

/**
 * A workspace change can restart the extension host in the middle of an
 * import, so the recorded intent decides whether the surviving host finishes
 * the job instead of leaving the panel on a progress state forever.
 */
it('resumes a recent interrupted target import', () => {
  const now = Date.parse('2026-09-14T17:13:18.000Z');
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'browse' }, now))
    .toEqual({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'browse' });
});

it('ignores a stale, malformed or future-dated import intent', () => {
  const now = Date.parse('2026-09-14T17:13:18.000Z');
  expect(readPendingTargetImport(undefined, now)).toBeUndefined();
  expect(readPendingTargetImport('browse', now)).toBeUndefined();
  expect(readPendingTargetImport({ mode: 'browse' }, now)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: 'not-a-date', mode: 'browse' }, now)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'elsewhere' }, now)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:13:00.000Z', mode: 'browse' }, now, 1000)).toBeUndefined();
  expect(readPendingTargetImport({ requestedAt: '2026-09-14T17:20:00.000Z', mode: 'browse' }, now)).toBeUndefined();
});
