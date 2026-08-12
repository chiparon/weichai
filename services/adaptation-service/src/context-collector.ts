import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CallerContext,
  Language,
  ModuleTarget,
  RelatedTypeContext,
  TargetDependencyContext,
  TargetModuleContext,
} from '@forexplore/contracts';

const MAX_TARGET_SOURCE = 24_000;
const MAX_FRAGMENT_SOURCE = 12_000;
const MAX_TYPE_SOURCE = 18_000;
const MAX_NEIGHBORS = 12;
const MAX_REFERENCES = 24;
const MAX_REFERENCE_EXCERPT = 240;
const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_RELATED_TYPES = 8;
const DEFAULT_MAX_FILES_TO_SCAN = 1_000;

const BUILT_IN_TYPES = new Set([
  'Action', 'Array', 'Boolean', 'CancellationToken', 'DateTime', 'DateTimeOffset',
  'Decimal', 'Dictionary', 'Enum', 'Exception', 'Func', 'IEnumerable',
  'IReadOnlyCollection', 'IReadOnlyList', 'IReadOnlyDictionary', 'List', 'Object',
  'String', 'Task', 'TimeSpan', 'ValueTask', 'bool', 'byte', 'char', 'decimal',
  'double', 'float', 'int', 'long', 'object', 'sbyte', 'short', 'string', 'uint',
  'ulong', 'ushort', 'void',
]);

const languageByExtension: Record<string, Language> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'TypeScript',
  '.jsx': 'TypeScript',
  '.py': 'Python',
  '.java': 'Java',
  '.cs': 'C#',
  '.rs': 'Rust',
  '.go': 'Go',
};

export interface ContextCollectorOptions {
  projectRoot?: string;
  maxNeighbors?: number;
  maxReferences?: number;
  maxChars?: number;
  maxRelatedTypes?: number;
  maxFilesToScan?: number;
  target?: ModuleTarget;
  signal?: AbortSignal;
}

interface CodeRange {
  declarationStart: number;
  openingBrace: number;
  end: number;
  declaration: string;
}

interface SourceFile {
  path: string;
  content: string;
}

export class ContextCollector {
  readonly #projectRoot?: string;
  readonly #maxNeighbors: number;
  readonly #maxReferences: number;
  readonly #maxChars: number;
  readonly #maxRelatedTypes: number;
  readonly #maxFilesToScan: number;

  constructor(options: ContextCollectorOptions = {}) {
    this.#projectRoot = options.projectRoot ? canonicalProjectRoot(options.projectRoot) : undefined;
    this.#maxNeighbors = Math.max(0, Math.min(options.maxNeighbors ?? MAX_NEIGHBORS, MAX_NEIGHBORS));
    this.#maxReferences = Math.max(0, Math.min(options.maxReferences ?? MAX_REFERENCES, MAX_REFERENCES));
    this.#maxChars = positiveBound(options.maxChars ?? DEFAULT_MAX_CHARS, 'maxChars');
    this.#maxRelatedTypes = nonNegativeBound(options.maxRelatedTypes ?? DEFAULT_MAX_RELATED_TYPES, 'maxRelatedTypes');
    this.#maxFilesToScan = positiveBound(options.maxFilesToScan ?? DEFAULT_MAX_FILES_TO_SCAN, 'maxFilesToScan');
  }

  collect(target: ModuleTarget, signal?: AbortSignal): TargetModuleContext {
    signal?.throwIfAborted();
    const targetFile = normalizeTargetPath(target.path);
    const projectRoot = this.#projectRoot;
    if (!projectRoot) {
      return emptyContext(targetFile);
    }

    const absoluteTarget = resolveInside(projectRoot, targetFile);
    if (!existsSync(absoluteTarget) || !statSync(absoluteTarget).isFile()) {
      throw new Error(`Target file does not exist in the project: ${target.path}`);
    }

    const targetSource = readFileSync(absoluteTarget, 'utf8').replace(/\r\n?/g, '\n');
    const language = target.language;
    const targetFragment = extractTargetFragment(targetSource, target, language);
    if (!targetFragment.trim()) {
      throw new Error(`Target ${target.name} was not found in ${target.path}.`);
    }
    const containingType = findContainingType(targetSource, target, language);
    const containingTypeSource = containingType
      ? extractNamedBlock(targetSource, containingType, language)
      : undefined;
    const imports = extractImports(targetSource, language);
    const neighboringFiles = collectNeighbors(
      projectRoot,
      dirname(absoluteTarget),
      absoluteTarget,
      language,
      this.#maxNeighbors,
    );
    const references = collectReferences(
      projectRoot,
      target.name,
      absoluteTarget,
      language,
      this.#maxReferences,
    );

    const range = findTargetRangeOrFallback(targetSource, target, targetFragment);
    const containingRange = range.openingBrace >= 0
      ? findContainingTypeRange(targetSource, range.declarationStart)
      : null;
    const typeRange = containingRange ?? range;
    const containingTypeSourceStructured = targetSource.slice(typeRange.declarationStart, typeRange.end + 1).trim();
    const typeName = extractTypeName(typeRange.declaration) ?? target.name;
    const fields = extractFields(containingTypeSourceStructured);
    const constructor = extractConstructor(containingTypeSourceStructured, typeName);
    const relatedMembers = extractRelatedMembers(containingTypeSourceStructured, target.name, typeName);
    const constraints = extractConstraints(targetSource, typeRange.declarationStart, typeRange.end);
    const files = listSourceFiles(projectRoot, this.#maxFilesToScan, signal);
    const dependencyNames = collectDependencyNames(target, fields, constructor, typeName);
    const relatedTypes = resolveRelatedTypes(files, absoluteTarget, dependencyNames, this.#maxRelatedTypes, signal)
      .map((definition) => ({ ...definition, path: relative(projectRoot, definition.path).replace(/\\/g, '/') }));
    const dependencies = buildDependencies(target, fields, constructor, dependencyNames, relatedTypes, targetSource.slice(range.declarationStart, range.end + 1));
    const callers = target.kind === 'function'
      ? findCallers(files, absoluteTarget, target.name, this.#maxReferences, signal)
        .map((caller) => ({ ...caller, path: relative(projectRoot, caller.path).replace(/\\/g, '/') }))
      : [];

    const context: TargetModuleContext = {
      projectRoot,
      targetFile,
      targetSource: truncate(targetSource, MAX_TARGET_SOURCE),
      targetFragment: truncate(targetFragment, MAX_FRAGMENT_SOURCE),
      imports,
      containingType,
      containingTypeSource: containingTypeSource
        ? truncate(containingTypeSource, MAX_TYPE_SOURCE)
        : undefined,
      neighboringFiles,
      references,
      truncated:
        targetSource.length > MAX_TARGET_SOURCE ||
        targetFragment.length > MAX_FRAGMENT_SOURCE ||
        (containingTypeSource?.length ?? 0) > MAX_TYPE_SOURCE,
      schemaVersion: '1.0',
      target,
      source: {
        namespace: findNamespace(targetSource),
        usings: imports,
        method: targetSource.slice(range.declarationStart, range.end + 1).trim(),
        containingType: containingTypeSourceStructured,
        fields,
        constructor,
        relatedMembers,
      },
      dependencies,
      relatedTypes,
      callers,
      constraints,
      collection: {
        projectRoot: '.',
        targetFile,
        maxChars: this.#maxChars,
        actualChars: 0,
        truncated: false,
        truncatedSections: [],
      },
    };
    applyBudget(context, this.#maxChars);
    return context;
  }
}

function emptyContext(targetFile: string, projectRoot?: string): TargetModuleContext {
  return {
    projectRoot,
    targetFile,
    targetSource: '',
    targetFragment: '',
    imports: [],
    neighboringFiles: [],
    references: [],
    truncated: false,
    schemaVersion: '1.0',
    source: {
      usings: [],
      method: '',
      containingType: '',
      fields: [],
      constructor: undefined,
      relatedMembers: [],
    },
    dependencies: [],
    relatedTypes: [],
    callers: [],
    constraints: [],
    collection: {
      projectRoot: '.',
      targetFile,
      maxChars: DEFAULT_MAX_CHARS,
      actualChars: 0,
      truncated: false,
      truncatedSections: [],
    },
  };
}

function findTargetRange(source: string, target: ModuleTarget): CodeRange {
  const pattern = target.kind === 'function'
    ? new RegExp(`\\b${escapeRegExp(target.name)}\\s*\\(`, 'g')
    : new RegExp(`\\b(?:class|record|struct|interface|enum)\\s+${escapeRegExp(target.name)}\\b`, 'g');
  const candidates: CodeRange[] = [];
  for (const match of source.matchAll(pattern)) {
    const declarationStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
    const openingBrace = source.indexOf('{', match.index ?? 0);
    if (openingBrace < 0) continue;
    candidates.push({
      declarationStart,
      openingBrace,
      end: matchingBrace(source, openingBrace),
      declaration: source.slice(declarationStart, openingBrace).trim(),
    });
  }
  if (candidates.length === 0) throw new Error(`Target ${target.name} was not found in ${target.path}.`);
  if (target.line !== undefined) {
    const targetOffset = lineStartOffset(source, target.line);
    candidates.sort((left, right) =>
      Math.abs(left.declarationStart - targetOffset) - Math.abs(right.declarationStart - targetOffset));
  }
  return candidates[0];
}

function findTargetRangeOrFallback(source: string, target: ModuleTarget, fragment: string): CodeRange {
  try {
    return findTargetRange(source, target);
  } catch (error) {
    if (target.language !== 'Python' && target.language !== 'TypeScript') throw error;
    const start = target.line ? lineStartOffset(source, target.line) : Math.max(0, source.indexOf(fragment));
    const safeStart = start < 0 ? 0 : start;
    return {
      declarationStart: safeStart,
      openingBrace: -1,
      end: Math.min(source.length - 1, safeStart + Math.max(0, fragment.length - 1)),
      declaration: source.slice(safeStart, safeStart + Math.max(0, fragment.indexOf('\n'))).trim(),
    };
  }
}

function findContainingTypeRange(source: string, offset: number): CodeRange | null {
  const pattern = /\b(class|record|struct|interface|enum)\s+([A-Za-z_]\w*)\b/g;
  const candidates: CodeRange[] = [];
  for (const match of source.matchAll(pattern)) {
    const declarationStart = source.lastIndexOf('\n', match.index ?? 0) + 1;
    const openingBrace = source.indexOf('{', match.index ?? 0);
    if (openingBrace < 0 || openingBrace > offset) continue;
    const end = matchingBrace(source, openingBrace);
    if (offset <= end) candidates.push({
      declarationStart,
      openingBrace,
      end,
      declaration: source.slice(declarationStart, openingBrace).trim(),
    });
  }
  return candidates.sort((left, right) => right.openingBrace - left.openingBrace)[0] ?? null;
}

function matchingBrace(source: string, openingBrace: number): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '/' && next === '/') {
      const newline = source.indexOf('\n', index + 2);
      if (newline < 0) break;
      index = newline;
      continue;
    }
    if (character === '/' && next === '*') { index = source.indexOf('*/', index + 2); if (index < 0) break; index += 1; continue; }
    if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return index;
  }
  throw new Error('Target context contains an unmatched brace.');
}

function extractFields(typeSource: string): string[] {
  return typeSource.split('\n').map((line) => line.trim()).filter((line) =>
    line && !line.startsWith('//') && /^(?:(?:public|private|protected|internal|static|readonly|volatile|const|new|unsafe)\s+)+[A-Za-z_]\w*(?:\s*<[^;=()]+>)?(?:\[\])?\s+[A-Za-z_]\w*\s*(?:=.*)?;\s*$/.test(line));
}

function extractConstructor(typeSource: string, typeName: string): string | undefined {
  const match = new RegExp(`(?:public|private|protected|internal|\\s)+${escapeRegExp(typeName)}\\s*\\([^)]*\\)`).exec(typeSource);
  if (!match) return undefined;
  const openingBrace = typeSource.indexOf('{', match.index + match[0].length);
  if (openingBrace < 0) return match[0].trim();
  return typeSource.slice(match.index, matchingBrace(typeSource, openingBrace) + 1).trim();
}

function extractRelatedMembers(typeSource: string, targetName: string, typeName: string): string[] {
  const members: string[] = [];
  for (const line of typeSource.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || !trimmed.includes('(')) continue;
    if (new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`).test(trimmed) ||
        new RegExp(`\\b${escapeRegExp(typeName)}\\s*\\(`).test(trimmed)) continue;
    if (/\b(?:public|private|protected|internal)\b/.test(trimmed) || /\binterface\b/.test(typeSource)) {
      members.push(trimmed.replace(/\s*\{\s*$/, ''));
    }
  }
  return [...new Set(members)];
}

function extractConstraints(source: string, start: number, end: number): string[] {
  const startLine = source.slice(0, start).split('\n').length - 1;
  const endLine = source.slice(0, end).split('\n').length - 1;
  return source.split('\n').map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line, index }) => index >= startLine && index <= endLine && /\bREQ\s*:/i.test(line))
    .map(({ line }) => line.replace(/^\/\/\/?\s*/, '').trim()).filter(Boolean);
}

function findNamespace(source: string): string | undefined {
  return /^\s*namespace\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:;|\{)/m.exec(source)?.[1];
}

function extractTypeName(declaration: string): string | undefined {
  return /\b(?:class|record|struct|interface|enum)\s+([A-Za-z_]\w*)/.exec(declaration)?.[1];
}

function collectDependencyNames(target: ModuleTarget, fields: string[], constructor: string | undefined, typeName: string): string[] {
  return [...new Set([target.signature, ...fields, constructor ?? ''].join('\n')
    .match(/\b([A-Z][A-Za-z0-9_]*)\b/g) ?? [])]
    .filter((name) => name !== typeName && name !== target.name && !BUILT_IN_TYPES.has(name));
}

function buildDependencies(target: ModuleTarget, fields: string[], constructor: string | undefined, names: string[], definitions: RelatedTypeContext[], method: string): TargetDependencyContext[] {
  const result: TargetDependencyContext[] = [];
  const add = (name: string, kind: TargetDependencyContext['kind'], declaration: string) => {
    if (result.some((item) => item.name === name)) return;
    const definition = definitions.find((item) => item.name === name);
    result.push({ name, kind, declaration, path: definition?.path, memberSignatures: definition?.source ? extractRelatedMembers(definition.source, '', name).slice(0, 12) : undefined });
  };
  for (const field of fields) {
    const fieldName = field.match(/([A-Za-z_]\w*)\s*(?:=.*)?;\s*$/)?.[1];
    const fieldType = field.match(/\b([A-Za-z_]\w*(?:\s*<[^;=()]+>)?(?:\[\])?)\s+[A-Za-z_]\w*\s*(?:=.*)?;\s*$/)?.[1];
    const directType = fieldType && [...fieldType.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]).find((name) => names.includes(name));
    if (directType) add(directType, 'field', field);
    else if (fieldName && method.includes(fieldName)) add(fieldName, 'invocation', field);
  }
  if (constructor) for (const match of constructor.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s+([A-Za-z_]\w*)\b/g)) {
    if (names.includes(match[1]) && !BUILT_IN_TYPES.has(match[1])) add(match[1], 'constructor', constructor);
  }
  for (const name of names) if (!result.some((item) => item.name === name)) add(name, target.signature.includes(name) ? 'signature' : 'type', target.signature);
  return result;
}

function listSourceFiles(root: string, maxFiles: number, signal?: AbortSignal): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    signal?.throwIfAborted();
    if (files.length >= maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.name === '.git' || entry.name === 'bin' || entry.name === 'obj' || entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'target') continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && path.endsWith('.cs') && safeProjectEntry(root, path)) files.push({ path, content: readFileSync(path, 'utf8').replace(/\r\n?/g, '\n') });
    }
  };
  visit(root);
  return files;
}

function resolveRelatedTypes(files: SourceFile[], targetPath: string, names: string[], maxTypes: number, signal?: AbortSignal): RelatedTypeContext[] {
  const result: RelatedTypeContext[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    if (result.length >= maxTypes) break;
    for (const file of files) {
      if (file.path === targetPath) continue;
      const match = new RegExp(`\\b(class|record|struct|interface|enum)\\s+${escapeRegExp(name)}\\b`).exec(file.content);
      if (!match) continue;
      const declarationStart = file.content.lastIndexOf('\n', match.index) + 1;
      const openingBrace = file.content.indexOf('{', match.index);
      const end = openingBrace >= 0 ? matchingBrace(file.content, openingBrace) : match.index + match[0].length;
      result.push({ name, kind: match[1] as RelatedTypeContext['kind'], path: file.path, declaration: file.content.slice(declarationStart, openingBrace >= 0 ? openingBrace : end).trim(), source: truncateText(file.content.slice(declarationStart, end + 1).trim(), 4_000) });
      break;
    }
  }
  return result;
}

function findCallers(files: SourceFile[], targetPath: string, name: string, limit: number, signal?: AbortSignal): CallerContext[] {
  const result: CallerContext[] = [];
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`);
  for (const file of files) {
    signal?.throwIfAborted();
    if (file.path === targetPath) continue;
    const lines = file.content.split('\n');
    for (let index = 0; index < lines.length && result.length < limit; index += 1) if (pattern.test(lines[index] ?? '')) {
      result.push({ path: file.path, line: index + 1, excerpt: truncateText(lines.slice(Math.max(0, index - 1), index + 2).join('\n').trim(), 500) });
    }
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeTargetPath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\/+/, '');
}

function resolveInside(root: string, filePath: string): string {
  const absolute = resolve(root, filePath);
  const relativePath = relative(root, absolute);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Target path must stay inside the project root: ${filePath}`);
  }
  if (!existsSync(absolute)) return absolute;
  const canonical = realpathSync(absolute);
  if (outsideRoot(root, canonical)) {
    throw new Error(`Target path must stay inside the project root: ${filePath}`);
  }
  return canonical;
}

function canonicalProjectRoot(projectRoot: string): string {
  const absolute = resolve(projectRoot);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`Project root is not a directory: ${projectRoot}`);
  }
  return realpathSync(absolute);
}

function outsideRoot(root: string, absolute: string): boolean {
  const relativePath = relative(root, absolute);
  return relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\') || isAbsolute(relativePath);
}

function safeProjectEntry(root: string, absolute: string): boolean {
  try {
    return !outsideRoot(root, realpathSync(absolute));
  } catch {
    return false;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}\n// ... context truncated ...`;
}

function extractImports(source: string, language: Language): string[] {
  const patterns: Partial<Record<Language, RegExp>> = {
    TypeScript: /^\s*(?:import|export)\s.+$/gm,
    Python: /^\s*(?:from|import)\s.+$/gm,
    Java: /^\s*import\s.+$/gm,
    'C#': /^\s*(?:using|global\s+using)\s.+$/gm,
    Rust: /^\s*(?:use|extern\s+crate)\s.+$/gm,
    Go: /^\s*import(?:\s|\().*$/gm,
  };
  return [...source.matchAll(patterns[language] ?? /^$/gm)]
    .map((match) => match[0].trim())
    .filter(Boolean)
    .slice(0, 80);
}

function extractTargetFragment(source: string, target: ModuleTarget, language: Language): string {
  if (target.line == null) return target.kind === 'class' ? extractNamedBlock(source, target.name, language) : '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(0, target.line - 1);
  return language === 'Python' ? pythonBlock(lines, start) : braceBlock(lines, start);
}

function findContainingType(source: string, target: ModuleTarget, language: Language): string | undefined {
  if (target.kind === 'class' || target.line == null) return undefined;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const start = Math.max(0, target.line - 1);
  const classPattern: Partial<Record<Language, RegExp>> = {
    TypeScript: /\bclass\s+([A-Za-z_$][\w$]*)/,
    Java: /\bclass\s+([A-Za-z_$][\w$]*)/,
    'C#': /\bclass\s+([A-Za-z_][\w]*)/,
    Python: /^\s*class\s+([A-Za-z_]\w*)/,
    Rust: /\b(?:struct|trait|enum)\s+([A-Za-z_]\w*)/,
    Go: /\btype\s+([A-Za-z_]\w*)\s+(?:struct|interface)/,
  };
  let candidate: string | undefined;
  for (let index = 0; index <= start; index += 1) {
    const match = lines[index]?.match(classPattern[language] ?? /^$/);
    if (match?.[1]) candidate = match[1];
  }
  return candidate;
}

function extractNamedBlock(source: string, name: string, language: Language): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const patterns: Partial<Record<Language, RegExp>> = {
    TypeScript: new RegExp(`\\bclass\\s+${escapeRegExp(name)}\\b`),
    Java: new RegExp(`\\b(?:class|interface|record|enum)\\s+${escapeRegExp(name)}\\b`),
    'C#': new RegExp(`\\b(?:class|interface|record|struct|enum)\\s+${escapeRegExp(name)}\\b`),
    Python: new RegExp(`^\\s*class\\s+${escapeRegExp(name)}\\b`),
    Rust: new RegExp(`\\b(?:struct|trait|enum)\\s+${escapeRegExp(name)}\\b`),
    Go: new RegExp(`\\btype\\s+${escapeRegExp(name)}\\s+(?:struct|interface)`),
  };
  const start = lines.findIndex((line) => patterns[language]?.test(line));
  if (start < 0) return '';
  return language === 'Python' ? pythonBlock(lines, start) : braceBlock(lines, start);
}

function braceBlock(lines: string[], start: number): string {
  const result: string[] = [];
  let depth = 0;
  let opened = false;
  for (let index = start; index < Math.min(lines.length, start + 500); index += 1) {
    const line = lines[index] ?? '';
    result.push(line);
    for (const character of line.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')) {
      if (character === '{') { depth += 1; opened = true; }
      if (character === '}') depth -= 1;
    }
    if (opened && depth <= 0) break;
  }
  return result.join('\n');
}

function pythonBlock(lines: string[], start: number): string {
  const baseIndent = lines[start]?.length - (lines[start]?.trimStart().length ?? 0) || 0;
  const result: string[] = [];
  for (let index = start; index < Math.min(lines.length, start + 500); index += 1) {
    const line = lines[index] ?? '';
    if (index > start && line.trim() && line.length - line.trimStart().length <= baseIndent) break;
    result.push(line);
  }
  return result.join('\n');
}

function extractNamedFileSummary(source: string, path: string, language: Language): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const declarations = lines
    .filter((line) => /\b(class|interface|record|struct|def|fn|func|function)\b/.test(line))
    .slice(0, 8)
    .map((line) => line.trim());
  return `${basename(path)} (${language})${declarations.length ? `: ${declarations.join(' | ')}` : ''}`.slice(0, 600);
}

function collectNeighbors(
  projectRoot: string,
  directory: string,
  targetFile: string,
  language: Language,
  limit: number,
): TargetModuleContext['neighboringFiles'] {
  const result: TargetModuleContext['neighboringFiles'] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolute = join(directory, entry.name);
    if (absolute === targetFile || languageByExtension[extname(entry.name)] !== language || !safeProjectEntry(projectRoot, absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    result.push({
      path: relative(projectRoot, absolute).replaceAll('\\', '/'),
      language,
      summary: extractNamedFileSummary(source, absolute, language),
    });
    if (result.length >= limit) break;
  }
  return result;
}

function collectReferences(
  projectRoot: string,
  name: string,
  targetFile: string,
  language: Language,
  limit: number,
): TargetModuleContext['references'] {
  const result: TargetModuleContext['references'] = [];
  const extension = Object.entries(languageByExtension).find(([, value]) => value === language)?.[0];
  if (!extension) return result;
  const visit = (directory: string): void => {
    if (result.length >= limit) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (result.length >= limit) return;
      if (entry.name.startsWith('.') || ['node_modules', 'bin', 'obj', 'build', 'target'].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (safeProjectEntry(projectRoot, absolute)) visit(absolute);
        continue;
      }
      if (absolute === targetFile || extname(entry.name) !== extension) continue;
      if (!safeProjectEntry(projectRoot, absolute)) continue;
      const lines = readFileSync(absolute, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, index) => {
        if (result.length >= limit) return;
        if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line)) {
          result.push({
            path: relative(projectRoot, absolute).replaceAll('\\', '/'),
            line: index + 1,
            excerpt: line.trim().slice(0, MAX_REFERENCE_EXCERPT),
          });
        }
      });
    }
  };
  visit(projectRoot);
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineStartOffset(source: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let index = 1; index < line; index += 1) {
    const next = source.indexOf('\n', offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = '\n... [truncated] ...\n';
  const available = Math.max(0, maxLength - marker.length);
  const head = Math.ceil(available * 0.7);
  return `${value.slice(0, head)}${marker}${value.slice(-Math.max(0, available - head))}`;
}

function applyBudget(context: TargetModuleContext, maxChars: number): void {
  if (!context.collection || !context.source || !context.dependencies || !context.relatedTypes || !context.callers) return;
  let serializedLength = JSON.stringify(context).length;
  const sections: Array<{ name: string; get: () => string; set: (value: string) => void }> = [
    { name: 'source.containingType', get: () => context.source!.containingType, set: (value) => { context.source!.containingType = value; } },
    { name: 'source.method', get: () => context.source!.method, set: (value) => { context.source!.method = value; } },
  ];
  for (let index = 0; index < context.relatedTypes.length; index += 1) {
    sections.push({ name: `relatedTypes[${index}].source`, get: () => context.relatedTypes![index].source, set: (value) => { context.relatedTypes![index].source = value; } });
  }
  for (let index = 0; index < context.callers.length; index += 1) {
    sections.push({ name: `callers[${index}].excerpt`, get: () => context.callers![index].excerpt, set: (value) => { context.callers![index].excerpt = value; } });
  }
  let sectionIndex = 0;
  while (serializedLength > maxChars && sectionIndex < sections.length) {
    const section = sections[sectionIndex];
    const current = section.get();
    const nextLength = Math.max(160, Math.floor(current.length * 0.65));
    if (nextLength < current.length) {
      section.set(truncateText(current, nextLength));
      context.collection.truncated = true;
      if (!context.collection.truncatedSections.includes(section.name)) context.collection.truncatedSections.push(section.name);
    } else sectionIndex += 1;
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.callers.length > 0) { context.callers.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('callers'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.relatedTypes.length > 0) { context.relatedTypes.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('relatedTypes'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.dependencies.length > 0) { context.dependencies.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('dependencies'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.source.relatedMembers.length > 0) { context.source.relatedMembers.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('source.relatedMembers'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.source.fields.length > 0) { context.source.fields.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('source.fields'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.neighboringFiles.length > 0) { context.neighboringFiles.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('neighboringFiles'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.references.length > 0) { context.references.pop(); context.collection.truncated = true; context.collection.truncatedSections.push('references'); serializedLength = JSON.stringify(context).length; }
  while (serializedLength > maxChars && context.targetSource.length > 0) {
    const next = context.targetSource.length <= 160 ? '' : truncateText(context.targetSource, Math.max(160, Math.floor(context.targetSource.length * 0.65)));
    if (next === context.targetSource) break;
    context.targetSource = next;
    context.collection.truncated = true;
    context.collection.truncatedSections.push('targetSource');
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.targetFragment.length > 0) {
    const next = context.targetFragment.length <= 160 ? '' : truncateText(context.targetFragment, Math.max(160, Math.floor(context.targetFragment.length * 0.65)));
    if (next === context.targetFragment) break;
    context.targetFragment = next;
    context.collection.truncated = true;
    context.collection.truncatedSections.push('targetFragment');
    serializedLength = JSON.stringify(context).length;
  }
  if (serializedLength > maxChars) {
    const optionalSections: Array<[string, () => void]> = [
      ['targetSource', () => { context.targetSource = ''; }],
      ['targetFragment', () => { context.targetFragment = ''; }],
      ['containingTypeSource', () => { context.containingTypeSource = undefined; }],
      ['imports', () => { context.imports = []; }],
      ['neighboringFiles', () => { context.neighboringFiles = []; }],
      ['references', () => { context.references = []; }],
      ['source.containingType', () => { context.source!.containingType = ''; }],
      ['source.method', () => { context.source!.method = ''; }],
      ['source.usings', () => { context.source!.usings = []; }],
      ['source.fields', () => { context.source!.fields = []; }],
      ['source.constructor', () => { context.source!.constructor = undefined; }],
      ['source.relatedMembers', () => { context.source!.relatedMembers = []; }],
      ['dependencies', () => { context.dependencies = []; }],
      ['relatedTypes', () => { context.relatedTypes = []; }],
      ['callers', () => { context.callers = []; }],
      ['constraints', () => { context.constraints = []; }],
    ];
    for (const [name, clear] of optionalSections) {
      if (serializedLength <= maxChars) break;
      clear();
      context.collection.truncated = true;
      if (!context.collection.truncatedSections.includes(name)) context.collection.truncatedSections.push(name);
      serializedLength = JSON.stringify(context).length;
    }
  }
  context.collection.actualChars = serializedLength;
}

function positiveBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeBound(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

export function collectTargetContext(
  target: ModuleTarget,
  options?: ContextCollectorOptions,
): TargetModuleContext;
export function collectTargetContext(
  options: ContextCollectorOptions & { projectRoot: string; target: ModuleTarget },
): TargetModuleContext;
export function collectTargetContext(
  targetOrOptions: ModuleTarget | (ContextCollectorOptions & { projectRoot: string; target: ModuleTarget }),
  options: ContextCollectorOptions = {},
): TargetModuleContext {
  if ('target' in targetOrOptions) {
    const { target, signal, ...collectorOptions } = targetOrOptions;
    return new ContextCollector(collectorOptions).collect(target, signal);
  }
  return new ContextCollector(options).collect(targetOrOptions, options.signal);
}

/** Stable serialization boundary for Analyzer/MCP callers. */
export function serializeTargetContext(context: TargetModuleContext): string {
  return JSON.stringify(context, null, 2);
}
