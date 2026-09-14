import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { HostToWebviewMessage, WebviewToHostMessage } from '../../src/protocol/messages';
import type { ModuleExplorerPresentation } from '../../src/ui-types';
import App from './App';

let reactRoot: Root | undefined;
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot!.unmount());
  document.body.innerHTML = '';
});

const unselectedTarget: ModuleExplorerPresentation = {
  generatedAt: '', history: [],
  target: {
    id: 'target:unselected', mode: 'target', name: '选择目标工程', rootLabel: '',
    stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' }, tree: [],
  },
};

async function mountPanel(initialMode: 'search' | 'migration' = 'search') {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const posted: WebviewToHostMessage[] = [];
  window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => {},
    postMessage: (message: unknown) => { posted.push(message as WebviewToHostMessage); } });
  const container = document.createElement('div'); document.body.append(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot!.render(<App initialMode={initialMode} />));
  const post = (message: HostToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data: message }));
  const postRaw = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
  await act(async () => post({ type: 'INIT', payload: { target: null, workspaceRoot: '',
    settings: { repositoryPaths: [], topK: 4 }, repositoryStatuses: [], moduleExplorer: unselectedTarget,
    codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
    serviceStatus: { retrieval: 'connected', adaptation: 'unconfigured', executionMode: 'real' },
    searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' } }));
  return { container, post, postRaw, posted };
}

/**
 * A native dialog returns nothing until it closes and the first index can run
 * for minutes. Without a rendered phase the user cannot tell a slow selection
 * from a button that never ran.
 */
it('renders every target-selection phase and keeps a retry beside the failure', async () => {
  const { container, post, posted } = await mountPanel();
  expect(container.querySelector('.target-add-status')).toBeNull();

  await act(async () => post({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'selecting',
    message: '请在弹出的对话框中选择目标工程目录…' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('请在弹出的对话框中选择目标工程目录');
  expect(container.querySelector('.target-add-status .is-spinning')).not.toBeNull();

  await act(async () => post({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'indexing',
    message: '正在解析目录并建立结构索引…' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('正在解析目录并建立结构索引');

  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'failed', mode: 'input',
    message: '目标目录不存在或不可访问，请检查路径。' }));
  const error = container.querySelector('.target-add-status.is-error')!;
  expect(error.textContent).toContain('目标目录不存在或不可访问');

  await act(async () => error.querySelector('button')!.click());
  expect(posted.filter((message) => message.type === 'ADD_TARGET_WORKSPACE'))
    .toEqual([{ type: 'ADD_TARGET_WORKSPACE', mode: 'input' }]);
  expect(container.querySelector('.target-add-status.is-error')).toBeNull();
  expect(container.querySelector('.target-add-status .is-spinning')).not.toBeNull();

  await act(async () => post({ type: 'TARGET_WORKSPACE_RESULT', outcome: 'cancelled', mode: 'input' }));
  expect(container.querySelector('.target-add-status')?.textContent).toContain('已取消选择目标工程');
  expect(container.querySelector('.target-add-status .is-spinning')).toBeNull();
});

/**
 * The index state is derived from the host presentation, not from the message
 * that started it, so it survives a Webview rebuild after the workspace change.
 */
it('shows a live index state for a target the host is still indexing', async () => {
  const { container, post } = await mountPanel('migration');
  expect(container.querySelector('.target-empty-state h1')?.textContent).toContain('选择目标工程');
  await act(async () => post({ type: 'CODE_INTELLIGENCE_STATUS', presentation: { status: 'ready', storage: 'seekdb',
    repositories: [{ repositoryId: 'repo-1', displayName: 'engine', role: 'target', analysisStatus: 'indexing',
      activeRevision: null, selectedRevision: null, revisions: [], languages: [], projects: [],
      selectedProjectId: null, summary: { status: 'missing' } }] } }));
  const empty = container.querySelector('.target-empty-state')!;
  expect(empty.querySelector('h1')?.textContent).toContain('正在建立项目索引');
  expect(empty.textContent).toContain('engine');
  expect(empty.querySelector('.is-spinning')).not.toBeNull();
});

it('rejects an unknown target phase instead of trusting the message name', async () => {
  const { container, postRaw } = await mountPanel();
  await act(async () => postRaw({ type: 'TARGET_WORKSPACE_PROGRESS', phase: 'queued', message: 'x' }));
  expect(container.querySelector('.target-add-status')).toBeNull();
});
