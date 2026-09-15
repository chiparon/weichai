import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SingleAgentDifferentialStrategy } from "./strategy.js";
import type { SingleAgentModelClient } from "./agent.js";
import type { TestSubmission } from "./report.js";
import { SubmittedTestFiles } from "./test-files.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";
import { createVerificationArtifactStore } from "../../run-output/verification-artifact-store.js";
import { normalizeVerificationStrategyOutput } from "../../schemas/materialize-verification-result.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(delta = 0) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "single-agent-")));
  directories.push(root);
  const sourceRoot = join(root, "source"),
    targetRoot = join(root, "target"),
    strategyRoot = join(root, "artifacts");
  for (const path of [sourceRoot, targetRoot, strategyRoot]) mkdirSync(path);
  writeFileSync(
    join(sourceRoot, "implementation.cjs"),
    "throw new Error('Source must never execute');",
  );
  writeFileSync(
    join(targetRoot, "implementation.cjs"),
    `module.exports = x => x + ${delta};`,
  );
  const store = createVerificationArtifactStore({
    artifactRoot: join(root, "durable"),
    durablePrefix: "attempt",
    agentRoot: strategyRoot,
  });
  const context: VerificationStrategyContext = {
    workspace: {
      root,
      sourceRoot,
      targetRoot,
      strategyRoot,
      evidenceRoot: strategyRoot,
    },
    deadlineAt: Date.now() + 10_000,
    writeArtifact: store.writeArtifact,
  };
  const input: VerificationInput = {
    schemaVersion: "1.0",
    request: {
      sourceBundle: { files: [] },
      targetContext: { sourceFiles: [] },
      requirement: "Return the input unchanged",
    } as unknown as VerificationInput["request"],
    analysisReport: {},
    migrationPlan: {},
    translation: {
      round: 1,
      generatedContent: "",
      files: [],
      patchHash: "a".repeat(64),
    },
  };
  const submission: TestSubmission = {
    files: [
      {
        path: ".forexplore-tests/runner.cjs",
        content:
          "require('node:assert/strict').equal(require('../implementation.cjs')(-1), -1); console.log('one assertion passed');",
      },
    ],
    command: { executable: "node", args: [".forexplore-tests/runner.cjs"] },
  };
  const complete = vi.fn<SingleAgentModelClient["complete"]>(
    async (_messages, tools) => {
      expect(tools.map((tool) => tool.name)).not.toContain("run_command");
      expect(existsSync(join(targetRoot, submission.files[0]!.path))).toBe(
        false,
      );
      return {
        toolCalls: [
          {
            id: "submit-1",
            name: "submit_tests",
            arguments: JSON.stringify(submission),
          },
        ],
      };
    },
  );
  const client: SingleAgentModelClient = { complete };
  return {
    root,
    sourceRoot,
    targetRoot,
    context,
    input,
    submission,
    client,
    complete,
  };
}

describe("single-agent host-owned target tests", () => {
  it("writes and executes submitted tests only on target, retaining success and real evidence", async () => {
    const f = fixture();
    const events: Record<string, unknown>[] = [];
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
      onEvent: (event) => events.push(event),
    }).verify(f.input, f.context);
    expect(output).toMatchObject({
      executionStatus: "completed",
      mode: "target_only",
      sourceAssessment: "not_checked",
      targetAssessment: "no_bug_observed",
      problems: [],
    });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(
      readFileSync(join(f.targetRoot, f.submission.files[0]!.path), "utf8"),
    ).toBe(f.submission.files[0]!.content);
    expect(output.strategyReport).toMatchObject({
      cleanup: "retained_on_success",
      evidence: [
        {
          side: "target",
          exitCode: 0,
          stdout: "one assertion passed\n",
          completed: true,
        },
      ],
    });
    expect(events.map((event) => event.type)).toEqual([
      "model.started",
      "model.completed",
      "tool.started",
      "tool.completed",
    ]);
    expect(normalizeVerificationStrategyOutput(f.input, output)).toEqual(
      output,
    );
    expect(
      readFileSync(join(f.sourceRoot, "implementation.cjs"), "utf8"),
    ).toContain("Source must never execute");
  });
  it("keeps assertion failure evidence, rolls back new files, and never starts a repair session", async () => {
    const f = fixture(1);
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context);
    expect(output).toMatchObject({
      executionStatus: "failed",
      targetAssessment: "inconclusive",
    });
    expect(output.strategyReport).toMatchObject({
      cleanup: "rolled_back",
      evidence: [{ side: "target", exitCode: 1 }],
    });
    expect(JSON.stringify(output.strategyReport)).toContain("AssertionError");
    expect(existsSync(join(f.targetRoot, ".forexplore-tests"))).toBe(false);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(output.artifacts.map((artifact) => artifact.kind)).toContain(
      "single-agent-submission",
    );
    expect(normalizeVerificationStrategyOutput(f.input, output)).toEqual(
      output,
    );
  });
  it("rejects an unsupported command before publishing files", async () => {
    const f = fixture();
    f.submission.command = { executable: "bash", args: ["-c", "exit 0"] };
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(output.strategyReport).toMatchObject({
      evidence: [],
      cleanup: "rolled_back",
    });
    expect(existsSync(join(f.targetRoot, ".forexplore-tests"))).toBe(false);
  });
  it("enforces configured directories", async () => {
    const f = fixture();
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
      writeDirectories: ["tests"],
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(output.problems[0]?.message).toContain(
      "outside configured directories",
    );
    expect(existsSync(join(f.targetRoot, ".forexplore-tests"))).toBe(false);
  });
  it("preflights every file and never overwrites an existing test", async () => {
    const f = fixture();
    mkdirSync(join(f.targetRoot, "tests"));
    writeFileSync(join(f.targetRoot, "tests/existing.cjs"), "existing test");
    f.submission.files.push({
      path: "tests/existing.cjs",
      content: "replacement",
    });
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(readFileSync(join(f.targetRoot, "tests/existing.cjs"), "utf8")).toBe(
      "existing test",
    );
    expect(existsSync(join(f.targetRoot, ".forexplore-tests"))).toBe(false);
  });
  it("rejects symlinked test directories even when baseline scanning excludes them", async () => {
    const f = fixture();
    symlinkSync(f.sourceRoot, join(f.targetRoot, ".forexplore-tests"), "dir");
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(existsSync(join(f.sourceRoot, "runner.cjs"))).toBe(false);
  });
  it("does not delete tests changed during command execution", async () => {
    const f = fixture();
    f.submission.files[0]!.content =
      "require('node:fs').writeFileSync(__filename, 'externally changed'); process.exitCode = 1;";
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(output.strategyReport).toMatchObject({ cleanup: "failed" });
    expect(
      readFileSync(join(f.targetRoot, f.submission.files[0]!.path), "utf8"),
    ).toBe("externally changed");
    expect(
      output.problems.some(
        (problem) => problem.code === "workspace_integrity_violation",
      ),
    ).toBe(true);
  });
  it("catches production writes without resetting the project", async () => {
    const f = fixture();
    f.submission.files[0]!.content =
      "require('node:fs').writeFileSync('implementation.cjs', 'changed');";
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context);
    expect(output.problems[0]?.code).toBe("workspace_integrity_violation");
    expect(output.strategyReport).toMatchObject({ cleanup: "rolled_back" });
    expect(readFileSync(join(f.targetRoot, "implementation.cjs"), "utf8")).toBe(
      "changed",
    );
  });
  it("cleans up after a target command deadline and records its termination", async () => {
    const f = fixture();
    f.submission.files[0]!.content = "setInterval(() => {}, 1000);";
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
      timeoutMs: 400,
    }).verify(f.input, f.context);
    expect(output.executionStatus).toBe("failed");
    expect(output.problems[0]?.code).toBe("command_timeout");
    expect(output.strategyReport).toMatchObject({
      cleanup: "rolled_back",
      evidence: [{ completed: true, exitCode: null }],
    });
    expect(existsSync(join(f.targetRoot, ".forexplore-tests"))).toBe(false);
  });
  it("respects caller cancellation before contacting a model or writing files", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const output = await new SingleAgentDifferentialStrategy({
      client: f.client,
    }).verify(f.input, f.context, controller.signal);
    expect(output.executionStatus).toBe("cancelled");
    expect(f.complete).not.toHaveBeenCalled();
  });
  it("reports missing credentials without trying a CLI fallback", async () => {
    const f = fixture();
    const output = await new SingleAgentDifferentialStrategy({
      apiKey: "",
    }).verify(f.input, f.context);
    expect(output.problems[0]?.code).toBe("environment_unavailable");
    expect(output.strategyReport).toMatchObject({ evidence: [] });
  });
  it("rolls back files published before a later file creation fails", () => {
    const f = fixture();
    const files = new SubmittedTestFiles(f.targetRoot, ["tests"]);
    expect(() =>
      files.apply([
        { path: "tests/a", content: "created" },
        { path: "tests/a/b", content: "cannot create under file" },
      ]),
    ).toThrow();
    files.rollback();
    expect(existsSync(join(f.targetRoot, "tests"))).toBe(false);
  });
});
