import { useEffect, useRef } from 'react';
import {
  AlertTriangle, Check, ChevronDown, FolderOpen, FolderPlus, Info, RefreshCw, Settings2, TextCursorInput,
} from 'lucide-react';
import type { CodeIntelligencePresentation, ModuleExplorerMode, ModuleWorkspacePresentation } from '../../../src/ui-types';
import type { TargetWorkspaceAddMode, TargetWorkspacePhase } from '../../../src/protocol/messages';

/**
 * Webview-local view of one explicit target selection. A native dialog returns
 * nothing until it closes and a first-time index can run for minutes, so the
 * attempt is rendered from the first click instead of only when it settles.
 */
export interface TargetAddUiState {
  status: 'idle' | 'pending' | 'failed' | 'notice';
  mode?: TargetWorkspaceAddMode;
  phase?: TargetWorkspacePhase;
  message?: string;
}

export const idleTargetAdd: TargetAddUiState = { status: 'idle' };

const phaseMessages: Record<TargetWorkspacePhase, string> = {
  selecting: '请在弹出的对话框中选择目标工程目录…',
  resolving: '正在校验目标目录…',
  attaching: '正在将目标目录加入工作区…',
  indexing: '正在解析目录并建立结构索引…',
};

export function targetAddMessage(state: TargetAddUiState): string {
  return state.message ?? phaseMessages[state.phase ?? 'selecting'];
}

export function targetAddRetryMode(state: TargetAddUiState): TargetWorkspaceAddMode {
  return state.mode ?? 'browse';
}

/** Shared status line: the same text appears in the sidebar and the empty state. */
export function TargetAddStatus({ state, onRetry }: { state: TargetAddUiState; onRetry(): void }) {
  if (state.status === 'idle') return null;
  const pending = state.status === 'pending';
  return (
    <div className={`target-add-status${state.status === 'failed' ? ' is-error' : ''}`} role={state.status === 'failed' ? 'alert' : 'status'}>
      {pending ? <RefreshCw size={12} className="is-spinning" />
        : state.status === 'failed' ? <AlertTriangle size={12} /> : <Info size={12} />}
      <span>{targetAddMessage(state)}</span>
      {state.status === 'failed' ? <button type="button" onClick={onRetry}>重试</button> : null}
    </div>
  );
}

export interface ProjectPickerProps {
  mode: ModuleExplorerMode;
  workspace: ModuleWorkspacePresentation;
  repositories: CodeIntelligencePresentation['repositories'];
  open: boolean;
  refreshing: boolean;
  targetAdd?: TargetAddUiState;
  onOpenChange(open: boolean): void;
  onSelect(repositoryId: string, analysisRevision: string, projectId: string): void;
  onRefresh(repositoryId: string): void;
  onAdd(mode: 'browse' | 'input' | 'workspace'): void;
  onOpenSettings(): void;
}

export function ProjectPicker(props: ProjectPickerProps) {
  const { mode, workspace, open, onOpenChange } = props;
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const repositories = props.repositories.filter((repository) => repository.role === mode);
  const current = repositories.find((repository) => repository.repositoryId === workspace.repositoryId);
  const label = current?.displayName ?? (workspace.projectId ? workspace.name : mode === 'target' ? '选择目标工程' : '选择参考工程');
  // Only a target selection can be in flight, and it must stay visible while
  // the menu is closed: the dialog and the index both happen after it closes.
  const addState = mode === 'target' ? props.targetAdd : undefined;
  const adding = addState?.status === 'pending';
  // A repository the host is already indexing cannot be refreshed again; the
  // button reports that instead of looking inert when it is clicked.
  const indexing = current?.analysisStatus === 'indexing';

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, onOpenChange]);

  const choose = (action: () => void) => {
    onOpenChange(false);
    trigger.current?.focus();
    action();
  };

  return (
    <div className="workspace-picker" ref={container} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); trigger.current?.focus(); }
      if (event.key === 'Tab') onOpenChange(false);
      if (!open && event.key === 'ArrowDown') { event.preventDefault(); onOpenChange(true); return; }
      if (!open || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (!items.length) return;
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>
      <div className="workspace-picker-row">
        <button ref={trigger} type="button" className="workspace-picker-trigger" aria-haspopup="menu"
          aria-expanded={open} aria-label={mode === 'target' ? '选择目标工程' : '选择参考工程'}
          title={workspace.projectId ? workspace.name : label} onClick={() => onOpenChange(!open)}>
          {adding ? <RefreshCw size={14} className="is-spinning" /> : <FolderOpen size={14} />}
          <span><strong>{label}</strong><small>{workspace.projectId ? workspace.rootLabel || '.' : adding ? '正在添加…' : '未选择项目'}</small></span>
          <ChevronDown size={13} />
        </button>
        <button type="button" className="icon-button"
          title={indexing ? '此仓库正在建立索引' : '刷新此仓库'} aria-label={indexing ? '此仓库正在建立索引' : '刷新此仓库'}
          disabled={!current || props.refreshing || adding || indexing} onClick={() => current && props.onRefresh(current.repositoryId)}>
          <RefreshCw size={14} className={props.refreshing || indexing ? 'is-spinning' : ''} />
        </button>
      </div>
      {addState ? <TargetAddStatus state={addState} onRetry={() => props.onAdd(targetAddRetryMode(addState))} /> : null}
      {open ? (
        <div className="workspace-picker-menu" role="menu" aria-label={mode === 'target' ? '目标工程列表' : '参考工程列表'} ref={menu}>
          <div className="workspace-picker-options">
            {repositories.map((repository) => (
              <div key={repository.repositoryId} role="group" aria-label={repository.displayName}>
                <div className="workspace-picker-group">{repository.displayName}</div>
                {repository.projects.map((project) => {
                  const selected = repository.repositoryId === workspace.repositoryId && project.projectId === workspace.projectId;
                  return <button type="button" role="menuitemradio" aria-checked={selected} key={project.projectId}
                    className="workspace-picker-option" disabled={!repository.selectedRevision || adding}
                    onClick={() => choose(() => props.onSelect(repository.repositoryId, repository.selectedRevision!, project.projectId))}>
                    <span><strong>{project.displayName}</strong><small>{project.relativePath || '.'}</small></span>
                    {selected ? <Check size={14} /> : null}
                  </button>;
                })}
                {!repository.projects.length ? <button type="button" role="menuitem" className="workspace-picker-option"
                  disabled={props.refreshing || adding || repository.analysisStatus === 'indexing'}
                  onClick={() => choose(() => props.onRefresh(repository.repositoryId))}>
                  <RefreshCw size={13} className={repository.analysisStatus === 'indexing' ? 'is-spinning' : ''} />
                  {repositoryIndexLabel(repository.analysisStatus)}
                </button> : null}
              </div>
            ))}
            {!repositories.length ? <div className="workspace-picker-empty">{mode === 'target' ? '尚未选择目标工程' : '尚未添加参考工程'}</div> : null}
          </div>
          <div className="workspace-picker-commands">
            {mode === 'target' ? <>
              <button type="button" role="menuitem" disabled={adding} onClick={() => choose(() => props.onAdd('workspace'))}><FolderOpen size={14} />从已打开工作区选择…</button>
              <button type="button" role="menuitem" disabled={adding} onClick={() => choose(() => props.onAdd('browse'))}><FolderPlus size={14} />浏览本地项目…</button>
              <button type="button" role="menuitem" disabled={adding} onClick={() => choose(() => props.onAdd('input'))}><TextCursorInput size={14} />输入项目路径…</button>
            </> : <button type="button" role="menuitem" onClick={() => choose(props.onOpenSettings)}><Settings2 size={14} />管理参考工程…</button>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The host owns this lifecycle. 'registered' means the directory is known but
 * never indexed yet, so the row stays an action instead of looking like a
 * progress state that already failed to advance.
 */
export function repositoryIndexLabel(status: CodeIntelligencePresentation['repositories'][number]['analysisStatus']): string {
  if (status === 'indexing') return '正在建立索引…';
  if (status === 'failed') return '索引失败，点击重试';
  return '初始化项目索引';
}
