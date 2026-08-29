import { createHash, randomUUID } from 'node:crypto';
import type {
  AnalysisReport,
  AdaptationRequest,
  AdaptationResult,
  ClassSnapshot,
  DiagnosticDelta,
  EditorTarget,
  FilePatch,
  LspValidationResult,
  NormalizedDiagnostic,
  SourceLocation,
  TargetModuleContext,
  TranslationAttempt,
  TranslationAttemptOutcome,
  ValidationRecord,
  ValidatorHandoff,
} from '@forexplore/contracts';
import { analysisSchemaVersion } from '@forexplore/contracts';
import {
  LanguageIntelligenceError,
  type LanguageIntelligencePort,
} from '@forexplore/workflow-core';
import { AnalyzerAgent, type AnalyzerAgentOptions } from './analyzer';
import {
  projectTargetContext,
  repairTranslation,
  translateWithAnalysis,
  type AnalyzeTranslationRequest,
  type RepairTranslationRequest,
  type TranslationResult,
  type TranslatorModelOptions,
} from './translator';

export interface ClassTranslationRequest {
  adaptation: AdaptationRequest;
  targetEditor: EditorTarget;
  candidateEditor: EditorTarget;
  /** Exact host-owned target file snapshot; never supplied by the Webview. */
  targetDocumentSource: string;
}

export interface ClassTranslationProgress {
  attempt: TranslationAttempt;
  remainingMs: number;
}

export interface ClassTranslationOrchestratorOptions {
  languageIntelligence: LanguageIntelligencePort;
  apiKey?: string;
  analyzer?: { analyze(request: Parameters<AnalyzerAgent['analyze']>[0], signal?: AbortSignal): Promise<AnalysisReport> };
  translator?: ClassTranslationModel;
  analyzerOptions?: Omit<AnalyzerAgentOptions, 'apiKey'>;
  translatorOptions?: Omit<TranslatorModelOptions, 'apiKey'>;
  timeoutMs?: number;
  maxAttempts?: number;
  now?: () => number;
  traceId?: () => string;
  onProgress?: (progress: ClassTranslationProgress) => void;
}

export interface ClassTranslationModel {
  translate(request: AnalyzeTranslationRequest, signal?: AbortSignal): Promise<TranslationResult>;
  repair(request: RepairTranslationRequest, signal?: AbortSignal): Promise<TranslationResult>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_CLASS_CONTEXT_CHARS = 64_000;

/**
 * Editor-owned class translation state machine. Compilation is deliberately
 * absent: only LSP diagnostics can open the Validator handoff gate.
 */
export class ClassTranslationOrchestrator {
  readonly #languageIntelligence: LanguageIntelligencePort;
  readonly #analyzer: ClassTranslationOrchestratorOptions['analyzer'];
  readonly #translator: ClassTranslationModel;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #traceId: () => string;
  readonly #onProgress?: (progress: ClassTranslationProgress) => void;

  constructor(options: ClassTranslationOrchestratorOptions) {
    this.#languageIntelligence = options.languageIntelligence;
    const apiKey = options.apiKey ?? '';
    this.#analyzer = options.analyzer ?? new AnalyzerAgent({
      apiKey,
      ...options.analyzerOptions,
    });
    const translatorOptions = { apiKey, ...options.translatorOptions };
    this.#translator = options.translator ?? {
      translate: (request, signal) => translateWithAnalysis(request, translatorOptions, signal),
      repair: (request, signal) => repairTranslation(request, translatorOptions, signal),
    };
    this.#timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    this.#maxAttempts = clamp(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, DEFAULT_MAX_ATTEMPTS);
    this.#now = options.now ?? Date.now;
    this.#traceId = options.traceId ?? randomUUID;
    this.#onProgress = options.onProgress;
  }

  async adapt(request: ClassTranslationRequest, signal?: AbortSignal): Promise<AdaptationResult> {
    assertClassRequest(request);
    const startedAt = this.#now();
    const deadlineAt = startedAt + this.#timeoutMs;
    const deadline = sharedDeadline(deadlineAt, signal, this.#now);
    let generatedCode = '';
    let targetClass: ClassSnapshot | undefined;
    let candidateClass: ClassSnapshot | undefined;
    let analysisReport: AnalysisReport | undefined;
    let baseline: NormalizedDiagnostic[] = [];
    const attempts: TranslationAttempt[] = [];

    try {
      [targetClass, candidateClass] = await Promise.all([
        this.#languageIntelligence.resolveContainingClass(request.targetEditor, deadline.signal),
        this.#languageIntelligence.resolveContainingClass(request.candidateEditor, deadline.signal),
      ]);
      assertSupportedClassKind(targetClass, 'target');
      assertSupportedClassKind(candidateClass, 'candidate');

      const symbolRequests = [targetClass.selectionRange, ...targetClass.members.slice(0, 12)
        .map((member) => member.selectionRange)].map((range) => ({
        uri: targetClass!.uri,
        position: range.start,
      }));
      const [definitionGroups, referenceGroups] = await Promise.all([
        Promise.all(symbolRequests.map((symbolRequest) =>
          this.#languageIntelligence.definitions(symbolRequest, deadline.signal))),
        Promise.all(symbolRequests.map((symbolRequest) =>
          this.#languageIntelligence.references(symbolRequest, deadline.signal))),
      ]);
      const definitions = uniqueLocations(definitionGroups.flat());
      const references = uniqueLocations(referenceGroups.flat());
      if (definitions.length === 0) {
        throw new LanguageIntelligenceError(
          'lsp_unavailable',
          'The active language provider returned no definition for the target class.',
        );
      }

      const targetContext = contextFromClass(
        targetClass,
        request.adaptation,
        request.targetDocumentSource,
        definitions,
        references,
      );
      analysisReport = await this.#analyzer!.analyze({
        schemaVersion: analysisSchemaVersion,
        targetContext,
        candidate: {
          ...request.adaptation.candidate,
          kind: 'class',
          preview: budgetClassSource(candidateClass, MAX_CLASS_CONTEXT_CHARS).source,
          signature: candidateClass.declaration,
          line: candidateClass.range.start.line + 1,
        },
        requirement: effectiveRequirement(request.adaptation),
        immutableConstraints: targetContext.constraints,
        decisionNotes: request.adaptation.decisionNotes,
      }, deadline.signal);

      const translationInput: AnalyzeTranslationRequest = {
        candidateSource: budgetClassSource(candidateClass, MAX_CLASS_CONTEXT_CHARS).source,
        targetContext: projectTargetContext(targetContext),
        requirement: effectiveRequirement(request.adaptation),
        analysisReport,
      };
      let translation = await this.#translator.translate(translationInput, deadline.signal);
      generatedCode = translation.generatedCode;

      baseline = (await this.#languageIntelligence.diagnose({
        target: targetClass,
        deadlineAt,
      }, deadline.signal)).current;

      for (let index = 1; index <= this.#maxAttempts; index += 1) {
        const attemptStartedAt = this.#now();
        let diagnostics: DiagnosticDelta;
        try {
          diagnostics = await this.#languageIntelligence.diagnose({
            target: targetClass,
            candidateSource: generatedCode,
            baselineDiagnostics: baseline,
            deadlineAt,
          }, deadline.signal);
        } catch (error: unknown) {
          const outcome = failureOutcome(error, deadline.timedOut());
          if (!outcome) throw error;
          const attempt = makeAttempt(index, attemptStartedAt, this.#now(), [], outcome);
          attempts.push(attempt);
          this.#publish(attempt, deadlineAt);
          return blockedResult(
            request.adaptation,
            generatedCode,
            validationResult(outcome, deadlineAt, attempts, baseline, [], [], errorMessage(error)),
            analysisReport,
          );
        }

        const introducedErrors = [...diagnostics.introduced, ...diagnostics.changed]
          .filter((item) => item.severity === 'error');
        if (introducedErrors.length === 0) {
          const attempt = makeAttempt(index, attemptStartedAt, this.#now(), [], 'passed');
          attempts.push(attempt);
          this.#publish(attempt, deadlineAt);
          const lspValidation = validationResult(
            'passed',
            deadlineAt,
            attempts,
            baseline,
            [],
            diagnostics.ignored,
          );
          return passedResult({
            request,
            targetClass,
            candidateClass,
            analysisReport,
            generatedCode,
            lspValidation,
            traceId: this.#traceId(),
          });
        }

        if (index >= this.#maxAttempts) {
          const attempt = makeAttempt(
            index,
            attemptStartedAt,
            this.#now(),
            introducedErrors,
            'max_attempts',
          );
          attempts.push(attempt);
          this.#publish(attempt, deadlineAt);
          return blockedResult(
            request.adaptation,
            generatedCode,
            validationResult(
              'max_attempts',
              deadlineAt,
              attempts,
              baseline,
              introducedErrors,
              diagnostics.ignored,
              `Reached the maximum of ${this.#maxAttempts} LSP attempts.`,
            ),
            analysisReport,
          );
        }

        const attempt = makeAttempt(index, attemptStartedAt, this.#now(), introducedErrors, 'retry');
        attempts.push(attempt);
        this.#publish(attempt, deadlineAt);
        translation = await this.#translator.repair({
          ...translationInput,
          previousResult: translation,
          validationFeedback: diagnosticFeedback(introducedErrors),
        }, deadline.signal);
        generatedCode = translation.generatedCode;
      }
      throw new Error('Class translation state machine exited without a terminal result.');
    } catch (error: unknown) {
      const outcome = failureOutcome(error, deadline.timedOut());
      if (!outcome) throw error;
      const terminal = validationResult(
        outcome,
        deadlineAt,
        attempts,
        baseline,
        [],
        [],
        errorMessage(error),
      );
      return blockedResult(request.adaptation, generatedCode, terminal, analysisReport);
    } finally {
      deadline.dispose();
    }
  }

  #publish(attempt: TranslationAttempt, deadlineAt: number): void {
    this.#onProgress?.({ attempt, remainingMs: Math.max(0, deadlineAt - this.#now()) });
  }
}

function contextFromClass(
  snapshot: ClassSnapshot,
  request: AdaptationRequest,
  targetDocumentSource: string,
  definitions: SourceLocation[],
  references: SourceLocation[],
): TargetModuleContext {
  const budgeted = budgetClassSource(snapshot, MAX_CLASS_CONTEXT_CHARS);
  const target = {
    ...request.target,
    name: snapshot.name,
    kind: 'class' as const,
    path: snapshot.path,
    language: snapshot.language,
    signature: snapshot.declaration,
    line: snapshot.range.start.line + 1,
  };
  const fields = snapshot.members.filter((member) => member.kind === 'field').map((member) => member.declaration);
  const constructor = snapshot.members.find((member) => member.kind === 'constructor')?.declaration;
  const relatedMembers = snapshot.members
    .filter((member) => member.kind === 'method' || member.kind === 'property')
    .map((member) => member.declaration);
  const dependencyNames = [...snapshot.baseTypes, ...snapshot.interfaces];
  return {
    schemaVersion: analysisSchemaVersion,
    target,
    source: {
      namespace: snapshot.namespace,
      usings: [...snapshot.imports],
      method: budgeted.source,
      containingType: budgeted.source,
      fields,
      constructor,
      relatedMembers,
    },
    dependencies: dependencyNames.map((name, index) => ({
      name,
      kind: 'type' as const,
      declaration: name,
      path: definitions[index]?.uri,
    })),
    relatedTypes: [],
    callers: references.map((reference) => ({
      path: reference.uri,
      line: reference.range.start.line + 1,
      excerpt: `${reference.range.start.line + 1}:${reference.range.start.character + 1}`,
    })),
    constraints: [
      `Only replace the LSP class range ${rangeLabel(snapshot)}.`,
      `Preserve the exact ${snapshot.declarationKind} declaration: ${snapshot.declaration}`,
      ...snapshot.genericConstraints,
    ],
    languageIntelligence: { definitions, references },
    collection: {
      projectRoot: '',
      targetFile: snapshot.path,
      maxChars: MAX_CLASS_CONTEXT_CHARS,
      actualChars: budgeted.source.length,
      truncated: budgeted.truncated,
      truncatedSections: budgeted.truncated ? ['class-member-bodies'] : [],
    },
  };
}

function passedResult(input: {
  request: ClassTranslationRequest;
  targetClass: ClassSnapshot;
  candidateClass: ClassSnapshot;
  analysisReport: AnalysisReport;
  generatedCode: string;
  lspValidation: LspValidationResult;
  traceId: string;
}): AdaptationResult {
  const target = {
    ...input.request.adaptation.target,
    name: input.targetClass.name,
    kind: 'class' as const,
    path: input.targetClass.path,
    language: input.targetClass.language,
    signature: input.targetClass.declaration,
    line: input.targetClass.range.start.line + 1,
  };
  const patch = buildLspClassPatch(
    target.path,
    input.generatedCode,
    input.request.targetDocumentSource,
    input.targetClass,
  );
  const validation: ValidationRecord[] = [
    analyzerValidation(input.analysisReport),
    lspValidationRecord(input.lspValidation),
    {
      id: 'validator-integration',
      label: 'Validator integration tests',
      status: 'unverified',
      required: true,
      summary: 'LSP passed. The class is ready for Validator behavioral and integration testing.',
      failureReason: 'validator-handoff-pending',
    },
  ];
  const handoff: ValidatorHandoff = {
    schemaVersion: '1.0',
    traceId: input.traceId,
    target,
    targetClass: input.targetClass,
    candidate: {
      id: input.request.adaptation.candidate.id,
      repository: input.request.adaptation.candidate.repository,
      path: input.request.adaptation.candidate.path,
      language: input.request.adaptation.candidate.language,
      signature: input.candidateClass.declaration,
    },
    candidateClass: input.candidateClass,
    requirement: effectiveRequirement(input.request.adaptation),
    analysisReport: input.analysisReport,
    generatedCode: input.generatedCode,
    interfaceMappings: input.analysisReport.contractMapping,
    lspValidation: input.lspValidation,
    preValidation: validation,
    files: [patch],
  };
  return {
    strategy: 'translate',
    targetLanguage: target.language,
    generatedCode: input.generatedCode,
    interfaceMappings: input.analysisReport.contractMapping,
    validation,
    files: [patch],
    lspValidation: input.lspValidation,
    validatorHandoff: handoff,
  };
}

function blockedResult(
  request: AdaptationRequest,
  generatedCode: string,
  lspValidation: LspValidationResult,
  analysisReport?: AnalysisReport,
): AdaptationResult {
  return {
    strategy: 'translate',
    targetLanguage: request.target.language,
    generatedCode,
    interfaceMappings: analysisReport?.contractMapping ?? [],
    validation: [
      ...(analysisReport ? [analyzerValidation(analysisReport)] : []),
      lspValidationRecord(lspValidation),
    ],
    files: [],
    lspValidation,
  };
}

function analyzerValidation(report: AnalysisReport): ValidationRecord {
  return {
    id: 'analyzer',
    label: 'Analyzer',
    status: report.applicability.level === 'reject' ? 'fail' : 'pass',
    required: true,
    summary: `${report.applicability.level} (${Math.round(report.applicability.confidence * 100)}%)`,
    failureReason: report.applicability.level === 'reject' ? 'candidate-rejected' : undefined,
  };
}

function lspValidationRecord(result: LspValidationResult): ValidationRecord {
  const passed = result.status === 'passed';
  return {
    id: 'lsp-class-diagnostics',
    label: 'LSP class diagnostics',
    status: passed ? 'pass' : result.status === 'cancelled' ? 'unverified' : 'fail',
    required: true,
    command: 'VS Code language provider diagnostics',
    summary: passed
      ? `No candidate-introduced class errors after ${result.attempts.length} attempt(s).`
      : result.detail ?? `LSP gate ended with ${result.status}.`,
    failureReason: passed ? undefined : result.status,
  };
}

function validationResult(
  outcome: TranslationAttemptOutcome,
  deadlineAt: number,
  attempts: TranslationAttempt[],
  baselineDiagnostics: NormalizedDiagnostic[],
  introducedDiagnostics: NormalizedDiagnostic[],
  ignoredDiagnostics: NormalizedDiagnostic[],
  detail?: string,
): LspValidationResult {
  const status = outcome === 'retry' ? 'max_attempts' : outcome;
  return {
    status,
    deadlineAt: new Date(deadlineAt).toISOString(),
    attempts: [...attempts],
    baselineDiagnostics,
    introducedDiagnostics,
    ignoredDiagnostics,
    detail,
  };
}

function diagnosticFeedback(diagnostics: NormalizedDiagnostic[]): RepairTranslationRequest['validationFeedback'] {
  return {
    status: 'fail',
    issues: diagnostics.map((diagnostic) => ({
      category: 'syntax' as const,
      file: diagnostic.uri,
      line: diagnostic.range.start.line + 1,
      message: diagnostic.message,
      evidence: [diagnostic.source, diagnostic.code].filter(Boolean).join(':'),
    })),
  };
}

function makeAttempt(
  index: number,
  startedAt: number,
  finishedAt: number,
  diagnostics: NormalizedDiagnostic[],
  outcome: TranslationAttemptOutcome,
): TranslationAttempt {
  return {
    index,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, finishedAt - startedAt),
    diagnostics,
    outcome,
  };
}

function sharedDeadline(
  deadlineAt: number,
  external: AbortSignal | undefined,
  now: () => number,
): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let timeout = false;
  const onAbort = (): void => controller.abort(external?.reason);
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error('translation deadline exceeded'));
  }, Math.max(0, deadlineAt - now()));
  return {
    signal: controller.signal,
    timedOut: () => timeout || now() >= deadlineAt,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function failureOutcome(error: unknown, timedOut: boolean): TranslationAttemptOutcome | null {
  if (timedOut) return 'timed_out';
  if (error instanceof LanguageIntelligenceError) {
    if (error.kind === 'lsp_unavailable') return 'lsp_unavailable';
    if (error.kind === 'timed_out') return 'timed_out';
    if (error.kind === 'cancelled' || error.kind === 'document_changed') return 'cancelled';
  }
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  return null;
}

function assertClassRequest(request: ClassTranslationRequest): void {
  if (request.adaptation.strategy !== 'translate') {
    throw new Error('ClassTranslationOrchestrator only supports the translate strategy.');
  }
  if (!request.targetDocumentSource) throw new Error('A host-owned target document snapshot is required.');
}

function assertSupportedClassKind(snapshot: ClassSnapshot, role: 'target' | 'candidate'): void {
  if (snapshot.declarationKind === 'interface') {
    throw new Error(
      `${role === 'target' ? 'Target' : 'Candidate'} interfaces are contract-only. Select a class or record implementation.`,
    );
  }
}

function effectiveRequirement(request: AdaptationRequest): string {
  return request.requirement.trim() || request.target.documentation?.trim() ||
    `Implement the target contract: ${request.target.signature}`;
}

function rangeLabel(snapshot: ClassSnapshot): string {
  return `${snapshot.range.start.line + 1}:${snapshot.range.start.character + 1}` +
    `-${snapshot.range.end.line + 1}:${snapshot.range.end.character + 1}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function budgetClassSource(
  snapshot: ClassSnapshot,
  maxChars: number,
): { source: string; truncated: boolean } {
  if (snapshot.source.length <= maxChars) return { source: snapshot.source, truncated: false };
  const sourceLines = snapshot.source.replace(/\r\n/g, '\n').split('\n');
  const prioritized = [...snapshot.members].sort((left, right) =>
    memberPriority(left.kind) - memberPriority(right.kind) ||
    left.range.start.line - right.range.start.line,
  );
  const blocks: string[] = [];
  let used = snapshot.declaration.length + 4;
  for (const member of prioritized) {
    const startLine = Math.max(0, member.range.start.line - snapshot.range.start.line);
    const endLine = Math.max(startLine, member.range.end.line - snapshot.range.start.line);
    const full = sourceLines.slice(startLine, endLine + 1).join('\n').trim();
    const block = full && used + full.length + 2 <= maxChars
      ? full
      : member.declaration.trim();
    if (!block || used + block.length + 2 > maxChars) continue;
    blocks.push(block);
    used += block.length + 2;
  }
  return {
    source: `${snapshot.declaration}\n{\n${blocks.join('\n\n')}\n}`,
    truncated: true,
  };
}

function memberPriority(kind: ClassSnapshot['members'][number]['kind']): number {
  if (kind === 'field') return 0;
  if (kind === 'constructor') return 1;
  if (kind === 'property') return 2;
  if (kind === 'method') return 3;
  return 4;
}

function uniqueLocations(locations: SourceLocation[]): SourceLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    const key = `${location.uri}:${location.range.start.line}:${location.range.start.character}` +
      `:${location.range.end.line}:${location.range.end.character}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildLspClassPatch(
  filePath: string,
  generatedCode: string,
  originalDocument: string,
  target: ClassSnapshot,
): FilePatch {
  const originalLines = originalDocument.replace(/\r\n/g, '\n').split('\n');
  const startLine = target.range.start.line;
  const endLine = target.range.end.character === 0
    ? Math.max(startLine, target.range.end.line - 1)
    : target.range.end.line;
  const firstLine = originalLines[startLine];
  const lastLine = originalLines[endLine];
  if (firstLine === undefined || lastLine === undefined || endLine < startLine) {
    throw new Error('The LSP class range is outside the host-owned target snapshot.');
  }
  const prefix = firstLine.slice(0, target.range.start.character);
  const suffix = lastLine.slice(target.range.end.character);
  if (prefix.trim() || suffix.trim()) {
    throw new Error('The LSP class range does not align to a safe class-only line boundary.');
  }
  const indentation = prefix;
  const replacement = generatedCode.trim().split(/\r?\n/).map((line) =>
    line.trim() ? `${indentation}${line}` : line,
  );
  const removed = originalLines.slice(startLine, endLine + 1);
  const lines: FilePatch['hunks'][number]['lines'] = [];
  if (startLine > 0) lines.push({ type: 'context', content: originalLines[startLine - 1] ?? '' });
  lines.push(...removed.map((content) => ({ type: 'remove' as const, content })));
  lines.push(...replacement.map((content) => ({ type: 'add' as const, content })));
  if (endLine + 1 < originalLines.length) {
    lines.push({ type: 'context', content: originalLines[endLine + 1] ?? '' });
  }
  return {
    path: filePath,
    status: 'modified',
    expectedOriginalSha256: createHash('sha256').update(originalDocument, 'utf8').digest('hex'),
    additions: replacement.length,
    deletions: removed.length,
    hunks: [{
      header: `@@ -${startLine + 1},${removed.length} +${startLine + 1},${replacement.length} @@`,
      lines,
    }],
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}
