import { describe, expect, it } from 'vitest';
import { syntacticDependencyResolverInternals } from './syntactic-dependency-resolver.js';

const { resolvedTarget } = syntacticDependencyResolverInternals;

describe('syntactic dependency target summaries', () => {
  it('preserves unique targets and reports ambiguous paths or symbols', () => {
    const fixtures = [
      [],
      [{ relativePath: 'a.java' }],
      [{ relativePath: 'a.java', symbolKey: 'one' }, { relativePath: 'a.java', symbolKey: 'one' }],
      [{ relativePath: 'a.java', symbolKey: 'two' }, { relativePath: 'a.java', symbolKey: 'one' }],
      [{ relativePath: 'b.java', symbolKey: 'same' }, { relativePath: 'a.java', symbolKey: 'same' }],
      [{ relativePath: 'b.java', symbolKey: 'two' }, { relativePath: 'a.java', symbolKey: 'one' }],
      [{ relativePath: 'a.java', symbolKey: '' }, { relativePath: 'a.java', symbolKey: 'one' }],
    ];
    const expected = [
      { resolution: 'unresolved' },
      { resolution: 'resolved', targetRelativePath: 'a.java' },
      { resolution: 'resolved', targetRelativePath: 'a.java', targetSymbolKey: 'one' },
      { resolution: 'resolved', targetRelativePath: 'a.java' },
      { resolution: 'ambiguous', targetSymbolKey: 'same' },
      { resolution: 'ambiguous' },
      { resolution: 'resolved', targetRelativePath: 'a.java', targetSymbolKey: 'one' },
    ];
    for (const [index, candidates] of fixtures.entries()) {
      for (const internal of [false, true]) {
        expect(resolvedTarget(candidates, internal)).toEqual({
          ...expected[index], internal: internal || expected[index]!.resolution === 'ambiguous',
        });
      }
    }
  });

});
