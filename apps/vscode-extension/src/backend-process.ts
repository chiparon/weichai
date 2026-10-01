import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { localFetch } from './local-fetch';

export interface BackendLaunchConfiguration {
  url: string; extensionPath: string; workspaceRoot: string; trusted: boolean; autoStart: boolean;
  semanticPort: number;
  compileCommand?: { executable: string; args: string[]; timeoutMs?: number };
  verification?: { command: { executable: string; args: string[]; timeoutMs?: number }; protectedFiles: string[] };
}
export interface BackendCapabilities {
  service: string; version: number; retrievalRerank: boolean; semanticPlanning: boolean;
  workspaceTranslation: boolean; workspaceRoot?: string;
}

/** One owned child per extension host. Existing processes are never terminated. */
export class BackendProcess {
  private child?: ChildProcess;
  private pending?: Promise<BackendCapabilities>;
  private ownedRoot?: string;
  private ownedOrigin?: string;
  private disposed = false;
  readonly translationToken = process.env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN || randomBytes(32).toString('hex');
  constructor(private readonly configuration: () => BackendLaunchConfiguration,
    private readonly log: (message: string) => void,
    private readonly launch: typeof spawn = spawn,
    private readonly transport: typeof localFetch = localFetch) {}

  async capabilities(url: string): Promise<BackendCapabilities | undefined> {
    try {
      const response = await this.transport(`${url.replace(/\/+$/, '')}/v1/capabilities`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return undefined;
      const value = await response.json() as BackendCapabilities;
      return value.service === 'recast-adaptation' && value.version === 1 ? value : undefined;
    } catch { return undefined; }
  }

  ensure(): Promise<BackendCapabilities> {
    if (this.disposed) return Promise.reject(new Error('Backend manager is disposed'));
    this.pending ??= this.start().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async start(): Promise<BackendCapabilities> {
    const config = this.configuration();
    const url = new URL(config.url);
    if (!config.trusted) throw new Error('请先信任工作区，再启动模型后端。');
    const root = await realpath(config.workspaceRoot);
    if (this.child && (this.ownedRoot !== root || this.ownedOrigin !== url.origin)) {
      throw new Error('后端仍绑定另一目标或端口；请关闭该扩展开发窗口后在新目标中重开，避免中断正在进行的翻译。');
    }
    const existing = await this.capabilities(config.url);
    if (existing) {
      if (!existing.retrievalRerank || !existing.semanticPlanning) throw new Error('现有后端缺少重排或语义规划能力，请更新后端。');
      if (existing.workspaceRoot && await realpath(existing.workspaceRoot) !== root) throw new Error('该后端绑定了其他目标工程，请使用另一端口。');
      return existing;
    }
    if (!config.autoStart) throw new Error('模型后端不可用，自动启动已关闭。');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('自动启动只支持本机 HTTP 根地址，例如 http://127.0.0.1:8788。');
    if (this.child) throw new Error('已启动的后端未通过能力检查，请查看 RECAST 输出后重启扩展。');
    const bundle = path.join(config.extensionPath, 'dist/extension/adaptation-server.cjs');
    await access(bundle);
    const compile = config.compileCommand ?? { executable: process.execPath,
      args: [path.join(config.extensionPath, 'dist/extension/workspace-compile.cjs')], timeoutMs: 120000 };
    const child = this.launch(process.execPath, [bundle], { cwd: root, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        DOTENV_CONFIG_PATH: path.join(config.extensionPath, '.backend-no-env'),
        ADAPTATION_HOST: url.hostname === '[::1]' ? '::1' : '127.0.0.1', ADAPTATION_PORT: url.port || '80',
        ADAPTATION_PROJECT_ROOT: root, ADAPTATION_SKELETON_PROJECT_PATH: root,
        ADAPTATION_SEMANTIC_INDEX_ENABLED: 'true', SEMANTIC_QUERY_PORT_URL: `http://127.0.0.1:${config.semanticPort}`,
        ADAPTATION_WORKSPACE_TRANSLATION_ENABLED: 'true', ADAPTATION_WORKSPACE_TRANSLATION_TOKEN: this.translationToken,
        ADAPTATION_WORKSPACE_COMPILE_COMMAND: JSON.stringify(compile),
        ADAPTATION_WORKSPACE_VERIFICATION: config.verification ? JSON.stringify(config.verification) : '',
      } });
    this.child = child; this.ownedRoot = root; this.ownedOrigin = url.origin;
    let failure: string | undefined;
    child.once('error', () => { failure = '后端进程启动失败'; });
    child.once('exit', code => {
      failure = `后端进程已退出（${code}）`;
      if (this.child === child) { this.child = undefined; this.ownedRoot = undefined; this.ownedOrigin = undefined; }
      this.log(failure);
    });
    // Drain pipes without copying model requests/responses or credentials into IDE logs.
    child.stdout?.resume(); child.stderr?.resume();
    this.log(`正在启动模型后端：${url.origin}；目标：${root}`);
    const deadline = Date.now() + 20000;
    try {
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('Backend manager is disposed');
      if (failure) throw new Error(failure);
      const ready = await this.capabilities(config.url);
      if (ready) {
        if (!ready.workspaceRoot || await realpath(ready.workspaceRoot) !== root) throw new Error('后端目标工程校验失败。');
        // Proves this child/configuration owns the endpoint, not another process racing this launch.
        const response = await this.transport(`${config.url.replace(/\/+$/, '')}/v1/workspace-translations/configuration`, {
          headers: { authorization: `Bearer ${this.translationToken}` }, signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error('后端鉴权不匹配，请检查端口占用。');
        this.log('模型后端已就绪：分析、模型重排、翻译。');
        return ready;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('模型后端在 20 秒内未就绪，请检查端口和构建产物。');
    } catch (error) {
      child.kill();
      if (this.child === child) { this.child = undefined; this.ownedRoot = undefined; this.ownedOrigin = undefined; }
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    const child = this.child;
    if (!child) return;
    if (child.connected) child.send({ type: 'shutdown' }, error => { if (error) child.kill(); });
    const timer = setTimeout(() => { if (this.child === child) child.kill(); }, 5000);
    timer.unref();
  }
}
