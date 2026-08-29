import path from 'node:path';
import * as vscode from 'vscode';
import type {
  ClassDeclarationKind,
  ClassMemberKind,
  ClassMemberSnapshot,
  ClassSnapshot,
  DiagnosticDelta,
  DiagnosticRequest,
  EditorTarget,
  Language,
  NormalizedDiagnostic,
  SourceLocation,
  SourcePosition,
  SourceRange,
  SymbolRequest,
} from '@forexplore/contracts';
import {
  LanguageIntelligenceError,
  type LanguageIntelligencePort,
} from '@forexplore/workflow-core';
import { classIntroducedDiagnostics, containsPosition } from './language-intelligence-core';

const DIAGNOSTIC_READY_LIMIT_MS = 15_000;

const languageIdByLanguage: Record<Language, string> = {
  TypeScript: 'typescript',
  Python: 'python',
  Java: 'java',
  'C#': 'csharp',
  Rust: 'rust',
  Go: 'go',
};

export class VscodeLanguageIntelligencePort implements LanguageIntelligencePort {
  async resolveContainingClass(target: EditorTarget, signal?: AbortSignal): Promise<ClassSnapshot> {
    throwIfAborted(signal);
    const uri = vscode.Uri.parse(target.uri, true);
    const document = await abortable(vscode.workspace.openTextDocument(uri), signal);
    if (target.documentVersion !== undefined && document.version !== target.documentVersion) {
      throw new LanguageIntelligenceError(
        'document_changed',
        `Document version changed from ${target.documentVersion} to ${document.version}.`,
      );
    }
    const symbols = await abortable(
      vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      ),
      signal,
    );
    if (!symbols) {
      throw new LanguageIntelligenceError(
        'lsp_unavailable',
        `No document-symbol language provider is available for ${document.languageId}.`,
      );
    }

    const documentSymbols = symbols.map(normalizeDocumentSymbol);
    const candidates = flattenSymbols(documentSymbols).filter(isClassLikeSymbol);
    const requestedPosition = target.position;
    const matches = requestedPosition
      ? candidates.filter((symbol) => containsPosition(toSourceRange(symbol.range), requestedPosition))
      : target.symbolName
        ? candidates.filter((symbol) => symbol.name === target.symbolName)
        : candidates.length === 1 ? candidates : [];
    const selected = [...matches].sort(
      (left, right) => rangeSize(left.range) - rangeSize(right.range),
    )[0];
    if (!selected) {
      const detail = requestedPosition
        ? `cursor ${requestedPosition.line + 1}:${requestedPosition.character + 1}`
        : `symbol ${target.symbolName ?? '(missing)'}`;
      throw new Error(`No containing class, record, or interface was returned by LSP for ${detail}.`);
    }

    return classSnapshot(document, selected, target.language);
  }

  async definitions(request: SymbolRequest, signal?: AbortSignal): Promise<SourceLocation[]> {
    const uri = vscode.Uri.parse(request.uri, true);
    const locations = await abortable(
      vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
        'vscode.executeDefinitionProvider',
        uri,
        toVscodePosition(request.position),
      ),
      signal,
    );
    if (!locations) {
      throw new LanguageIntelligenceError(
        'lsp_unavailable',
        `No definition language provider is available for ${uri.toString()}.`,
      );
    }
    return locations.map(normalizeLocation);
  }

  async references(request: SymbolRequest, signal?: AbortSignal): Promise<SourceLocation[]> {
    const uri = vscode.Uri.parse(request.uri, true);
    const locations = await abortable(
      vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        toVscodePosition(request.position),
      ),
      signal,
    );
    if (!locations) {
      throw new LanguageIntelligenceError(
        'lsp_unavailable',
        `No reference language provider is available for ${uri.toString()}.`,
      );
    }
    return locations.map(normalizeLocation);
  }

  async diagnose(request: DiagnosticRequest, signal?: AbortSignal): Promise<DiagnosticDelta> {
    throwIfDeadlineExpired(request.deadlineAt);
    throwIfAborted(signal);
    const targetUri = vscode.Uri.parse(request.target.uri, true);
    const targetDocument = await abortable(vscode.workspace.openTextDocument(targetUri), signal);
    if (targetDocument.version !== request.target.documentVersion) {
      throw new LanguageIntelligenceError(
        'document_changed',
        `Target document changed from version ${request.target.documentVersion} to ${targetDocument.version}.`,
      );
    }

    const baseline = request.baselineDiagnostics ?? normalizeDiagnostics(
      targetUri,
      vscode.languages.getDiagnostics(targetUri),
      targetDocument.version,
    );
    if (request.candidateSource === undefined) {
      const current = normalizeDiagnostics(
        targetUri,
        vscode.languages.getDiagnostics(targetUri),
        targetDocument.version,
      );
      const delta = classIntroducedDiagnostics(baseline, current, request.target.range);
      return { documentVersion: targetDocument.version, baseline, current, ...delta };
    }

    const candidateText = replaceClassSource(
      targetDocument,
      request.target.range,
      request.candidateSource,
    );
    const plainDocument = await abortable(
      vscode.workspace.openTextDocument({ content: candidateText }),
      signal,
    );
    const diagnosticsReady = waitForDiagnostics(
      plainDocument.uri,
      Math.min(request.deadlineAt, Date.now() + DIAGNOSTIC_READY_LIMIT_MS),
      signal,
    );
    const candidateDocument = await abortable(
      vscode.languages.setTextDocumentLanguage(
        plainDocument,
        languageIdByLanguage[request.target.language],
      ),
      signal,
    );

    await diagnosticsReady;
    throwIfDeadlineExpired(request.deadlineAt);
    const current = normalizeDiagnostics(
      targetUri,
      vscode.languages.getDiagnostics(candidateDocument.uri),
      candidateDocument.version,
    );
    const delta = classIntroducedDiagnostics(baseline, current, candidateClassRange(request));
    return { documentVersion: candidateDocument.version, baseline, current, ...delta };
  }
}

function classSnapshot(
  document: vscode.TextDocument,
  symbol: vscode.DocumentSymbol,
  language: Language,
): ClassSnapshot {
  const source = document.getText(symbol.range);
  const declaration = declarationHeader(source);
  const declarationKind = classKind(symbol, declaration);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const relativePath = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath).replace(/\\/g, '/')
    : document.uri.fsPath;
  const members = symbol.children.map((child) => memberSnapshot(document, child)).filter(isPresent);
  const metadata = classMetadata(declaration, language);
  return {
    uri: document.uri.toString(),
    path: relativePath,
    language,
    name: symbol.name,
    declarationKind,
    range: toSourceRange(symbol.range),
    selectionRange: toSourceRange(symbol.selectionRange),
    documentVersion: document.version,
    source,
    declaration,
    namespace: namespaceOf(document.getText()),
    imports: importsOf(document.getText(), symbol.range.start.line),
    baseTypes: metadata.baseTypes,
    interfaces: metadata.interfaces,
    genericConstraints: metadata.genericConstraints,
    members,
  };
}

function memberSnapshot(
  document: vscode.TextDocument,
  symbol: vscode.DocumentSymbol,
): ClassMemberSnapshot | null {
  const kind = memberKind(symbol.kind);
  if (!kind) return null;
  const source = document.getText(symbol.range);
  return {
    name: symbol.name,
    kind,
    range: toSourceRange(symbol.range),
    selectionRange: toSourceRange(symbol.selectionRange),
    declaration: declarationHeader(source).slice(0, 1_000),
  };
}

function memberKind(kind: vscode.SymbolKind): ClassMemberKind | null {
  if (kind === vscode.SymbolKind.Field || kind === vscode.SymbolKind.Variable) return 'field';
  if (kind === vscode.SymbolKind.Constructor) return 'constructor';
  if (kind === vscode.SymbolKind.Property) return 'property';
  if (kind === vscode.SymbolKind.Method || kind === vscode.SymbolKind.Function) return 'method';
  if (kind === vscode.SymbolKind.Interface) return 'interface';
  if (kind === vscode.SymbolKind.Struct) return 'record';
  if (kind === vscode.SymbolKind.Class) return 'class';
  return null;
}

function classKind(symbol: vscode.DocumentSymbol, declaration: string): ClassDeclarationKind {
  if (symbol.kind === vscode.SymbolKind.Interface || /\binterface\b/.test(declaration)) return 'interface';
  if (/\brecord\b/.test(declaration)) return 'record';
  return 'class';
}

function classMetadata(
  declaration: string,
  language: Language,
): { baseTypes: string[]; interfaces: string[]; genericConstraints: string[] } {
  const compact = declaration.replace(/\s+/g, ' ').trim();
  const genericConstraints = [...compact.matchAll(/\bwhere\s+[^,{]+(?=\bwhere\s+|$)/g)]
    .map((match) => match[0].trim());
  if (language === 'Java') {
    const baseTypes = compact.match(/\bextends\s+([^\s,{]+)/)?.[1]
      ?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
    const interfaces = compact.match(/\bimplements\s+(.+?)(?:\bpermits\b|$)/)?.[1]
      ?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
    return { baseTypes, interfaces, genericConstraints };
  }
  const inheritance = compact.match(/:\s*(.+?)(?:\bwhere\s+|$)/)?.[1]
    ?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
  return { baseTypes: inheritance.slice(0, 1), interfaces: inheritance.slice(1), genericConstraints };
}

function declarationHeader(source: string): string {
  const brace = source.indexOf('{');
  const colon = source.indexOf(':\n');
  const end = brace >= 0 ? brace : colon >= 0 ? colon + 1 : source.indexOf('\n');
  return source.slice(0, end < 0 ? source.length : end).trim();
}

function importsOf(source: string, beforeLine: number): string[] {
  return source.split(/\r?\n/).slice(0, beforeLine + 1)
    .map((line) => line.trim())
    .filter((line) => /^(?:global\s+)?using\s+.+;|^import\s+.+;/.test(line));
}

function namespaceOf(source: string): string | undefined {
  return source.match(/^\s*(?:namespace|package)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/m)?.[1];
}

function replaceClassSource(
  document: vscode.TextDocument,
  range: SourceRange,
  candidateSource: string,
): string {
  const start = document.offsetAt(toVscodePosition(range.start));
  const end = document.offsetAt(toVscodePosition(range.end));
  return `${document.getText().slice(0, start)}${candidateSource}${document.getText().slice(end)}`;
}

function candidateClassRange(request: DiagnosticRequest): SourceRange {
  const source = request.candidateSource ?? request.target.source;
  const lines = source.split(/\r?\n/);
  return {
    start: request.target.range.start,
    end: lines.length === 1
      ? {
          line: request.target.range.start.line,
          character: request.target.range.start.character + (lines[0]?.length ?? 0),
        }
      : {
          line: request.target.range.start.line + lines.length - 1,
          character: lines.at(-1)?.length ?? 0,
        },
  };
}

function waitForDiagnostics(uri: vscode.Uri, deadlineAt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new LanguageIntelligenceError('timed_out', 'Timed out waiting for LSP diagnostics.'));
      return;
    }
    let subscription: vscode.Disposable | undefined;
    const cleanup = (): void => {
      clearTimeout(timer);
      subscription?.dispose();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new LanguageIntelligenceError('cancelled', 'LSP diagnostics were cancelled.'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new LanguageIntelligenceError(
        'lsp_unavailable',
        'The language provider did not publish diagnostics for the candidate document.',
      ));
    }, remaining);
    subscription = vscode.languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((changed) => changed.toString() === uri.toString())) return;
      cleanup();
      resolve();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeDiagnostics(
  reportedUri: vscode.Uri,
  diagnostics: readonly vscode.Diagnostic[],
  documentVersion: number,
): NormalizedDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    uri: reportedUri.toString(),
    range: toSourceRange(diagnostic.range),
    severity: diagnosticSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source,
    code: diagnosticCode(diagnostic.code),
    documentVersion,
  }));
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): NormalizedDiagnostic['severity'] {
  if (severity === vscode.DiagnosticSeverity.Error) return 'error';
  if (severity === vscode.DiagnosticSeverity.Warning) return 'warning';
  if (severity === vscode.DiagnosticSeverity.Information) return 'information';
  return 'hint';
}

function diagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return code ? String(code.value) : undefined;
}

function normalizeLocation(location: vscode.Location | vscode.LocationLink): SourceLocation {
  if ('targetUri' in location) {
    return { uri: location.targetUri.toString(), range: toSourceRange(location.targetRange) };
  }
  return { uri: location.uri.toString(), range: toSourceRange(location.range) };
}

function isDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): symbol is vscode.DocumentSymbol {
  return 'range' in symbol && 'selectionRange' in symbol && 'children' in symbol;
}

function normalizeDocumentSymbol(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): vscode.DocumentSymbol {
  if (isDocumentSymbol(symbol)) return symbol;
  return new vscode.DocumentSymbol(
    symbol.name,
    symbol.containerName,
    symbol.kind,
    symbol.location.range,
    symbol.location.range,
  );
}

function flattenSymbols(symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
  return symbols.flatMap((symbol) => [symbol, ...flattenSymbols(symbol.children)]);
}

function isClassLikeSymbol(symbol: vscode.DocumentSymbol): boolean {
  return symbol.kind === vscode.SymbolKind.Class ||
    symbol.kind === vscode.SymbolKind.Interface ||
    symbol.kind === vscode.SymbolKind.Struct;
}

function rangeSize(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}

function toSourceRange(range: vscode.Range): SourceRange {
  return { start: toSourcePosition(range.start), end: toSourcePosition(range.end) };
}

function toSourcePosition(position: vscode.Position): SourcePosition {
  return { line: position.line, character: position.character };
}

function toVscodePosition(position: SourcePosition): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function throwIfDeadlineExpired(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) {
    throw new LanguageIntelligenceError('timed_out', 'The shared translation deadline expired.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new LanguageIntelligenceError('cancelled', 'Language intelligence request was cancelled.');
  }
}

function abortable<T>(promise: Thenable<T> | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new LanguageIntelligenceError('cancelled', 'Language intelligence request was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
