import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

/**
 * C/C++ coverage over a real JNI bridge pair.
 *
 * The header is the reason this fixture exists. `.h` used to resolve to the C
 * grammar, and a C++ header parses as garbage under it: seven syntax errors, the
 * `ChunkWriter` class dropped entirely, two bogus function entries left behind —
 * while the matching .cpp indexed cleanly. Because a header is where the interface
 * and the JNI export declarations live, C++ interfaces were reachable only through
 * their definitions.
 *
 * Known gaps after that fix, measured here and deliberately not asserted as correct:
 *   - a member function declared inside a class body is reported as `field`, and
 *     `field` is not in `functionKinds`, so declared methods are not retrievable as
 *     functions;
 *   - a declaration without a body (a prototype, which is what a header is made of)
 *     is not extracted at all, so the header's `extern "C"` JNI declarations are
 *     missing even though the .cpp's definitions are found;
 *   - both files still report three syntax errors each.
 */
const header = new URL('../../../fixtures/code-corpus/harmony-upload-native/app/src/main/cpp/upload_bridge.h', import.meta.url);
const implementation = new URL('../../../fixtures/code-corpus/harmony-upload-native/app/src/main/cpp/upload_bridge.cpp', import.meta.url);

const index = async (url: URL, expectedLanguage: string) => {
  const content = await readFile(url, 'utf8');
  const language = createDefaultLanguageRegistry().resolvePath(url.pathname);
  expect(language?.languageId).toBe(expectedLanguage);
  return indexTreeSitterFile({ content, language: language!, relativePath: url.pathname });
};

describe('C/C++ fixture through the real indexer', () => {
  it('reads a .h with the C++ grammar, so a C++ class declaration survives', async () => {
    const names = (await index(header, 'c')).declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);
    expect(names).toContain('namespace upload');
    expect(names).toContain('class ChunkWriter');
  });

  it('reads a .c with the C grammar, leaving plain C untouched by the header override', () => {
    const language = createDefaultLanguageRegistry().resolvePath('src/plain.c');
    expect(language?.languageId).toBe('c');
    expect(language?.grammar).toBe(createDefaultLanguageRegistry().resolvePath('src/plain.c')?.grammar);
    // The override is per extension: only `.h` takes the C++ grammar.
    expect(createDefaultLanguageRegistry().resolvePath('src/plain.h')?.grammar)
      .not.toBe(language?.grammar);
  });

  it('indexes the implementation, including every JNI export the Java side calls', async () => {
    const names = (await index(implementation, 'cpp')).declarations.map((declaration) => declaration.name);
    expect(names).toContain('open_session');
    expect(names).toContain('close_session');
    for (const exported of ['Java_com_example_upload_NativeUpload_beginUpload', 'Java_com_example_upload_NativeUpload_pumpChunks',
      'Java_com_example_upload_NativeUpload_endUpload']) {
      expect(names).toContain(exported);
    }
  });

  it('keeps the include graph the dependency resolver consumes, system headers included', async () => {
    const result = await index(implementation, 'cpp');
    // System includes keep their angle brackets, which is what keeps them
    // distinguishable from a local include of the same name.
    expect(result.imports.map((item) => item.targetReference))
      .toEqual(expect.arrayContaining(['upload_bridge.h', '<fstream>', '<unordered_map>', '<vector>']));
  });
});
