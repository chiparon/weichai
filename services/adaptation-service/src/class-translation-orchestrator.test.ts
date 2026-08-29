import type {
  AnalysisReport,
  AdaptationRequest,
  ClassSnapshot,
  DiagnosticDelta,
  DiagnosticRequest,
  NormalizedDiagnostic,
} from '@forexplore/contracts';
import {
  LanguageIntelligenceError,
  type LanguageIntelligencePort,
} from '@forexplore/workflow-core';
import { describe, expect, it, vi } from 'vitest';
import {
  ClassTranslationOrchestrator,
  type ClassTranslationModel,
} from './class-translation-orchestrator';

const targetSource = [
  'namespace Demo;',
  '',
  'public class TargetService',
  '{',
  '    public int Value() => 0;',
  '}',
].join('\n');

const targetClass: ClassSnapshot = {
  uri: 'file:///workspace/TargetService.cs',
  path: 'TargetService.cs',
  language: 'C#',
  name: 'TargetService',
  declarationKind: 'class',
  range: { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } },
  selectionRange: { start: { line: 2, character: 13 }, end: { line: 2, character: 26 } },
  documentVersion: 1,
  source: targetSource.split('\n').slice(2).join('\n'),
  declaration: 'public class TargetService',
  namespace: 'Demo',
  imports: [],
  baseTypes: [],
  interfaces: [],
  genericConstraints: [],
  members: [{
    name: 'Value',
    kind: 'method',
    range: { start: { line: 4, character: 4 }, end: { line: 4, character: 28 } },
    selectionRange: { start: { line: 4, character: 15 }, end: { line: 4, character: 20 } },
    declaration: 'public int Value() => 0;',
  }],
};

const candidateClass: ClassSnapshot = {
  ...targetClass,
  uri: 'file:///corpus/SourceService.java',
  path: 'src/SourceService.java',
  language: 'Java',
  name: 'SourceService',
  declaration: 'public class SourceService',
  source: 'public class SourceService { public int value() { return 1; } }',
};

const adaptation: AdaptationRequest = {
  target: {
    id: 'target',
    name: 'TargetService',
    kind: 'class',
    path: 'TargetService.cs',
    language: 'C#',
    signature: 'public class TargetService',
    line: 3,
  },
  candidate: {
    id: 'candidate',
    title: 'SourceService',
    repository: 'fixture/java',
    license: 'MIT',
    language: 'Java',
    kind: 'class',
    path: 'src/SourceService.java',
    signature: 'public class SourceService',
    summary: 'Source class.',
    score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
    preview: candidateClass.source,
    dependencies: [],
    compatibility: [],
    risks: [],
  },
  requirement: 'Return one.',
  strategy: 'translate',
  decisionNotes: '',
};

const analysisReport: AnalysisReport = {
  schemaVersion: '1.0',
  applicability: { level: 'adapt', confidence: 0.9, reasons: ['Class behavior maps.'] },
  behaviorMapping: [{
    requirement: 'Return one.',
    status: 'covered',
    candidateEvidence: ['return 1'],
    targetAction: 'Preserve the target class declaration.',
  }],
  contractMapping: [],
  dependencyPlan: [],
  implementationPlan: ['Preserve the target class declaration.'],
  risks: [],
  assumptions: [],
  unresolved: [],
};

const brokenCode = 'public class TargetService { public int Value() => missing; }';
const fixedCode = 'public class TargetService { public int Value() => 1; }';

function error(message = 'The name missing does not exist'): NormalizedDiagnostic {
  return {
    uri: targetClass.uri,
    range: { start: { line: 2, character: 50 }, end: { line: 2, character: 57 } },
    severity: 'error',
    source: 'csharp',
    code: 'CS0103',
    message,
  };
}

function delta(
  request: DiagnosticRequest,
  introduced: NormalizedDiagnostic[] = [],
): DiagnosticDelta {
  const baseline = request.baselineDiagnostics ?? [];
  return {
    documentVersion: 2,
    baseline,
    current: [...baseline, ...introduced],
    introduced,
    changed: [],
    ignored: baseline,
  };
}

function port(
  diagnose: LanguageIntelligencePort['diagnose'],
): LanguageIntelligencePort {
  return {
    async resolveContainingClass(target) {
      return target.uri.includes('SourceService') ? candidateClass : targetClass;
    },
    async definitions() {
      return [{ uri: targetClass.uri, range: targetClass.range }];
    },
    async references() {
      return [];
    },
    diagnose,
  };
}

function model(): ClassTranslationModel & { translate: ReturnType<typeof vi.fn>; repair: ReturnType<typeof vi.fn> } {
  return {
    translate: vi.fn(async () => ({
      schemaVersion: '1.0' as const,
      generatedCode: brokenCode,
      completedSteps: analysisReport.implementationPlan,
      unresolved: [],
    })),
    repair: vi.fn(async () => ({
      schemaVersion: '1.0' as const,
      generatedCode: fixedCode,
      completedSteps: analysisReport.implementationPlan,
      unresolved: [],
    })),
  };
}

function request() {
  return {
    adaptation,
    targetEditor: { uri: targetClass.uri, language: 'C#' as const, position: { line: 4, character: 10 } },
    candidateEditor: { uri: candidateClass.uri, language: 'Java' as const, symbolName: 'SourceService' },
    targetDocumentSource: targetSource,
  };
}

describe('ClassTranslationOrchestrator', () => {
  it('repairs candidate-introduced LSP errors and creates a Validator handoff only after pass', async () => {
    let candidateChecks = 0;
    const language = port(async (diagnosticRequest) => {
      if (!diagnosticRequest.candidateSource) return delta(diagnosticRequest);
      candidateChecks += 1;
      return delta(diagnosticRequest, candidateChecks === 1 ? [error()] : []);
    });
    const translation = model();
    const progress = vi.fn();
    const orchestrator = new ClassTranslationOrchestrator({
      languageIntelligence: language,
      analyzer: { async analyze() { return analysisReport; } },
      translator: translation,
      onProgress: progress,
      traceId: () => 'trace-1',
    });

    const result = await orchestrator.adapt(request());

    expect(result.generatedCode).toBe(fixedCode);
    expect(result.lspValidation?.status).toBe('passed');
    expect(result.lspValidation?.attempts.map((attempt) => attempt.outcome)).toEqual(['retry', 'passed']);
    expect(translation.repair).toHaveBeenCalledOnce();
    expect(result.files).toHaveLength(1);
    expect(result.validatorHandoff).toMatchObject({ traceId: 'trace-1', generatedCode: fixedCode });
    expect(result.validation).toContainEqual(expect.objectContaining({
      id: 'validator-integration',
      status: 'unverified',
      required: true,
    }));
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('returns max_attempts without a patch or Validator handoff', async () => {
    const orchestrator = new ClassTranslationOrchestrator({
      languageIntelligence: port(async (diagnosticRequest) =>
        diagnosticRequest.candidateSource ? delta(diagnosticRequest, [error()]) : delta(diagnosticRequest)),
      analyzer: { async analyze() { return analysisReport; } },
      translator: model(),
      maxAttempts: 2,
    });

    const result = await orchestrator.adapt(request());

    expect(result.lspValidation?.status).toBe('max_attempts');
    expect(result.lspValidation?.attempts).toHaveLength(2);
    expect(result.files).toEqual([]);
    expect(result.validatorHandoff).toBeUndefined();
  });

  it.each([
    ['lsp_unavailable', 'lsp_unavailable'],
    ['timed_out', 'timed_out'],
    ['cancelled', 'cancelled'],
  ] as const)('returns a structured %s terminal state', async (kind, expected) => {
    const orchestrator = new ClassTranslationOrchestrator({
      languageIntelligence: port(async (diagnosticRequest) => {
        if (!diagnosticRequest.candidateSource) return delta(diagnosticRequest);
        throw new LanguageIntelligenceError(kind, `fixture ${kind}`);
      }),
      analyzer: { async analyze() { return analysisReport; } },
      translator: model(),
    });

    const result = await orchestrator.adapt(request());

    expect(result.lspValidation?.status).toBe(expected);
    expect(result.files).toEqual([]);
    expect(result.validation).toContainEqual(expect.objectContaining({
      id: 'lsp-class-diagnostics',
      required: true,
    }));
  });

  it('makes interfaces explicit contract-only targets', async () => {
    const interfacePort = port(async (diagnosticRequest) => delta(diagnosticRequest));
    interfacePort.resolveContainingClass = async () => ({ ...targetClass, declarationKind: 'interface' });
    const orchestrator = new ClassTranslationOrchestrator({
      languageIntelligence: interfacePort,
      analyzer: { async analyze() { return analysisReport; } },
      translator: model(),
    });

    await expect(orchestrator.adapt(request())).rejects.toThrow('interfaces are contract-only');
  });
});
