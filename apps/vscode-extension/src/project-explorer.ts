import path from 'node:path';
import type { StructuralIndex } from '@forexplore/contracts';
import type { CodeIntelligenceHost } from './code-intelligence-host';
import { emptyTargetWorkspace } from './module-explorer';
import type { ModuleExplorerNode, ModuleExplorerPresentation, ModuleWorkspacePresentation } from './ui-types';

/** Descriptive project analysis never mints reviewed-catalog migration identities. */
export async function buildProjectExplorer(
  host: Pick<CodeIntelligenceHost, 'explorerData'>,
): Promise<{ presentation: ModuleExplorerPresentation }> {
  const data = await host.explorerData();
  let target = emptyTargetWorkspace('选择目标项目', '', false);
  const history: ModuleWorkspacePresentation[] = [];
  for (const entry of data) {
    const { index, projectId, repository, analysis } = entry;
    const project = index.projects.find((candidate) => candidate.projectId === projectId);
    if (!project) continue;
    const files = index.files.filter((file) => file.projectId === projectId);
    const paths = new Set(files.map((file) => file.relativePath));
    const symbols = index.symbols.filter((symbol) => paths.has(symbol.relativePath));
    const dependencies = index.dependencyEdges.filter((edge) => paths.has(edge.sourceRelativePath));
    const diagnostics = index.diagnostics.filter((diagnostic) => !diagnostic.relativePath || paths.has(diagnostic.relativePath));
    const byPath = new Map(files.map((file) => [file.relativePath, projectFileNode(file, symbols)]));
    const mode = entry.selectedTarget ? 'target' : 'history';
    const historical = index.analysisRevision !== repository.activeRevision;
    const tree: ModuleExplorerNode[] = analysis?.proposal
      ? analysis.proposal.modules.map((module) => ({
        id: `module:${module.id}`, kind: 'module', name: module.name,
        description: module.description, purpose: module.purpose, coreApis: module.coreApis,
        domain: module.domain, language: module.language,
        children: module.sourceFiles.flatMap((filePath) => byPath.get(filePath) ? [byPath.get(filePath)!] : []),
      }))
      : [{ id: 'files', kind: 'folder', name: `${project.displayName}（文件视图）`, children: [...byPath.values()] }];
    if (analysis?.proposal) {
      const assigned = new Set(analysis.proposal.modules.flatMap((module) => module.sourceFiles));
      const unassigned = [...byPath].filter(([filePath]) => !assigned.has(filePath)).map(([, node]) => node);
      if (unassigned.length) tree.push({ id: 'unassigned', kind: 'folder', name: '未归属文件', children: unassigned });
    }
    const workspace: ModuleWorkspacePresentation = {
      id: repository.repositoryId,
      repositoryId: repository.repositoryId,
      projectId,
      mode,
      name: `${repository.displayName} / ${project.displayName}`,
      rootLabel: project.relativePath || '.',
      snapshotId: index.analysisRevision,
      revision: index.analysisRevision,
      analysis,
      dependencies,
      diagnostics,
      lifecycle: {
        stage: historical ? 'historical-analysis' : analysis?.state ?? 'indexed',
        label: '项目分析（只读）',
        message: '自动分析只用于浏览；迁移仍需独立审阅模块目录、映射与执行路线。',
        ready: false,
        publicationActive: false,
      },
      stats: {
        modules: analysis?.proposal?.modules.length ?? 0,
        files: files.length,
        types: symbols.filter((symbol) => typeKinds.has(symbol.kind)).length,
        methods: symbols.filter((symbol) => callableKinds.has(symbol.kind)).length,
        implemented: 0,
        unimplemented: 0,
        partial: 0,
        unknown: symbols.filter((symbol) => callableKinds.has(symbol.kind)).length,
        notApplicable: 0,
        dependencies: dependencies.length,
      },
      summary: { exists: Boolean(analysis?.proposal), path: '', status: analysis?.state },
      tree,
    };
    if (entry.selectedTarget) target = workspace;
    else if (repository.role === 'history') history.push(workspace);
  }
  return { presentation: { generatedAt: new Date().toISOString(), target, history } };
}

const typeKinds = new Set(['class', 'interface', 'record', 'struct', 'enum']);
const callableKinds = new Set(['method', 'constructor', 'function']);

function projectFileNode(
  file: StructuralIndex['files'][number],
  symbols: StructuralIndex['symbols'],
): ModuleExplorerNode {
  const visible = symbols.filter((symbol) => symbol.relativePath === file.relativePath)
    .sort((left, right) => left.sourceRange.startLine - right.sourceRange.startLine);
  const types = visible.filter((symbol) => typeKinds.has(symbol.kind));
  const members = visible.filter((symbol) => callableKinds.has(symbol.kind));
  const claimed = new Set<string>();
  const children = types.map((type) => {
    const node = projectSymbolNode(type);
    node.children = members.filter((member) => member.qualifiedName.startsWith(`${type.qualifiedName}.`))
      .map((member) => {
        claimed.add(member.symbolKey);
        return projectSymbolNode(member);
      });
    return node;
  });
  children.push(...members.filter((member) => !claimed.has(member.symbolKey)).map(projectSymbolNode));
  return {
    id: `file:${file.relativePath}`, name: path.posix.basename(file.relativePath),
    kind: 'file', path: file.relativePath, language: file.languageId, children,
  };
}

function projectSymbolNode(symbol: StructuralIndex['symbols'][number]): ModuleExplorerNode {
  return {
    id: `symbol:${symbol.symbolKey}`, name: symbol.name,
    kind: symbol.kind as ModuleExplorerNode['kind'],
    path: symbol.relativePath, language: symbol.languageId,
    signature: symbol.signature, line: symbol.sourceRange.startLine,
    ...(callableKinds.has(symbol.kind) ? { implementationStatus: 'unknown' as const } : {}),
    children: [],
  };
}
