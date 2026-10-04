import { describe, expect, it } from 'vitest';
import { applyWorkspaceEdits, maxWorkspaceEdits, parseWorkspaceEdits } from './workspace-translation-edits.js';

const parse = (edits: unknown) => parseWorkspaceEdits(edits);

describe('anchored workspace edits', () => {
  it('replaces the named text and leaves everything else byte-identical', () => {
    const content = 'export function keep() { return 1; }\nexport function limit(value) { throw new Error("todo"); }\n';
    const edits = parse([{ oldText: 'throw new Error("todo");', newText: 'return value + 1;' }]);
    expect(applyWorkspaceEdits(content, edits))
      .toBe('export function keep() { return 1; }\nexport function limit(value) { return value + 1; }\n');
  });

  it('applies several edits in order, including text an earlier edit introduced', () => {
    const edits = parse([
      { oldText: 'const a = 1;', newText: 'const a = 2;\nconst b = 3;' },
      { oldText: 'const b = 3;', newText: 'const b = 4;' },
    ]);
    expect(applyWorkspaceEdits('const a = 1;\n', edits)).toBe('const a = 2;\nconst b = 4;\n');
  });

  it('refuses a missing anchor instead of writing anything', () => {
    const edits = parse([{ oldText: 'not in the file', newText: 'x' }]);
    expect(() => applyWorkspaceEdits('// only this\n', edits)).toThrow(/anchor was not found/);
  });

  it('refuses an ambiguous anchor unless replaceAll is explicit', () => {
    const content = 'call();\ncall();\n';
    const ambiguous = parse([{ oldText: 'call();', newText: 'run();' }]);
    expect(() => applyWorkspaceEdits(content, ambiguous)).toThrow(/matches 2 times/);
    const explicit = parse([{ oldText: 'call();', newText: 'run();', replaceAll: true }]);
    expect(applyWorkspaceEdits(content, explicit)).toBe('run();\nrun();\n');
  });

  it('rejects malformed, empty, oversized and no-op edit lists', () => {
    expect(() => parse([])).toThrow(/nonempty edits array/);
    expect(() => parse(undefined)).toThrow(/nonempty edits array/);
    expect(() => parse(Array.from({ length: maxWorkspaceEdits + 1 }, () => ({ oldText: 'a', newText: 'b' }))))
      .toThrow(/at most 20 edits/);
    expect(() => parse(['text'])).toThrow(/must be an object/);
    expect(() => parse([{ oldText: '', newText: 'x' }])).toThrow(/exact existing text/);
    expect(() => parse([{ oldText: 'a' }])).toThrow(/requires string oldText and newText/);
    expect(() => parse([{ oldText: 'a', newText: 'b', replaceAll: 'yes' }])).toThrow(/replaceAll must be a boolean/);
    expect(() => parse([{ oldText: 'a', newText: 'b', extra: 1 }])).toThrow(/unsupported field/);
    expect(() => parse([{ oldText: 'a', newText: 'a' }])).toThrow(/does not change the file/);
    expect(() => parse([{ oldText: 'x'.repeat(32_001), newText: 'y' }])).toThrow(/per-edit text limit/);
  });
});
