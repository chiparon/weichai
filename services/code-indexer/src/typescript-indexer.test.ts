import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

/**
 * TypeScript coverage over a real corpus file rather than an inline snippet,
 * because the two declarations this file has to hold apart are the two the walk
 * got wrong for opposite reasons.
 *
 * `lexical_declaration` was mapped to `field` for the exported constants and
 * function-valued variables at file scope, so `const parsed = new Map(...)` inside
 * `ParameterParser.parse` became a field; a later fix made the walk drop any
 * `field`-kinded binding below a callable. `public_field_definition` was then
 * simply not mapped at all, so `private lowerCaseNames = false` — the state
 * `setLowerCaseNames` mutates — was invisible while the method beside it indexed.
 * The class-body half of the distinction was missing rather than wrong, and the
 * same mistake hid every ArkTS page component's `@State` (arkts-indexer.test.ts).
 *
 * Measured on fixtures/code-corpus/commons-fileupload-ts/src/file-upload.ts: 117
 * declarations before, 143 after; the 26 new ones are all `field`s of this shape,
 * and every function-local binding in the file is still absent.
 *
 * Left alone deliberately, each measured:
 *   - an interface property is a `property_signature`, a different node type, and
 *     stays unmapped: it declares a contract member rather than state, and the
 *     same node type also spells the members of a `type X = { ... }` literal, so
 *     mapping it would not be a statement about interfaces at all. `MultipartPart`
 *     reports neither `rawHeaders` nor `body`; corpus-wide the node type covers
 *     766 interface members and 324 type-literal members.
 *   - an index signature (`[key: string]: unknown`) declares no name to key on and
 *     is skipped for the same reason: its node type is unmapped.
 *   - `FileUploadBase`'s ten members extract, because they are properties of a
 *     `class_body` like any other, but without their class: TypeScript spells an
 *     abstract class `abstract_class_declaration`, which the walk does not map, so
 *     the class is not a declaration and cannot be a container. The seven methods
 *     of that class already carried the same bare qualified names. Unifying it
 *     means mapping one more node type, and the resulting `class` symbol would not
 *     be a property, so it is a separate change rather than part of this one.
 */
const fixture = new URL('../../../fixtures/code-corpus/commons-fileupload-ts/src/file-upload.ts', import.meta.url);

const index = async () => {
  const content = await readFile(fixture, 'utf8');
  const language = createDefaultLanguageRegistry().resolvePath('file-upload.ts');
  expect(language?.languageId).toBe('typescript');
  return indexTreeSitterFile({ content, language: language!, relativePath: 'file-upload.ts' });
};

describe('TypeScript fixture through the real indexer', () => {
  it('extracts a class property, with the class it belongs to', async () => {
    const result = await index();
    expect(result.diagnostics).toEqual([]);
    const property = result.declarations.find((declaration) => declaration.name === 'lowerCaseNames')!;
    expect(property.kind).toBe('field');
    expect(property.declarationNodeType).toBe('public_field_definition');
    expect(property.qualifiedName).toBe('ParameterParser.lowerCaseNames');
    expect(property.signature).toBe('private lowerCaseNames = false');
    expect(property.sourceRange.startLine).toBe(106);
    const parser = result.declarations.find((declaration) => declaration.name === 'ParameterParser')!;
    expect(property.containerSymbolKey).toBe(parser.symbolKey);
    // The method that mutates that state is untouched by the fix.
    const mutator = result.declarations.find((declaration) => declaration.name === 'setLowerCaseNames')!;
    expect(mutator.kind).toBe('method');
    expect(mutator.qualifiedName).toBe('ParameterParser.setLowerCaseNames');
  });

  it('keeps every class property in the file a field and nothing else', async () => {
    const result = await index();
    const content = await readFile(fixture, 'utf8');
    const fields = result.declarations.filter((declaration) => declaration.kind === 'field');
    // The file is a port of a Java library, so almost all of its state is
    // `private readonly` fields the methods below them close over.
    expect(fields.length).toBe(26);
    for (const field of fields) {
      expect(field.declarationNodeType).toBe('public_field_definition');
      // Position-exactly: the reported range selects the declaration's own text
      // out of the original file, so a field cannot be reported for a locator
      // that points somewhere else.
      const line = content.split('\n')[field.sourceRange.startLine - 1]!;
      expect(line.slice(field.sourceRange.startColumn - 1, field.sourceRange.endColumn - 1))
        .toBe(field.signature);
    }
    expect(fields.map((field) => field.qualifiedName)).toContain('MultipartStream.boundary');
    expect(fields.map((field) => field.qualifiedName)).toContain('FileItemHeaders.values');
  });

  it('does not extract a binding local to a callable body', async () => {
    const result = await index();
    const names = result.declarations.map((declaration) => declaration.name);
    // All of these are `lexical_declaration`s inside `ParameterParser.parse` or
    // `ParameterParser.split`, the same node type the walk maps to `field`.
    for (const local of ['parsed', 'separators', 'selected', 'equals', 'rawName', 'name', 'rawValue',
      'current', 'quoted', 'escaped', 'found', 'earliestFound']) {
      expect(names).not.toContain(local);
    }
    // `value` and `separator` are parameters, which were never declarations here.
    expect(names).not.toContain('separator');
    // The same identifier is a field where the scope says so: `parts` is a local
    // in `split` and a `private parts: MultipartPart[] | undefined` property of
    // `MultipartStream`, and only the property may be indexed.
    const parts = result.declarations.filter((declaration) => declaration.name === 'parts');
    expect(parts.map((declaration) => `${declaration.kind} ${declaration.qualifiedName}`))
      .toEqual(['field MultipartStream.parts']);
    // File-scope bindings of the same node type are still indexed, which is what
    // the scope rule has to keep working.
    const decode = result.declarations.find((declaration) => declaration.name === 'decodeMimeHeader')!;
    expect(decode.kind).toBe('function');
  });

  it('leaves interface members and index signatures out of the field set', async () => {
    const result = await index();
    const names = result.declarations.map((declaration) => declaration.name);
    // `MultipartPart` is an interface whose entire body is `{ rawHeaders: string;
    // body: Buffer; }`: a `property_signature` mapping would report two fields
    // here, and neither is storage this file allocates.
    expect(result.declarations.find((declaration) => declaration.name === 'MultipartPart')?.kind)
      .toBe('interface');
    expect(names).not.toContain('rawHeaders');
    expect(names).not.toContain('body');
    // Interface methods keep indexing as methods, as they did before: the
    // conservative choice is about `field`s, not about interfaces in general.
    expect(result.declarations.find((declaration) => declaration.qualifiedName === 'RequestContext.getInputStream')?.kind)
      .toBe('method');
    // Every field in the file comes from the one property node type, so no other
    // node type leaked into the `field` kind while the map was open.
    expect(result.declarations.filter((declaration) => declaration.kind === 'field'
      && declaration.declarationNodeType !== 'public_field_definition')).toEqual([]);
  });
});
