import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  FileCode2,
  ScanSearch,
} from 'lucide-react';
import type {
  ModuleIssue,
  ModuleIssueKind,
  ModuleNode,
  ModuleTarget,
} from '@forexplore/contracts';
import { toModuleTarget } from '@forexplore/workflow-core';

export interface IncompleteModuleFinding {
  node: ModuleNode;
  target: ModuleTarget | null;
  issues: ModuleIssue[];
}

export interface ProjectReadinessSummary {
  sourceFileCount: number;
  issueCount: number;
  incompleteModuleCount: number;
  findings: IncompleteModuleFinding[];
}

function flattenTree(node: ModuleNode): ModuleNode[] {
  return [node, ...(node.children?.flatMap(flattenTree) ?? [])];
}

function hasIncompleteDescendant(node: ModuleNode): boolean {
  return Boolean(
    node.children?.some(
      (child) =>
        child.implementationStatus === 'unimplemented' ||
        hasIncompleteDescendant(child),
    ),
  );
}

export function summarizeProjectReadiness(
  root: ModuleNode,
): ProjectReadinessSummary {
  const nodes = flattenTree(root);
  const directFindings = nodes
    .filter((node) => Boolean(node.issues?.length))
    .map((node) => ({
      node,
      target: toModuleTarget(node),
      issues: node.issues ?? [],
    }));
  const statusOnlyFindings = nodes
    .filter(
      (node) =>
        node.implementationStatus === 'unimplemented' &&
        !node.issues?.length &&
        !hasIncompleteDescendant(node),
    )
    .map((node) => ({
      node,
      target: toModuleTarget(node),
      issues: [],
    }));
  const findings = [...directFindings, ...statusOnlyFindings].sort(
    (left, right) =>
      left.node.path.localeCompare(right.node.path) ||
      (left.node.line ?? 0) - (right.node.line ?? 0),
  );

  return {
    sourceFileCount: nodes.filter(
      (node) => node.kind === 'file' && /\.(?:cs|ts|tsx)$/iu.test(node.path),
    ).length,
    issueCount: findings.reduce((count, finding) => count + finding.issues.length, 0),
    incompleteModuleCount: findings.length,
    findings,
  };
}

const issueLabels: Record<ModuleIssueKind, string> = {
  todo: 'TODO',
  fixme: 'FIXME',
  hack: 'HACK',
  xxx: 'XXX',
  stub: '未实现异常',
};

function FindingCard({
  finding,
  index,
  onSelect,
}: {
  finding: IncompleteModuleFinding;
  index: number;
  onSelect: (target: ModuleTarget) => void;
}) {
  const content = (
    <>
      <span className="finding-index">{String(index + 1).padStart(2, '0')}</span>
      <span className="finding-copy">
        <span className="finding-heading">
          <strong>{finding.node.name}</strong>
          <span>{finding.node.kind}</span>
        </span>
        <code>
          {finding.node.path}:{finding.node.line ?? finding.issues[0]?.line ?? 1}
        </code>
        {finding.issues.length ? (
          <span className="finding-issues">
            {finding.issues.map((issue) => (
              <span key={issue.id}>
                <em>{issueLabels[issue.kind]}</em>
                {issue.message}
              </span>
            ))}
          </span>
        ) : (
          <span className="finding-issues">
            <span>
              <em>待实现</em>
              符号扫描判定该实现仍为空
            </span>
          </span>
        )}
      </span>
      {finding.target ? <ArrowRight className="finding-arrow" size={17} /> : null}
    </>
  );

  return finding.target ? (
    <button
      type="button"
      className="finding-card"
      aria-label={`打开未完成模块 ${finding.node.name}`}
      onClick={() => onSelect(finding.target!)}
    >
      {content}
    </button>
  ) : (
    <div className="finding-card is-static">{content}</div>
  );
}

export function ProjectReadiness({
  root,
  onSelect,
}: {
  root: ModuleNode;
  onSelect: (target: ModuleTarget) => void;
}) {
  const summary = summarizeProjectReadiness(root);
  const complete = summary.incompleteModuleCount === 0;

  return (
    <section className="project-readiness">
      <header className="readiness-heading">
        <div>
          <div className="eyebrow">Source completion scan</div>
          <h1>
            {complete
              ? '当前没有发现未完成模块'
              : `还剩 ${summary.incompleteModuleCount} 个模块需要补齐`}
          </h1>
          <p>
            从真实目标工作区读取源码标记和占位实现，把可修复的符号直接连接到检索与翻译流程。
          </p>
        </div>
        <span className={`scan-state ${complete ? 'is-complete' : ''}`}>
          {complete ? <CheckCircle2 size={15} /> : <ScanSearch size={15} />}
          {complete ? 'SCAN CLEAN' : 'LIVE SOURCE SCAN'}
        </span>
      </header>

      <div className="readiness-metrics" aria-label="项目完成度概览">
        <div className={complete ? 'is-positive' : 'is-warning'}>
          <CircleAlert size={16} />
          <span>
            <strong>{summary.incompleteModuleCount}</strong>
            <small>未完成模块</small>
          </span>
        </div>
        <div>
          <ScanSearch size={16} />
          <span>
            <strong>{summary.issueCount}</strong>
            <small>源码信号</small>
          </span>
        </div>
        <div>
          <FileCode2 size={16} />
          <span>
            <strong>{summary.sourceFileCount}</strong>
            <small>已扫描文件</small>
          </span>
        </div>
      </div>

      <div className="readiness-grid">
        <section className="finding-panel">
          <header>
            <span>未完成清单</span>
            <em>{summary.incompleteModuleCount} actionable</em>
          </header>
          {summary.findings.length ? (
            <div className="finding-list">
              {summary.findings.map((finding, index) => (
                <FindingCard
                  key={`${finding.node.id}:${finding.issues.map((issue) => issue.id).join(',')}`}
                  finding={finding}
                  index={index}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ) : (
            <div className="finding-empty">
              <CheckCircle2 size={22} />
              <strong>扫描范围内没有占位实现</strong>
              <span>新增 TODO 或未实现异常后，清单会在开发服务器重载时自动更新。</span>
            </div>
          )}
        </section>

        <aside className="scan-rules">
          <div className="panel-caption">识别规则</div>
          <ul>
            <li>
              <code>TODO / FIXME</code>
              <span>显式待办与缺陷注释</span>
            </li>
            <li>
              <code>HACK / XXX</code>
              <span>临时实现和风险标记</span>
            </li>
            <li>
              <code>NotImplementedException</code>
              <span>仍会中断执行的骨架路径</span>
            </li>
          </ul>
          <p>REQ 契约注释不会计入未完成项，避免把验收要求误报成代码缺口。</p>
        </aside>
      </div>
    </section>
  );
}
