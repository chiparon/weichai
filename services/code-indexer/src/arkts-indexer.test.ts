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
  });

  it('keeps the imports the dependency graph is built on, including the native binding', async () => {
    const result = await index();
    const targets = result.imports.map((item) => item.targetReference);
    expect(targets).toContain('libentry.so');
    expect(targets).toContain('@kit.BasicServicesKit');
  });

  it('reports source ranges in original file coordinates', async () => {
    const result = await index();
    const page = result.declarations.find((declaration) => declaration.name === 'UploadPage')!;
    const content = await readFile(fixture, 'utf8');
    const line = content.split('\n')[page.sourceRange.startLine - 1]!;
    expect(line).toContain('struct UploadPage');
  });
});
