import type { NormalizedDiagnostic, SourceRange } from '@forexplore/contracts';
import { describe, expect, it } from 'vitest';
import { classIntroducedDiagnostics, containsPosition } from './language-intelligence-core';

const classRange: SourceRange = {
  start: { line: 4, character: 0 },
  end: { line: 20, character: 1 },
};

function diagnostic(
  line: number,
  message: string,
  severity: NormalizedDiagnostic['severity'] = 'error',
): NormalizedDiagnostic {
  return {
    uri: 'file:///workspace/Service.cs',
    range: {
      start: { line, character: 4 },
      end: { line, character: 10 },
    },
    severity,
    source: 'csharp',
    code: 'CS1001',
    message,
  };
}

describe('language intelligence diagnostic delta', () => {
  it('gates only new or changed class errors', () => {
    const existing = diagnostic(7, 'existing error');
    const changed = diagnostic(9, 'old message');
    const warning = diagnostic(11, 'style warning', 'warning');
    const outside = diagnostic(30, 'other file region');

    const result = classIntroducedDiagnostics(
      [existing, changed],
      [existing, diagnostic(9, 'new message'), diagnostic(10, 'new error'), warning, outside],
      classRange,
    );

    expect(result.introduced).toEqual([diagnostic(10, 'new error')]);
    expect(result.changed).toEqual([diagnostic(9, 'new message')]);
    expect(result.ignored).toEqual([existing, warning, outside]);
  });

  it('treats both class boundaries as contained positions', () => {
    expect(containsPosition(classRange, classRange.start)).toBe(true);
    expect(containsPosition(classRange, classRange.end)).toBe(true);
    expect(containsPosition(classRange, { line: 21, character: 0 })).toBe(false);
  });
});
