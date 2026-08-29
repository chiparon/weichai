import type { Language, ModuleTarget } from './module';
import type { SearchCandidate } from './retrieval';
import type { FilePatch } from './backfill';
import type { AnalysisReport, InterfaceMapping } from './adaptation';
import type { ValidationRecord } from './validation';

export interface SourcePosition {
  /** Zero-based line. */
  line: number;
  /** Zero-based UTF-16 character offset. */
  character: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface EditorTarget {
  uri: string;
  language: Language;
  position?: SourcePosition;
  /** Used for retrieved candidates when the index has no stable source position. */
  symbolName?: string;
  documentVersion?: number;
}

export type ClassDeclarationKind = 'class' | 'record' | 'interface';

export type ClassMemberKind =
  | 'field'
  | 'constructor'
  | 'property'
  | 'method'
  | 'class'
  | 'record'
  | 'interface';

export interface ClassMemberSnapshot {
  name: string;
  kind: ClassMemberKind;
  range: SourceRange;
  selectionRange: SourceRange;
  declaration: string;
}

/** Complete, LSP-owned class boundary plus bounded source facts for one document version. */
export interface ClassSnapshot {
  uri: string;
  path: string;
  language: Language;
  name: string;
  declarationKind: ClassDeclarationKind;
  range: SourceRange;
  selectionRange: SourceRange;
  documentVersion: number;
  source: string;
  declaration: string;
  namespace?: string;
  imports: string[];
  baseTypes: string[];
  interfaces: string[];
  genericConstraints: string[];
  members: ClassMemberSnapshot[];
}

export interface SymbolRequest {
  uri: string;
  position: SourcePosition;
}

export interface SourceLocation {
  uri: string;
  range: SourceRange;
}

export type NormalizedDiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint';

export interface NormalizedDiagnostic {
  uri: string;
  range: SourceRange;
  severity: NormalizedDiagnosticSeverity;
  message: string;
  source?: string;
  code?: string;
  documentVersion?: number;
}

export interface DiagnosticRequest {
  target: ClassSnapshot;
  candidateSource?: string;
  baselineDiagnostics?: NormalizedDiagnostic[];
  /** Absolute epoch deadline shared by model and LSP operations. */
  deadlineAt: number;
}

export interface DiagnosticDelta {
  documentVersion: number;
  baseline: NormalizedDiagnostic[];
  current: NormalizedDiagnostic[];
  introduced: NormalizedDiagnostic[];
  changed: NormalizedDiagnostic[];
  ignored: NormalizedDiagnostic[];
}

export type TranslationAttemptOutcome =
  | 'retry'
  | 'passed'
  | 'timed_out'
  | 'cancelled'
  | 'lsp_unavailable'
  | 'max_attempts';

export interface TranslationAttempt {
  index: number;
  startedAt: string;
  durationMs: number;
  diagnostics: NormalizedDiagnostic[];
  outcome: TranslationAttemptOutcome;
}

export type LspValidationStatus =
  | 'passed'
  | 'timed_out'
  | 'cancelled'
  | 'lsp_unavailable'
  | 'max_attempts';

export interface LspValidationResult {
  status: LspValidationStatus;
  deadlineAt: string;
  attempts: TranslationAttempt[];
  baselineDiagnostics: NormalizedDiagnostic[];
  introducedDiagnostics: NormalizedDiagnostic[];
  ignoredDiagnostics: NormalizedDiagnostic[];
  detail?: string;
}

/** Serializable handoff created only after the LSP gate passes. */
export interface ValidatorHandoff {
  schemaVersion: '1.0';
  traceId: string;
  target: ModuleTarget;
  targetClass: ClassSnapshot;
  candidate: Pick<SearchCandidate, 'id' | 'repository' | 'path' | 'language' | 'signature'>;
  candidateClass: ClassSnapshot;
  requirement: string;
  analysisReport: AnalysisReport;
  generatedCode: string;
  interfaceMappings: InterfaceMapping[];
  lspValidation: LspValidationResult;
  preValidation: ValidationRecord[];
  files: FilePatch[];
}

export interface ValidatorIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  uri?: string;
  range?: SourceRange;
  suggestedAction?: string;
}

export interface ValidatorFeedback {
  schemaVersion: '1.0';
  traceId: string;
  verdict: 'pass' | 'fail' | 'blocked';
  checks: ValidationRecord[];
  issues: ValidatorIssue[];
}
