import type { SearchCandidate, TranslationAttempt } from '@forexplore/contracts';
import type { WorkflowState } from '@forexplore/workflow-core';

export function AdaptationStage({
  state,
  candidate,
  attempts,
  remainingMs,
}: {
  state: WorkflowState;
  candidate: SearchCandidate | null;
  attempts: TranslationAttempt[];
  remainingMs: number;
}) {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1_000));

  return (
    <div className="processing">
      <div className="processing-ring" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="eyebrow">LanguageIntelligencePort</div>
      <h2>正在翻译完整目标类</h2>
      <p>translate · {candidate?.language ?? '?'} class → {state.target?.language} class</p>
      <p className="muted-copy">共享时限剩余 {seconds || '—'} 秒</p>
      <ol className="processing-log">
        <li className="is-active">Analyzer 已接收类级上下文、定义与引用</li>
        {attempts.map((attempt) => (
          <li key={attempt.index} className="is-active">
            第 {attempt.index} 轮 · {attempt.outcome} · {attempt.diagnostics.length} 个新增错误 · {attempt.durationMs} ms
          </li>
        ))}
        {attempts.length === 0 ? <li className="is-active">Translator 正在生成首个候选类</li> : null}
      </ol>
    </div>
  );
}
