import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Language, ModuleTarget, TargetModuleContext } from '@forexplore/contracts';
import { ContextCollector } from './context-collector.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpToolHost {
  listTools(): McpToolDefinition[];
  callTool(name: string, input: unknown): Promise<McpToolResult>;
}

const tools: McpToolDefinition[] = [
  {
    name: 'get_directory_tree',
    description: 'ReCodeAgent-compatible bounded directory tree for the configured project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        print_dirs_only: { type: 'boolean' },
        max_depth: { type: 'number' },
      },
      required: ['path', 'print_dirs_only'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_structure',
    description: 'ReCodeAgent-compatible high-level file skeleton with imports, types, fields, and functions.',
    inputSchema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'java', 'javascript', 'js', 'typescript', 'ts', 'go', 'c', 'csharp', 'c#', 'cs', 'rust'],
        },
        file_path: { type: 'string' },
      },
      required: ['language', 'file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'definition',
    description: 'Read the source definition of a symbol. Compatible with ReCodeAgent language-server MCP naming.',
    inputSchema: {
      type: 'object',
      properties: { symbolName: { type: 'string' }, maxChars: { type: 'number' } },
      required: ['symbolName'],
      additionalProperties: false,
    },
  },
  {
    name: 'references',
    description: 'Find bounded textual references to a symbol. Compatible with ReCodeAgent language-server MCP naming.',
    inputSchema: {
      type: 'object',
      properties: { symbolName: { type: 'string' }, maxResults: { type: 'number' } },
      required: ['symbolName'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: 'Read a bounded UTF-8 source file inside the configured project.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, maxChars: { type: 'number' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_target_context',
    description: 'Collect the target file, fragment, imports, neighbors, and references.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'object' } },
      required: ['target'],
      additionalProperties: false,
    },
  },
];

export class LocalMcpToolHost implements McpToolHost {
  readonly #projectRoot: string;
  readonly #collector: ContextCollector;

  constructor(projectRoot: string, options: { maxNeighbors?: number; maxReferences?: number } = {}) {
    const requestedRoot = resolve(projectRoot);
    if (!existsSync(requestedRoot) || !statSync(requestedRoot).isDirectory()) {
      throw new Error(`MCP project root is not a directory: ${projectRoot}`);
    }
    this.#projectRoot = realpathSync(requestedRoot);
    this.#collector = new ContextCollector({ projectRoot: this.#projectRoot, ...options });
  }

  listTools(): McpToolDefinition[] {
    return tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
  }

  async callTool(name: string, input: unknown): Promise<McpToolResult> {
    try {
      const value = this.execute(name, input);
      return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  private execute(name: string, input: unknown): unknown {
    if (name === 'get_directory_tree') return this.directoryTree(input);
    if (name === 'read_file') return this.readFile(input);
    if (name === 'get_file_structure') return this.fileStructure(input);
    if (name === 'definition') return this.definition(input);
    if (name === 'references' || name === 'find_references') return this.findReferences(input);
    if (name === 'get_target_context') return this.targetContext(input);
    throw new Error(`Unknown MCP tool: ${name}`);
  }

  private directoryTree(input: unknown): string {
    const args = objectInput(input);
    const path = stringInput(args.path, 'path');
    const absolute = resolveProjectPath(this.#projectRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error(`Directory does not exist: ${path}`);
    const directoriesOnly = booleanInput(args.print_dirs_only, 'print_dirs_only');
    const maxDepth = boundedNumber(args.max_depth, 6, 1, 12);
    const lines = [`${basename(absolute)}/`];
    let truncated = false;
    const visit = (directory: string, prefix: string, depth: number): void => {
      if (depth > maxDepth) return;
      const entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.') && !['node_modules', 'bin', 'obj', 'build', 'target'].includes(entry.name))
        .filter((entry) => !directoriesOnly || entry.isDirectory())
        .filter((entry) => isSafeProjectEntry(this.#projectRoot, join(directory, entry.name)))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const [index, entry] of entries.entries()) {
        if (lines.length >= 500) {
          truncated = true;
          return;
        }
        const last = index === entries.length - 1;
        lines.push(`${prefix}${last ? '`-- ' : '|-- '}${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) visit(join(directory, entry.name), `${prefix}${last ? '    ' : '|   '}`, depth + 1);
      }
    };
    visit(absolute, '', 1);
    if (truncated) lines.push('... tree truncated ...');
    return lines.join('\n');
  }

  private readFile(input: unknown): { path: string; content: string; truncated: boolean } {
    const args = objectInput(input);
    const path = stringInput(args.path, 'path');
    const maxChars = boundedNumber(args.maxChars, 24_000, 1, 100_000);
    const absolute = resolveProjectPath(this.#projectRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`File does not exist: ${path}`);
    const content = readFileSync(absolute, 'utf8');
    return { path: normalizePath(relative(this.#projectRoot, absolute)), content: content.slice(0, maxChars), truncated: content.length > maxChars };
  }

  private fileStructure(input: unknown): Record<string, unknown> {
    const args = objectInput(input);
    const path = stringInput(args.file_path, 'file_path');
    const absolute = resolveProjectPath(this.#projectRoot, path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`File does not exist: ${path}`);
    const source = readFileSync(absolute, 'utf8').replace(/\r\n?/g, '\n');
    const language = normalizeLanguage(args.language, extname(path));
    const expectedLanguage = languageForExtension(extname(path));
    if (expectedLanguage && expectedLanguage !== language) {
      throw new Error(`Language ${language} does not match file extension ${extname(path)}.`);
    }
    return extractFileSkeleton(source, normalizePath(relative(this.#projectRoot, absolute)), language);
  }

  private definition(input: unknown): Record<string, unknown> {
    const args = objectInput(input);
    const symbolName = stringInput(args.symbolName, 'symbolName');
    const simpleName = simpleSymbolName(symbolName);
    const maxChars = boundedNumber(args.maxChars, 12_000, 1, 50_000);
    const result = findDefinition(this.#projectRoot, simpleName);
    if (!result) throw new Error(`Symbol definition not found: ${symbolName}`);
    return { ...result, source: result.source.slice(0, maxChars), truncated: result.source.length > maxChars };
  }

  private findReferences(input: unknown): Array<{ path: string; line: number; excerpt: string }> {
    const args = objectInput(input);
    const symbolName = stringInput(args.symbolName, 'symbolName');
    const name = simpleSymbolName(symbolName);
    const maxResults = boundedNumber(args.maxResults, 24, 1, 200);
    const references: Array<{ path: string; line: number; excerpt: string }> = [];
    const visit = (directory: string): void => {
      if (references.length >= maxResults) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (references.length >= maxResults) return;
        if (entry.name.startsWith('.') || ['node_modules', 'bin', 'obj', 'build', 'target'].includes(entry.name)) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (isSafeProjectEntry(this.#projectRoot, absolute)) visit(absolute);
          continue;
        }
        if (!isSourceFile(entry.name)) continue;
        if (!isSafeProjectEntry(this.#projectRoot, absolute)) continue;
        const lines = readFileSync(absolute, 'utf8').replace(/\r\n?/g, '\n').split('\n');
        lines.forEach((line, index) => {
          if (references.length >= maxResults) return;
          if (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line)) {
            references.push({ path: normalizePath(relative(this.#projectRoot, absolute)), line: index + 1, excerpt: line.trim().slice(0, 240) });
          }
        });
      }
    };
    visit(this.#projectRoot);
    return references;
  }

  private targetContext(input: unknown): TargetModuleContext {
    const args = objectInput(input);
    const target = moduleTargetInput(args.target);
    resolveProjectPath(this.#projectRoot, target.path);
    return this.#collector.collect(target);
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('MCP tool input must be an object.');
  return value as Record<string, unknown>;
}

function stringInput(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function booleanInput(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('Numeric MCP arguments must be integers.');
  return Math.min(max, Math.max(min, value));
}

function moduleTargetInput(value: unknown): ModuleTarget {
  const target = objectInput(value);
  const language = stringInput(target.language, 'target.language') as Language;
  if (!['TypeScript', 'Python', 'Java', 'C#', 'Rust', 'Go'].includes(language)) {
    throw new Error(`Unsupported target.language: ${language}`);
  }
  if (target.kind !== 'class' && target.kind !== 'function') {
    throw new Error('target.kind must be "class" or "function".');
  }
  if (target.line !== undefined && (!Number.isInteger(target.line) || Number(target.line) < 1)) {
    throw new Error('target.line must be a positive integer.');
  }
  return {
    id: stringInput(target.id, 'target.id'),
    name: stringInput(target.name, 'target.name'),
    kind: target.kind,
    path: stringInput(target.path, 'target.path'),
    language,
    signature: stringInput(target.signature, 'target.signature'),
    ...(typeof target.documentation === 'string' ? { documentation: target.documentation } : {}),
    ...(typeof target.line === 'number' ? { line: target.line } : {}),
  };
}

function resolveProjectPath(projectRoot: string, targetPath: string): string {
  const absolute = resolve(projectRoot, targetPath.replaceAll('\\', '/'));
  const relativePath = relative(projectRoot, absolute);
  if (isOutsideProject(relativePath)) {
    throw new Error(`Path must stay inside the project root: ${targetPath}`);
  }
  if (!existsSync(absolute)) return absolute;
  const canonical = realpathSync(absolute);
  if (isOutsideProject(relative(projectRoot, canonical))) {
    throw new Error(`Path must stay inside the project root: ${targetPath}`);
  }
  return canonical;
}

function isOutsideProject(relativePath: string): boolean {
  return relativePath === '..' || relativePath.startsWith('../') || relativePath.startsWith('..\\') || isAbsolute(relativePath);
}

function isSafeProjectEntry(projectRoot: string, entryPath: string): boolean {
  try {
    return !isOutsideProject(relative(projectRoot, realpathSync(entryPath)));
  } catch {
    return false;
  }
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}

function normalizeLanguage(value: unknown, extension: string): string {
  const aliases: Record<string, string> = {
    python: 'python',
    java: 'java',
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'typescript',
    ts: 'typescript',
    go: 'go',
    c: 'c',
    csharp: 'csharp',
    'c#': 'csharp',
    cs: 'csharp',
    rust: 'rust',
  };
  if (typeof value === 'string' && value.trim()) {
    const language = aliases[value.trim().toLowerCase()];
    if (!language) throw new Error(`Unsupported language: ${value}`);
    return language;
  }
  const language = languageForExtension(extension);
  if (!language) throw new Error(`Cannot infer a supported language from extension: ${extension || '(none)'}`);
  return language;
}

function languageForExtension(extension: string): string | undefined {
  const byExtension: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.py': 'python', '.java': 'java', '.cs': 'csharp', '.rs': 'rust', '.go': 'go', '.c': 'c', '.h': 'c',
  };
  return byExtension[extension.toLowerCase()];
}

function extractFileSkeleton(source: string, filePath: string, language: string): Record<string, unknown> {
  if (language === 'python') return extractPythonFileSkeleton(source, filePath);
  const imports: string[] = [];
  const classes: Array<Record<string, unknown>> = [];
  const functions: Array<Record<string, unknown>> = [];
  const globals: Array<Record<string, unknown>> = [];
  const lines = source.split('\n');
  const typeStack: Array<{ name: string; depth: number; item: Record<string, unknown> }> = [];
  let depth = 0;
  const classPattern = /\b(class|interface|record|struct|enum|trait)\s+([A-Za-z_$][\w$]*)/;
  const functionPatterns = [
    /\b(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:(?:public|private|protected|internal|static|async|abstract|virtual|override|final|synchronized|default|extern|unsafe|new|partial)\s+)*(?:[\w.[\]<?>,]+\s+)+([A-Za-z_$][\w$]*)\s*\(/,
  ];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^(?:import|using|use|from\s+|extern\s+crate)\b/.test(trimmed)) imports.push(trimmed);
    while (typeStack.length && depth < typeStack.at(-1)!.depth) typeStack.pop();
    const typeMatch = line.match(classPattern);
    if (typeMatch?.[2]) {
      const item = { name: typeMatch[2], kind: typeMatch[1], start_line: index + 1, end_line: blockEndLine(lines, index), fields: [], methods: [] };
      classes.push(item);
      typeStack.push({ name: typeMatch[2], depth: depth + countCharacter(line, '{'), item });
    } else {
      const functionMatch = functionPatterns.map((pattern) => line.match(pattern)).find((match) => match?.[1]);
      if (functionMatch?.[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(functionMatch[1])) {
        const item = { name: functionMatch[1], signature: trimmed.slice(0, 1000), start_line: index + 1, end_line: blockEndLine(lines, index) };
        const owner = typeStack.at(-1)?.item;
        if (owner) (owner.methods as Array<Record<string, unknown>>).push(item);
        else functions.push(item);
      } else if (!typeStack.length && /^(?:const|let|var|static\s+final|public\s+static\s+final)\b/.test(trimmed)) {
        globals.push({ declaration: trimmed.slice(0, 1000), line: index + 1 });
      }
    }
    depth += countCharacter(line, '{') - countCharacter(line, '}');
  });
  return {
    file_path: filePath,
    language,
    skeleton: { imports, classes, functions, globals, structs: classes.filter((item) => item.kind === 'struct') },
  };
}

function extractPythonFileSkeleton(source: string, filePath: string): Record<string, unknown> {
  const imports: string[] = [];
  const classes: Array<Record<string, unknown>> = [];
  const functions: Array<Record<string, unknown>> = [];
  const globals: Array<Record<string, unknown>> = [];
  const lines = source.split('\n');
  const classStack: Array<{ indent: number; item: Record<string, unknown> }> = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const indent = line.length - line.trimStart().length;
    while (classStack.length && indent <= classStack.at(-1)!.indent) classStack.pop();
    if (/^(?:from|import)\s+/.test(trimmed)) imports.push(trimmed);

    const classMatch = trimmed.match(/^class\s+([A-Za-z_]\w*)/);
    if (classMatch?.[1]) {
      const item = {
        name: classMatch[1],
        kind: 'class',
        start_line: index + 1,
        end_line: pythonBlockEndLine(lines, index),
        fields: [],
        methods: [],
      };
      classes.push(item);
      classStack.push({ indent, item });
      return;
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    if (functionMatch?.[1]) {
      const item = {
        name: functionMatch[1],
        signature: trimmed.slice(0, 1000),
        start_line: index + 1,
        end_line: pythonBlockEndLine(lines, index),
      };
      const owner = classStack.at(-1)?.item;
      if (owner) (owner.methods as Array<Record<string, unknown>>).push(item);
      else functions.push(item);
      return;
    }

    if (indent === 0 && /^[A-Za-z_]\w*\s*(?::[^=]+)?=/.test(trimmed)) {
      globals.push({ declaration: trimmed.slice(0, 1000), line: index + 1 });
    }
  });

  return { file_path: filePath, language: 'python', skeleton: { imports, classes, functions, globals, structs: [] } };
}

function findDefinition(projectRoot: string, symbolName: string): { path: string; line: number; declaration: string; source: string } | null {
  let found: { path: string; line: number; declaration: string; source: string } | null = null;
  const declarationPattern = new RegExp(`\\b(?:class|interface|record|struct|enum|trait|function|def|fn|func)\\s+${escapeRegExp(symbolName)}\\b|\\b${escapeRegExp(symbolName)}\\s*\\(`);
  const visit = (directory: string): void => {
    if (found) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (found) return;
      if (entry.name.startsWith('.') || ['node_modules', 'bin', 'obj', 'build', 'target'].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (isSafeProjectEntry(projectRoot, absolute)) visit(absolute);
        continue;
      }
      if (!isSourceFile(entry.name)) continue;
      if (!isSafeProjectEntry(projectRoot, absolute)) continue;
      const lines = readFileSync(absolute, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      const index = lines.findIndex((line) => declarationPattern.test(line));
      if (index < 0) continue;
      const end = extname(entry.name) === '.py' ? pythonBlockEndLine(lines, index) : blockEndLine(lines, index);
      found = {
        path: normalizePath(relative(projectRoot, absolute)),
        line: index + 1,
        declaration: lines[index]!.trim().slice(0, 1000),
        source: lines.slice(index, end).join('\n'),
      };
    }
  };
  visit(projectRoot);
  return found;
}

function pythonBlockEndLine(lines: string[], start: number): number {
  const startLine = lines[start] ?? '';
  const baseIndent = startLine.length - startLine.trimStart().length;
  let end = start + 1;
  for (let index = start + 1; index < Math.min(lines.length, start + 500); index += 1) {
    const line = lines[index] ?? '';
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    end = index + 1;
  }
  return end;
}

function blockEndLine(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let index = start; index < Math.min(lines.length, start + 500); index += 1) {
    depth += countCharacter(lines[index] ?? '', '{') - countCharacter(lines[index] ?? '', '}');
    if (countCharacter(lines[index] ?? '', '{') > 0) opened = true;
    if (opened && depth <= 0) return index + 1;
  }
  return Math.min(lines.length, start + 1);
}

function countCharacter(value: string, target: string): number {
  let count = 0;
  for (const character of value) if (character === target) count += 1;
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function simpleSymbolName(symbolName: string): string {
  return symbolName.split(/::|[.:]/).filter(Boolean).at(-1) ?? symbolName;
}

function isSourceFile(fileName: string): boolean {
  return ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cs', '.rs', '.go', '.c', '.h'].includes(extname(fileName).toLowerCase());
}

export function createLocalMcpToolHost(projectRoot: string, options: { maxNeighbors?: number; maxReferences?: number } = {}): McpToolHost {
  return new LocalMcpToolHost(projectRoot, options);
}
