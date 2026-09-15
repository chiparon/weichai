import type { WorkspaceTestResult, WorkspaceTestFeedback } from '@forexplore/contracts';

export function BehaviorTestResults({ results, feedback, durationMs }: { results: WorkspaceTestResult[]; feedback?: WorkspaceTestFeedback[]; durationMs?: number }) {
  const statusText = { passed: '通过', failed: '失败', inconclusive: '无法判定', cancelled: '已取消' } as const;
  return <div className="test-results" aria-label="行为测试结果">
    <h3>行为测试结果</h3>
    {durationMs !== undefined ? <p>测试阶段总耗时：{(durationMs / 1000).toFixed(2)} 秒（包含模型调用与测试执行）</p> : null}
    {results.map(result => <details key={result.id} open>
      <summary>{statusText[result.status]} · {result.summary}{result.reportConsistent ? '' : result.report ? ' · agent 报告与宿主证据不一致' : ' · 尚无有效 agent 报告'}</summary>
      <p>状态：{statusText[result.status]} · 清理：{result.cleanup === 'retained' ? '已保留' : result.cleanup === 'removed' ? '已清理' : result.cleanup === 'conflict' ? '清理冲突' : '无需清理'}</p>
      {!result.reportConsistent ? <p role="alert">{result.report ? '宿主判定与 agent 报告不一致，以宿主证据为准。' : '测试 agent 未提交有效报告，无法完成报告校验。'}</p> : null}
      {result.commands.map(command => <details key={command.id} className="test-command"><summary>命令 {command.id} · 退出码 {command.exitCode ?? '未知'} · {command.timedOut ? '超时' : `${Math.round(command.durationMs)} ms`}</summary>
        <p><code>{command.command.executable} {command.command.args.join(' ')}</code></p>
        {command.executedProductionFiles?.length ? <p>实际执行的译后文件：{command.executedProductionFiles.join('、')}</p> : null}
        {command.tests ? <p>测试统计：共 {command.tests.total}，通过 {command.tests.passed}，失败 {command.tests.failed}，跳过 {command.tests.skipped}</p> : null}
        <details><summary>stdout</summary><pre>{command.stdout || '（无输出）'}</pre></details>
        <details><summary>stderr</summary><pre>{command.stderr || '（无输出）'}</pre></details>
      </details>)}
      {result.report?.bugs.length ? <div><h4>{result.reportConsistent && result.status === 'failed' ? '已确认的测试失败' : 'Agent 报告的问题（未获宿主确认）'}</h4>{result.report.bugs.map((bug, index) => <details key={`${bug.summary}:${index}`}><summary>{bug.summary}</summary><p>预期：{bug.expected}</p><p>实际：{bug.actual}</p><p>文件：{bug.testPaths.join('、') || '未提供'}</p></details>)}</div> : null}
    </details>)}
    {feedback?.length ? <div><h3>Translator 修复反馈</h3>{feedback.map(feedback => <details key={`${feedback.testRunId}:${feedback.attempt}`}><summary>第 {feedback.attempt} 次 · {({ pending: '等待修复', repairing: '正在修复', resolved: '已修复并复测通过', exhausted: '修复次数已耗尽' } as const)[feedback.status]} · {feedback.summary}</summary>{feedback.bugs.map((bug, index) => <p key={index}>{bug.summary}：预期 {bug.expected}，实际 {bug.actual}</p>)}</details>)}</div> : null}
  </div>;
}
