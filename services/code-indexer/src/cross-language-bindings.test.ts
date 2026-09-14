import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildStructuralIndex, type StructuralSourceFile } from './structural-index.js';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

const native = `napi_value Sum(napi_env env, napi_callback_info info) { return nullptr; }
napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {{ "sum", nullptr, Sum, nullptr, nullptr, nullptr, napi_default, nullptr }};
  napi_define_properties(env, exports, 1, desc);
  return exports;
}
static napi_module entryModule = { .nm_version = 1, .nm_register_func = Init, .nm_modname = "entry" };
void Register() { napi_module_register(&entryModule); }
`;
const files: StructuralSourceFile[] = [
  { relativePath: 'entry/native.cpp', content: native },
  { relativePath: 'entry/Index.ets', content: 'import native from "libentry.so"; export function calculate() { return native.sum(1, 2); }' },
  { relativePath: 'demo/Foo.java', content: 'package demo; public class Foo { public native int sum(int value); }' },
  { relativePath: 'native/foo.cpp', content: 'JNIEXPORT jint JNICALL Java_demo_Foo_sum(JNIEnv *env, jobject obj, jint value) { return value; }' },
  { relativePath: 'shared/src/commonMain/kotlin/Counter.kt', content: 'package demo\nexpect fun sum(value: Int): Int\n' },
  { relativePath: 'shared/src/nativeMain/kotlin/Counter.kt', content: 'package demo\nactual fun sum(value: Int): Int { return value + 1 }\n' },
];
const build = (sources = files, previousIndex?: ReturnType<typeof buildStructuralIndex>['index']) =>
  buildStructuralIndex({ repositoryId: 'repo', analysisRevision: 'r1', files: sources, previousIndex }).index;

describe('Huawei language frontends and bindings', () => {
  it('resolves JNI long names using primitive and array parameter descriptors', () => {
    const index = build([
      { relativePath: 'demo/Foo.java', content: 'package demo; public class Foo { public native int sum(int value); public native int sum(long value); public native int read(String[] values); }' },
      { relativePath: 'native/foo.cpp', content: 'JNIEXPORT jint JNICALL Java_demo_Foo_sum__I(JNIEnv *e, jobject o, jint n) { return n; }\nJNIEXPORT jint JNICALL Java_demo_Foo_sum__J(JNIEnv *e, jobject o, jlong n) { return n; }\nJNIEXPORT jint JNICALL Java_demo_Foo_read___3Ljava_lang_String_2(JNIEnv *e, jobject o, jobjectArray n) { return 1; }' },
    ]);
    const edges = index.dependencyEdges.filter(edge => edge.kind === 'jni-binding');
    expect(edges).toHaveLength(3);
    expect(edges.every(edge => edge.resolution === 'resolved')).toBe(true);
    expect(new Set(edges.map(edge => edge.targetSymbolKey)).size).toBe(3);
  });

  it('does not infer JNI object descriptors from simple imported type names', () => {
    const index = build([
      { relativePath: 'demo/Foo.java', content: 'package demo; import other.Value; public class Foo { public native int sum(Value value); }' },
      { relativePath: 'native/foo.cpp', content: 'JNIEXPORT jint JNICALL Java_demo_Foo_sum__Lother_Value_2(JNIEnv *e, jobject o, jobject n) { return 1; }' },
    ]);
    expect(index.dependencyEdges.find(edge => edge.kind === 'jni-binding')?.resolution).toBe('unresolved');
  });
  it.each([
    ['native/test.c', '#include "local.h"\nint *lookup(int value) { return 0; }', 'lookup', 'local.h'],
    ['native/test.cpp', '#include "local.hpp"\nnamespace demo { class Counter { int sum(int x) { return x; } }; }', 'Counter', 'local.hpp'],
    ['shared/Counter.kt', 'package demo\nimport demo.Contract\nclass Counter {\n fun sum(x: Int): Int { return x + 1 }\n}\n', 'Counter', 'demo.Contract'],
    ['entry/Index.ets', 'import native from "libentry.so"; export function calculate() { return native.sum(); }', 'calculate', 'libentry.so'],
  ])('indexes declarations and imports from %s', (relativePath, content, name, imported) => {
    const result = indexTreeSitterFile({ relativePath, content, language: createDefaultLanguageRegistry().resolvePath(relativePath)! });
    expect(result.declarations.some(value => value.name === name)).toBe(true);
    expect(result.imports.some(value => value.targetReference === imported)).toBe(true);
  });

  it('follows registration and qualified identities to real native/platform endpoints', () => {
    const index = build();
    for (const kind of ['jni-binding', 'napi-binding', 'kmp-binding']) {
      const edge = index.dependencyEdges.find(value => value.kind === kind);
      expect(edge, JSON.stringify(index.symbols.map(value => [value.name, value.signature]))).toMatchObject({ resolution: 'resolved', evidenceLevel: 'syntactic' });
      expect(index.symbols.some(value => value.symbolKey === edge?.sourceSymbolKey)).toBe(true);
      expect(index.symbols.some(value => value.symbolKey === edge?.targetSymbolKey)).toBe(true);
    }
  });

  it('does not bind unregistered descriptors, wrong module names, or overloaded short JNI exports', () => {
    const index = build(files.map(file => ({ ...file, content: file.content
      .replace('napi_module_register(&entryModule);', '')
      .replace('public native int sum(int value);', 'public native int sum(int value); public native int sum(long value);') })));
    expect(index.dependencyEdges.filter(value => ['jni-binding', 'napi-binding'].includes(value.kind)).every(value => value.resolution === 'unresolved')).toBe(true);
    const wrongModule = build(files.map(file => file.relativePath.endsWith('.ets') ? { ...file, content: file.content.replace('libentry.so', 'libother.so') } : file));
    expect(wrongModule.dependencyEdges.find(value => value.kind === 'napi-binding')?.resolution).toBe('unresolved');
  });

  it('preserves platform ambiguity and excludes expect/actual matches from unrelated modules', () => {
    const common = files.filter(file => file.relativePath.includes('commonMain'));
    const actual = files.find(file => file.relativePath.includes('nativeMain'))!;
    const unrelated = build([...common, { ...actual, relativePath: actual.relativePath.replace('shared/', 'other/') }]);
    expect(unrelated.dependencyEdges.find(value => value.kind === 'kmp-binding')?.resolution).toBe('unresolved');
    const ambiguous = build([...common, actual, { ...actual, relativePath: actual.relativePath.replace('nativeMain', 'jvmMain') }]);
    expect(ambiguous.dependencyEdges.find(value => value.kind === 'kmp-binding')).toMatchObject({ resolution: 'ambiguous' });
  });

  /**
   * The header and the .cpp of the real JNI fixture pair both report each of the
   * three `extern "C"` exports. `7601e64` made the indexer extract body-less
   * declarations, which is right — a header is where a C/C++ interface lives —
   * but it left `resolveCrossLanguageBindings` with two native symbols per export
   * name, so every binding was reported `ambiguous` where it used to resolve to
   * the .cpp definition. A declaration and its definition are one logical symbol,
   * and the definition is the one a binding points at.
   */
  it('resolves a JNI export declared in a header and defined in a .cpp to the definition', async () => {
    const cppFixture = new URL('../../../fixtures/code-corpus/harmony-upload-native/app/src/main/cpp/', import.meta.url);
    const read = (name: string) => readFile(new URL(name, cppFixture), 'utf8');
    const index = build([
      { relativePath: 'app/src/main/cpp/upload_bridge.h', content: await read('upload_bridge.h') },
      { relativePath: 'app/src/main/cpp/upload_bridge.cpp', content: await read('upload_bridge.cpp') },
      // The Java half of the pair is declared inline: the fixture corpus carries
      // only the native side.
      { relativePath: 'app/src/main/java/com/example/upload/NativeUpload.java',
        content: 'package com.example.upload;\npublic class NativeUpload {\n  public native int beginUpload(String fileName);\n  public native int pumpChunks(int handle);\n  public native void endUpload(int handle);\n}\n' },
    ]);
    // Unifying the two sites is a resolution decision, not an extraction one: the
    // header really does declare these names and keeps its own records.
    const declared = index.symbols.filter(symbol => symbol.relativePath === 'app/src/main/cpp/upload_bridge.h' &&
      symbol.name.startsWith('Java_com_example_upload_'));
    expect(declared.map(symbol => symbol.signature)).toHaveLength(3);
    // A body-less declaration's signature still ends in the declarator's `;`.
    expect(declared.every(symbol => symbol.signature?.endsWith(';'))).toBe(true);

    const edges = index.dependencyEdges.filter(edge => edge.kind === 'jni-binding');
    expect(edges.map(edge => edge.targetReference).sort()).toEqual([
      'Java_com_example_upload_NativeUpload_beginUpload',
      'Java_com_example_upload_NativeUpload_endUpload',
      'Java_com_example_upload_NativeUpload_pumpChunks',
    ]);
    for (const edge of edges) {
      expect(edge).toMatchObject({ confidence: 0.85, evidenceLevel: 'syntactic', resolution: 'resolved',
        targetRelativePath: 'app/src/main/cpp/upload_bridge.cpp' });
      const target = index.symbols.find(symbol => symbol.symbolKey === edge.targetSymbolKey)!;
      expect(target.name).toBe(edge.targetReference);
      // The definition, never the prototype.
      expect(target.signature?.endsWith(';')).toBe(false);
    }
  });

  it('keeps two definitions of one JNI export name ambiguous', () => {
    const definition = 'JNIEXPORT jint JNICALL Java_demo_Foo_sum(JNIEnv *env, jobject obj, jint value) { return value; }';
    const index = build([
      { relativePath: 'demo/Foo.java', content: 'package demo; public class Foo { public native int sum(int value); }' },
      { relativePath: 'native/a.cpp', content: definition },
      { relativePath: 'native/b.cpp', content: definition.replace('return value;', 'return value + 1;') },
    ]);
    // Collapsing the declaration site of one symbol must not collapse two
    // implementations of it: that ambiguity is real and stays reported.
    expect(index.dependencyEdges.find(edge => edge.kind === 'jni-binding')).toMatchObject({ resolution: 'ambiguous' });
  });

  it('resolves a registered N-API callback declared ahead of its definition to the definition', () => {
    const index = build([
      { relativePath: 'entry/native.cpp', content: `static napi_value Sum(napi_env env, napi_callback_info info);
napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {{ "sum", nullptr, Sum, nullptr, nullptr, nullptr, napi_default, nullptr }};
  napi_define_properties(env, exports, 1, desc);
  return exports;
}
static napi_value Sum(napi_env env, napi_callback_info info) { return nullptr; }
static napi_module entryModule = { .nm_version = 1, .nm_register_func = Init, .nm_modname = "entry" };
void Register() { napi_module_register(&entryModule); }
` },
      { relativePath: 'entry/Index.ets', content: 'import native from "libentry.so"; export function calculate() { return native.sum(1, 2); }' },
    ]);
    // The registration scan reads one file, so this is a forward declaration and
    // its definition in one translation unit — the same two records for one
    // symbol, and previously a registration that reported `ambiguous`.
    const edge = index.dependencyEdges.find(value => value.kind === 'napi-binding');
    expect(edge).toMatchObject({ resolution: 'resolved', targetRelativePath: 'entry/native.cpp' });
    const target = index.symbols.find(value => value.symbolKey === edge?.targetSymbolKey)!;
    expect(target.signature).toMatch(/^static napi_value Sum\(/);
    expect(target.signature?.endsWith(';')).toBe(false);
  });

  it('rebinds unchanged callers after registration edits and matches a full build', () => {
    const before = build();
    const changed = files.map(file => file.relativePath === 'entry/native.cpp' ? { ...file, content: file.content.replace('"sum"', '"add"') } : file);
    const incremental = build(changed, before), full = build(changed);
    expect(incremental.dependencyEdges).toEqual(full.dependencyEdges);
    expect(incremental.analysisHash).toBe(full.analysisHash);
    expect(incremental.dependencyEdges.find(value => value.kind === 'napi-binding')?.resolution).toBe('unresolved');
  });

  it('revisits a Java import when a previously missing Kotlin declaration is added', () => {
    const caller = { relativePath: 'Caller.java', content: 'import demo.Contract; public class Caller {}' };
    const before = build([caller]);
    const added = [caller, { relativePath: 'Contract.kt', content: 'package demo\nclass Contract\n' }];
    const incremental = build(added, before), full = build(added);
    expect(incremental.dependencyEdges).toEqual(full.dependencyEdges);
    expect(incremental.dependencyEdges.find(value => value.kind === 'import')).toMatchObject({ resolution: 'resolved', targetRelativePath: 'Contract.kt' });
  });
});
