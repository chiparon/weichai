import { useEffect, useState } from 'react';
import type { SearchCandidate } from '@forexplore/contracts';
import type { WorkflowState } from '@forexplore/workflow-core';

/** The phases this step performs; a description of the flow, never a progress bar. */
const phases = [
  '已读取目标契约与候选实现',
  '正在生成接口映射（参数 / 返回 / 错误语义）',
  '正在翻译源实现到目标语言',
  '执行编译与集成编译（如服务已配置）',
  '生成工作区补丁预览',
];

function waited(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/**
 * This screen used to animate five hard-coded lines whenever the panel entered
 * the adaptation step, so a workflow whose reply never arrived looked exactly
 * like a running translation.  It now states what is actually true: a request
 * is outstanding and how long it has been outstanding, or nothing is running.
 */
export function AdaptationStage({
  state,
  candidate,
  onBack,
  onRetry,
}: {
  state: WorkflowState;
  candidate: SearchCandidate | null;
  onBack: () => void;
  onRetry: () => void;
}) {
  const waiting = state.pending === 'adapt';
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!waiting) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1_000);
    return () => clearInterval(timer);
  }, [waiting]);

  return (
    <div className="processing">
      {waiting ? (
        <div className="processing-ring" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <div className="eyebrow">CodeAdaptationPort</div>
      <h2>{waiting ? '正在生成接口映射与目标实现' : '当前没有进行中的翻译'}</h2>
      <p>策略：translate · {candidate?.language ?? '?'} → {state.target?.language}</p>
      <p className="muted-copy">
        {waiting
          ? `已向宿主发出翻译请求，正在等待宿主回复（已等待 ${waited(elapsed)}）。`
          : '宿主没有收到任何进行中的请求。上一次流程没有完成或已被丢弃，可以重试。'}
      </p>
      <p className="muted-copy">编译结果是工程检查证据，不等同于业务行为正确性。</p>
      <p className="muted-copy">以下为流程说明，不代表当前进度：</p>
      <ol className="processing-log">
        {phases.map((phase) => <li key={phase}>{phase}</li>)}
      </ol>
      <div className="action-row">
        <button type="button" className="secondary-action" onClick={onBack}>返回方案选择</button>
        <button type="button" className="primary-action" onClick={onRetry}>重新发起翻译</button>
      </div>
    </div>
  );
}
