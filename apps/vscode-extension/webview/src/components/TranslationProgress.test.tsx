import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { TranslationProgress } from './TranslationProgress';

function run(patch: Partial<WorkspaceTranslationRun> = {}): WorkspaceTranslationRun {
  return { id: 'be20a046-55bb-432e-b60c-514279066fe7', workspaceRoot: '/target', status: 'analyzing',
    request: { spec: 'Servlet', sourceLanguage: 'C#', targetLanguage: 'Java', context: [],
      workspaceFiles: ['a.java', 'b.java'], writeFiles: ['a.java', 'b.java'] },
    createdAt: new Date(Date.now() - 12_000).toISOString(), updatedAt: '', completedSteps: [], changes: [],
    compilations: [], modelTurns: 4, acceptance: 'compilation-only', ...patch };
}

describe('TranslationProgress', () => {
  it('animates the phases the module flow performs', () => {
    const markup = renderToStaticMarkup(<TranslationProgress run={run()} />);

    expect(markup).toContain('processing-ring');
    expect(markup).toContain('正在生成接口映射与目标实现');
    for (const phase of ['已读取目标契约与候选实现', '正在生成接口映射（参数 / 返回 / 错误语义）',
      '正在翻译源实现到目标语言', '执行编译与集成编译（如服务已配置）', '生成工作区补丁预览']) {
      expect(markup).toContain(phase);
    }
    // analyzing covers the first two phases only.
    expect(markup.match(/is-active/g)).toHaveLength(2);
    expect(markup).toContain('制定计划');
    expect(markup).toContain('已用时');
  });

  it('advances the phases and reports real counters from the run record', () => {
    const check = { command: { executable: 'node', args: ['tools/compile.mjs'] }, startedAt: '', durationMs: 1,
      exitCode: 0, success: true, output: '', diagnostics: [] };
    const markup = renderToStaticMarkup(<TranslationProgress run={run({ status: 'testing',
      changes: [{ path: 'a.java', before: '// a', after: '// x', applied: true },
        { path: 'b.java', before: '// b', after: '// y', applied: false }],
      compilations: [check],
      verification: { command: { executable: 'node', args: ['tools/verify.mjs'] }, criteria: [], runs: [
        { ...check, sourceSnapshot: 'snapshot', planHash: 'plan', filesUnchanged: true }] },
      completedSteps: ['step-1', 'step-2'], modelTurns: 17 })} />);

    expect(markup.match(/is-active/g)).toHaveLength(5);
    expect(markup).toContain('行为测试');
    expect(markup).toContain('已写入 1/2 个文件');
    expect(markup).toContain('编译 1 次');
    expect(markup).toContain('行为测试 1 次');
    expect(markup).toContain('模型轮次 17');
    expect(markup).toContain('已完成计划步骤 2');
  });

  it('offers cancelling without leaving the animation', () => {
    const onCancel = vi.fn();
    const markup = renderToStaticMarkup(<TranslationProgress run={run({ status: 'translating' })} onCancel={onCancel} />);

    expect(markup).toContain('取消运行');
    expect(markup.match(/is-active/g)).toHaveLength(3);
  });
});
