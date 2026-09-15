import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { initialWorkflowState } from '@forexplore/workflow-core';
import type { AdaptationResult } from '@forexplore/contracts';
import { PatchStage } from './PatchStage';

it('shows Java test evidence and total time in the actual patch preview and blocks failed tests', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const result: AdaptationResult = {
    strategy: 'translate', targetLanguage: 'Java', generatedCode: '', interfaceMappings: [], files: [], testDurationMs: 12345,
    validation: [{ id: 'behavioral-semantics', label: 'Java behavior tests', required: true, status: 'fail', summary: 'Assertion failed', artifactPath: '/target/.forexplore/adaptation-tests/run/result.json' }],
    testRuns: [{ id: 'test-1', translationRunId: 'run', status: 'failed', summary: 'readBodyData assertion failed', sourceSnapshot: 'hash', cleanup: 'retained', reportConsistent: true,
      report: { outcome: 'failed', summary: 'Wrong length', commandIds: ['cmd'], bugs: [{ summary: 'Wrong length', expected: '3', actual: 'expected:<3> but was:<0>', commandIds: ['cmd'], testPaths: ['.forexplore-tests/GeneratedTest.java'] }] },
      commands: [{ id: 'cmd', command: { executable: 'mvn', args: ['test'] }, cwd: '/isolated', startedAt: '', durationMs: 1200, exitCode: 1, timedOut: false, stdout: 'expected:<3> but was:<0>', stderr: '', sourceSnapshot: 'hash', filesUnchanged: true, executedProductionFiles: ['src/main/java/MultipartStream.java'], tests: { total: 2, passed: 1, failed: 1, skipped: 0 } }] }],
  };
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<PatchStage state={{ ...initialWorkflowState, adaptation: result }} onApply={() => {}} onBack={() => {}} onOpenTarget={() => {}} />));
    expect(node.textContent).toContain('行为测试结果');
    expect(node.textContent).toContain('12.35 秒');
    expect(node.textContent).toContain('测试统计：共 2');
    expect(node.textContent).toContain('mvn test');
    expect(node.textContent).toContain('expected:<3> but was:<0>');
    expect(node.textContent).toContain('/target/.forexplore/adaptation-tests/run/result.json');
    expect([...node.querySelectorAll('button')].find(button => button.textContent?.includes('应用补丁'))?.disabled).toBe(true);
  } finally { await act(async () => root.unmount()); node.remove(); }
});
