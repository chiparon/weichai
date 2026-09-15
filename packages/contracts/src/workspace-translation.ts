/** A reproducible suite generated for a translation; repair attempts reuse it. */
export interface WorkspaceTestSuite {
  files: Array<{ path: string; content: string }>;
  command: Pick<WorkspaceCompileCommand, "executable" | "args">;
}

export interface WorkspaceTestCommandEvidence {
  id: string;
  command: Pick<WorkspaceCompileCommand, "executable" | "args">;
  cwd: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Hash of the production files tested, computed by the host. */
  sourceSnapshot: string;
  filesUnchanged: boolean;
  /** Translated files whose functions actually executed, from host-collected V8 coverage. */
  executedProductionFiles?: string[];
  /** Present only when the host parsed actual test-runner results. */
  tests?: { total: number; passed: number; failed: number; skipped: number };
}

export interface WorkspaceTestBug {
  summary: string;
  expected: string;
  actual: string;
  /** References to this attempt's host-owned command evidence. */
  commandIds: string[];
  testPaths: string[];
}

/** Untrusted agent claims; the host must compare them with command evidence. */
export interface WorkspaceTestReport {
  outcome: "passed" | "failed" | "inconclusive";
  summary: string;
  commandIds: string[];
  bugs: WorkspaceTestBug[];
}

export interface WorkspaceTestResult {
  id: string;
  translationRunId: string;
  status: "passed" | "failed" | "inconclusive" | "cancelled";
  summary: string;
  sourceSnapshot: string;
  suite?: WorkspaceTestSuite;
  report?: WorkspaceTestReport;
  reportConsistent: boolean;
  commands: WorkspaceTestCommandEvidence[];
  cleanup: "not-needed" | "retained" | "removed" | "conflict";
}

export interface WorkspaceTestFeedback {
  testRunId: string;
  attempt: number;
  summary: string;
  bugs: WorkspaceTestBug[];
  status: "pending" | "repairing" | "resolved" | "exhausted";
}

/** Trusted in-process handoff; workspaceRoot never comes from the test model. */
export interface WorkspaceTestInput {
  translationRunId: string;
  workspaceRoot: string;
  request: WorkspaceTranslationRequest;
  compilation: WorkspaceCompilation;
  /** Re-run these exact tests after a translator repair; do not regenerate them. */
  suite?: WorkspaceTestSuite;
}

export type WorkspaceTestVerifier = (
  input: WorkspaceTestInput,
  signal: AbortSignal,
) => Promise<WorkspaceTestResult>;

/** Retrieval evidence is immutable; workspaceFiles are read live by the agents. */
export interface WorkspaceTranslationContext {
  id: string;
  kind: "source" | "interface" | "call-chain" | "configuration" | "dependency" | "summary";
  content: string;
  path?: string;
  repository?: string;
  revision?: string;
}

/**
 * A read-only history revision this run may query on demand. The trusted host
 * derives these from the selected module scope; a page never supplies them.
 */
export interface WorkspaceEvidenceScope {
  repositoryId: string;
  analysisRevision: string;
  projectId?: string;
}

export interface WorkspaceTranslationRequest {
  spec: string;
  sourceLanguage: string;
  targetLanguage: string;
  context: WorkspaceTranslationContext[];
  /** Exact workspace-relative paths available for live reads. */
  workspaceFiles: string[];
  /** Exact workspace-relative files that this task may create or update. */
  writeFiles: string[];
  /**
   * Bounded history revisions the agent may query itself through the read-only
   * semantic index. Absent or empty means the on-demand evidence tool is not
   * offered at all.
   */
  evidenceScopes?: WorkspaceEvidenceScope[];
}

/** One on-demand evidence query, recorded so the run stays auditable. */
export interface WorkspaceEvidenceQuery {
  at: string;
  requirement: string;
  repositoryIds: string[];
  excerptCount: number;
  characters: number;
  error?: string;
}

export interface WorkspaceTranslationPlan {
  summary: string;
  mappings: Array<{ source: string; targetPath: string; targetSymbol: string }>;
  dependencies: Array<{ name: string; strategy: "reuse" | "replace" | "adapt" | "translate"; detail: string }>;
  steps: Array<{ id: string; description: string; files: string[]; dependsOn: string[] }>;
}

/** Owned by the backend configuration, never by the model or HTTP payload. */
export interface WorkspaceCompileCommand {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface WorkspaceCompilation {
  command: WorkspaceCompileCommand;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  success: boolean;
  output: string;
  diagnostics: string[];
}

export type WorkspaceTranslationStatus =
  | "analyzing" | "translating" | "compiling" | "testing" | "completed"
  | "failed" | "cancelled" | "interrupted" | "rolling-back" | "rolled-back";

export interface WorkspaceTranslationChange {
  path: string;
  before: string | null;
  after: string;
  /** Recorded before writing so an interrupted write can be recovered. */
  applied: boolean;
  /** Last disk content while an update is journaled but not yet acknowledged. */
  pendingBefore?: string | null;
  rolledBack?: boolean;
}

export interface WorkspaceTranslationRun {
  id: string;
  workspaceRoot: string;
  status: WorkspaceTranslationStatus;
  request: WorkspaceTranslationRequest;
  createdAt: string;
  updatedAt: string;
  plan?: WorkspaceTranslationPlan;
  completedSteps: string[];
  changes: WorkspaceTranslationChange[];
  compilations: WorkspaceCompilation[];
  /** Every on-demand history query this run performed, in order. */
  evidenceQueries?: WorkspaceEvidenceQuery[];
  modelTurns: number;
  /** Persist the acceptance requirement so restart cannot silently disable it. */
  testVerificationRequired?: boolean;
  /** Host-checked test attempts, retained across translator repairs. */
  testRuns?: WorkspaceTestResult[];
  /** Only the host creates feedback and controls the repair budget. */
  testFeedback?: WorkspaceTestFeedback[];
  error?: string;
  /** A passing fixed test suite is evidence, not a proof of all behaviors. */
  acceptance: "compilation-only" | "behavior-verified";
  verification?: {
    command: WorkspaceCompileCommand;
    criteria: Array<{ path: string; hash: string }>;
    runs: Array<WorkspaceCompilation & { sourceSnapshot: string; planHash: string; filesUnchanged: boolean }>;
  };
}
