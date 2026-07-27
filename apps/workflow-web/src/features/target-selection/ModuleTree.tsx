import { useMemo, useState } from 'react';
import {
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { ModuleKind, ModuleNode, ModuleTarget } from '@forexplore/contracts';
import { toModuleTarget } from '@forexplore/workflow-core';

interface ModuleTreeProps {
  root: ModuleNode;
  selectedId: string | null;
  onSelect: (target: ModuleTarget) => void;
}

function collectInitialExpandedIds(
  node: ModuleNode,
  result: string[] = [],
  depth = 0,
): string[] {
  if (!node.children?.length || depth > 1) return result;
  result.push(node.id);
  node.children
    .filter((child) => child.kind === 'folder')
    .forEach((child) => collectInitialExpandedIds(child, result, depth + 1));
  return result;
}

function NodeIcon({ node, expanded }: { node: ModuleNode; expanded: boolean }) {
  if (node.kind === 'workspace' || node.kind === 'folder') {
    return expanded ? <FolderOpen size={14} /> : <Folder size={14} />;
  }
  if (node.kind === 'file') return <FileCode2 size={14} />;
  if (node.kind === 'class' || node.kind === 'record') return <Box size={14} />;
  return <Braces size={14} />;
}

const kindLabels: Partial<Record<ModuleKind, string>> = {
  class: 'cls',
  record: 'rec',
  interface: 'ifc',
  function: 'fn',
};

function collectIncompleteCounts(
  node: ModuleNode,
  counts = new Map<string, number>(),
): Map<string, number> {
  const childCount = (node.children ?? []).reduce((count, child) => {
    collectIncompleteCounts(child, counts);
    return count + (counts.get(child.id) ?? 0);
  }, 0);
  const ownCount =
    node.issues?.length || (node.implementationStatus === 'unimplemented' && childCount === 0)
      ? 1
      : 0;
  counts.set(node.id, childCount + ownCount);
  return counts;
}

export function ModuleTree({ root, selectedId, onSelect }: ModuleTreeProps) {
  const initialExpanded = useMemo(() => new Set(collectInitialExpandedIds(root)), [root]);
  const incompleteCounts = useMemo(() => collectIncompleteCounts(root), [root]);
  const [expanded, setExpanded] = useState(initialExpanded);

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: ModuleNode, depth: number) {
    const hasChildren = Boolean(node.children?.length);
    const isExpanded = expanded.has(node.id);
    const target = toModuleTarget(node);
    const isSelectable = Boolean(target);
    const isSelected = selectedId === node.id;
    const incompleteCount = incompleteCounts.get(node.id) ?? 0;

    return (
      <div key={node.id}>
        <button
          type="button"
          className={`tree-row ${isSelectable ? 'is-selectable' : ''} ${
            isSelected ? 'is-selected' : ''
          }`}
          style={{ paddingInlineStart: 8 + depth * 14 }}
          aria-selected={isSelected}
          onClick={() => {
            if (target) onSelect(target);
            if (hasChildren) toggle(node.id);
          }}
        >
          <span
            className="tree-chevron"
            onClick={(event) => {
              if (!hasChildren) return;
              event.stopPropagation();
              toggle(node.id);
            }}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : null}
          </span>
          <span className={`tree-icon tree-icon-${node.kind}`}>
            <NodeIcon node={node} expanded={isExpanded} />
          </span>
          <span className="tree-label">{node.name}</span>
          {incompleteCount > 0 ? (
            <span
              className="tree-status"
              title={`${incompleteCount} 个待补齐符号`}
              aria-hidden="true"
            >
              {incompleteCount}
            </span>
          ) : null}
          {kindLabels[node.kind] ? <span className="tree-kind">{kindLabels[node.kind]}</span> : null}
        </button>
        {hasChildren && isExpanded
          ? node.children?.map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  }

  return <div className="module-tree">{renderNode(root, 0)}</div>;
}
