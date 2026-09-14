import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile, normalizeArkTs } from './tree-sitter-indexer.js';

/**
 * ArkTS/ArkUI coverage, over a real `.ets` file rather than an inline snippet.
 *
 * Before normalizeArkTs the page component was missing from the index entirely: the
 * TypeScript grammar cannot read `@Entry @Component struct UploadPage`, so the file
 * reported eight syntax errors, `UploadPage` never became a declaration, and the UI
 * builder call `Column(...)` was misread as a method. That is the symbol a HarmonyOS
 * developer names when they ask for a page, so the gap mattered more than its size
 * suggests.
 *
 * The declaration walk also turned the method-local bindings into structure:
 * `const handle = this.native.beginUpload(...)` in `UploadBridge.transfer` and
 * `const failure = error as BusinessError` in `UploadBridge.abort` were reported as
 * `field`s, because a TypeScript `const` is a `lexical_declaration` wherever it
 * sits. Both are gone, and `methods` and the page component are untouched.
 *
 * Fixing that left the opposite half of the same distinction open. A class
 * *property* is a `public_field_definition`, which the walk did not map, so a
 * property was never extracted at all — while the `method_signature` beside it in
 * the same file was. The page's `@State progress`, `@Prop fileName` and
 * `@Link session`, and `UploadPage.bridge` and `UploadBridge.native` with them,
 * were invisible: a page component's state, which is what a HarmonyOS developer
 * asks for by name, indexed as structure with no state. They are extracted now, so
 * the fixture reports 14 declarations — 9 before — of which 5 are `field`s; the
 * local bindings above are still not among them, because a class body is a type
 * scope and a callable body is not.
 */
const fixture = new URL('../../../fixtures/code-corpus/harmony-upload-arkts/entry/src/main/ets/pages/UploadPage.ets', import.meta.url);

describe('normalizeArkTs', () => {
  it('is exactly width-preserving, so source ranges and content hashes stay valid', () => {
    for (const line of ['@Entry', '@Component struct UploadPage {', '  @State progress: number = 0;', '  @Link session: UploadSession;']) {
      expect(normalizeArkTs(line)).toHaveLength(line.length);
    }
  });

  it('rewrites struct to class and blanks decorators', () => {
    expect(normalizeArkTs('@Component struct UploadPage {')).toBe('           class  UploadPage {');
    expect(normalizeArkTs('  @State progress: number = 0;')).toBe('         progress: number = 0;');
  });

  it('never touches a decorator-shaped string literal', () => {
    const line = "import { BusinessError } from '@kit.BasicServicesKit';";
    expect(normalizeArkTs(line)).toBe(line);
    expect(normalizeArkTs('const s = "a@State b";')).toBe('const s = "a@State b";');
  });

  it('leaves an identifier that merely starts with struct alone', () => {
    expect(normalizeArkTs('const structure = 1;')).toBe('const structure = 1;');
  });
});

describe('ArkTS fixture through the real indexer', () => {
  const index = async () => {
    const content = await readFile(fixture, 'utf8');
    const language = createDefaultLanguageRegistry().resolvePath('UploadPage.ets');
    expect(language?.languageId).toBe('arkts');
    return indexTreeSitterFile({ content, language: language!, relativePath: 'UploadPage.ets' });
  };

  it('indexes the page component and its ArkUI members with no syntax errors', async () => {
    const result = await index();
    expect(result.diagnostics).toEqual([]);
    const names = result.declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);
    expect(names).toContain('class UploadPage');
    expect(names).toContain('method aboutToAppear');
    expect(names).toContain('method build');
    expect(names).toContain('method startUpload');
    expect(names).toContain('class UploadBridge');
    // The whole file, so a member cannot go missing or double without a failure:
    // two classes, one interface, six methods and five class properties.
    expect(result.declarations).toHaveLength(14);
  });

  it('keeps the imports the dependency graph is built on, including the native binding', async () => {
    const result = await index();
    const targets = result.imports.map((item) => item.targetReference);
    expect(targets).toContain('libentry.so');
    expect(targets).toContain('@kit.BasicServicesKit');
  });

  it('extracts the page state the ArkUI decorators declare, in original coordinates', async () => {
    const result = await index();
    const content = await readFile(fixture, 'utf8');
    const lines = content.split('\n');
    const page = result.declarations.find((declaration) => declaration.name === 'UploadPage')!;
    // The decorator is blanked to spaces rather than deleted, so the node starts
    // where the property starts; slicing the *original* line by the reported
    // columns must still yield exactly the property.
    for (const [name, decorator, line] of [
      ['progress', '@State', 21],
      ['fileName', '@Prop', 22],
      ['session', '@Link', 23],
    ] as const) {
      const declaration = result.declarations.find((entry) => entry.name === name)!;
      expect(declaration.kind).toBe('field');
      expect(declaration.declarationNodeType).toBe('public_field_definition');
      expect(declaration.qualifiedName).toBe(`UploadPage.${name}`);
      expect(declaration.containerSymbolKey).toBe(page.symbolKey);
      const original = lines[line - 1]!;
      expect(original.startsWith(`  ${decorator} ${name}`)).toBe(true);
      expect(declaration.sourceRange.startLine).toBe(line);
      expect(declaration.sourceRange.endLine).toBe(line);
      expect(original.slice(
        declaration.sourceRange.startColumn - 1,
        declaration.sourceRange.endColumn - 1,
      )).toBe(declaration.signature);
    }
    expect(result.declarations.find((entry) => entry.name === 'progress')?.signature)
      .toBe('progress: number = 0');
  });

  it('does not index a binding local to a method as a field', async () => {
    const result = await index();
    const names = result.declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);
    // `handle` in `transfer` and `failure` in `abort` are the only two bindings
    // this file declares inside a callable body, and both are locals.
    expect(names).not.toContain('field handle');
    expect(names).not.toContain('field failure');
    // The arrow-function parameters `sent`/`total` are not declarations either.
    expect(names).not.toContain('field sent');
    expect(names).not.toContain('field total');
    // Every `field` the file reports is a class property, and they are exactly
    // the five the source declares.
    expect(result.declarations.filter((declaration) => declaration.kind === 'field')
      .map((declaration) => declaration.qualifiedName).sort()).toEqual([
      'UploadBridge.native',
      'UploadPage.bridge',
      'UploadPage.fileName',
      'UploadPage.progress',
      'UploadPage.session',
    ]);
    // The enclosing methods are still indexed, under their class.
    const transfer = result.declarations.find((declaration) => declaration.name === 'transfer')!;
    expect(transfer.kind).toBe('method');
    expect(transfer.qualifiedName).toBe('UploadBridge.transfer');
  });

  it('reports source ranges in original file coordinates', async () => {
    const result = await index();
    const page = result.declarations.find((declaration) => declaration.name === 'UploadPage')!;
    const content = await readFile(fixture, 'utf8');
    const line = content.split('\n')[page.sourceRange.startLine - 1]!;
    expect(line).toContain('struct UploadPage');
  });
});
