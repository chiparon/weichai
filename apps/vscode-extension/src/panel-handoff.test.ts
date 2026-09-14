// @vitest-environment node
/**
 * The panel chain: Webview -> translation panel -> host handlers -> reply.
 *
 * The end-to-end translation acceptance drives the service directly, so this
 * seam was never covered: a Webview message the host refused used to vanish
 * without a log or a reply, and the workbench kept waiting for an answer
 * nobody owed it. These cases run the real panel, the real validator and the
 * real handler policy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  posted: [] as Array<Record<string, any>>,
  logLines: [] as string[],
  disposed: [] as string[],
  receive: undefined as ((message: unknown) => void) | undefined,
  dispatched: [] as Array<Record<string, any>>,
  published: [] as Array<Record<string, any>>,
}));

vi.mock('vscode', () => {
  const uri = (path: string) => ({ path, fsPath: path, toString: () => `file:///${path}` });
  return {
    Uri: { joinPath: (base: any, ...parts: string[]) => uri([base?.path ?? '', ...parts].join('/')) },
    ViewColumn: { Beside: 2 },
    commands: { executeCommand: vi.fn(async () => undefined) },
    workspace: {
      fs: { readFile: async () => Buffer.from('<html>{{CSP_SOURCE}}</html>') },
      textDocuments: [], workspaceFolders: undefined, isTrusted: true,
    },
    window: { createOutputChannel: () => ({ appendLine: (line: string) => api.logLines.push(line) }) },
  };
});

import { TranslationPanel } from './panel';
import { createPanelHandlers, publishPanelMessage } from './panel-handlers';

function fakePanel(id: string) {
  return {
    iconPath: undefined,
    webview: {
      cspSource: 'vscode-webview:', options: {},
      onDidReceiveMessage: (handler: (message: unknown) => void) => { api.receive = handler; return { dispose() {} }; },
      postMessage: async (message: Record<string, any>) => { api.posted.push({ panel: id, ...message }); return true; },
      asWebviewUri: (value: unknown) => value,
    },
    onDidDispose: () => ({ dispose() {} }),
    reveal: vi.fn(),
    dispose: () => api.disposed.push(id),
  } as any;
}

const context = { extensionUri: { path: '/extension', toString: () => 'file:///extension' } } as any;
const payload = { target: null, workspaceRoot: '', settings: { repositoryPaths: [], topK: 4 },
  repositoryStatuses: [], moduleExplorer: { generatedAt: '', history: [], target: {
    id: 'target', mode: 'target', name: 'Target', rootLabel: '.', tree: [],
    stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' } } },
  codeIntelligence: { status: 'ready', storage: 'memory', repositories: [] },
  serviceStatus: { retrieval: 'connected', adaptation: 'connected', executionMode: 'real' },
  searchProvider: 'SeekDB', adaptationProvider: 'DeepSeek' } as any;

const output = { appendLine: (line: string) => api.logLines.push(line) };
const publish = (message: Record<string, any>) => {
  api.published.push(message);
  publishPanelMessage(TranslationPanel.current, message as any, output);
};
const handlers = (dispatch: (message: any) => Promise<void>) =>
  createPanelHandlers({ output, dispatch, publish });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  api.posted.length = 0; api.logLines.length = 0; api.disposed.length = 0;
  api.dispatched.length = 0; api.published.length = 0; api.receive = undefined;
  (TranslationPanel as any).current = undefined;
});

describe('translation panel handoff', () => {
  it('delivers a valid translation request to the host dispatcher', async () => {
    await TranslationPanel.restore(fakePanel('a'), context, payload, handlers(async (message) => {
      api.dispatched.push(message);
    }));

    api.receive!({ type: 'START_ADAPT', decisionNotes: '依赖注入' });
    await flush();

    expect(api.dispatched).toEqual([{ type: 'START_ADAPT', decisionNotes: '依赖注入' }]);
    expect(api.published).toEqual([]);
  });

  it('reports a failing dispatch instead of leaving the panel waiting', async () => {
    await TranslationPanel.restore(fakePanel('a'), context, payload, handlers(async () => {
      throw new Error('请先从已保存的目标方法启动一次迁移。');
    }));

    api.receive!({ type: 'START_ADAPT', decisionNotes: 'ok' });
    await flush();

    expect(api.posted).toContainEqual(expect.objectContaining({ type: 'ERROR',
      message: '面板操作失败：请先从已保存的目标方法启动一次迁移。' }));
  });

  it('answers a refused translation request with the reason instead of dropping it', async () => {
    await TranslationPanel.restore(fakePanel('a'), context, payload, handlers(async (message) => {
      api.dispatched.push(message);
    }));

    api.receive!({ type: 'START_ADAPT', decisionNotes: 'x'.repeat(8_001) });
    await flush();

    expect(api.logLines).toContain('[forexplore] refused an invalid webview message: '
      + 'START_ADAPT 的决策说明 8001 字，超过 8000 字上限。');
    expect(api.posted).toContainEqual(expect.objectContaining({ type: 'ERROR',
      message: '面板请求未被宿主接受：START_ADAPT 的决策说明 8001 字，超过 8000 字上限。' }));
    // The dispatcher never ran: this is the path that used to hang in silence.
    expect(api.dispatched).toEqual([]);
  });

  it('names an unknown field on a refused translation request', async () => {
    await TranslationPanel.restore(fakePanel('a'), context, payload, handlers(async () => {}));

    api.receive!({ type: 'START_ADAPT', decisionNotes: 'ok', force: true });
    await flush();

    expect(api.posted).toContainEqual(expect.objectContaining({ type: 'ERROR',
      message: '面板请求未被宿主接受：START_ADAPT 含未知字段：force。' }));
  });

  it('keeps exactly one live panel so replies can never go to an orphan', async () => {
    await TranslationPanel.restore(fakePanel('first'), context, payload, handlers(async () => {}));
    await TranslationPanel.restore(fakePanel('second'), context, payload, handlers(async () => {}));

    expect(api.disposed).toEqual(['first']);
    expect(api.logLines).toContain(
      '[forexplore] closed a superseded workbench panel: only one panel receives host replies.');
    api.receive!({ type: 'START_ADAPT', decisionNotes: 'ok' });
    await flush();
    expect(api.posted.every((message) => message.panel === 'second')).toBe(true);
  });

  it('reports a waited-for reply that has no panel to reach', async () => {
    publishPanelMessage(undefined, { type: 'MODULE_TRANSLATION_READY', targetId: 't', candidateId: 'c',
      moduleScopeId: 'a'.repeat(64) }, output);
    publishPanelMessage(undefined, { type: 'SERVICE_STATUS',
      status: { retrieval: 'connected', adaptation: 'connected', executionMode: 'real' } }, output);

    expect(api.logLines).toContain('[forexplore] dropped MODULE_TRANSLATION_READY: no panel is attached.');
    expect(api.logLines.some((line) => line.includes('SERVICE_STATUS'))).toBe(false);
  });
});
