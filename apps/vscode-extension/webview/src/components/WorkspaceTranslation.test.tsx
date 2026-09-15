import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { WorkspaceTranslation } from './WorkspaceTranslation';
import type { TranslationProvider } from '../workspace-translation-provider';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); });
it('previews the destination, starts with evidence IDs, reviews failed tests and rolls back', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const run: WorkspaceTranslationRun = { id: '12345678-1234-1234-1234-123456789012', workspaceRoot: '/target', status: 'failed',
    request: { spec: 'Limit', sourceLanguage: 'Java', targetLanguage: 'TypeScript', context: [], workspaceFiles: ['limit.ts'], writeFiles: ['limit.ts'] },
    createdAt: '', updatedAt: '', completedSteps: [], changes: [{ path: 'limit.ts', before: '// old', after: '// wrong', applied: true }], compilations: [], modelTurns: 3,
    acceptance: 'compilation-only', error: 'Negative input test failed' };
  const provider = vi.fn<TranslationProvider>(async intent => ({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: 'reply',
    ...(intent.action === 'describe' ? { profile: { profileId: 'profile-1', workspaceRoot: '/target', sourceLanguage: 'Java', targetLanguage: 'TypeScript', workspaceFiles: ['limit.ts'], writeFiles: ['limit.ts'], behavioralVerification: true } }
      : { run: intent.action === 'rollback' ? { ...run, status: 'rolled-back' } : run }) }));
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<WorkspaceTranslation provider={provider} packetId="packet-1" evidenceIds={['source-1']} />));
  expect(container.textContent).toContain('/target');
  expect(container.textContent).toContain('limit.ts');
  const button = (text: string) => [...container.querySelectorAll('button')].find(item => item.textContent === text)!;
  await act(async () => button('使用所选证据生成代码').click());
  expect(provider).toHaveBeenLastCalledWith({ action: 'start', profileId: 'profile-1', packetId: 'packet-1', evidenceIds: ['source-1'] });
  expect(container.textContent).toContain('Negative input test failed');
  expect(container.textContent).toContain('尚无行为验收通过记录');
  expect(container.textContent).toContain('// old');
  expect(container.textContent).toContain('// wrong');
  await act(async () => button('回滚本次修改').click());
  expect(provider).toHaveBeenLastCalledWith({ action: 'rollback', runId: run.id });
  expect(container.textContent).toContain('已回滚');
});


it.each(['failed', 'inconclusive', 'cancelled', 'passed'] as const)('shows host evidence and repair history (%s)', async status => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const bug = { summary: 'Wrong result', expected: '3', actual: '2', commandIds: ['cmd-1'], testPaths: ['.forexplore-tests/limit.test.mjs'] };
  const run: WorkspaceTranslationRun = { id: 'run', workspaceRoot: '/target', status: status === 'passed' ? 'completed' : 'failed',
    request: { spec: 'Limit', sourceLanguage: 'Python', targetLanguage: 'JavaScript', context: [], workspaceFiles: [], writeFiles: [] },
    createdAt: '', updatedAt: '', completedSteps: [], changes: [], compilations: [], modelTurns: 1, acceptance: status === 'passed' ? 'behavior-verified' : 'compilation-only',
    testRuns: [{ id: 'test-1', translationRunId: 'run', status, summary: 'Host observation', sourceSnapshot: 'hash', cleanup: 'removed', reportConsistent: status !== 'inconclusive' && status !== 'cancelled',
      ...(status === 'cancelled' ? {} : { report: { outcome: status === 'passed' ? 'passed' : 'failed', summary: 'Agent observation', commandIds: ['cmd-1'], bugs: status === 'passed' ? [] : [bug] } }),
      commands: [{ id: 'cmd-1', command: { executable: 'node', args: ['--test'] }, cwd: '/target', startedAt: '', durationMs: 42, exitCode: status === 'passed' ? 0 : 1, timedOut: false, stdout: 'real stdout', stderr: 'real stderr', sourceSnapshot: 'hash', filesUnchanged: true,
        ...(status === 'cancelled' ? {} : { tests: { total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'passed' ? 0 : 1, skipped: 0 } }) }] }],
    testFeedback: [{ testRunId: 'test-1', attempt: 1, summary: 'Repair', bugs: [bug], status: status === 'passed' ? 'resolved' : 'exhausted' }] };
  const provider: TranslationProvider = async intent => ({ type: 'WORKSPACE_TRANSLATION_RESULT', requestId: 'reply',
    ...(intent.action === 'describe' ? { profile: { profileId: 'profile', workspaceRoot: '/target', sourceLanguage: 'Python', targetLanguage: 'JavaScript', workspaceFiles: [], writeFiles: [], behavioralVerification: true } } : { run }) });
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<WorkspaceTranslation provider={provider} packetId="packet" evidenceIds={['source']} />));
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '使用所选证据生成代码')!.click());
  expect(container.textContent).toContain('Host observation');
  expect(container.textContent).toContain('node --test');
  expect(container.textContent).toContain('real stdout');
  expect(container.textContent).toContain('real stderr');
  expect(container.textContent).toContain(status === 'passed' ? '已修复并复测通过' : '修复次数已耗尽');
  if (status === 'inconclusive') expect(container.textContent).toContain('未获宿主确认');
  if (status === 'cancelled') { expect(container.textContent).toContain('尚无有效 agent 报告'); expect(container.textContent).not.toContain('测试统计'); }
  else expect(container.textContent).toContain('测试统计：共 1');
});
