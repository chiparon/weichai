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
 * The third gap was the container rather than the member, and it is closed in the
 * same file: `FileUploadBase` is spelled `abstract_class_declaration`, so it was
 * no declaration and could not be a container, and the 17 members the walk did
 * find carried bare names (`sizeMax`, `parseRequest`) with no
 * `containerSymbolKey` for retrieval to promote them by. The class and its
 * members are pinned in the tests below; corpus-wide the same mapping adds
 * nothing else (measured over the scanner's own file set: 391 files, 7911
 * declarations before, 7914 after — one abstract class and the two
 * `abstract_method_signature` members that were the fourth, smaller gap, with
 * 17 members re-keyed onto the class name and no other declaration touched).
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

  it('extracts an abstract class as a class, with its members qualified by it', async () => {
    const result = await index();
    const base = result.declarations.find((declaration) => declaration.name === 'FileUploadBase')!;
    expect(base.kind).toBe('class');
    expect(base.declarationNodeType).toBe('abstract_class_declaration');
    expect(base.signature).toBe('abstract class FileUploadBase');
    expect(base.qualifiedName).toBe('FileUploadBase');
    expect(base.isExported).toBe(true);
    expect(base.sourceRange.startLine).toBe(378);
    // The class hangs off the file, so nothing may claim it as a member.
    expect(base.containerSymbolKey).toBeUndefined();

    // The field the size check in `parseRequest` reads, under the class that
    // declares it: retrieval promotes a recalled member by this container.
    const sizeMax = result.declarations.find((declaration) => declaration.qualifiedName === 'FileUploadBase.sizeMax')!;
    expect(sizeMax.kind).toBe('field');
    expect(sizeMax.containerSymbolKey).toBe(base.symbolKey);

    // An abstract member is `abstract_method_signature`, a different node type
    // from the methods beside it, and it is the contract a subclass must meet.
    const factory = result.declarations.find((declaration) => declaration.qualifiedName === 'FileUploadBase.getFileItemFactory')!;
    expect(factory.kind).toBe('method');
    expect(factory.declarationNodeType).toBe('abstract_method_signature');
    expect(factory.signature).toBe('abstract getFileItemFactory(): FileItemFactory | undefined');
    expect(factory.containerSymbolKey).toBe(base.symbolKey);
    // A concrete class declaring the same member name is a separate symbol.
    expect(result.declarations.find((declaration) => declaration.qualifiedName === 'FileUpload.getFileItemFactory')?.symbolKey)
      .not.toBe(factory.symbolKey);
  });

  it('gives every member of the abstract class that container and no other owner', async () => {
    const result = await index();
    const content = await readFile(fixture, 'utf8');
    const base = result.declarations.find((declaration) => declaration.name === 'FileUploadBase')!;
    const members = result.declarations.filter((declaration) =>
      declaration.sourceRange.startLine >= base.sourceRange.startLine
      && declaration.sourceRange.endLine <= base.sourceRange.endLine
      && declaration.symbolKey !== base.symbolKey);
    // Ten fields, seven methods and the two abstract signatures between them.
    expect(members.map((member) => `${member.kind} ${member.qualifiedName}`)).toEqual([
      'field FileUploadBase.MULTIPART',
      'field FileUploadBase.MULTIPART_FORM_DATA',
      'field FileUploadBase.MULTIPART_MIXED',
      'field FileUploadBase.CONTENT_TYPE',
      'field FileUploadBase.CONTENT_DISPOSITION',
      'field FileUploadBase.sizeMax',
      'field FileUploadBase.fileSizeMax',
      'field FileUploadBase.fileCountMax',
      'field FileUploadBase.headerEncoding',
      'field FileUploadBase.progressListener',
      'method FileUploadBase.isMultipartContent',
      'method FileUploadBase.getFileItemFactory',
      'method FileUploadBase.setFileItemFactory',
      'method FileUploadBase.parseRequest',
      'method FileUploadBase.parseParameterMap',
      'method FileUploadBase.getItemIterator',
      'method FileUploadBase.getBoundary',
      'method FileUploadBase.getParsedHeaders',
      'method FileUploadBase.parseDisposition',
    ]);
    for (const member of members) {
      expect(member.containerSymbolKey).toBe(base.symbolKey);
      // Position-exactly: the range the member reports starts on the member's own
      // declaration text in the original file, so a container can only be claimed
      // for a real declaration and never for an expression the walk passed
      // through. A method's signature stops at its body, which the whole-range
      // equality in the field test above pins for the fields.
      const lineStarts = [0];
      for (let index = 0; index < content.length; index += 1) {
        if (content[index] === '\n') lineStarts.push(index + 1);
      }
      const start = lineStarts[member.sourceRange.startLine - 1]! + member.sourceRange.startColumn - 1;
      expect(content.slice(start, start + member.signature.length)).toBe(member.signature);
    }
  });
});
