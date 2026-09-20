import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BackendProcess, type BackendLaunchConfiguration } from './backend-process';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(existing = false) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recast-backend-'))); roots.push(root);
  await mkdir(path.join(root, 'dist/extension'), { recursive: true });
  await writeFile(path.join(root, 'dist/extension/adaptation-server.cjs'), '');
  const config: BackendLaunchConfiguration = { url: 'http://127.0.0.1:8788', extensionPath: root, workspaceRoot: root,
    trusted: true, autoStart: true, semanticPort: 8790 };
  const capabilities = { service: 'recast-adaptation', version: 1, retrievalRerank: true, semanticPlanning: true, workspaceTranslation: true, workspaceRoot: root };
  let running = existing;
  const child = Object.assign(new EventEmitter(), { connected: true, kill: vi.fn(), send: vi.fn(), stdout: { resume() {} }, stderr: { resume() {} } });
  const launch = vi.fn(() => { running = true; return child; });
  const transport = vi.fn(async (url: Parameters<typeof fetch>[0]) => running ? Response.json(String(url).endsWith('/configuration') ? { workspaceRoot: root } : capabilities) : new Response('', { status: 503 }));
  const manager = new BackendProcess(() => config, vi.fn(), launch as any, transport);
  return { root, config, capabilities, child, launch, manager, transport };
}
it('shares concurrent startup, uses a hidden owned process, and shuts it down over IPC', async () => {
  const { manager, launch, child, root } = await setup();
  const first = manager.ensure(); expect(manager.ensure()).toBe(first); await first;
  await manager.ensure(); expect(launch).toHaveBeenCalledTimes(1);
  const options = (launch.mock.calls[0] as any)[2];
  expect(options).toMatchObject({ cwd: root, shell: false, windowsHide: true });
  expect(options.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN).toBe(manager.translationToken);
  expect(options.env.ADAPTATION_PROJECT_ROOT).toBe(root);
  manager.dispose(); expect(child.send).toHaveBeenCalledWith({ type: 'shutdown' }, expect.any(Function));
  await expect(manager.ensure()).rejects.toThrow('disposed');
});
it('reuses a compatible external backend without killing it', async () => {
  const { manager, launch, child } = await setup(true);
  await manager.ensure(); manager.dispose(); expect(launch).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
});
it('refuses untrusted workspaces and disabled automatic startup', async () => {
  const { manager, config, launch } = await setup(); config.trusted = false;
  await expect(manager.ensure()).rejects.toThrow('信任'); config.trusted = true; config.autoStart = false;
  await expect(manager.ensure()).rejects.toThrow('已关闭'); expect(launch).not.toHaveBeenCalled();
});
it('refuses remote auto-start and incompatible existing targets', async () => {
  const first = await setup(); first.config.url = 'http://example.com';
  await expect(first.manager.ensure()).rejects.toThrow('本机'); expect(first.launch).not.toHaveBeenCalled();
  const second = await setup(true); second.capabilities.workspaceRoot = first.root;
  await expect(second.manager.ensure()).rejects.toThrow('其他目标'); expect(second.launch).not.toHaveBeenCalled();
});
it('cleans up a child that fails ownership authentication', async () => {
  const { manager, transport, child, root } = await setup();
  transport.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json({
    service: 'recast-adaptation', version: 1, retrievalRerank: true, semanticPlanning: true, workspaceTranslation: true, workspaceRoot: root,
  })).mockResolvedValueOnce(new Response('', { status: 401 }));
  await expect(manager.ensure()).rejects.toThrow('鉴权'); expect(child.kill).toHaveBeenCalledOnce();
});
