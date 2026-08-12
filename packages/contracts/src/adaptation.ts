import type { FilePatch } from './backfill';
import type { Language, ModuleTarget } from './module';
import type { SearchCandidate } from './retrieval';

export type AdaptationStrategy = 'translate' | 'bridge' | 'wrap' | 'reuse';

export interface AnalysisRequest {
  target: ModuleTarget;
  candidate: SearchCandidate;
  requirement: string;
}

export interface AdaptationRequest extends AnalysisRequest {
  strategy: AdaptationStrategy;
  decisionNotes: string;
}

export type AnalysisApplicability = 'direct' | 'adapt' | 'reference' | 'reject';

export type BehaviorCoverage = 'covered' | 'partial' | 'missing' | 'conflict';

export interface TargetDependencyContext {
  name: string;
  kind: 'field' | 'constructor' | 'signature' | 'invocation' | 'type';
  declaration: string;
  path?: string;
  memberSignatures?: string[];
}

export interface RelatedTypeContext {
  name: string;
  kind: 'class' | 'record' | 'interface' | 'struct' | 'enum' | 'unknown';
  path: string;
  declaration: string;
  source: string;
}

export interface CallerContext {
  path: string;
  line: number;
  excerpt: string;
}

export interface StructuredTargetSource {
  namespace?: string;
  usings: string[];
  method: string;
  /** Complete containing type source, kept separate from the legacy type name. */
  containingType: string;
  fields: string[];
  constructor?: string;
  relatedMembers: string[];
}

export interface TargetContextCollection {
  projectRoot: string;
  targetFile: string;
  maxChars: number;
  actualChars: number;
  truncated: boolean;
  truncatedSections: string[];
}

export interface TargetModuleContext {
  projectRoot?: string;
  targetFile: string;
  targetSource: string;
  targetFragment: string;
  imports: string[];
  containingType?: string;
  containingTypeSource?: string;
  neighboringFiles: Array<{
    path: string;
    language: Language;
    summary: string;
  }>;
  references: Array<{
    path: string;
    line: number;
    excerpt: string;
  }>;
  truncated: boolean;
  /** Rich, structured facts added by the Analyzer context collector. */
  schemaVersion?: '1.0';
  target?: ModuleTarget;
  source?: StructuredTargetSource;
  dependencies?: TargetDependencyContext[];
  relatedTypes?: RelatedTypeContext[];
  callers?: CallerContext[];
  constraints?: string[];
  collection?: TargetContextCollection;
}

export interface BehaviorMapping {
  requirement: string;
  status: BehaviorCoverage;
  candidateEvidence: string[];
  targetAction: string;
}

export interface ContractMapping {
  source: string;
  target: string;
  action: 'preserve' | 'rename' | 'convert' | 'inject' | 'replace';
  note: string;
}

export interface DependencyPlan {
  sourceDependency: string;
  targetDependency?: string;
  action: 'reuse-existing' | 'adapt' | 'inline' | 'unresolved';
}

export interface AnalysisReport {
  schemaVersion: '1.0';
  applicability: {
    level: AnalysisApplicability;
    confidence: number;
    reasons: string[];
  };
  behaviorMapping: BehaviorMapping[];
  contractMapping: ContractMapping[];
  dependencyPlan: DependencyPlan[];
  implementationPlan: string[];
  risks: string[];
  assumptions: string[];
  unresolved: string[];
  /** Issues that must be resolved before translation can start. */
  blockingIssues: string[];
}

export interface AnalyzerRequest extends AnalysisRequest {
  context: TargetModuleContext;
}

export interface AnalysisResult {
  report: AnalysisReport;
  context: TargetModuleContext;
}

export interface InterfaceMapping {
  source: string;
  target: string;
  action: 'rename' | 'convert' | 'inject' | 'preserve' | 'replace';
  note: string;
}

export interface ValidationCheckResult {
  label: string;
  status: 'pass' | 'warn';
  detail: string;
}

/** Serializable handoff owned by the adaptation team and consumed by Validator. */
export interface ValidatorHandoff {
  schemaVersion: '1.0';
  traceId: string;
  target: ModuleTarget;
  candidate: Pick<SearchCandidate, 'id' | 'repository' | 'path' | 'language' | 'signature'>;
  requirement: string;
  analysisReport: AnalysisReport;
  generatedCode: string;
  interfaceMappings: InterfaceMapping[];
  preValidation: ValidationCheckResult[];
  files: FilePatch[];
}

export interface ValidatorIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  line?: number;
  suggestedAction?: string;
}

export interface ValidatorFeedback {
  schemaVersion: '1.0';
  traceId: string;
  targetId: string;
  candidateId: string;
  verdict: 'pass' | 'fail' | 'blocked';
  checks: ValidationCheckResult[];
  issues: ValidatorIssue[];
}

export interface TranslationRepairRequest {
  request: AdaptationRequest;
  handoff: ValidatorHandoff;
  feedback: ValidatorFeedback;
}

export interface AdaptationResult {
  strategy: AdaptationStrategy;
  targetLanguage: Language;
  generatedCode: string;
  interfaceMappings: InterfaceMapping[];
  validation: ValidationCheckResult[];
  files: FilePatch[];
  analysisReport?: AnalysisReport;
  validatorHandoff?: ValidatorHandoff;
}
