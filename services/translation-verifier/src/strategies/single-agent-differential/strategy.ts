import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  VerificationArtifact,
  VerificationInput,
  VerificationProblem,
  VerificationStrategy,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
} from "../../schemas/verification-types.js";
import { parseBehaviorJson } from "../multi-agent-write-box/behavior-schema.js";
import type {
  BehaviorCommandRecord,
  BehaviorSide,
} from "../multi-agent-write-box/behavior-types.js";
import {
  assertDeclaredSnapshot,
  assertProjectRoots,
  assertProjectBaseline,
  captureProjectBaseline,
  persistBehaviorArtifact,
} from "../multi-agent-write-box/behavior-workspace.js";
import {
  buildEnvironment,
  protectedSecrets,
  redact,
  resolveBehaviorCommand,
  runBehaviorCommand,
  type BehaviorCommandControl,
} from "../multi-agent-write-box/behavior-command.js";
import {
  createSingleAgentModelClient,
  generateTests,
  SingleAgentBlockerError,
  type SingleAgentModelClient,
} from "./agent.js";
import { buildSingleAgentPrompt, singleAgentSystemPrompt } from "./prompt.js";
import { parseTestSubmission, type TestSubmission } from "./report.js";
import {
  defaultWriteDirectories,
  SubmittedTestFiles,
  validateWriteDirectories,
} from "./test-files.js";

export const SINGLE_AGENT_DIFFERENTIAL_STRATEGY: VerificationStrategyDescriptor =
  {
    id: "single-agent-differential",
    version: "2.0.0",
    displayName: "Single-Agent Target Tests",
  };
export interface SingleAgentDifferentialOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  /** Retained for callers sharing model options; this direct client uses non-thinking tool calls. */
  effort?: string;
  client?: SingleAgentModelClient;
  /** Existing project test directories; only new files may be published. */
  writeDirectories?: string[];
  onEvent?: (event: Record<string, unknown>) => void;
  /** Target must be authorized. Source is read-only regardless of this list. */
  executionSides?: BehaviorSide[];
}
class SingleAgentFailure extends Error {
  constructor(
    readonly code: VerificationProblem["code"],
    message: string,
  ) {
    super(message);
  }
}
const limitations = [
  "One agent authors test assertions from task and project context. Passing generated tests does not prove coverage or business correctness.",
  "Only the target test command executes. Source files are read-only context; no source behavior is certified.",
  "Command success is based on its exit status; this first version does not independently count tests across all frameworks.",
  "Baseline checks are workflow controls, not OS isolation. Build caches and command-created outputs are not rolled back with submitted test files.",
];

export class SingleAgentDifferentialStrategy implements VerificationStrategy {
  constructor(private readonly options: SingleAgentDifferentialOptions = {}) {}

  async verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput> {
    const timeoutMs = this.options.timeoutMs ?? 300_000;
    const deadlineAt = Math.min(context.deadlineAt, Date.now() + timeoutMs);
    const budgetValid =
      Number.isFinite(timeoutMs) &&
      timeoutMs > 0 &&
      Number.isFinite(deadlineAt);
    const timeout = AbortSignal.timeout(
      budgetValid
        ? Math.max(0, Math.min(2147483647, Math.floor(deadlineAt - Date.now())))
        : 0,
    );
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const secrets = protectedSecrets(
      this.options.apiKey ?? process.env.DEEPSEEK_API_KEY,
    );
    const artifacts: VerificationArtifact[] = [];
    const events: Record<string, unknown>[] = [];
    const problems: VerificationProblem[] = [];
    let stage = "preparation";
    let submission: TestSubmission | undefined;
    let files: SubmittedTestFiles | undefined;
    let evidence: BehaviorCommandRecord[] = [];
    let commandEvidencePath: string | undefined;
    let passed = false;
    let cleanup = "not_needed";
    let checkIntegrity = () => {};
    const recordArtifact = async (id: string, value: unknown) => {
      const artifact = await persistBehaviorArtifact(
        context,
        id,
        parseBehaviorJson(
          redact(JSON.stringify(value), secrets),
          10 * 1024 * 1024,
          24,
        ),
      );
      artifacts.push(artifact);
      return artifact;
    };
    const onEvent = (event: Record<string, unknown>) => {
      const safe = parseBehaviorJson(
        redact(JSON.stringify(event), secrets),
      ) as Record<string, unknown>;
      if (events.length < 2000) events.push(safe);
      this.options.onEvent?.(safe);
    };
    const measured = async <T>(
      name: string,
      work: () => Promise<T>,
    ): Promise<T> =>
      context.measureStep ? context.measureStep(name, work) : work();
    try {
      if (!budgetValid)
        throw new SingleAgentFailure(
          "context_incomplete",
          "Invalid single-agent deadline.",
        );
      combined.throwIfAborted();
      const executionSides = this.options.executionSides ?? ["target"];
      if (
        !executionSides.includes("target") ||
        executionSides.some((side) => !["source", "target"].includes(side))
      ) {
        throw new SingleAgentFailure(
          "context_incomplete",
          "Target execution is not authorized.",
        );
      }
      const writeDirectories =
        this.options.writeDirectories ?? defaultWriteDirectories;
      validateWriteDirectories(writeDirectories);
      assertProjectRoots(context);
      const { sourceRoot, targetRoot, strategyRoot } = context.workspace;
      const baselines = [
        captureProjectBaseline(sourceRoot),
        captureProjectBaseline(targetRoot),
      ];
      checkIntegrity = () => {
        for (const baseline of baselines) assertProjectBaseline(baseline);
      };
      assertDeclaredSnapshot(input, sourceRoot, "source");
      assertDeclaredSnapshot(input, targetRoot, "target");
      files = new SubmittedTestFiles(targetRoot, writeDirectories);
      stage = "generation";
      await recordArtifact("single-agent-prompt", {
        system: singleAgentSystemPrompt,
        prompt: buildSingleAgentPrompt(input, {
          ...context.workspace,
          writeDirectories,
        }),
      });
      submission = parseTestSubmission(
        await measured("single-agent-session", () =>
          generateTests({
            input,
            workspace: context.workspace,
            writeDirectories,
            client:
              this.options.client ??
              createSingleAgentModelClient({
                ...this.options,
                apiKey:
                  this.options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
              }),
            maxTurns: this.options.maxTurns ?? 50,
            signal: combined,
            onEvent,
          }),
        ),
      );
      combined.throwIfAborted();
      checkIntegrity();
      if (
        redact(JSON.stringify(submission), secrets) !==
        JSON.stringify(submission)
      ) {
        throw new SingleAgentFailure(
          "report_evidence_invalid",
          "Submitted tests contain protected credential material.",
        );
      }
      await recordArtifact("single-agent-submission", submission);
      commandEvidencePath = join(
        strategyRoot,
        `single-agent-commands-${randomUUID()}.jsonl`,
      );
      const control: BehaviorCommandControl = {
        scope: {
          cwd: realpathSync(targetRoot),
          readRoots: [sourceRoot, targetRoot],
          writeRoots: [targetRoot],
          baseline: baselines[1],
        },
        baselines,
        frozenFiles: {},
        deadlineAt,
        env: buildEnvironment(),
        secrets,
        side: "target",
        evidencePath: commandEvidencePath,
      };
      // Reject an unavailable/unsupported executable before publishing any test files.
      stage = "writing";
      resolveBehaviorCommand(submission.command, control);
      combined.throwIfAborted();
      files.apply(submission.files);
      stage = "execution";
      const result = await measured("single-agent-target-tests", () =>
        runBehaviorCommand(submission!.command, control, combined),
      );
      combined.throwIfAborted();
      files.assertUnchanged();
      checkIntegrity();
      if (result.timedOut)
        throw new SingleAgentFailure(
          "command_timeout",
          "Target test command timed out.",
        );
      if (result.exitCode !== 0) {
        throw new SingleAgentFailure(
          "report_evidence_invalid",
          `Target test command did not pass (exit code ${result.exitCode}); inspect host command output.`,
        );
      }
      passed = true;
      cleanup = "retained_on_success";
      stage = "completed";
    } catch (cause) {
      let code: VerificationProblem["code"] =
        cause instanceof SingleAgentFailure
          ? cause.code
          : signal?.aborted
            ? "cancelled"
            : combined.aborted
              ? stage === "execution"
                ? "command_timeout"
                : "agent_timeout"
              : stage === "preparation"
                ? "context_incomplete"
                : /unavailable|API key|API_KEY/.test(String(cause))
                  ? "environment_unavailable"
                  : cause instanceof SingleAgentBlockerError
                    ? "context_incomplete"
                    : stage === "generation"
                      ? "agent_error"
                      : "report_evidence_invalid";
      try {
        checkIntegrity();
      } catch (integrity) {
        code = "workspace_integrity_violation";
        cause = integrity;
      }
      problems.push({
        code,
        message: redact(
          cause instanceof Error ? cause.message : String(cause),
          secrets,
        ),
      });
    } finally {
      if (!passed && files) {
        try {
          files.rollback();
          cleanup = "rolled_back";
        } catch (error) {
          cleanup = "failed";
          problems.push({
            code: "workspace_integrity_violation",
            message: redact(`Test cleanup failed: ${String(error)}`, secrets),
          });
        }
      }
      if (commandEvidencePath && existsSync(commandEvidencePath)) {
        try {
          if (statSync(commandEvidencePath).size > 8 * 1024 * 1024)
            throw new Error("Command evidence exceeds budget.");
          const rows = readFileSync(commandEvidencePath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as BehaviorCommandRecord);
          evidence = [
            ...new Map(rows.map((row) => [row.commandId, row])).values(),
          ];
        } catch (error) {
          passed = false;
          problems.push({
            code: "report_evidence_invalid",
            message: `Unable to read host command evidence: ${String(error)}`,
          });
        }
      }
    }
    // Command evidence comes from the host runner, never from model output.
    if (
      passed &&
      (evidence.length !== 1 ||
        evidence[0]?.completed === false ||
        evidence[0]?.exitCode !== 0 ||
        !evidence[0]?.baselineValid ||
        evidence[0]?.credentialHit)
    ) {
      passed = false;
      problems.push({
        code: "report_evidence_invalid",
        message: "Missing successful host command evidence.",
      });
    }
    if (!passed && cleanup === "retained_on_success" && files) {
      try {
        files.rollback();
        cleanup = "rolled_back";
      } catch (error) {
        cleanup = "failed";
        problems.push({
          code: "workspace_integrity_violation",
          message: String(error),
        });
      }
    }
    await recordArtifact("single-agent-session", { events });
    const report = parseBehaviorJson(
      redact(
        JSON.stringify({
          schemaVersion: "2.0",
          stage,
          submission: submission ?? null,
          evidence,
          cleanup,
          limitations,
        }),
        secrets,
      ),
      10 * 1024 * 1024,
      24,
    );
    const reportArtifact = await recordArtifact("single-agent-report", report);
    return {
      mode: "target_only",
      referenceDecision: "undetermined",
      referenceReason:
        "Source is read-only context; this version executes generated tests on the target only.",
      executionStatus: passed
        ? "completed"
        : problems.some((problem) => problem.code === "cancelled")
          ? "cancelled"
          : "failed",
      sourceAssessment: "not_checked",
      targetAssessment: passed ? "no_bug_observed" : "inconclusive",
      problems,
      summary: passed
        ? "Host target test command passed. Generated tests retained; source was not executed."
        : `${stage}: target verification did not complete; test cleanup ${cleanup}.`,
      artifacts,
      strategyReport: report,
      issues: problems.map((problem, index) => ({
        id: `single-agent-problem-${index}`,
        kind: problem.code,
        message: problem.message,
        evidenceArtifactIds: [reportArtifact.id],
      })),
    };
  }
}
export function createSingleAgentDifferentialProvider(
  options: SingleAgentDifferentialOptions = {},
): VerificationStrategyProvider {
  return {
    descriptor: SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
    workspaceRequirements: () => ({ source: true }),
    create: () => new SingleAgentDifferentialStrategy(options),
  };
}
