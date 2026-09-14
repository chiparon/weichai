import type { WorkspaceCompileCommand } from '@forexplore/contracts';
import { validateWorkspaceCompileCommand } from '@forexplore/adaptation-service/module-patch-preparer';

/**
 * The in-module gate for generated module patches. It is trusted local
 * configuration, never content supplied by a model, a patch bundle or the
 * Webview. These commands only produce fast feedback inside one module's
 * disposable worktree; the wave-level joint validation stays authoritative.
 */
export interface ModuleGenerationGate {
  compileCommand: WorkspaceCompileCommand;
  verification?: { command: WorkspaceCompileCommand; protectedFiles: string[] };
  maxModelTurns: number;
}

const defaultMaxModelTurns = 40;
const maxModelTurnLimit = 200;

function command(value: unknown, label: string): WorkspaceCompileCommand {
  try {
    validateWorkspaceCompileCommand(value);
  } catch (error) {
    throw new Error(`${label} 无效：${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = value as WorkspaceCompileCommand;
  // The service validator already requires a relative cwd inside the workspace;
  // arguments may not name absolute paths because a module worktree moves.
  if (parsed.args.some((arg) => arg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(arg))) {
    throw new Error(`${label} 不允许绝对路径参数；模块 worktree 的路径因模块而异。`);
  }
  return {
    executable: parsed.executable,
    args: [...parsed.args],
    ...(parsed.cwd === undefined ? {} : { cwd: parsed.cwd }),
    ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }),
  };
}

/** Parse `forexplore.moduleGenerationGate`; undefined disables generated preparation. */
export function parseModuleGenerationGate(value: unknown): ModuleGenerationGate | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('模块生成门配置必须是对象。');
  const gate = value as Record<string, unknown>;
  const allowed = ['enabled', 'compileCommand', 'verification', 'maxModelTurns'];
  if (Object.keys(gate).some((key) => !allowed.includes(key))) throw new Error('模块生成门配置包含未知字段。');
  if (gate.enabled === false) return undefined;
  const compileCommand = command(gate.compileCommand, '模块生成编译命令');
  let verification: ModuleGenerationGate['verification'];
  if (gate.verification !== undefined && gate.verification !== null) {
    if (typeof gate.verification !== 'object' || Array.isArray(gate.verification)) {
      throw new Error('模块生成行为验收配置必须是对象。');
    }
    const raw = gate.verification as Record<string, unknown>;
    if (Object.keys(raw).some((key) => !['command', 'protectedFiles'].includes(key))) {
      throw new Error('模块生成行为验收配置包含未知字段。');
    }
    if (!Array.isArray(raw.protectedFiles) || raw.protectedFiles.length === 0 || raw.protectedFiles.length > 100 ||
      raw.protectedFiles.some((file) => typeof file !== 'string' || !file.trim() || file.includes('\\') || file.startsWith('/') || file.split('/').includes('..'))) {
      throw new Error('模块生成行为验收必须声明 1..100 个工作区相对的保护文件路径。');
    }
    verification = {
      command: command(raw.command, '模块生成行为验收命令'),
      protectedFiles: [...new Set(raw.protectedFiles as string[])],
    };
  }
  const turns = gate.maxModelTurns ?? defaultMaxModelTurns;
  if (!Number.isInteger(turns) || (turns as number) < 4 || (turns as number) > maxModelTurnLimit) {
    throw new Error(`模块生成模型轮次预算必须是 4..${maxModelTurnLimit} 的整数。`);
  }
  return { compileCommand, ...(verification ? { verification } : {}), maxModelTurns: turns as number };
}
