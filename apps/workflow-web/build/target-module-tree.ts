import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ImplementationStatus,
  ModuleIssue,
  ModuleIssueKind,
  ModuleNode,
} from '@forexplore/contracts';
import { parse } from '@babel/parser';
import type {
  BlockStatement,
  ClassDeclaration,
  ClassMethod,
  FunctionDeclaration,
  Node,
} from '@babel/types';

const sourceExtensions = new Set(['.ts', '.tsx']);

function normalizedPath(value: string): string {
  return value.replaceAll('\\', '/');
}

function nodeId(kind: ModuleNode['kind'], relativePath: string, suffix = ''): string {
  return `${kind}:${relativePath}${suffix ? `:${suffix}` : ''}`;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name.startsWith('.') ||
        entry.name === 'dist'
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (sourceExtensions.has(path.extname(entry.name))) files.push(absolutePath);
    }
  }

  await visit(root);
  return files;
}

function lineOf(node: Node): number {
  return node.loc?.start.line ?? 1;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/\s*\{\s*$/, '');
}

function sourceSlice(source: string, start: number | null | undefined, end: number | null | undefined) {
  return source.slice(start ?? 0, end ?? 0);
}

function classSignature(source: string, node: ClassDeclaration): string {
  return compact(sourceSlice(source, node.start, node.body.start));
}

function callableSignature(
  source: string,
  node: FunctionDeclaration | ClassMethod,
): string {
  return compact(sourceSlice(source, node.start, node.body?.start ?? node.end).replace(/;\s*$/, ''));
}

function implementationStatus(
  source: string,
  body: BlockStatement | null | undefined,
): ImplementationStatus {
  if (!body) return 'unimplemented';
  const bodySource = sourceSlice(source, body.start, body.end);
  return /throw\s+new\s+(?:(?:\w+)\.)*NotImplementedError\b/i.test(bodySource) ||
    /throw\s+new\s+Error\s*\(\s*["'`]Not implemented/i.test(bodySource)
    ? 'unimplemented'
    : 'implemented';
}

function methodName(source: string, node: ClassMethod): string | null {
  const { key } = node;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral' || key.type === 'NumericLiteral') {
    return String(key.value);
  }
  return sourceSlice(source, key.start, key.end) || null;
}

export function extractTypeScriptModuleNodes(
  source: string,
  relativePath: string,
): ModuleNode[] {
  const program = parse(source, {
    sourceType: 'module',
    sourceFilename: relativePath,
    errorRecovery: true,
    plugins: ['typescript', ...(relativePath.endsWith('.tsx') ? ['jsx' as const] : [])],
  }).program;
  const symbols: ModuleNode[] = [];

  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ||
      statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (!declaration) continue;
    if (declaration.type === 'ClassDeclaration') {
      const name = declaration.id?.name;
      if (!name) continue;
      const classLine = lineOf(declaration);
      const children = declaration.body.body.flatMap<ModuleNode>((member) => {
        if (member.type !== 'ClassMethod' || member.kind !== 'method') return [];
        const name = methodName(source, member);
        if (!name) return [];
        const line = lineOf(member);
        return [{
          id: nodeId('function', relativePath, `${name}:${line}`),
          name,
          kind: 'function',
          path: relativePath,
          language: 'TypeScript',
          signature: callableSignature(source, member),
          line,
          implementationStatus: implementationStatus(source, member.body),
        }];
      });
      symbols.push({
        id: nodeId('class', relativePath, `${name}:${classLine}`),
        name,
        kind: 'class',
        path: relativePath,
        language: 'TypeScript',
        signature: classSignature(source, declaration),
        line: classLine,
        implementationStatus: 'implemented',
        children,
      });
      continue;
    }

    if (declaration.type === 'FunctionDeclaration') {
      const name = declaration.id?.name;
      if (!name) continue;
      const line = lineOf(declaration);
      symbols.push({
        id: nodeId('function', relativePath, `${name}:${line}`),
        name,
        kind: 'function',
        path: relativePath,
        language: 'TypeScript',
        signature: callableSignature(source, declaration),
        line,
        implementationStatus: implementationStatus(source, declaration.body),
      });
    }
  }

  return symbols;
}

interface MutableFolder extends ModuleNode {
  kind: 'workspace' | 'folder';
  children: ModuleNode[];
}

function folder(
  kind: MutableFolder['kind'],
  name: string,
  relativePath: string,
): MutableFolder {
  return {
    id: nodeId(kind, relativePath || name),
    name,
    kind,
    path: relativePath,
    children: [],
  };
}

function sortTree(node: ModuleNode): void {
  node.children?.sort((left, right) => {
    const leftGroup = left.kind === 'folder' ? 0 : left.kind === 'file' ? 1 : 2;
    const rightGroup = right.kind === 'folder' ? 0 : right.kind === 'file' ? 1 : 2;
    return leftGroup - rightGroup || left.name.localeCompare(right.name);
  });
  node.children?.forEach(sortTree);
}

export async function scanTargetModuleTree(workspaceRoot: string): Promise<ModuleNode> {
  const root = folder('workspace', path.basename(workspaceRoot), '');

  for (const absolutePath of await sourceFiles(workspaceRoot)) {
    const relativePath = normalizedPath(path.relative(workspaceRoot, absolutePath));
    const source = await readFile(absolutePath, 'utf8');
    const symbols = extractTypeScriptModuleNodes(source, relativePath);
    if (symbols.length === 0) continue;

    const pathParts = relativePath.split('/');
    const fileName = pathParts.pop();
    if (!fileName) continue;
    let parent = root;
    let currentPath = '';

    for (const part of pathParts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = parent.children.find(
        (candidate): candidate is MutableFolder =>
          candidate.kind === 'folder' && candidate.name === part,
      );
      if (!child) {
        child = folder('folder', part, currentPath);
        parent.children.push(child);
      }
      parent = child;
    }

    parent.children.push({
      id: nodeId('file', relativePath),
      name: fileName,
      kind: 'file',
      path: relativePath,
      language: 'TypeScript',
      children: symbols,
    });
  }

  sortTree(root);
  return root;
}

interface MutableModuleNode extends ModuleNode {
  children?: MutableModuleNode[];
}

const csharpIssueMarkers = ['TODO', 'FIXME', 'HACK', 'XXX'] as const;

function cloneModuleNode(node: ModuleNode): MutableModuleNode {
  return {
    ...node,
    issues: node.issues?.map((issue) => ({ ...issue })),
    children: node.children?.map(cloneModuleNode),
  };
}

function issueId(
  relativePath: string,
  line: number,
  kind: ModuleIssueKind,
  index: number,
): string {
  return `issue:${relativePath}:${line}:${kind}:${index}`;
}

/**
 * Detects explicit maintenance annotations and executable placeholder throws.
 * The scanner intentionally ignores REQ comments: those are contracts, not
 * evidence that an implementation is missing.
 */
export function detectCSharpSourceIssues(
  source: string,
  relativePath: string,
): ModuleIssue[] {
  const issues: ModuleIssue[] = [];

  source.split(/\r?\n/u).forEach((lineSource, lineIndex) => {
    const line = lineIndex + 1;
    const commentPattern =
      /(?:\/\/|\/\*+|\*)\s*(TODO|FIXME|HACK|XXX)\b(?:\(([^)]+)\))?\s*:?\s*(.*?)(?=\*\/\s*$|$)/giu;
    let markerMatch: RegExpExecArray | null;
    while ((markerMatch = commentPattern.exec(lineSource)) !== null) {
      const marker = markerMatch[1]?.toUpperCase();
      if (!csharpIssueMarkers.includes(marker as (typeof csharpIssueMarkers)[number])) {
        continue;
      }
      const owner = markerMatch[2]?.trim();
      const detail = markerMatch[3]?.trim();
      const kind = marker.toLowerCase() as ModuleIssueKind;
      const message = [owner, detail].filter(Boolean).join(': ') || `${marker} annotation`;
      issues.push({
        id: issueId(relativePath, line, kind, issues.length),
        kind,
        message,
        line,
      });
    }

    const stubMatch =
      /\bthrow\s+new\s+(?:(?:[A-Za-z_]\w*)\.)*(NotImplementedException|NotSupportedException)\b(?:\s*\(\s*"([^"]*)")?/u.exec(
        lineSource,
      );
    if (stubMatch) {
      issues.push({
        id: issueId(relativePath, line, 'stub', issues.length),
        kind: 'stub',
        message: stubMatch[2]?.trim() || stubMatch[1] || 'Unimplemented code path',
        line,
      });
    }
  });

  return issues;
}

async function csharpSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === 'bin' ||
        entry.name === 'obj' ||
        entry.name === 'node_modules' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (path.extname(entry.name).toLowerCase() === '.cs') files.push(absolutePath);
    }
  }

  await visit(root);
  return files;
}

function resetScanMetadata(node: MutableModuleNode): void {
  delete node.implementationStatus;
  delete node.issues;
  node.children?.forEach(resetScanMetadata);
}

function findFileNode(
  node: MutableModuleNode,
  relativePath: string,
): MutableModuleNode | null {
  if (node.kind === 'file' && node.path === relativePath) return node;
  for (const child of node.children ?? []) {
    const match = findFileNode(child, relativePath);
    if (match) return match;
  }
  return null;
}

function ensureCSharpFileNode(
  root: MutableModuleNode,
  relativePath: string,
): MutableModuleNode {
  const existing = findFileNode(root, relativePath);
  if (existing) return existing;

  const parts = relativePath.split('/');
  const fileName = parts.pop()!;
  let parent = root;
  let currentPath = '';
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    let folderNode = parent.children?.find(
      (candidate) => candidate.kind === 'folder' && candidate.path === currentPath,
    );
    if (!folderNode) {
      folderNode = {
        id: nodeId('folder', currentPath),
        name: part,
        kind: 'folder',
        path: currentPath,
        children: [],
      };
      parent.children ??= [];
      parent.children.push(folderNode);
    }
    parent = folderNode;
  }

  const fileNode: MutableModuleNode = {
    id: nodeId('file', relativePath),
    name: fileName,
    kind: 'file',
    path: relativePath,
    language: 'C#',
    children: [],
  };
  parent.children ??= [];
  parent.children.push(fileNode);
  return fileNode;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function declarationLine(source: string, node: ModuleNode): number | null {
  const escapedName = escapePattern(node.name);
  const pattern =
    node.kind === 'class' || node.kind === 'record' || node.kind === 'interface'
      ? new RegExp(
          `\\b(?:class|interface|record(?:\\s+(?:class|struct))?)\\s+${escapedName}\\b`,
          'u',
        )
      : node.kind === 'function'
        ? new RegExp(`\\b${escapedName}\\s*\\(`, 'u')
        : null;
  if (!pattern) return null;

  const lines = source.split(/\r?\n/u);
  const matchIndex = lines.findIndex((line) => pattern.test(line));
  return matchIndex < 0 ? null : matchIndex + 1;
}

function synchronizeSymbolLines(source: string, node: MutableModuleNode): void {
  if (
    node.kind === 'class' ||
    node.kind === 'record' ||
    node.kind === 'interface' ||
    node.kind === 'function'
  ) {
    node.line = declarationLine(source, node) ?? node.line;
  }
  node.children?.forEach((child) => synchronizeSymbolLines(source, child));
}

function lineStartOffset(source: string, line: number): number {
  if (line <= 1) return 0;
  let currentLine = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n') continue;
    currentLine += 1;
    if (currentLine === line) return index + 1;
  }
  return source.length;
}

function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, source.length); index += 1) {
    if (source[index] === '\n') line += 1;
  }
  return line;
}

function matchingSourceBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;

  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }

  return source.length - 1;
}

function symbolEndLine(source: string, node: ModuleNode): number {
  const startLine = node.line ?? 1;
  const startOffset = lineStartOffset(source, startLine);
  const nameOffset = source.indexOf(node.name, startOffset);
  if (nameOffset < 0) return startLine;

  const openingBrace = source.indexOf('{', nameOffset);
  const expressionBody = source.indexOf('=>', nameOffset);
  const semicolon = source.indexOf(';', nameOffset);
  const terminalOffsets = [openingBrace, expressionBody, semicolon].filter(
    (offset) => offset >= 0,
  );
  const firstTerminal = terminalOffsets.length ? Math.min(...terminalOffsets) : -1;

  if (firstTerminal === openingBrace) {
    return lineAtOffset(source, matchingSourceBrace(source, openingBrace));
  }
  if (firstTerminal >= 0) return lineAtOffset(source, firstTerminal);
  return startLine;
}

interface SymbolRange {
  node: MutableModuleNode;
  startLine: number;
  endLine: number;
  depth: number;
}

function symbolRanges(
  source: string,
  node: MutableModuleNode,
  depth = 0,
  result: SymbolRange[] = [],
): SymbolRange[] {
  if (
    node.line &&
    (node.kind === 'class' ||
      node.kind === 'record' ||
      node.kind === 'interface' ||
      node.kind === 'function')
  ) {
    result.push({
      node,
      startLine: node.line,
      endLine: symbolEndLine(source, node),
      depth,
    });
  }
  node.children?.forEach((child) => symbolRanges(source, child, depth + 1, result));
  return result;
}

function attachIssuesToFile(
  fileNode: MutableModuleNode,
  source: string,
  issues: ModuleIssue[],
): void {
  const ranges = symbolRanges(source, fileNode);
  for (const issue of issues) {
    const owner = ranges
      .filter((range) => range.startLine <= issue.line && issue.line <= range.endLine)
      .sort(
        (left, right) =>
          right.depth - left.depth ||
          left.endLine - left.startLine - (right.endLine - right.startLine),
      )[0]?.node;
    const target = owner ?? fileNode;
    target.issues ??= [];
    target.issues.push(issue);
  }
}

function propagateImplementationStatus(node: MutableModuleNode): boolean {
  let childIncomplete = false;
  for (const child of node.children ?? []) {
    if (propagateImplementationStatus(child)) childIncomplete = true;
  }
  const incomplete = Boolean(node.issues?.length) || childIncomplete;
  if (
    node.kind === 'class' ||
    node.kind === 'record' ||
    node.kind === 'interface' ||
    node.kind === 'function'
  ) {
    node.implementationStatus = incomplete ? 'unimplemented' : 'implemented';
  } else if (incomplete) {
    node.implementationStatus = 'unimplemented';
  }
  return incomplete;
}

/**
 * Enriches the curated C# symbol tree with live source locations and incomplete
 * implementation signals. New C# files are still represented even when no
 * curated symbol metadata exists for them.
 */
export async function scanCSharpWorkspaceTree(
  workspaceRoot: string,
  baseTree: ModuleNode,
): Promise<ModuleNode> {
  const root = cloneModuleNode(baseTree);
  resetScanMetadata(root);

  for (const absolutePath of await csharpSourceFiles(workspaceRoot)) {
    const relativePath = normalizedPath(path.relative(workspaceRoot, absolutePath));
    const fileNode = ensureCSharpFileNode(root, relativePath);
    const source = await readFile(absolutePath, 'utf8');
    synchronizeSymbolLines(source, fileNode);
    attachIssuesToFile(
      fileNode,
      source,
      detectCSharpSourceIssues(source, relativePath),
    );
  }

  propagateImplementationStatus(root);
  sortTree(root);
  return root;
}
