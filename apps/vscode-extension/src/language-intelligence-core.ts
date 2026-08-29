import type {
  NormalizedDiagnostic,
  SourcePosition,
  SourceRange,
} from '@forexplore/contracts';

export function containsPosition(range: SourceRange, position: SourcePosition): boolean {
  return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

export function intersectsRange(left: SourceRange, right: SourceRange): boolean {
  return comparePosition(left.end, right.start) >= 0 && comparePosition(right.end, left.start) >= 0;
}

export function classIntroducedDiagnostics(
  baseline: readonly NormalizedDiagnostic[],
  current: readonly NormalizedDiagnostic[],
  classRange: SourceRange,
): {
  introduced: NormalizedDiagnostic[];
  changed: NormalizedDiagnostic[];
  ignored: NormalizedDiagnostic[];
} {
  const baselineInClass = baseline.filter((item) => intersectsRange(item.range, classRange));
  const exactBaseline = new Set(baselineInClass.map(diagnosticFingerprint));
  const baselineByLocus = new Map(
    baselineInClass.map((item) => [diagnosticLocus(item), item] as const),
  );
  const introduced: NormalizedDiagnostic[] = [];
  const changed: NormalizedDiagnostic[] = [];
  const ignored: NormalizedDiagnostic[] = [];

  for (const diagnostic of current) {
    if (!intersectsRange(diagnostic.range, classRange) || diagnostic.severity !== 'error') {
      ignored.push(diagnostic);
      continue;
    }
    if (exactBaseline.has(diagnosticFingerprint(diagnostic))) {
      ignored.push(diagnostic);
      continue;
    }
    if (baselineByLocus.has(diagnosticLocus(diagnostic))) {
      changed.push(diagnostic);
    } else {
      introduced.push(diagnostic);
    }
  }

  return { introduced, changed, ignored };
}

export function diagnosticFingerprint(diagnostic: NormalizedDiagnostic): string {
  return [diagnosticLocus(diagnostic), diagnostic.severity, diagnostic.message].join('|');
}

function diagnosticLocus(diagnostic: NormalizedDiagnostic): string {
  const code = diagnostic.code ?? '';
  const source = diagnostic.source ?? '';
  const { start, end } = diagnostic.range;
  return [
    source,
    code,
    start.line,
    start.character,
    end.line,
    end.character,
  ].join(':');
}

function comparePosition(left: SourcePosition, right: SourcePosition): number {
  return left.line === right.line
    ? left.character - right.character
    : left.line - right.line;
}
