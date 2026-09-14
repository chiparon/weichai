import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { moduleFileHash } from './module-translation-handoff';
import { formatContextMarkdown, type ContextPacket, type WorkspaceEvidenceScope, type WorkspaceTranslationContext, type WorkspaceTranslationRequest, type WorkspaceTranslationRun } from '@forexplore/contracts';
import type { HostToWebviewMessage, WebviewToHostMessage } from './protocol/messages';

export interface TranslationProfile {
  workspaceRoot: string;
  sourceLanguage: string;
  targetLanguage: string;
  workspaceFiles: string[];
  writeFiles: string[];
}
export type TranslationIntent = Extract<WebviewToHostMessage, { type: 'WORKSPACE_TRANSLATION' }>;

/**
 * A host-owned translation scope derived from a selected target module and its
 * retrieved history candidates. The page may only refer to it by opaque id, so
 * a Webview can neither widen the write set nor inject source or a path.
 */
export interface WorkspaceTranslationModuleScope {
  label: string;
  /** Analyzer specification owned by the host. */
  spec: string;
  profile: TranslationProfile;
  context: WorkspaceTranslationContext[];
  /** Read-only history revisions the agents may query on demand. */
  evidenceScopes?: WorkspaceEvidenceScope[];
  /** Bounded, non-blocking observations about the derived scope. */
  warnings?: string[];
  /** Snapshot captured by the host when the user prepares a module translation. */
  fileHashes?: Record<string, string>;
}

/** Credentials, paths and retrieved source stay in the host. The page supplies opaque IDs only. */
export class WorkspaceTranslationHost {
  private readonly packets = new Map<string, ContextPacket>();
  private readonly starts = new Map<string, Promise<WorkspaceTranslationRun>>();
  private readonly runKeys = new Map<string, string>();
  private moduleScope?: { id: string; scope: WorkspaceTranslationModuleScope };
  constructor(private readonly configuration: () => { url: string; token?: string; profile?: string },
    private readonly transport: typeof fetch = (...args) => fetch(...args)) {}

  remember(packet: ContextPacket): void {
    this.packets.set(packet.packetId, structuredClone(packet));
    while (this.packets.size > 16) this.packets.delete(this.packets.keys().next().value!);
  }

  /**
   * Replaces the active module scope and returns the opaque id the page may
   * echo back. The scope's files and source never leave the host except as the
   * describe summary the panel already displays.
   */
  rememberModuleScope(scope: WorkspaceTranslationModuleScope): string {
    const id = createHash('sha256').update(canonicalScope(scope)).digest('hex');
    this.moduleScope = { id, scope: structuredClone(scope) };
    return id;
  }

  clearModuleScope(): void {
    this.moduleScope = undefined;
  }

  get activeModuleScopeId(): string | undefined {
    return this.moduleScope?.id;
  }

  async handle(intent: TranslationIntent): Promise<HostToWebviewMessage> {
    try {
      const { url, token, profile: raw } = this.configuration();
      if (!token) throw new Error('请在宿主配置 ADAPTATION_WORKSPACE_TRANSLATION_TOKEN，并在翻译服务启用工作区翻译。');
      if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) {
        throw new Error('模块翻译范围已变化，请重新选择目标模块或候选模块。');
      }
      const scope = intent.moduleScopeId === undefined ? undefined : this.moduleScope?.scope;
      // A module scope replaces the static profile for this operation; the
      // static profile remains the fallback for the single-workspace flow.
      const profile = scope?.profile ?? (raw && (intent.action === 'describe' || intent.action === 'start') ? parseProfile(raw) : undefined);
      const endpoint = new URL(url);
      const base = endpoint.pathname.replace(/\/+$/, '');
      endpoint.search = ''; endpoint.hash = '';
      const request = async <T>(suffix: string, body?: unknown): Promise<T> => {
        const target = new URL(endpoint); target.pathname = `${base}/v1/workspace-translations${suffix}`;
        const response = await this.transport(target, { method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
        const value = await response.json() as T & { error?: string };
        if (!response.ok) throw new Error(value.error ?? `翻译服务返回 ${response.status}`);
        return value;
      };
      const configured = await request<{ workspaceRoot: string; behavioralVerification: boolean }>('/configuration');
      if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) throw new Error('模块翻译范围已变化，请重新选择候选。');
      if (profile && await realpath(configured.workspaceRoot) !== await realpath(profile.workspaceRoot)) throw new Error('翻译服务的工作区与宿主配置不一致。');
      if ((intent.action === 'describe' || intent.action === 'start') && !profile) throw new Error('请先选择模块候选，或在宿主配置 FOREXPLORE_TRANSLATION_PROFILE。');
      const profileId = createHash('sha256').update(JSON.stringify([url, profile, intent.moduleScopeId ?? ''])).digest('hex');
      if (intent.action === 'describe') return { type: 'WORKSPACE_TRANSLATION_RESULT', requestId: intent.requestId,
        profile: { ...profile!, profileId, behavioralVerification: configured.behavioralVerification,
          ...(scope ? { moduleScopeId: intent.moduleScopeId, label: scope.label, warnings: scope.warnings ?? [] } : {}) } };

      let run: WorkspaceTranslationRun;
      if (intent.action === 'start') {
        if (intent.profileId !== profileId) throw new Error('翻译配置已变化，请重新打开生成与验收面板。');
        if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) throw new Error('模块翻译范围已变化，请重新选择候选。');
        const context: WorkspaceTranslationRequest['context'] = scope ? structuredClone(scope.context) : [];
        let evidenceKey = '';
        if (intent.packetId !== undefined) {
          const packet = this.packets.get(intent.packetId);
          if (!packet || packet.status === 'unavailable') throw new Error('任务证据已失效，请重新检索。');
          const selected = new Set(intent.evidenceIds ?? []);
          const evidence = packet.evidence.filter(item => selected.has(item.evidenceId));
          if (!evidence.length || evidence.length !== selected.size) throw new Error('选择的证据不属于当前任务。');
          context.push(...evidence.map(item => ({ id: item.evidenceId, kind: item.role === 'implementation' ? 'source' as const : item.role,
            content: item.content, path: item.relativePath, repository: item.repositoryId, revision: item.analysisRevision })));
          // Preserve snapshots, relations and gaps without duplicating source text.
          context.push({ id: `${packet.packetId}:provenance`, kind: 'summary', content: formatContextMarkdown({ ...packet, evidence: [],
            gaps: [...packet.gaps, ...(evidence.length < packet.evidence.length ? [{ code: 'USER_SELECTION', message: 'Only user-selected evidence is included; task coverage may be incomplete.' }] : [])] }) });
          evidenceKey = [...selected].sort().join(',');
        }
        if (context.length === 0) throw new Error('模块翻译缺少可用上下文：请选择历史候选模块，或先做一次任务检索并勾选证据。');
        const packetRequirement = intent.packetId === undefined ? undefined : this.packets.get(intent.packetId)?.requirement;
        const input = { spec: scope ? moduleSpec(scope, packetRequirement) : (packetRequirement ?? ''),
          sourceLanguage: profile!.sourceLanguage, targetLanguage: profile!.targetLanguage,
          workspaceFiles: profile!.workspaceFiles, writeFiles: profile!.writeFiles, context,
          ...(scope?.evidenceScopes?.length ? { evidenceScopes: scope.evidenceScopes } : {}) };
        // Do not repeat a write request if the UI delivers the same operation twice.
        const startKey = JSON.stringify([url, profile, intent.packetId ?? '', evidenceKey, intent.moduleScopeId ?? '']);
        let pending = this.starts.get(startKey);
        if (!pending) {
          if (this.starts.size >= 100) throw new Error('本次会话的翻译任务已达上限，请重启宿主。');
          let submitted = false;
          pending = (async () => {
            for (const [file, hash] of Object.entries(scope?.fileHashes ?? {})) {
              if (await moduleFileHash(profile!.workspaceRoot, file) !== hash) throw new Error(`模块文件 ${file} 已变化，请重新准备翻译。`);
            }
            if (intent.moduleScopeId !== undefined && intent.moduleScopeId !== this.moduleScope?.id) throw new Error('模块翻译范围已变化，请重新选择候选。');
            submitted = true;
            return request<WorkspaceTranslationRun>('', input);
          })();
          this.starts.set(startKey, pending);
          // A lost response may follow a successful write submission. Only a
          // failure before submission is safe to retry as a new start request.
          void pending.catch(() => { if (!submitted && this.starts.get(startKey) === pending) this.starts.delete(startKey); });
        }
        run = await pending;
        this.runKeys.set(run.id, startKey);
      } else {
        if (!intent.runId || !/^[a-f0-9-]{36}$/.test(intent.runId)) throw new Error('无效的运行编号。');
        // Check the durable run before any action, including after host restart.
        run = await request<WorkspaceTranslationRun>(`/${intent.runId}`);
        if (await realpath(run.workspaceRoot) !== await realpath(configured.workspaceRoot)) throw new Error('运行不属于配置的工作区。');
        if (intent.action !== 'read') run = await request<WorkspaceTranslationRun>(`/${intent.runId}/${intent.action}`, {});
        if (run.status === 'rolled-back') {
          const key = this.runKeys.get(run.id);
          if (key) this.starts.delete(key);
          this.runKeys.delete(run.id);
        }
      }
      return { type: 'WORKSPACE_TRANSLATION_RESULT', requestId: intent.requestId, run };
    } catch (error) {
      return { type: 'WORKSPACE_TRANSLATION_ERROR', requestId: intent.requestId,
        message: error instanceof Error ? error.message : '翻译操作失败。' };
    }
  }
}

function parseProfile(raw: string): TranslationProfile {
  const profile = JSON.parse(raw) as TranslationProfile;
  if (!profile || typeof profile.workspaceRoot !== 'string' || !path.isAbsolute(profile.workspaceRoot) ||
      ![profile.sourceLanguage, profile.targetLanguage].every(value => typeof value === 'string' && value.trim()) ||
      ![profile.workspaceFiles, profile.writeFiles].every(files => Array.isArray(files) && files.length > 0 && files.length <= 100 && files.every(file => typeof file === 'string' && file.length > 0))) {
    throw new Error('宿主翻译配置无效。');
  }
  return profile;
}

/** Identity covers the reviewed file scope and the module package inventory. */
function canonicalScope(scope: WorkspaceTranslationModuleScope): string {
  return JSON.stringify([scope.label, scope.profile, scope.spec, scope.context, scope.evidenceScopes, scope.fileHashes]);
}

/** A module run's specification is host-owned; a task requirement only adds detail. */
function moduleSpec(scope: WorkspaceTranslationModuleScope, requirement: string | undefined): string {
  const detail = requirement?.trim();
  return [scope.spec, detail && !scope.spec.includes(detail) ? `补充需求：${detail}` : ''].filter(Boolean).join('\n');
}
