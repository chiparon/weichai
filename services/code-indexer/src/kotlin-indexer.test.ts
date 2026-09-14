import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

/**
 * Kotlin / KMP coverage over real files.
 *
 * Unlike ArkTS, Kotlin needed no normalization: the grammar reads it as-is, both
 * source sets report zero diagnostics, and every material symbol reaches the index —
 * including the `expect` and `actual` halves of the platform pair that
 * cross-language-bindings.ts resolves.
 *
 * Known fidelity gaps, deliberately not asserted as correct here:
 *   - `interface` and `enum class` are both reported as `class`, although
 *     `classKinds` distinguishes them for class-level routing;
 *   - a member function is reported as `function`, so its container is lost;
 *   - a local `val` inside a lambda is reported as `field`, the same
 *     language-agnostic noise seen with a TypeScript `const`.
 */
const common = new URL('../../../fixtures/code-corpus/multipart-shared-kmp/shared/src/commonMain/kotlin/com/example/upload/UploadSession.kt', import.meta.url);
const android = new URL('../../../fixtures/code-corpus/multipart-shared-kmp/shared/src/androidMain/kotlin/com/example/upload/UploadSession.android.kt', import.meta.url);

const index = async (url: URL) => {
  const content = await readFile(url, 'utf8');
  const language = createDefaultLanguageRegistry().resolvePath(url.pathname);
  expect(language?.languageId).toBe('kotlin');
  return indexTreeSitterFile({ content, language: language!, relativePath: url.pathname });
};

describe('Kotlin fixture through the real indexer', () => {
  it('parses both source sets without diagnostics', async () => {
    expect((await index(common)).diagnostics).toEqual([]);
    expect((await index(android)).diagnostics).toEqual([]);
  });

  it('indexes the common declarations a KMP module is written in', async () => {
    const names = (await index(common)).declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);
    for (const expected of ['class UploadSink', 'function platformTag', 'class UploadProgress', 'class UploadState',
      'class UploadListener', 'class UploadSession', 'function transfer', 'field MAX_CHUNK', 'function describe']) {
      expect(names).toContain(expected);
    }
  });

  it('indexes the actual half of the expect/actual pair, so the binding can resolve it', async () => {
    const names = (await index(android)).declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);
    expect(names).toContain('class UploadSink');
    expect(names).toContain('function platformTag');
    expect(names).toContain('field file');
  });

  it('keeps the package and imports the dependency graph is built on', async () => {
    const result = await index(common);
    expect(result.declarations.some((declaration) => declaration.name === 'com.example.upload')).toBe(true);
    expect(result.imports.map((item) => item.targetReference)).toEqual(
      expect.arrayContaining(['kotlinx.coroutines.Dispatchers', 'kotlinx.coroutines.withContext', 'java.io.File']));
  });
});
