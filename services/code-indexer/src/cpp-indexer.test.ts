import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

/**
 * C/C++ coverage over a real JNI bridge pair, plus the plain-C half of the same
 * bridge.
 *
 * The header is the reason this fixture exists. `.h` used to resolve to the C
 * grammar, and a C++ header parses as garbage under it: seven syntax errors, the
 * `ChunkWriter` class dropped entirely, two bogus function entries left behind —
 * while the matching .cpp indexed cleanly. Because a header is where the interface
 * and the JNI export declarations live, C++ interfaces were reachable only through
 * their definitions.
 *
 * What the declaration walk used to lose, and what these tests now pin:
 *   - a declaration without a body is a `declaration` node, and that node type was
 *     not in the indexer's map, so no prototype reached the index:
 *     `upload_manifest.c` reported 6 declarations and none of its three prototypes,
 *     and the header reported 8 declarations with none of its three `extern "C"`
 *     JNI exports and neither namespace-scope function;
 *   - C++ spells a member function prototype `field_declaration`, so `write`,
 *     `flush` and `written` were reported as `field` — and `field` is not in the
 *     retrieval `functionKinds`, so a declared method was not retrievable as a
 *     function;
 *   - an in-class member initializer whose value is `0` (`std::size_t written_ = 0;`)
 *     is parsed by the C++ grammar as a body-less function definition, so it was
 *     reported as a function although it declares data;
 *   - a function-local `declaration` must not become a field.
 *
 * Measured after the fix: the header reports 15 declarations, `upload_manifest.c`
 * reports 10, and the .cpp reports 13.
 *
 * Because the header now declares the same three JNI exports the .cpp defines,
 * cross-language resolution sees two native symbols per export name. Those two
 * records are one logical symbol: `cross-language-bindings.ts` prefers the record
 * with a body, so a Java `native` method resolves to the .cpp definition instead
 * of the binding being reported `ambiguous`. Both records still reach the index —
 * unifying them is a resolution decision, not an extraction one — and the
 * resolved outcome is pinned against this same fixture pair in
 * cross-language-bindings.test.ts.
 *
 * Remaining gaps, measured here and deliberately not asserted as correct:
 *   - both other files still report three syntax errors each. `JNIEXPORT jint
 *     JNICALL` is a macro pair the grammar cannot read, so an ERROR node sits
 *     between the type and the declarator of every JNI export; the declarations
 *     are extracted anyway because the declarator itself parses;
 *   - a function-pointer member is named `(*on_chunk)` rather than `on_chunk`:
 *     `nameNodeFor` stops at the `parenthesized_declarator` because that node does
 *     not expose its child through a `declarator` field. Pre-existing and
 *     unchanged by this fix, so the C test asserts the kind instead of the name;
 *   - only the first name of a multi-declarator statement (`int a, b;`) is
 *     resolved, because `nameNodeFor` reads one `declarator` field.
 */
const directory = new URL('../../../fixtures/code-corpus/harmony-upload-native/app/src/main/cpp/', import.meta.url);
const header = new URL('upload_bridge.h', directory);
const implementation = new URL('upload_bridge.cpp', directory);
const plainC = new URL('upload_manifest.c', directory);

const index = async (url: URL, expectedLanguage: string) => {
  const content = await readFile(url, 'utf8');
  const language = createDefaultLanguageRegistry().resolvePath(url.pathname);
  expect(language?.languageId).toBe(expectedLanguage);
  return indexTreeSitterFile({ content, language: language!, relativePath: url.pathname });
};

const kindsOf = (declarations: { kind: string; name: string }[]) =>
  declarations.map((declaration) => `${declaration.kind} ${declaration.name}`);

describe('C/C++ fixture through the real indexer', () => {
  it('reads a .h with the C++ grammar, so a C++ class declaration survives', async () => {
    const names = kindsOf((await index(header, 'c')).declarations);
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

  it('extracts a body-less declaration, so a header is more than its class body', async () => {
    const result = await index(header, 'c');
    const names = kindsOf(result.declarations);
    expect(names).toContain('function open_session');
    expect(names).toContain('function close_session');
    for (const exported of ['Java_com_example_upload_NativeUpload_beginUpload', 'Java_com_example_upload_NativeUpload_pumpChunks',
      'Java_com_example_upload_NativeUpload_endUpload']) {
      expect(names).toContain(`function ${exported}`);
    }
    // `JNIEXPORT` is the marker cross-language-bindings.ts resolves a Java
    // `native` method against, so the declaration's signature has to keep it.
    const declaration = result.declarations.find((entry) => entry.name === 'Java_com_example_upload_NativeUpload_beginUpload')!;
    expect(declaration.signature).toMatch(/^JNIEXPORT\b/);
    expect(declaration.declarationNodeType).toBe('declaration');
    expect(declaration.qualifiedName).toBe('Java_com_example_upload_NativeUpload_beginUpload');
  });

  it('distinguishes a member of a class body from a namespace-scope function', async () => {
    const result = await index(header, 'c');
    const class_ = result.declarations.find((entry) => entry.name === 'ChunkWriter')!;
    const names = kindsOf(result.declarations);
    for (const method of ['write', 'flush', 'written']) {
      expect(names).toContain(`method ${method}`);
      expect(names).not.toContain(`field ${method}`);
    }
    expect(names).toContain('method ChunkWriter');
    expect(names).toContain('method ~ChunkWriter');
    // Class-body membership is what makes them methods; the same function
    // names one level up in the namespace are plain functions.
    const write = result.declarations.find((entry) => entry.name === 'write')!;
    expect(write.qualifiedName).toBe('upload.ChunkWriter.write');
    expect(write.containerSymbolKey).toBe(class_.symbolKey);
    // A function at namespace scope is contained by the namespace, not a type.
    const openSession = result.declarations.find((entry) => entry.name === 'open_session')!;
    expect(openSession.kind).toBe('function');
    expect(openSession.qualifiedName).toBe('upload.open_session');
    expect(openSession.containerSymbolKey)
      .toBe(result.declarations.find((entry) => entry.name === 'upload' && entry.kind === 'namespace')!.symbolKey);
  });

  it('keeps the data members of the class body fields', async () => {
    const result = await index(header, 'c');
    const names = kindsOf(result.declarations);
    expect(names).toContain('field path_');
    expect(names).toContain('field handle_');
    // `std::size_t written_ = 0;` parses as a body-less function definition
    // under a `pure_virtual_clause`; it declares data.
    expect(names).toContain('field written_');
    expect(names).not.toContain('function written_');
    expect(result.declarations.filter((entry) => entry.kind === 'field').map((entry) => entry.name).sort())
      .toEqual(['handle_', 'path_', 'written_']);
  });

  it('extracts a prototype from a .c file without disturbing its C-grammar members', async () => {
    const result = await index(plainC, 'c');
    expect(result.diagnostics).toEqual([]);
    const names = kindsOf(result.declarations);
    for (const prototype of ['upload_manifest_open', 'upload_manifest_close', 'upload_manifest_written']) {
      expect(names).toContain(`function ${prototype}`);
    }
    // Declared once, by its definition: an elaborated `struct X` inside a
    // signature is only a type reference, which this fixture avoids by naming the
    // type through a `typedef`.
    expect(result.declarations.filter((entry) => entry.name === 'upload_manifest')).toHaveLength(1);
    // A declaration that contains a function declarator without declaring a
    // function stays a field.
    const pointer = result.declarations.find((entry) => entry.declarationNodeType === 'field_declaration'
      && entry.signature.includes('(*on_chunk)'))!;
    expect(pointer.kind).toBe('field');
    // The local `header_bytes` is a `declaration` too, and is not this file's interface.
    expect(result.declarations.some((entry) => entry.name === 'header_bytes')).toBe(false);
    expect(names).toContain('field g_manifests_open');
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

  it('keeps file-scope bindings and drops the function-local ones the same node type declares', async () => {
    const result = await index(implementation, 'cpp');
    // Every local in this file is a `declaration` as well: `const int32_t handle`,
    // `const std::size_t written`, `const auto found`, `const char* utf8`.
    expect(result.declarations.filter((entry) => entry.kind === 'field').map((entry) => entry.name).sort())
      .toEqual(['g_next', 'g_sessions']);
    expect(result.declarations.some((entry) => entry.name === 'utf8')).toBe(false);
  });

  it('keeps the include graph the dependency resolver consumes, system headers included', async () => {
    const result = await index(implementation, 'cpp');
    // System includes keep their angle brackets, which is what keeps them
    // distinguishable from a local include of the same name.
    expect(result.imports.map((item) => item.targetReference))
      .toEqual(expect.arrayContaining(['upload_bridge.h', '<fstream>', '<unordered_map>', '<vector>']));
  });
});

