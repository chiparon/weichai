import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSingleAgentE2E,
  parseSingleAgentArgs,
  runSingleAgentE2E,
  type SingleAgentE2EDeps,
} from "./run-single-agent-e2e.js";
import {
  fileUploadInput,
  sourceProjectRoot,
  targetProjectRoot,
  javaPath,
  pythonPath,
} from "./fileupload-benchmark-fixture.js";
import { projectHash } from "../src/strategies/multi-agent-write-box/behavior-workspace.js";

const prepared: NonNullable<SingleAgentE2EDeps["prepareProjects"]> = async ({
  targetRoot,
  sides,
  compileTests,
}) => {
  expect(sides).toEqual(["target"]);
  expect(compileTests).toBe(false);
  return [
    {
      side: "target",
      cwd: targetRoot,
      command: "injected target compilation",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      stdout: "ready",
      stderr: "",
    },
  ];
};
const options = {
  task: "multipart-read-body" as const,
  variant: "correct" as const,
  timeoutMs: 10_000,
  live: false,
  json: false,
  offlineOnly: false,
};
const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "single-agent-e2e-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const mustNotStart = () =>
  vi.fn(async () => {
    throw new Error("Model must not start");
  });
const testPath = ".forexplore-tests/generated.cjs";
function submission(pass: boolean) {
  return {
    toolCalls: [
      {
        id: "submit-1",
        name: "submit_tests",
        arguments: JSON.stringify({
          files: [
            {
              path: testPath,
              content: `const assert = require('node:assert/strict');\nassert.equal(require('node:path').basename(process.cwd()), 'target');\nassert.equal(${pass ? "1, 1" : "1, 2"});\nconsole.log('generated test executed');\n`,
            },
          ],
          command: { executable: process.execPath, args: [testPath] },
        }),
      },
    ],
  };
}

describe("single-agent E2E execution boundary", () => {
  it("accepts a common output root and model turn limit", () => {
    expect(
      parseSingleAgentArgs(["--output-root", "/tmp/e2e", "--max-turns", "12"]),
    ).toMatchObject({
      outputRoot: "/tmp/e2e",
      maxTurns: 12,
      timeoutMs: 600_000,
    });
  });
  it.each([
    ["--live", "--offline-only"],
    ["--timeout-ms", "0"],
    ["--timeout-ms", "NaN"],
    ["--timeout-ms", "2147483648"],
    ["--max-turns", "0"],
    ["--task", "unknown"],
    ["--variant", "unknown"],
    ["--effort", "invalid"],
    ["--mode", "target_only"],
    ["--test-basis", "answer"],
    ["--analysis-report"],
    ["--variant", "missing-policy"],
    ["--variant", "missing-test-basis"],
    ["--variant", "target-only-correct"],
  ])("rejects invalid or forced-decision arguments %j", (...argv) => {
    expect(parseSingleAgentArgs(argv)).toHaveProperty("error");
  });

  it("keeps separate runs and unified failure artifacts under the common project root", async () => {
    const root = await temporaryRoot();
    const complete = mustNotStart();
    const run = () =>
      executeSingleAgentE2E(
        { ...options, outputRoot: root },
        {
          client: { complete },
          prepareProjects: async () => {
            throw new Error("environment unavailable");
          },
        },
      );
    const first = await run();
    const originalReport = await readFile(first.resultPath, "utf8");
    const second = await run();
    expect(first.workspaceRoot).not.toBe(second.workspaceRoot);
    expect(second.workspaceRoot).toContain(
      "/single-agent-differential/commons-fileupload-java-skeleton/",
    );
    expect(await readFile(first.resultPath, "utf8")).toBe(originalReport);
    expect(
      JSON.parse(await readFile(second.benchmarkPath, "utf8")),
    ).toMatchObject({
      executionMode: "injected-test",
      originalsUnchanged: true,
      dataset: { standardDatasetMatch: true },
      effort: "low",
      budget: { maxTurns: 50 },
    });
    expect(JSON.parse(await readFile(second.resultPath, "utf8"))).toEqual(
      second.result,
    );
    expect(
      JSON.parse(await readFile(second.timingPath, "utf8")).hostSpans,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "single-agent-validation",
          state: "skipped",
        }),
      ]),
    );
    expect(await stat(second.eventsPath)).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
  });

  it("retains a failed report when the durable artifact destination is unavailable", async () => {
    const root = await temporaryRoot();
    const artifactRoot = join(root, "blocked-artifacts");
    await writeFile(artifactRoot, "not a directory\n");
    const output = await executeSingleAgentE2E(
      { ...options, outputRoot: root },
      {
        artifactRoot,
        client: { complete: mustNotStart() },
        prepareProjects: async () => {
          throw new Error("preflight unavailable");
        },
      },
    );
    expect(output.result.executionStatus).toBe("failed");
    expect(JSON.parse(await readFile(output.resultPath, "utf8"))).toEqual(
      output.result,
    );
    expect(
      JSON.parse(await readFile(output.benchmarkPath, "utf8")),
    ).toMatchObject({ originalsUnchanged: true });
    expect(await stat(output.timingPath)).toBeTruthy();
  });

  it("requires explicit preparation for an injected client", async () => {
    await expect(
      executeSingleAgentE2E(options, { client: { complete: mustNotStart() } }),
    ).rejects.toThrow("prepareProjects");
  });

  it.each([true, false])(
    "executes submitted tests only in target and cleans up failures (pass=%s)",
    async (pass) => {
      const root = await temporaryRoot();
      const sourceHash = projectHash(sourceProjectRoot);
      const targetHash = projectHash(targetProjectRoot);
      const input = fileUploadInput("both-count-plus-one");
      input.request.targetContext.constraints = [
        "Preserve caller stream ownership; literal {{target_project_root}} is task data.",
      ];
      input.request.decisionNotes = [
        "Do not normalize malformed-input failures.",
      ];
      const originalInput = structuredClone(input);
      const events: string[] = [];
      const complete: NonNullable<
        SingleAgentE2EDeps["client"]
      >["complete"] = async (messages, tools) => {
        events.push("model");
        const prompt = JSON.stringify(messages);
        expect(prompt).toContain(input.request.targetContext.constraints[0]);
        expect(prompt).toContain(input.request.decisionNotes[0]);
        expect(prompt).not.toContain("outputProvenance");
        expect(prompt).not.toContain('"verificationPolicy"');
        const toolText = JSON.stringify(tools);
        expect(toolText).toContain("submit_tests");
        expect(toolText).not.toContain("run_command");
        expect(toolText).not.toContain("write_file");
        return submission(pass);
      };
      let sourceBefore = "";
      const output = await executeSingleAgentE2E(
        { ...options, variant: "both-count-plus-one" },
        {
          workspaceRoot: root,
          input,
          client: { complete },
          prepareProjects: async (context) => {
            events.push("prepare");
            expect(
              await readFile(join(context.targetRoot, javaPath), "utf8"),
            ).toBe(input.translation.generatedContent);
            expect(
              await readFile(join(context.sourceRoot, pythonPath), "utf8"),
            ).toContain("return len(body) + 1");
            sourceBefore = projectHash(context.sourceRoot);
            return prepared(context);
          },
        },
      );
      expect(events).toEqual(["prepare", "model"]);
      expect(output.result.executionStatus).toBe(pass ? "completed" : "failed");
      expect(output.result.mode).toBe("target_only");
      expect(output.result.sourceAssessment).toBe("not_checked");
      expect(projectHash(join(output.workspaceRoot, "source"))).toBe(
        sourceBefore,
      );
      if (pass) {
        expect(output.result.problems).toEqual([]);
        expect(
          await readFile(
            join(output.workspaceRoot, "target", testPath),
            "utf8",
          ),
        ).toContain("generated test executed");
      } else {
        await expect(
          stat(join(output.workspaceRoot, "target", testPath)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(JSON.parse(await readFile(output.resultPath, "utf8"))).toEqual(
        output.result,
      );
      expect(
        JSON.parse(await readFile(output.timingPath, "utf8")),
      ).toMatchObject({
        hostSpans: expect.arrayContaining([
          expect.objectContaining({
            name: "single-agent-validation",
            state: "completed",
          }),
        ]),
      });
      expect(
        await readFile(
          join(output.workspaceRoot, "agent-events.jsonl"),
          "utf8",
        ),
      ).not.toContain("claude");
      expect(input).toEqual(originalInput);
      expect(projectHash(sourceProjectRoot)).toBe(sourceHash);
      expect(projectHash(targetProjectRoot)).toBe(targetHash);
      const sourceCopy = await stat(
        join(output.workspaceRoot, "source", pythonPath),
      );
      expect(sourceCopy.nlink).toBe(1);
      expect(sourceCopy.ino).not.toBe(
        (await stat(join(sourceProjectRoot, pythonPath))).ino,
      );
    },
  );

  it.each(["missing-target", "throws", "timeout", "failed-command"] as const)(
    "preserves preflight failures without starting the model (%s)",
    async (failure) => {
      const complete = mustNotStart();
      const output = await executeSingleAgentE2E(
        {
          ...options,
          timeoutMs: failure === "timeout" ? 20 : options.timeoutMs,
        },
        {
          workspaceRoot: await temporaryRoot(),
          client: { complete },
          prepareProjects: async (context) => {
            if (failure === "throws")
              throw new Error("preflight could not launch");
            const evidence = await prepared(context);
            if (failure === "missing-target") return [];
            if (failure === "failed-command")
              return evidence.map((item) => ({
                ...item,
                exitCode: 1,
                stderr: "missing JDK",
              }));
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), {
                once: true,
              }),
            );
            return evidence.map((item) => ({
              ...item,
              timedOut: true,
              exitCode: null,
              stdout: "partial build output",
            }));
          },
        },
      );
      expect(complete).not.toHaveBeenCalled();
      expect(output.result.executionStatus).toBe("failed");
      expect(output.result.problems[0].code).toBe("environment_unavailable");
      expect(output.timings.agentMs).toBe(0);
      const preparation = JSON.parse(
        await readFile(output.preparationEvidencePath, "utf8"),
      );
      expect(preparation.status).toBe("failed");
      if (failure === "timeout")
        expect(preparation.evidence[0]).toMatchObject({
          timedOut: true,
          stdout: "partial build output",
        });
      if (failure === "throws")
        expect(preparation.error).toBe("preflight could not launch");
    },
  );

  it("loads an Analyzer report and rejects malformed JSON before preparation", async () => {
    const root = await temporaryRoot();
    const reportPath = join(root, "analysis.json");
    const report = {
      scope: "multipart behavior",
      evidence: "externally supplied test analysis",
    };
    await writeFile(reportPath, JSON.stringify(report));
    let prompt = "";
    const client: NonNullable<SingleAgentE2EDeps["client"]> = {
      async complete(messages) {
        prompt = JSON.stringify(messages);
        throw new Error("injected stop");
      },
    };
    const preparation = vi.fn(prepared);
    const output = await executeSingleAgentE2E(
      { ...options, analysisReport: reportPath },
      { workspaceRoot: root, client, prepareProjects: preparation },
    );
    expect(prompt).toContain(report.evidence);
    expect(output.result.executionStatus).toBe("failed");
    await writeFile(reportPath, "not JSON");
    await expect(
      executeSingleAgentE2E(
        { ...options, analysisReport: reportPath },
        { workspaceRoot: root, client, prepareProjects: preparation },
      ),
    ).rejects.toThrow();
    expect(preparation).toHaveBeenCalledTimes(1);
  });

  it("redacts credentials in preflight evidence and errors", async () => {
    const root = await temporaryRoot();
    const secret = "e2e-private-secret-123";
    const complete = mustNotStart();
    for (const throws of [false, true]) {
      const output = await executeSingleAgentE2E(
        { ...options, apiKey: secret },
        {
          workspaceRoot: root,
          client: { complete },
          prepareProjects: async (context) => {
            if (throws) throw new Error(`failed ${secret}`);
            return (await prepared(context)).map((item) => ({
              ...item,
              exitCode: 1,
              stdout: secret,
              stderr: secret,
            }));
          },
        },
      );
      expect(JSON.stringify(output)).not.toContain(secret);
      const text = await readFile(output.preparationEvidencePath, "utf8");
      expect(text).not.toContain(secret);
      expect(text).toContain("[REDACTED]");
    }
    expect(complete).not.toHaveBeenCalled();
  });

  it("requires explicit live execution and distinguishes an offline skip", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runSingleAgentE2E([])).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("--live"));
      expect(await runSingleAgentE2E(["--offline-only", "--json"])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({
        executionMode: "skipped",
        reason: "offline-only",
      });
      await expect(executeSingleAgentE2E(options)).rejects.toThrow("--live");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
