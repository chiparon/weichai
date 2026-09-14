import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SearchCandidate } from '@forexplore/contracts';
import { initialWorkflowState, type WorkflowState } from '@forexplore/workflow-core';
import { AdaptationStage } from './AdaptationStage';

const candidate: SearchCandidate = { id: 'history-module', title: 'Java limit module', kind: 'module', language: 'Java',
  repository: 'History', path: 'Limit.java', signature: 'limit(int)', summary: 'Boundary policy', preview: 'class Limit {}',
  license: 'MIT', dependencies: [], compatibility: [], risks: [], score: { overall: 0.9, semantic: 0.9, symbol: 1, contract: 1 } };

function state(patch: Partial<WorkflowState>): WorkflowState {
  return { ...initialWorkflowState, target: { id: 'target', name: 'Target', kind: 'module', language: 'TypeScript',
    path: 'target.ts', signature: '' }, ...patch };
}

function markup(patch: Partial<WorkflowState>): string {
  return renderToStaticMarkup(
    <AdaptationStage state={state(patch)} candidate={candidate} onBack={vi.fn()} onRetry={vi.fn()} />,
  );
}

describe('AdaptationStage', () => {
  it('states that nothing is running instead of animating progress nothing backs', () => {
    // The panel reached this step without an outstanding request: showing the
    // five-phase animation here was what made a dead workflow look busy.
    const html = markup({ stage: 'adaptation', pending: null });

    expect(html).toContain('当前没有进行中的翻译');
    expect(html).toContain('宿主没有收到任何进行中的请求');
    expect(html).not.toContain('processing-ring');
    expect(html).toContain('返回方案选择');
    expect(html).toContain('重新发起翻译');
  });

  it('describes the phases as a flow and reports how long the request has been waiting', () => {
    const html = markup({ stage: 'adaptation', pending: 'adapt' });

    expect(html).toContain('正在生成接口映射与目标实现');
    expect(html).toContain('已向宿主发出翻译请求，正在等待宿主回复');
    expect(html).toContain('已等待 0 秒');
    expect(html).toContain('以下为流程说明，不代表当前进度');
    // The phase list itself is no longer a progress indicator.
    expect(html).not.toContain('is-active');
    expect(html).toContain('processing-ring');
  });
});
