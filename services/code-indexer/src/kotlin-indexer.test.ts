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
 * What the declaration walk used to lose, and what these tests now pin:
 *   - Kotlin spells `interface` and `enum class` with a `class_declaration` node,
 *     so `UploadListener` and `UploadState` were both reported as `class` although
 *     `classKinds` distinguishes `interface` and `enum` for class-level routing;
 *   - a member function and a top-level function are both `function_declaration`,
 *     so `UploadSink.write` was a `function` with no way to tell it from
 *     `platformTag`. Membership is now read off the parent chain: commonMain went
 *     from 19 declarations to 17, of which six are methods;
 *   - a local `val` inside a lambda is a `variable_declaration`, exactly like a
 *     class property, so `bytes` and `sent` inside `transfer` were reported as
 *     `field`s — the same language-agnostic noise seen with a TypeScript `const`.
 *     `sink`, `state` and `MAX_CHUNK` are real class properties and stay fields.
 *
 * Remaining gaps, deliberately not asserted as correct:
 *   - a Kotlin property is reported as `field` through its inner
 *     `variable_declaration` node, because `property_declaration` itself has no
 *     name node `nameNodeFor` recognises, so `property` never appears;
 *   - an `object` / `companion object` has no kind of its own and is not reported
 *     at all; its members are qualified under the enclosing class.
 */
const common = new URL('../../../fixtures/code-corpus/multipart-shared-kmp/shared/src/commonMain/kotlin/com/example/upload/UploadSession.kt', import.meta.url);
const android = new URL('../../../fixtures/code-corpus/multipart-shared-kmp/shared/src/androidMain/kotlin/com/example/upload/UploadSession.android.kt', import.meta.url);

const index = async (url: URL) => {
  const content = await readFile(url, 'utf8');
  const language = createDefaultLanguageRegistry().resolvePath(url.pathname);
  expect(language?.languageId).toBe('kotlin');
  return indexTreeSitterFile({ content, language: language!, relativePath: url.pathname });
};

const kindsOf = (declarations: { kind: string; name: string }[]) =>
  declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);

describe('Kotlin fixture through the real indexer', () => {
  it('parses both source sets without diagnostics', async () => {
    expect((await index(common)).diagnostics).toEqual([]);
    expect((await index(android)).diagnostics).toEqual([]);
  });

  it('indexes the common declarations a KMP module is written in', async () => {
    const names = kindsOf((await index(common)).declarations);
    for (const expected of ['class UploadSink', 'function platformTag', 'class UploadProgress', 'enum UploadState',
      'interface UploadListener', 'class UploadSession', 'method transfer', 'field MAX_CHUNK', 'method describe']) {
      expect(names).toContain(expected);
    }
  });

  it('tells an interface and an enum class from a plain class', async () => {
    const declarations = (await index(common)).declarations;
    const kindOf = (name: string) => declarations.find((declaration) => declaration.name === name)?.kind;
    expect(kindOf('UploadListener')).toBe('interface');
    expect(kindOf('UploadState')).toBe('enum');
    expect(kindOf('UploadProgress')).toBe('class');
    expect(kindOf('UploadSession')).toBe('class');
    // `classKinds` routes class-level evidence by these three kinds.
    expect(kindOf('UploadState')).not.toBe('class');
  });

  it('reports a member function as a method and a top-level function as a function', async () => {
    const declarations = (await index(common)).declarations;
    const sink = declarations.find((declaration) => declaration.name === 'UploadSink')!;
    const write = declarations.find((declaration) => declaration.name === 'write')!;
    expect(write.kind).toBe('method');
    expect(write.qualifiedName).toBe('com.example.upload.UploadSink.write');
    expect(write.containerSymbolKey).toBe(sink.symbolKey);
    // The interface and the class body are the same shape, and `companion object`
    // members are members of the class that owns it.
    expect(kindsOf(declarations)).toEqual(expect.arrayContaining(['method onProgress', 'method onFailure', 'method describe']));
    const tag = declarations.find((declaration) => declaration.name === 'platformTag')!;
    expect(tag.kind).toBe('function');
    expect(tag.qualifiedName).toBe('com.example.upload.platformTag');
    expect(tag.containerSymbolKey).toBeUndefined();
  });

  it('does not index a local inside a lambda body as a field', async () => {
    const declarations = (await index(common)).declarations;
    // `val bytes = source.readBytes()` and `val sent = sink.write(bytes)` sit
    // inside `withContext(Dispatchers.IO) { ... }` in `transfer`.
    for (const local of ['bytes', 'sent']) {
      expect(declarations.some((declaration) => declaration.name === local)).toBe(false);
    }
    // The properties declared in a class body are not locals.
    expect(declarations.filter((declaration) => declaration.kind === 'field').map((declaration) => declaration.name).sort())
      .toEqual(['MAX_CHUNK', 'percent', 'sink', 'state']);
  });

  it('indexes the actual half of the expect/actual pair, so the binding can resolve it', async () => {
    const names = kindsOf((await index(android)).declarations);
    expect(names).toContain('class UploadSink');
    expect(names).toContain('function platformTag');
    expect(names).toContain('method write');
    expect(names).toContain('method close');
    expect(names).toContain('field file');
  });

  it('keeps the package and imports the dependency graph is built on', async () => {
    const result = await index(common);
    expect(result.declarations.some((declaration) => declaration.name === 'com.example.upload')).toBe(true);
    expect(result.imports.map((item) => item.targetReference)).toEqual(
      expect.arrayContaining(['kotlinx.coroutines.Dispatchers', 'kotlinx.coroutines.withContext', 'java.io.File']));
  });
});

