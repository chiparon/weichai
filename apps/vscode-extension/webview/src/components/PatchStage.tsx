import { Check, FilePlus2, FileSymlink, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import { canApplyAdaptation, evaluateValidationGate, type WorkflowState } from '@forexplore/workflow-core';

interface PatchStageProps {
  state: WorkflowState;
  onApply: () => void;
  onBack: () => void;
  onOpenTarget: () => void;
  onValidator: () => void;
}

export function PatchStage({ state, onApply, onBack, onOpenTarget, onValidator }: PatchStageProps) {
  const result = state.adaptation;
  if (!result) return null;
  const applying = state.pending === 'apply';
  const additions = result.files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = result.files.reduce((sum, file) => sum + file.deletions, 0);
  const gate = evaluateValidationGate(result.validation);
  const canApply = canApplyAdaptation(result);
  const visibleValidation = result.validation.filter((item) => item.id !== 'standalone-compile');

  return (
    <div className="stage-stack">
      <div className="card-heading">
        <span>05 · 校验与回填预览</span>
        <span className="card-heading-meta">
          {result.files.length} files · +{additions} / −{deletions} · {result.strategy}
        </span>
      </div>

      {state.applyResult ? (
        <section className="card apply-success" role="status">
          <span className="success-mark">
            <Check size={20} />
          </span>
          <div>
            <h3>补丁已应用到当前目标</h3>
            <p>
              已处理 {state.applyResult.appliedFiles.length} 个文件；检查点：
              <code>{state.applyResult.checkpointId}</code>
              {state.applyResult.rollbackAvailable ? '（可通过命令恢复）' : '（不可恢复）'}
            </p>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3 className="section-title">
          <ShieldCheck size={14} /> 验证证据
        </h3>
        <ul className="validation-list">
          {visibleValidation.map((item) => (
            <li key={item.id} className={`validation is-${item.status}`}>
              {item.status === 'pass' ? <Check size={13} /> : <TriangleAlert size={13} />}
              <span>
                <strong>{item.label} {item.required ? '（必需）' : '（可选）'}</strong>
                <small>{item.summary}</small>
                {item.command ? <small>命令：<code>{item.command}</code></small> : null}
                {item.failureReason ? <small>原因：{item.failureReason}</small> : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted-copy">
          LSP 通过只表示候选类没有引入新的语言诊断；业务行为由 Validator 独立确认。
        </p>
        {!gate.allowed ? (
          <p className="validation-blocker" role="alert">
            写回已阻止：{gate.blockers.map((item) => item.label).join('、')} 尚未满足。
          </p>
        ) : null}
      </section>

      {result.interfaceMappings.length > 0 ? (
        <section className="card">
          <h3 className="section-title">
            <FileSymlink size={14} /> 接口映射
          </h3>
          <ul className="mapping-list">
            {result.interfaceMappings.map((mapping) => (
              <li key={`${mapping.source}-${mapping.target}`}>
                <code>{mapping.source}</code>
                <span className="mapping-action">{mapping.action}</span>
                <code>{mapping.target}</code>
                <small>{mapping.note}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.modificationPlan && result.modificationPlan.length > 0 ? (
        <section className="card">
          <h3 className="section-title">修改计划</h3>
          <ol className="mapping-list">
            {result.modificationPlan.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ol>
        </section>
      ) : null}

      {result.lspValidation ? (
        <section className="card">
          <h3 className="section-title"><ShieldCheck size={14} /> LSP 迭代</h3>
          <ul className="mapping-list">
            {result.lspValidation.attempts.map((attempt) => (
              <li key={attempt.index}>
                第 {attempt.index} 轮 · {attempt.outcome} · {attempt.diagnostics.length} 个新增错误 · {attempt.durationMs} ms
              </li>
            ))}
          </ul>
          {result.lspValidation.detail ? <p className="muted-copy">{result.lspValidation.detail}</p> : null}
        </section>
      ) : null}

      {result.files.map((file) => (
        <section className="card file-diff" key={file.path}>
          <header className="file-diff-heading">
            <span>
              <FilePlus2 size={13} /> {file.path}
            </span>
            <span>
              +{file.additions} −{file.deletions}
              <button
                type="button"
                className="text-button"
                onClick={onOpenTarget}
              >
                打开文件
              </button>
            </span>
          </header>
          {file.hunks.map((hunk) => (
            <div className="diff-hunk" key={hunk.header}>
              <div className="diff-hunk-header">{hunk.header}</div>
              {hunk.lines.map((line, index) => (
                <div className={`diff-line is-${line.type}`} key={`${index}-${line.content}`}>
                  <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
                  <code>{line.content || ' '}</code>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}

      {!state.applyResult ? (
        <div className="action-row">
          <button type="button" className="secondary-action" onClick={onBack} disabled={applying}>
            返回方案选择
          </button>
          <button
            type="button"
            className="secondary-action"
            onClick={onValidator}
            disabled={!result.validatorHandoff}
            title={result.validatorHandoff ? '发送结构化 handoff 给 Validator' : 'LSP 尚未通过'}
          >
            <Send size={15} />
            交给 Validator
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={onApply}
            disabled={applying || !canApply}
            title={canApply ? '应用已审阅、已验证的当前补丁' : '必需验证尚未通过或尚未验证，不能写回'}
          >
            {applying ? <span className="spinner" /> : <Check size={15} />}
            {applying ? '正在写入工作区…' : '应用补丁到工作区'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
