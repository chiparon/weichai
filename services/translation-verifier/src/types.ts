import type {
  AnalysisReport,
  FilePatch,
  WorkspaceCompilation,
  WorkspaceTranslationChange,
  WorkspaceTranslationPlan,
} from "@forexplore/contracts";

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type VerificationFunction = {
  /** Project-relative file path containing the function. */
  path: string;
  name: string;
  signature?: string;
};

export type VerificationSubject = {
  sourceFunction: VerificationFunction;
  targetFunction: VerificationFunction;
  requirement: string;
};

export type Translation = {
  round: number;
  generatedContent?: string;
  files: FilePatch[];
};

export type VerificationInput = {
  schemaVersion: "2.0";
  sourceLanguage: string;
  targetLanguage: string;
  /** Absolute path to the project containing the source code being translated. */
  sourceProjectPath: string;
  /** Absolute path to the project receiving the translated code. */
  targetProjectPath: string;
  subject: VerificationSubject;
  analysisReport: AnalysisReport;
  migrationPlan: JsonValue;
  translation: Translation;
};

export type FunctionGroupVerificationFunction = {
  source: VerificationFunction;
  target: VerificationFunction;
};

export type FunctionGroupTranslationEvidence = {
  id: string;
  plan?: WorkspaceTranslationPlan;
  changes: WorkspaceTranslationChange[];
  compilations: WorkspaceCompilation[];
  acceptance: "compilation-only" | "behavior-verified";
};

export type FunctionGroupVerificationInput = {
  schemaVersion: "3.0";
  sourceLanguage: string;
  targetLanguage: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  requirement: string;
  functions: FunctionGroupVerificationFunction[];
  translationRun: FunctionGroupTranslationEvidence;
};

export type VerificationIssueKind =
  | "translation"
  | "test"
  | "environment"
  | "unknown";

export type VerificationIssue = {
  kind: VerificationIssueKind;
  description: string;
};

export type TargetFunctionCoverage = {
  name: string;
  executed: boolean;
  /** Percentage from 0 to 100; null when no lines can be measured. */
  lineCoverage: number | null;
  /** Percentage from 0 to 100; null when the function has no branches. */
  branchCoverage: number | null;
};

export type VerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
  targetFunction?: TargetFunctionCoverage;
};

export type FunctionGroupFunctionResult = {
  source: VerificationFunction;
  target: VerificationFunction;
  status: "passed" | "unverified";
  executed: boolean;
  lineCoverage: number | null;
  branchCoverage: number | null;
};

export type FunctionGroupVerificationResult = {
  status: "success" | "failure";
  issue?: VerificationIssue;
  functions: FunctionGroupFunctionResult[];
};

export type VerificationPhase = "prepare" | "verify";

export type StrategyHandler<Result = unknown> = (
  input: VerificationInput,
) => Result | Promise<Result>;

export type VerificationStrategy<Result = unknown> = Partial<
  Record<VerificationPhase, StrategyHandler<Result>>
>;

export type FunctionGroupVerificationStrategy<Result = unknown> = Partial<
  Record<
    VerificationPhase,
    (input: FunctionGroupVerificationInput) => Result | Promise<Result>
  >
>;
