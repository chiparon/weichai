import { useEffect, useState } from 'react';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';

/** The phases one module translation performs, in order. */
const phases = [
  '已读取目标契约与候选实现',
  '正在生成接口映射（参数 / 返回 / 错误语义）',
  '正在翻译源实现到目标语言',
  '执行编译与集成编译（如服务已配置）',
  '生成工作区补丁预览',
];

/**
 * Which phase the host reports.  Derived from the real run status, so the ring
 * only ever animates while the service is actually working.
 */
const phaseByStatus: Partial<Record<WorkspaceTranslationRun['status'], number>> = {
  analyzing: 1, translating: 2, compiling: 3, testing: 4, 'rolling-back': 4, completed: 4,
};

const statusLabels: Partial<Record<WorkspaceTranslationRun['status'], string>> = {
  analyzing: '制定计划', translating: '生成代码', compiling: '编译检查', testing: '行为测试',
  'rolling-back': '正在回滚', completed: '执行完成，待审阅',
};

function elapsed(createdAt: string): string {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/**
 * The animated progress the workbench shows while a module translation runs.
 * Every highlighted phase and every counter comes from the run record, so this
 * is progress rather than decoration.
 */
export function TranslationProgress({ run, onCancel }: {
  run: WorkspaceTranslationRun;
  onCancel?: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);

  const current = phaseByStatus[run.status] ?? 0;
  const written = run.changes.filter((change) => change.applied).length;
  const compileRuns = run.compilations.length;
  const verificationRuns = run.verification?.runs.length ?? 0;

  return (
    <div className="processing">
      <div className="processing-ring" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="eyebrow">CodeAdaptationPort</div>
      <h2>正在生成接口映射与目标实现</h2>
      <p role="status">
        {statusLabels[run.status] ?? run.status} · 运行 {run.id.slice(0, 8)} · 已用时 {elapsed(run.createdAt)}
      </p>
      <p className="muted-copy">
        已写入 {written}/{run.request.writeFiles.length} 个文件 · 编译 {compileRuns} 次 · 行为测试 {verificationRuns} 次
        · 模型轮次 {run.modelTurns}
        {run.completedSteps.length ? ` · 已完成计划步骤 ${run.completedSteps.length}` : ''}
      </p>
      <p className="muted-copy">编译结果是工程检查证据，不等同于业务行为正确性。</p>
      <ol className="processing-log">
        {phases.map((phase, index) => (
          <li key={phase} className={index <= current ? 'is-active' : ''}>{phase}</li>
        ))}
      </ol>
      {onCancel ? (
        <div className="action-row">
          <button type="button" className="secondary-action" onClick={onCancel}>取消运行</button>
        </div>
      ) : null}
    </div>
  );
}
