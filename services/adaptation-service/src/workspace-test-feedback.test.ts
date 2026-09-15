import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createWorkspaceTestVerifier } from "@forexplore/translation-verifier/workspace-test-verifier";
import { WorkspaceTranslationRuntime } from "./workspace-translation-runtime.js";
import type { DeepSeekToolCompletion } from "./deepseek-client.js";
const roots: string[] = [],
  runtimes: WorkspaceTranslationRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const call = (name: string, args: unknown = {}): DeepSeekToolCompletion => ({
  content: "",
  toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }],
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const original = "export const limit=value=>value;\n",
  bad = "export const limit=value=>value+1;\n",
  good = "export const limit=value=>value+2;\n";
it.each([false, true])(
  "host routes evidenced bugs into a bounded repair and reuses the compiled worktree (exhaust=%s)",
  async (exhaust) => {
    const root = mkdtempSync(join(tmpdir(), "host-feedback-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "target.mjs"), original);
    writeFileSync(
      join(root, "compile.mjs"),
      "import {execFileSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; execFileSync(process.execPath,['--check','target.mjs']);writeFileSync('compiled.json',JSON.stringify({cwd:process.cwd()}));",
    );
    const testPath = ".forexplore-tests/limit.test.mjs";
    const suite = {
      files: [
        {
          path: testPath,
          content:
            "import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {limit} from '../target.mjs';test('compiled worktree',()=>assert.equal(JSON.parse(readFileSync('compiled.json')).cwd,process.cwd()));test('increment',()=>assert.equal(limit(1),3));",
        },
      ],
      command: {
        executable: "node",
        args: ["--test", "--test-reporter=tap", testPath],
      },
    };
    let generated = 0;
    const verifier = createWorkspaceTestVerifier({
      client: {
        async complete(messages) {
          const evidence = [...messages]
            .reverse()
            .find(
              (message) =>
                message.role === "tool" ||
                (message.role === "user" &&
                  message.content.includes("hostEvidence")),
            );
          if (!evidence) {
            generated++;
            return call("run_tests", suite);
          }
          const value = JSON.parse(evidence.content);
          const command = value.hostEvidence ?? value;
          const failed = command.tests.failed > 0;
          return call("submit_report", {
            outcome: failed ? "failed" : "passed",
            summary: failed ? "Wrong increment" : "Correct increment",
            commandIds: [command.id],
            bugs: failed
              ? [
                  {
                    summary: "Wrong increment",
                    expected: "3",
                    actual: "ERR_ASSERTION",
                    commandIds: [command.id],
                    testPaths: [testPath],
                  },
                ]
              : [],
          });
        },
      },
    });
    const plan = {
      summary: "Translate increment",
      mappings: [
        { source: "limit", targetPath: "target.mjs", targetSymbol: "limit" },
      ],
      dependencies: [],
      steps: [
        {
          id: "implement",
          description: "Implement limit",
          files: ["target.mjs"],
          dependsOn: [],
        },
      ],
    };
    const steps = [
      call("submit_plan", plan),
      call("read_file", { path: "target.mjs" }),
      call("write_file", {
        path: "target.mjs",
        expectedHash: hash(original),
        content: bad,
      }),
      call("complete_step", { stepId: "implement" }),
      call("compile"),
      call("finish"),
      call("read_file", { path: "target.mjs" }),
      call("write_file", {
        path: "target.mjs",
        expectedHash: hash(bad),
        content: exhaust ? bad : good,
      }),
      call("complete_step", { stepId: "implement" }),
      call("compile"),
      call("finish"),
    ];
    let turn = 0;
    const runtime = new WorkspaceTranslationRuntime({
      workspaceRoot: root,
      compileCommand: { executable: process.execPath, args: ["compile.mjs"] },
      testVerifier: verifier,
      maxTestRepairAttempts: 1,
      client: {
        async complete(messages) {
          if (turn === 6)
            expect(messages.at(-1)?.content).toContain("hostFeedback");
          const next = steps[turn++];
          if (!next) throw new Error("Unexpected model turn");
          return next;
        },
      },
    });
    runtimes.push(runtime);
    const start = runtime.start({
      spec: "Increment by two",
      sourceLanguage: "Python",
      targetLanguage: "JavaScript",
      workspaceFiles: ["target.mjs", "compile.mjs"],
      writeFiles: ["target.mjs"],
      context: [
        { id: "source", kind: "source", content: "def limit(x): return x+2" },
      ],
    });
    let result = runtime.get(start.id);
    for (
      let i = 0;
      i < 300 &&
      ["analyzing", "translating", "compiling", "testing"].includes(
        result.status,
      );
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = runtime.get(start.id);
    }
    expect(result.status, result.error).toBe(exhaust ? "failed" : "completed");
    expect(generated).toBe(1);
    expect(result.testRuns?.map((test) => test.status)).toEqual([
      "failed",
      exhaust ? "failed" : "passed",
    ]);
    expect(result.testRuns?.[1]?.suite).toEqual(result.testRuns?.[0]?.suite);
    expect(result.testFeedback?.at(-1)?.status).toBe(
      exhaust ? "exhausted" : "resolved",
    );
    expect(result.compilations).toHaveLength(2);
    if (!exhaust) {
      expect(result.acceptance).toBe("behavior-verified");
      expect(existsSync(join(root, testPath))).toBe(false);
      expect(result.testRuns?.at(-1)?.suite?.files.some(file => file.path === testPath)).toBe(true);
      runtime.rollback(start.id);
      expect(existsSync(join(root, testPath))).toBe(false);
      expect(readFileSync(join(root, "target.mjs"), "utf8")).toBe(original);
    }
  },
);
