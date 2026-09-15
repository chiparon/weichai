import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FilePatch } from "@forexplore/contracts";
import type { AdaptationRequestV2 } from "./schemas/legacy-input.js";
import { calculatePatchHashV2 } from "./schemas/legacy-input.js";
import { createDefaultVerificationService } from "./create-default-verifier.js";
import { assertVerificationReceipt } from "./schemas/validate-verification-receipt.js";
import type { VerificationInput } from "./schemas/verification-types.js";
import { SINGLE_AGENT_DIFFERENTIAL_STRATEGY } from "./strategies/single-agent-differential/strategy.js";
import { MULTI_AGENT_DIFFERENTIAL_STRATEGY } from "./strategies/multi-agent-write-box/strategy.js";
import { BehaviorEnvironmentError } from "./strategies/multi-agent-write-box/claude-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function input(): VerificationInput {
  const content = "module.exports = value => value;";
  const files: FilePatch[] = [
    {
      path: "implementation.cjs",
      status: "created",
      expectedAbsent: true,
      additions: 1,
      deletions: 0,
      hunks: [{ header: "@@ -0,0 +1,1 @@", lines: [{ type: "add", content }] }],
    },
  ];
  return {
    schemaVersion: "1.0",
    request: {
      requirement: "Return the input unchanged.",
      sourceBundle: { files: [] },
      targetContext: { sourceFiles: [] },
    } as unknown as AdaptationRequestV2,
    analysisReport: { applicability: { level: "reject" } },
    migrationPlan: {},
    translation: {
      round: 1,
      generatedContent: content,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

describe("default service strategy integration", () => {
  it.each(["reference", "reject"])(
    "starts only Agent2 for %s with a caller-prepared target and no source project",
    async (level) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "verifier-target-only-")),
      );
      roots.push(root);
      const targetRoot = join(root, "prepared-target");
      mkdirSync(targetRoot);
      const request = input();
      request.analysisReport = { applicability: { level } };
      const content = request.translation.generatedContent;
      writeFileSync(join(targetRoot, "implementation.cjs"), content);
      const sessions: string[] = [];
      const service = createDefaultVerificationService({
        workspaceRoot: join(root, "workspaces"),
        artifactRoot: join(root, "artifacts"),
        multiAgent: {
          executionSides: ["target"],
          runtime: {
            async runAgent(task) {
              sessions.push(task.side);
              expect(task.sandbox.cwd).toBe(targetRoot);
              expect(task.sandbox.readRoots).toEqual([targetRoot]);
              expect(task.additionalProjects).toBeUndefined();
              expect(task.executionSides).toEqual(["target"]);
              expect(task.prompt).not.toContain("<source-collection-context>");
              throw new BehaviorEnvironmentError(
                "Test Agent environment unavailable",
              );
            },
            async runCommand() {
              throw new Error("No test was authored");
            },
          },
        },
      });
      const receipt = await service.verifyTranslationWithReceipt(request, {
        strategyId: MULTI_AGENT_DIFFERENTIAL_STRATEGY.id,
        preparedProjects: { targetRoot },
      });
      expect(sessions).toEqual(["target"]);
      expect(receipt.result).toMatchObject({
        strategyId: MULTI_AGENT_DIFFERENTIAL_STRATEGY.id,
        subjectHash: request.translation.patchHash,
        mode: "target_only",
        sourceAssessment: "not_checked",
        executionStatus: "failed",
        targetAssessment: "inconclusive",
      });
      expect(() =>
        assertVerificationReceipt(
          receipt,
          request,
          MULTI_AGENT_DIFFERENTIAL_STRATEGY,
        ),
      ).not.toThrow();
      expect(readFileSync(join(targetRoot, "implementation.cjs"), "utf8")).toBe(
        content,
      );
    },
  );

  it("defaults to the direct model client and persists a bound failure when it supplies no tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "verifier-registration-"));
    roots.push(root);
    const sessions: string[] = [];
    const service = createDefaultVerificationService({
      workspaceRoot: join(root, "workspaces"),
      artifactRoot: join(root, "artifacts"),
      singleAgent: {
        maxTurns: 1,
        client: {
          async complete(messages, tools) {
            sessions.push(messages[0]!.role);
            expect(tools.map((tool) => tool.name)).toContain("submit_tests");
            expect(tools.map((tool) => tool.name)).not.toContain("run_command");
            return { content: "No tests supplied" };
          },
        },
      },
    });
    const request = input();
    const receipt = await service.verifyWithReceipt(request);
    expect(sessions).toEqual(["system"]);
    expect(receipt.result).toMatchObject({
      strategyId: SINGLE_AGENT_DIFFERENTIAL_STRATEGY.id,
      subjectHash: request.translation.patchHash,
      executionStatus: "failed",
      targetAssessment: "inconclusive",
      problems: [{ code: "agent_error" }],
    });
    expect(receipt.resultArtifact).toBeDefined();
    expect(() =>
      assertVerificationReceipt(
        receipt,
        request,
        SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
      ),
    ).not.toThrow();
  });
});
