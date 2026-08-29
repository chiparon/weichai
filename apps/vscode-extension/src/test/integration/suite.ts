import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { VscodeLanguageIntelligencePort } from '../../vscode-language-intelligence';
import { LanguageIntelligenceError } from '@forexplore/workflow-core';
const FIXTURE_FILE = process.env.FOREXPLORE_TEST_FIXTURE;
const FIXTURE_WORKSPACE = process.env.FOREXPLORE_TEST_WORKSPACE;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms.`);
}

async function openFixtureWithSelection(): Promise<void> {
  if (!FIXTURE_FILE) throw new Error('FOREXPLORE_TEST_FIXTURE env var is required.');
  if (!FIXTURE_WORKSPACE) throw new Error('FOREXPLORE_TEST_WORKSPACE env var is required.');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(FIXTURE_FILE));
  const editor = await vscode.window.showTextDocument(document);
  const methodOffset = document.getText().indexOf('public List<FileItem> parseRequest(RequestContext ctx)');
  assert.ok(methodOffset >= 0, 'Java fixture must contain parseRequest');
  const fullRange = new vscode.Range(
    document.positionAt(methodOffset),
    document.positionAt(Math.min(document.getText().length, methodOffset + 360)),
  );
  editor.selection = new vscode.Selection(fullRange.start, fullRange.end);
  assert.ok(
    vscode.workspace.getWorkspaceFolder(document.uri),
    'Java fixture must be inside the launched workspace folder',
  );
}

function registerFixtureLanguageProviders(): vscode.Disposable {
  const selectors: vscode.DocumentSelector = [{ language: 'java' }, { language: 'csharp' }];
  const diagnostics = vscode.languages.createDiagnosticCollection('forexplore-fixture-lsp');
  const symbols = vscode.languages.registerDocumentSymbolProvider(selectors, {
    provideDocumentSymbols(document) {
      const source = document.getText();
      const match = /^[\t ]*(?:(?:public|private|protected|internal|abstract|final|sealed|static|partial)\s+)*(class|record|interface)\s+([A-Za-z_]\w*)/m.exec(source);
      if (!match || match.index === undefined || !match[2]) return [];
      const declarationStart = source.lastIndexOf('\n', match.index) + 1;
      const nameStart = match.index + match[0].lastIndexOf(match[2]);
      const range = new vscode.Range(
        document.positionAt(declarationStart),
        document.positionAt(source.length),
      );
      const selectionRange = new vscode.Range(
        document.positionAt(nameStart),
        document.positionAt(nameStart + match[2].length),
      );
      const kind = match[1] === 'interface'
        ? vscode.SymbolKind.Interface
        : match[1] === 'record' ? vscode.SymbolKind.Struct : vscode.SymbolKind.Class;
      const type = new vscode.DocumentSymbol(match[2], '', kind, range, selectionRange);
      const method = /\b([A-Za-z_]\w*)\s*\([^)]*\)/g;
      for (const member of source.matchAll(method)) {
        if (member.index === undefined || !member[1] || member[1] === match[2]) continue;
        const lineStart = source.lastIndexOf('\n', member.index) + 1;
        const lineEnd = source.indexOf('\n', member.index);
        const memberRange = new vscode.Range(
          document.positionAt(lineStart),
          document.positionAt(lineEnd < 0 ? source.length : lineEnd),
        );
        const memberNameStart = member.index + member[0].indexOf(member[1]);
        type.children.push(new vscode.DocumentSymbol(
          member[1],
          '',
          vscode.SymbolKind.Method,
          memberRange,
          new vscode.Range(
            document.positionAt(memberNameStart),
            document.positionAt(memberNameStart + member[1].length),
          ),
        ));
      }
      return [type];
    },
  });
  const definitions = vscode.languages.registerDefinitionProvider(selectors, {
    provideDefinition(document, position) {
      return new vscode.Location(document.uri, new vscode.Range(position, position));
    },
  });
  const references = vscode.languages.registerReferenceProvider(selectors, {
    provideReferences(document, position) {
      return [new vscode.Location(document.uri, new vscode.Range(position, position))];
    },
  });
  const publish = (document: vscode.TextDocument): void => {
    if (document.languageId !== 'java' && document.languageId !== 'csharp') return;
    setTimeout(() => {
      const source = document.getText();
      const offset = source.indexOf('BROKEN_LSP');
      diagnostics.set(document.uri, offset < 0 ? [] : [new vscode.Diagnostic(
        new vscode.Range(document.positionAt(offset), document.positionAt(offset + 10)),
        'Fixture candidate contains BROKEN_LSP.',
        vscode.DiagnosticSeverity.Error,
      )]);
    }, 10);
  };
  const opened = vscode.workspace.onDidOpenTextDocument(publish);
  const changed = vscode.workspace.onDidChangeTextDocument((event) => publish(event.document));
  vscode.workspace.textDocuments.forEach(publish);
  return vscode.Disposable.from(diagnostics, symbols, definitions, references, opened, changed);
}

async function verifyLanguageIntelligencePort(): Promise<void> {
  if (!FIXTURE_FILE) throw new Error('FOREXPLORE_TEST_FIXTURE env var is required.');
  const port = new VscodeLanguageIntelligencePort();
  const javaDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(FIXTURE_FILE));
  const methodOffset = javaDocument.getText().indexOf('public List<FileItem> parseRequest(RequestContext ctx)');
  const javaTarget = {
    uri: javaDocument.uri.toString(),
    language: 'Java' as const,
    position: {
      line: javaDocument.positionAt(methodOffset).line,
      character: javaDocument.positionAt(methodOffset).character,
    },
    documentVersion: javaDocument.version,
  };
  const javaClass = await port.resolveContainingClass(javaTarget);
  assert.strictEqual(javaClass.name, 'FileUploadBase');
  assert.ok(javaClass.source.includes('parseRequest'), 'Java class snapshot must include complete members');
  const definition = await port.definitions({
    uri: javaClass.uri,
    position: javaClass.selectionRange.start,
  });
  const references = await port.references({
    uri: javaClass.uri,
    position: javaClass.selectionRange.start,
  });
  assert.strictEqual(definition.length, 1, 'Java definition must use the registered provider');
  assert.strictEqual(references.length, 1, 'Java references must use the registered provider');

  const csharpPlain = await vscode.workspace.openTextDocument({
    content: 'namespace Fixture;\npublic record QuoteService { public int Value() => 1; }',
  });
  const csharpDocument = await vscode.languages.setTextDocumentLanguage(csharpPlain, 'csharp');
  const csharpClass = await port.resolveContainingClass({
    uri: csharpDocument.uri.toString(),
    language: 'C#',
    symbolName: 'QuoteService',
    documentVersion: csharpDocument.version,
  });
  assert.strictEqual(csharpClass.declarationKind, 'record');

  const baseline = await port.diagnose({ target: javaClass, deadlineAt: Date.now() + 5_000 });
  const broken = await port.diagnose({
    target: javaClass,
    candidateSource: javaClass.source.replace('public abstract class FileUploadBase', 'public abstract class FileUploadBase /* BROKEN_LSP */'),
    baselineDiagnostics: baseline.current,
    deadlineAt: Date.now() + 5_000,
  });
  assert.strictEqual(broken.introduced.length, 1, 'candidate-only Java diagnostic must be introduced');

  const plaintext = await vscode.workspace.openTextDocument({ content: 'plain text' });
  await assert.rejects(
    () => port.resolveContainingClass({
      uri: plaintext.uri.toString(),
      language: 'TypeScript',
      position: { line: 0, character: 0 },
    }),
    (error: unknown) => error instanceof LanguageIntelligenceError && error.kind === 'lsp_unavailable',
  );
}

function findTranslationTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        (tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType === 'forexplore.translation') ||
        tab.label === 'ForeXplore 代码翻译',
    );
}

export async function run(): Promise<void> {
  const providers = registerFixtureLanguageProviders();
  try {
  const extension = vscode.extensions.getExtension('forexplore.forexplore-vscode');
  assert.ok(extension, 'extension forexplore.forexplore-vscode must be activated');
  await extension.activate();
  await verifyLanguageIntelligencePort();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'forexplore.startTranslation',
    'forexplore.showPanel',
    'forexplore.checkRepositories',
    'forexplore.reindex',
    'forexplore.configureModelKey',
    'forexplore.restoreLastCheckpoint',
  ]) {
    assert.ok(commands.includes(command), `command ${command} must be registered`);
  }

  await openFixtureWithSelection();
  await vscode.commands.executeCommand('forexplore.startTranslation');
  await waitFor(() => findTranslationTab() !== undefined);
  assert.ok(findTranslationTab(), 'translation webview panel must be opened');

  // Re-running with an active selection must reuse the same panel.
  await vscode.commands.executeCommand('forexplore.startTranslation');
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const panels = tabs.filter(
      (tab) =>
        (tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType === 'forexplore.translation') ||
        tab.label === 'ForeXplore 代码翻译',
  );
  assert.strictEqual(panels.length, 1, 'translation panel must be reused, not duplicated');
  } finally {
    providers.dispose();
  }
}
