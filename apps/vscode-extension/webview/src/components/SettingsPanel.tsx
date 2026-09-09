import { DEFAULT_LLM_SETTINGS, LLM_PRESETS, OUTPUT_TOKEN_LIMITS, parseLlmSettings, type LlmProvider } from '@forexplore/contracts';
import { mergeReferencePaths } from '../reference-folder-picker';
import { FolderPlus, RefreshCw, Save, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PanelSettingsPresentation } from '../../../src/protocol/messages';
import type {
  CodeIntelligencePresentation,
  CodeIntelligenceRevisionPresentation,
  RepositoryStatus,
} from '../../../src/ui-types';

interface SettingsPanelProps extends PanelSettingsPresentation {
  modelKeyStatus?: { configured: boolean; message?: string };
  onBrowseReferenceFolders?(): Promise<string[]>;
  onConfigureModelKey?(): void;
  onClearModelKey?(): void;
  repositoryStatuses: RepositoryStatus[];
  codeIntelligence?: CodeIntelligencePresentation | null;
  saving: boolean;
  onCheckRepositories(): void;
  /** Selects only a host-verified opaque repository/revision pair for read-only display. */
  onSelectCodeIntelligenceRevision(repositoryId: string, analysisRevision: string): void;
  /** Selects only a project inside the host-verified revision. */
  onSelectCodeIntelligenceProject(repositoryId: string, analysisRevision: string, projectId: string): void;
  onSave(settings: PanelSettingsPresentation): void;
  onCancel(): void;
}

export function SettingsPanel({
  llm = DEFAULT_LLM_SETTINGS,
  onBrowseReferenceFolders,
  modelKeyStatus,
  onConfigureModelKey,
  onClearModelKey,
  topK,
  repositoryPaths,
  repositoryStatuses,
  codeIntelligence,
  saving,
  onCheckRepositories,
  onSelectCodeIntelligenceRevision,
  onSelectCodeIntelligenceProject,
  onSave,
  onCancel,
}: SettingsPanelProps) {
  const [draftLlm, setDraftLlm] = useState(llm);
  const [browsing, setBrowsing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const credentialChanged = draftLlm.provider !== llm.provider || draftLlm.apiBase !== llm.apiBase;
  useEffect(() => { setDraftLlm(llm); }, [llm]);

  const [draftTopK, setDraftTopK] = useState(topK);
  const [draftPaths, setDraftPaths] = useState<string[]>(repositoryPaths);

  useEffect(() => {
    setDraftTopK(topK);
    setDraftPaths(repositoryPaths);
  }, [topK, repositoryPaths]);

  const normalizedPaths = useMemo(
    () => mergeReferencePaths(draftPaths, []),
    [draftPaths],
  );

  function updatePath(index: number, value: string): void {
    setDraftPaths((current) => current.map((path, itemIndex) => itemIndex === index ? value : path));
  }

  function removePath(index: number): void {
    setDraftPaths((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      const model = parseLlmSettings(draftLlm);
      setFormError(null);
      onSave({ topK: draftTopK, repositoryPaths: normalizedPaths, llm: model });
    } catch (error) { setFormError(error instanceof Error ? error.message : 'AI 配置无效。'); }
  }

  async function browse(): Promise<void> {
    if (!onBrowseReferenceFolders || browsing) return;
    setBrowsing(true); setFormError(null);
    try {
      const selected = await onBrowseReferenceFolders();
      if (selected.length) setDraftPaths(current => {
        const merged = mergeReferencePaths(current, selected);
        if (merged.length > 20 || merged.some(p => p.length > 1000)) {
          setFormError('最多添加 20 个参考工程，每个路径不超过 1000 字符。请减少选择后重试。');
          return current;
        }
        return merged;
      });
    } catch (error) { setFormError(error instanceof Error ? error.message : '目录选择失败。'); }
    finally { setBrowsing(false); }
  }

  return (
    <form className="settings-panel" onSubmit={submit}>
      <div className="settings-heading">
        <span className="settings-glyph"><Settings2 size={18} /></span>
        <div>
          <h1>设置</h1>
          <p>配置 AI 服务、候选方案数量和用于模块检索的参考工程。</p>
        </div>
      </div>

      <section className="card settings-section" aria-label="AI 服务">
        <div className="card-heading"><span>AI 服务</span><strong>{LLM_PRESETS[draftLlm.provider].label}</strong></div>
        <div className="model-settings-grid">
          <label>服务商<select aria-label="AI 服务商" value={draftLlm.provider} disabled={saving}
            onChange={event => { const provider = event.target.value as LlmProvider; setDraftLlm(current => ({ ...current, provider, apiBase: LLM_PRESETS[provider].apiBase, model: LLM_PRESETS[provider].model })); }}>
            {Object.entries(LLM_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
          </select></label>
          <label>模型名称<input aria-label="模型名称" value={draftLlm.model} maxLength={200} required disabled={saving}
            onChange={event => setDraftLlm(current => ({ ...current, model: event.target.value }))} /></label>
          <label className="model-endpoint">API Base URL<input aria-label="API Base URL" type="url" value={draftLlm.apiBase} maxLength={1000} required disabled={saving}
            onChange={event => setDraftLlm(current => ({ ...current, apiBase: event.target.value }))} /></label>
          <label>每次最大输出 Token<select aria-label="每次最大输出 Token" value={draftLlm.maxOutputTokens} disabled={saving}
            onChange={event => setDraftLlm(current => ({ ...current, maxOutputTokens: Number(event.target.value) }))}>
            {OUTPUT_TOKEN_LIMITS.map(limit => <option key={limit} value={limit}>{limit.toLocaleString('en-US')} tokens</option>)}
          </select></label>
        </div>
        <p className="settings-intro">限制每次模型调用的最大输出，不包含输入 Token；多步骤任务会多次调用。模型须支持所选上限，模型名称可按账号权限修改。</p>
        <p className="muted-copy">{draftLlm.provider === 'anthropic' ? '使用 Claude Messages 原生接口，支持工具调用。' : '使用 Chat Completions 兼容接口，支持工具调用。'} API 地址填写到版本路径，不含 /messages 或 /chat/completions。</p>
      </section>

      <section className="card settings-section" aria-label="API Key">
        <div className="card-heading"><span>{LLM_PRESETS[llm.provider].label} API Key</span><strong>{modelKeyStatus?.configured ? '插件已保存' : '插件未保存'}</strong></div>
        <p className="settings-intro">通过 VS Code 密码输入框加密保存，按服务商与 API 地址隔离。只有默认 DeepSeek 地址可回退到后端环境配置。</p>
        <div className="settings-actions">
          <button type="button" className="secondary-action" onClick={onConfigureModelKey} disabled={saving || credentialChanged || !onConfigureModelKey}>
            {modelKeyStatus?.configured ? '更换 API Key' : '配置 API Key'}
          </button>
          <button type="button" className="text-button" onClick={onClearModelKey} disabled={saving || credentialChanged || !modelKeyStatus?.configured || !onClearModelKey}>清除保存的 Key</button>
        </div>
        {credentialChanged ? <p role="status" className="muted-copy">请先保存服务商和 API 地址，再配置对应的 Key。</p> : null}
        {modelKeyStatus?.message ? <p role="status" className="muted-copy">{modelKeyStatus.message}</p> : null}
      </section>

      <section className="card settings-section">
        <div className="card-heading"><span>返回方案数</span><strong>Top {draftTopK}</strong></div>
        <input
          aria-label="返回方案数"
          type="range"
          min="1"
          max="10"
          value={draftTopK}
          onChange={(event) => setDraftTopK(Number(event.target.value))}
        />
        <div className="settings-range-scale"><span>1</span><span>10</span></div>
        <p className="muted-copy">每次检索展示 {draftTopK} 个候选方案。</p>
      </section>

      <section className="card settings-section" aria-label="代码智能索引状态">
        <div className="card-heading">
          <span>代码智能索引</span>
          <strong>{codeIntelligenceStatusLabel(codeIntelligence)}</strong>
        </div>
        <p className="settings-intro">
          代码智能状态仅展示仓库 ID、revision 和能力等级；该状态不携带本地路径、数据库连接或源码内容。
        </p>
        {codeIntelligence?.repositories.length ? (
          <div className="code-intelligence-list">
            {codeIntelligence.repositories.map((repository) => (
              <div className="code-intelligence-row" key={repository.repositoryId}>
                <div>
                  <strong>{repository.displayName}</strong>
                  <span>{repository.role === 'target' ? '目标工程' : '参考工程'} · {repository.analysisStatus}</span>
                </div>
                <div className="code-intelligence-facts">
                  <span className="code-intelligence-active-revision" title={repository.activeRevision ?? '尚未激活 revision'}>
                    {repository.activeRevision ? `活动 revision ${shortId(repository.activeRevision)}` : '尚未索引'}
                  </span>
                  {repository.revisions.length ? (
                    <label className="code-intelligence-revision-picker">
                      <span>查看 revision</span>
                      <select
                        aria-label={`${repository.displayName} 的代码智能 revision`}
                        value={repository.selectedRevision ?? ''}
                        onChange={(event) => {
                          if (event.target.value) {
                            onSelectCodeIntelligenceRevision(repository.repositoryId, event.target.value);
                          }
                        }}
                      >
                        {!repository.selectedRevision ? <option value="">请选择可查询 revision</option> : null}
                        {repository.revisions.map((revision) => (
                          <option key={revision.analysisRevision} value={revision.analysisRevision}>
                            {revisionLabel(revision)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {repository.selectedRevision && repository.activeRevision && repository.selectedRevision !== repository.activeRevision ? (
                    <span className="code-intelligence-history-notice">
                      正在查看历史 revision（只读）；活动 revision 未变
                    </span>
                  ) : null}
                  <span>{repository.languages.length
                    ? repository.languages.map((language) => `${language.languageId} · ${language.capabilityLevel}`).join('，')
                    : '尚无语言能力数据'}</span>
                  {repository.projects.length ? (
                    <label className="code-intelligence-revision-picker">
                      <span>{repository.role === 'target' ? '目标工程' : '参考工程'}</span>
                      <select
                        aria-label={`${repository.displayName} 的${repository.role === 'target' ? '目标工程' : '参考工程'}`}
                        value={repository.selectedProjectId ?? ''}
                        onChange={(event) => {
                          if (event.target.value && repository.selectedRevision) {
                            onSelectCodeIntelligenceProject(
                              repository.repositoryId,
                              repository.selectedRevision,
                              event.target.value,
                            );
                          }
                        }}
                      >
                        <option value="">请选择项目</option>
                        {repository.projects.map((project) => (
                          <option key={project.projectId} value={project.projectId}>
                            {project.displayName} · {project.kind}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <span className={`summary-status is-${repository.summary.status}`}>
                    {summaryLabel(repository.summary.status)}
                  </span>
                  {repository.summary.status === 'stale' ? (
                    <span className="code-intelligence-stale-warning">该 Summary 不属于活动 revision，不能作为当前结果使用。</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-empty">
            <span>{codeIntelligence?.message ?? '尚未注册可索引仓库。'}</span>
          </div>
        )}
      </section>

      <section className="card settings-section">
        <div className="card-heading">
          <span>参考工程路径</span>
          <button
            type="button"
            className="text-button"
            onClick={() => setDraftPaths((current) => current.length < 20 ? [...current, ''] : current)}
            disabled={draftPaths.length >= 20 || saving}
          >
            <FolderPlus size={13} /> 手动添加路径
          </button>
        </div>
        <button type="button" className="secondary-action" onClick={() => void browse()} disabled={saving || browsing || !onBrowseReferenceFolders || draftPaths.length >= 20}>
          <FolderPlus size={14} /> {browsing ? '正在选择…' : '浏览文件夹（可多选）'}
        </button>
        <p className="settings-intro">可添加多个本地参考工程。保存后，它们会分别出现在左侧“参考工程”列表中。</p>
        {draftPaths.length === 0 ? (
          <div className="settings-empty">
            <span>尚未添加参考工程路径</span>
            <button type="button" className="secondary-action" onClick={() => onBrowseReferenceFolders ? void browse() : setDraftPaths([''])} disabled={saving || browsing}>
              <FolderPlus size={13} /> 添加第一个路径
            </button>
          </div>
        ) : (
          <div className="repository-path-fields">
            {draftPaths.map((path, index) => {
              const status = repositoryStatuses.find((item) => item.path === path.trim());
              return (
                <div className="repository-path-row" key={`${index}-${repositoryPaths[index] ?? 'new'}`}>
                  <label>
                    <span>路径 {index + 1}</span>
                    <input
                      type="text"
                      value={path}
                      maxLength={1000}
                      placeholder="例如 D:\\CodeProjects\\legacy-system"
                      onChange={(event) => updatePath(index, event.target.value)}
                      disabled={saving}
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-button danger-button"
                    aria-label={`删除路径 ${index + 1}`}
                    title="删除路径"
                    onClick={() => removePath(index)}
                    disabled={saving}
                  >
                    <Trash2 size={14} />
                  </button>
                  {status ? (
                    <span className={`path-status is-${statusClass(status)}`} title={status.message}>
                      <i className="repository-dot" />{status.message}
                    </span>
                  ) : path.trim() ? <span className="path-status">保存后检查</span> : null}
                </div>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className="text-button settings-check-button"
          onClick={onCheckRepositories}
          disabled={saving || repositoryPaths.length === 0}
          title={repositoryPaths.length === 0 ? '请先保存至少一个仓库路径' : '检查已保存的仓库路径'}
        >
          <RefreshCw size={13} /> 重新检查已保存路径
        </button>
      </section>

      {formError ? <p role="alert" className="error-banner">{formError}</p> : null}
      <div className="settings-actions">
        <button type="button" className="secondary-action" onClick={onCancel} disabled={saving}>
          <X size={14} /> 取消
        </button>
        <button type="submit" className="primary-action settings-save" disabled={saving || browsing}>
          {saving ? <span className="spinner" /> : <Save size={14} />}
          {saving ? '正在保存…' : '保存设置'}
        </button>
      </div>
    </form>
  );
}

function codeIntelligenceStatusLabel(value: CodeIntelligencePresentation | null | undefined): string {
  if (!value || value.status === 'initializing') return '初始化中';
  if (value.status === 'error') return '需要处理';
  return value.storage === 'seekdb' ? 'SeekDB 已连接' : '内存开发存储';
}

function summaryLabel(status: 'missing' | 'current' | 'stale'): string {
  if (status === 'current') return 'Summary 当前';
  if (status === 'stale') return 'Summary 已过期';
  return '尚无 Summary';
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 18)}…`;
}

function revisionLabel(revision: CodeIntelligenceRevisionPresentation): string {
  const state = revision.isActive ? '活动' : '历史';
  return `${state} · ${shortId(revision.analysisRevision)} · ${revision.status}`;
}

function statusClass(status: RepositoryStatus): string {
  if (!status.exists || !status.readable) return 'error';
  if (status.stale) return 'stale';
  if (!status.indexed) return 'pending';
  return 'ok';
}
