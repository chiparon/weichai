import type {
  ClassSnapshot,
  DiagnosticDelta,
  DiagnosticRequest,
  EditorTarget,
  SourceLocation,
  SymbolRequest,
} from '@forexplore/contracts';

/** Business-facing language intelligence. Implementations must use a real language provider. */
export interface LanguageIntelligencePort {
  resolveContainingClass(target: EditorTarget, signal?: AbortSignal): Promise<ClassSnapshot>;
  definitions(request: SymbolRequest, signal?: AbortSignal): Promise<SourceLocation[]>;
  references(request: SymbolRequest, signal?: AbortSignal): Promise<SourceLocation[]>;
  diagnose(request: DiagnosticRequest, signal?: AbortSignal): Promise<DiagnosticDelta>;
}

export type LanguageIntelligenceFailureKind =
  | 'lsp_unavailable'
  | 'timed_out'
  | 'cancelled'
  | 'document_changed';

export class LanguageIntelligenceError extends Error {
  constructor(
    readonly kind: LanguageIntelligenceFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LanguageIntelligenceError';
  }
}
