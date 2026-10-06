import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { WorkspaceTranslationHost } from './workspace-translation-host';

const workspaceRoot = process.cwd();
const token = 'fixed-test-token-with-at-least-32-characters';
const profile = JSON.stringify({
  workspaceRoot, sourceLanguage: 'Java', targetLanguage: 'Java',
  workspaceFiles: ['src/main/java/a/MultipartStream.java'], writeFiles: ['src/main/java/a/MultipartStream.java'],
});

interface Request { url: string; method: string; body: Record<string, any> | undefined }

const requests: Request[] = [];
let nextRun: Partial<WorkspaceTranslationRun> = {};

function stubServer(behavioralVerification = true): void {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/v1/workspace-translations/configuration')) {
      return new Response(JSON.stringify({ workspaceRoot, behavioralVerification }), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ id: '11111111-2222-3333-4444-555555555555', workspaceRoot, status: 'analyzing', ...nextRun }), { status: 202 });
    }
    return new Response(JSON.stringify({ id: '11111111-2222-3333-4444-555555555555', workspaceRoot, status: 'completed', ...nextRun }), { status: 200 });
  }));
}

function host(): WorkspaceTranslationHost {
  return new WorkspaceTranslationHost(() => ({ url: 'http://127.0.0.1:8790', token, profile }));
}


afterEach(() => {
  requests.length = 0;
  nextRun = {};
  vi.unstubAllGlobals();
});

describe('workspace translation host', () => {
  it('keeps the static single-workspace profile as the fallback', async () => {
    stubServer();
    const response = await host().handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe-1', action: 'describe' });
    expect(response.type).toBe('WORKSPACE_TRANSLATION_RESULT');
    if (response.type !== 'WORKSPACE_TRANSLATION_RESULT') throw new Error('unreachable');
    expect(response.profile).toMatchObject({ workspaceRoot, writeFiles: ['src/main/java/a/MultipartStream.java'], behavioralVerification: true });
    expect(response.profile?.moduleScopeId).toBeUndefined();
    expect(response.profile?.profileId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires a selected module scope before starting', async () => {
    stubServer();
    const instance = host();
    const described = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe-2', action: 'describe' });
    const profileId = described.type === 'WORKSPACE_TRANSLATION_RESULT' ? described.profile!.profileId : '';
    const refused = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'start-1', action: 'start', profileId });
    expect(refused).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR', message: expect.stringContaining('模块翻译缺少可用上下文') });
    const forged = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'start-2', action: 'start', profileId: 'deadbeef' });
    expect(forged).toMatchObject({ type: 'WORKSPACE_TRANSLATION_ERROR', message: expect.stringContaining('翻译配置已变化') });
  });

  it('runs a module-scoped translation without a task packet', async () => {
    stubServer();
    const instance = host();
    const scopeId = instance.rememberModuleScope({
      label: '模块 Multipart 流解析',
      spec: '# 模块级翻译任务：Multipart 流解析\n允许修改的文件（writeFiles）：src/main/java/a/MultipartStream.java',
      profile: { workspaceRoot, sourceLanguage: 'Java', targetLanguage: 'Java',
        workspaceFiles: ['src/main/java/a/MultipartStream.java', 'src/main/java/a/ItemInputStream.java'],
        writeFiles: ['src/main/java/a/MultipartStream.java'] },
      evidenceScopes: [{ repositoryId: 'repo-history', analysisRevision: 'analysis-1', projectId: 'project-1' }],
      context: [
        { id: 'module-target', kind: 'summary', content: '目标模块：Multipart 流解析' },
        { id: 'module-candidate:repo-history:module-multipart', kind: 'summary', content: '历史候选模块：MultipartStream.cs' },
        { id: 'module-interface:repo-history:module-multipart', kind: 'interface', content: 'int ReadBodyData(Stream?)', repository: 'repo-history', revision: 'analysis-1' },
      ],
      warnings: ['尚未选择历史候选模块；本次翻译只依据目标模块自身与已勾选的任务证据。'],
    });
    expect(scopeId).toMatch(/^[a-f0-9]{64}$/);

    const described = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe-3', action: 'describe', moduleScopeId: scopeId });
    if (described.type !== 'WORKSPACE_TRANSLATION_RESULT') throw new Error('unreachable');
    expect(described.profile).toMatchObject({ moduleScopeId: scopeId, label: '模块 Multipart 流解析', behavioralVerification: true });
    expect(described.profile?.warnings).toHaveLength(1);
    expect(described.profile?.profileId).not.toBe(await describeStaticProfileId());

    const started = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'start-3', action: 'start',
      profileId: described.profile!.profileId, moduleScopeId: scopeId });
    expect(started.type).toBe('WORKSPACE_TRANSLATION_RESULT');
    const posted = requests.find((request) => request.method === 'POST' && request.url.endsWith('/v1/workspace-translations'));
    expect(posted?.body).toBeDefined();
    expect(posted!.body).toMatchObject({ sourceLanguage: 'Java', targetLanguage: 'Java' });
    expect(posted!.body!.writeFiles).toEqual(['src/main/java/a/MultipartStream.java']);
    expect(posted!.body!.context.map((item: { id: string }) => item.id)).toEqual([
      'module-target', 'module-candidate:repo-history:module-multipart', 'module-interface:repo-history:module-multipart',
    ]);
    // The agent may query exactly the reviewed revisions, nothing else.
    expect(posted!.body!.evidenceScopes).toEqual([{ repositoryId: 'repo-history', analysisRevision: 'analysis-1', projectId: 'project-1' }]);
    expect(posted!.body!.spec).toContain('# 模块级翻译任务：Multipart 流解析');
  });

  it('keeps the history-view root out of webview run responses', async () => {
    nextRun = { request: {
      spec: 'task', sourceLanguage: 'Java', targetLanguage: 'Java', context: [{ id: 'x', kind: 'summary', content: 'x' }],
      workspaceFiles: ['src/main/java/a/MultipartStream.java'], writeFiles: ['src/main/java/a/MultipartStream.java'],
      historyView: { root: '/tmp/private-history-view', files: ['Legacy.java'], repositoryId: 'history', analysisRevision: 'rev', moduleId: 'm', manifestHash: 'a'.repeat(64) },
    } };
    stubServer();
    const instance = host();
    const scopeId = instance.rememberModuleScope({
      label: 'scope', spec: 'task',
      profile: { workspaceRoot, sourceLanguage: 'Java', targetLanguage: 'Java', workspaceFiles: ['src/main/java/a/MultipartStream.java'], writeFiles: ['src/main/java/a/MultipartStream.java'] },
      context: [{ id: 'x', kind: 'summary', content: 'x' }],
      historyView: { root: '/tmp/private-history-view', files: ['Legacy.java'], repositoryId: 'history', analysisRevision: 'rev', moduleId: 'm', manifestHash: 'a'.repeat(64) },
    });
    const described = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe-hidden-root', action: 'describe', moduleScopeId: scopeId });
    if (described.type !== 'WORKSPACE_TRANSLATION_RESULT') throw new Error('unreachable');
    const response = await instance.handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'start-hidden-root', action: 'start', moduleScopeId: scopeId, profileId: described.profile!.profileId });
    expect(response.type).toBe('WORKSPACE_TRANSLATION_RESULT');
    if (response.type !== 'WORKSPACE_TRANSLATION_RESULT') throw new Error('unreachable');
    expect(response.run?.request.historyView).toBeUndefined();
  });

});

async function describeStaticProfileId(): Promise<string> {
  stubServer();
  const response = await host().handle({ type: 'WORKSPACE_TRANSLATION', requestId: 'describe-static', action: 'describe' });
  return response.type === 'WORKSPACE_TRANSLATION_RESULT' ? response.profile!.profileId : '';
}
