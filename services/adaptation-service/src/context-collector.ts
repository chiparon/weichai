import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Language, ModuleTarget, TargetModuleContext } from '@forexplore/contracts';

const MAX_TARGET_SOURCE = 24_000;
const MAX_FRAGMENT_SOURCE = 12_000;
const MAX_TYPE_SOURCE = 18_000;
const MAX_NEIGHBORS = 12;
const MAX_REFERENCES = 24;
const MAX_REFERENCE_EXCERPT = 240;

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
}

export class ContextCollector {
  readonly #projectRoot?: string;
  readonly #maxNeighbors: number;
  readonly #maxReferences: number;

  constructor(options: ContextCollectorOptions = {}) {
    this.#projectRoot = options.projectRoot ? canonicalProjectRoot(options.projectRoot) : undefined;
    this.#maxNeighbors = Math.max(0, Math.min(options.maxNeighbors ?? MAX_NEIGHBORS, MAX_NEIGHBORS));
    this.#maxReferences = Math.max(0, Math.min(options.maxReferences ?? MAX_REFERENCES, MAX_REFERENCES));
  }

  collect(target: ModuleTarget): TargetModuleContext {
    const targetFile = normalizeTargetPath(target.path);
    const projectRoot = this.#projectRoot;
    if (!projectRoot) {
      return emptyContext(targetFile);
    }

    const absoluteTarget = resolveInside(projectRoot, targetFile);
    if (!existsSync(absoluteTarget) || !statSync(absoluteTarget).isFile()) {
      return emptyContext(targetFile, projectRoot);
    }

    const targetSource = readFileSync(absoluteTarget, 'utf8');
    const language = target.language;
    const targetFragment = extractTargetFragment(targetSource, target, language);
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

    return {
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
    };
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
  };
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

export function collectTargetContext(
  target: ModuleTarget,
  options: ContextCollectorOptions = {},
): TargetModuleContext {
  return new ContextCollector(options).collect(target);
}
