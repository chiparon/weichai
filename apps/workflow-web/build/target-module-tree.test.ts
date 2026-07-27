// @vitest-environment node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleNode } from '@forexplore/contracts';
import { csharpWorkspaceTree } from '@forexplore/workspace-adapters';
import { describe, expect, it } from 'vitest';
import {
  detectCSharpSourceIssues,
  extractTypeScriptModuleNodes,
  scanCSharpWorkspaceTree,
  scanTargetModuleTree,
} from './target-module-tree';

function flatten(node: ModuleNode): ModuleNode[] {
  return [node, ...(node.children?.flatMap(flatten) ?? [])];
}

describe('target module tree scanner', () => {
  it('extracts real class methods, signatures, lines and implementation status', () => {
    const symbols = extractTypeScriptModuleNodes(
      `export class Example {
  public async ready(value: string): Promise<string> {
    return value;
  }

  public async missing(request: Request): Promise<Result> {
    void request;
    throw new NotImplementedError("Example.missing");
  }
}`,
      'src/example.ts',
    );

    const example = symbols[0];
    expect(example?.name).toBe('Example');
    expect(example?.children?.map((node) => node.name)).toEqual(['ready', 'missing']);
    expect(example?.children?.[0]?.signature).toContain(
      'public async ready(value: string): Promise<string>',
    );
    expect(example?.children?.[0]?.implementationStatus).toBe('implemented');
    expect(example?.children?.[1]?.implementationStatus).toBe('unimplemented');
    expect(example?.children?.[1]?.line).toBe(6);
  });

  it('loads SettlementService from the real target workspace', async () => {
    const workspaceRoot = fileURLToPath(
      new URL('../../../fixtures/target-system/currency-platform', import.meta.url),
    );
    const tree = await scanTargetModuleTree(path.resolve(workspaceRoot));
    const nodes = flatten(tree);
    const settleBatch = nodes.find((node) => node.name === 'settleBatch');

    expect(tree.name).toBe('currency-platform');
    expect(settleBatch?.path).toBe(
      'src/application/settlement/settlement-service.ts',
    );
    expect(settleBatch?.line).toBe(66);
    expect(settleBatch?.signature).toContain(
      'settleBatch(request: SettlementBatchRequest): Promise<SettlementBatchResult>',
    );
    expect(settleBatch?.implementationStatus).toBe('unimplemented');
  });

  it('detects maintenance annotations and executable C# stubs but ignores requirements', () => {
    const issues = detectCSharpSourceIssues(
      `// REQ: this is a contract
// TODO(owner): complete routing
// FIXME remove fallback
throw new NotImplementedException("missing route");
// HACK: temporary
// XXX inspect this`,
      'src/Routing.cs',
    );

    expect(issues.map((issue) => issue.kind)).toEqual([
      'todo',
      'fixme',
      'stub',
      'hack',
      'xxx',
    ]);
    expect(issues[0]?.message).toBe('owner: complete routing');
  });

  it('reports only GetQuoteAsync as incomplete in the real C# workspace', async () => {
    const workspaceRoot = fileURLToPath(
      new URL(
        '../../../fixtures/target-system/forexplore-csharp-workspace',
        import.meta.url,
      ),
    );
    const tree = await scanCSharpWorkspaceTree(
      path.resolve(workspaceRoot),
      csharpWorkspaceTree,
    );
    const nodes = flatten(tree);
    const issueOwners = nodes.filter((node) => node.issues?.length);
    const getQuote = nodes.find((node) => node.name === 'GetQuoteAsync');

    expect(issueOwners.map((node) => node.name)).toEqual(['GetQuoteAsync']);
    expect(getQuote?.issues?.map((issue) => issue.kind)).toEqual(['todo', 'stub']);
    expect(getQuote?.line).toBe(25);
    expect(getQuote?.implementationStatus).toBe('unimplemented');
    expect(
      nodes.find((node) => node.name === 'AuditPipeline')?.implementationStatus,
    ).toBe('implemented');
  });
});
