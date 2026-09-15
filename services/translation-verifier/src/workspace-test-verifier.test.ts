import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type {
  WorkspaceTestInput,
  WorkspaceTestSuite,
  WorkspaceTestCommandEvidence,
} from "@forexplore/contracts";
import type {
  SingleAgentModelClient,
  Message,
} from "./strategies/single-agent-differential/agent.js";
import {
  createWorkspaceTestVerifier,
  parseNodeTestCounts,
} from "./workspace-test-verifier.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const call = (name: string, args: unknown) => ({
  toolCalls: [{ id: name, name, arguments: JSON.stringify(args) }],
});
export function reportingClient(
  suite: WorkspaceTestSuite,
  lie = false,
): SingleAgentModelClient {
  return {
    async complete(messages: readonly Message[]) {
      const evidenceMessage = [...messages]
        .reverse()
        .find(
          (message) =>
            message.role === "tool" ||
            (message.role === "user" &&
              message.content.includes("hostEvidence")),
        );
      if (!evidenceMessage) return call("run_tests", suite);
      const parsed = JSON.parse(evidenceMessage.content);
      const command: WorkspaceTestCommandEvidence =
        parsed.hostEvidence ?? parsed;
      if (!command.id) return call("report_blocker", { reason: parsed.error });
      const failed =
        (command.tests?.failed ?? 0) > 0 &&
        command.stdout.includes("ERR_ASSERTION");
      const outcome = lie
        ? "passed"
        : failed
          ? "failed"
          : command.tests?.passed && command.exitCode === 0
            ? "passed"
            : "inconclusive";
      return call("submit_report", {
        outcome,
        summary: `Observed ${outcome}`,
        commandIds: [command.id],
        bugs:
          !lie && failed
            ? [
                {
                  summary: "Wrong translated result",
                  expected: "limit(1) equals 3",
                  actual: "ERR_ASSERTION",
                  commandIds: [command.id],
                  testPaths: [suite.files[0]!.path],
                },
              ]
            : [],
      });
    },
  };
}
const suite: WorkspaceTestSuite = {
  files: [
    {
      path: ".forexplore-tests/limit.test.mjs",
      content: `import test from 'node:test'; import assert from 'node:assert/strict'; import {limit} from '../target.mjs'; test('increments by two',()=>assert.equal(limit(1),3));\n`,
    },
  ],
  command: {
    executable: "node",
    args: ["--test", "--test-reporter=tap", ".forexplore-tests/limit.test.mjs"],
  },
};
it.each([true, false])('executes submitted javac/java commands (passing=%s)', async good => {
  const input = fixture();
  writeFileSync(join(input.workspaceRoot, 'Value.java'), `public class Value { public static int get() { return ${good ? 2 : 1}; } }`);
  input.request.writeFiles = ['Value.java'];
  const javaSuite: WorkspaceTestSuite = {
    files: [
      { path: 'src/test/java/Check.java', content: 'public class Check { public static void main(String[] args) { if (Value.get() != 2) throw new AssertionError("expected 2"); System.out.println("assertion passed"); } }' },
      { path: '.forexplore-tests/run.sh', content: 'set -eu\njavac -d .forexplore-tests Value.java src/test/java/Check.java\njava -cp .forexplore-tests Check\n' },
    ],
    command: { executable: 'sh', args: ['.forexplore-tests/run.sh'] },
  };
  const result = await createWorkspaceTestVerifier({ client: {
    async complete(messages) {
      const evidence = messages.find(message => message.role === 'tool');
      if (!evidence) return call('run_tests', javaSuite);
      const command = JSON.parse(evidence.content) as WorkspaceTestCommandEvidence;
      return call('submit_report', { outcome: good ? 'passed' : 'failed', summary: 'Java assertions executed', commandIds: [command.id],
        bugs: good ? [] : [{ summary: 'Wrong value', expected: '2', actual: 'java.lang.AssertionError: expected 2', commandIds: [command.id], testPaths: ['src/test/java/Check.java'] }] });
    },
  } })(input, new AbortController().signal);
  expect(result.status, JSON.stringify(result)).toBe(good ? 'passed' : 'failed');
  expect(result.commands[0]?.command).toEqual(javaSuite.command);
  expect(result.commands[0]?.exitCode).toBe(good ? 0 : 1);
  expect(result.commands[0]?.tests).toBeUndefined();
}, 30000);

function fixture(good = true): WorkspaceTestInput {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "host-tests-"));
  roots.push(workspaceRoot);
  writeFileSync(join(workspaceRoot, "package.json"), "{}");
  writeFileSync(
    join(workspaceRoot, "target.mjs"),
    `export const limit = value => value + ${good ? 2 : 1};\n`,
  );
  return {
    workspaceRoot,
    translationRunId: "translation-1",
    request: {
      spec: "Increment by two",
      sourceLanguage: "JavaScript",
      targetLanguage: "JavaScript",
      context: [],
      workspaceFiles: ["target.mjs"],
      writeFiles: ["target.mjs"],
    },
    compilation: {
      command: { executable: "node", args: ["--check", "target.mjs"] },
      success: true,
      exitCode: 0,
      output: "",
      diagnostics: [],
      startedAt: "",
      durationMs: 1,
    },
  };
}
it("generates, executes and preserves a passing suite in the result for replay", async () => {
  const input = fixture();
  const verify = createWorkspaceTestVerifier({
    client: reportingClient(suite),
  });
  const result = await verify(input, new AbortController().signal);
  expect(result).toMatchObject({
    status: "passed",
    reportConsistent: true,
    cleanup: "removed",
    commands: [
      {
        exitCode: 0,
        filesUnchanged: true,
        tests: { total: 1, passed: 1, failed: 0 },
      },
    ],
  });
  expect(result.sourceSnapshot).toHaveLength(64);
  expect(
    (
      await verify(
        { ...input, suite: result.suite },
        new AbortController().signal,
      )
    ).status,
  ).toBe("passed");
});
it.each(['Check.mjs', 'src/test/check.mjs'])('retries setup and reads generated tests at %s', async testPath => {
  const input = fixture();
  const submitted: WorkspaceTestSuite = {
    files: [{ path: testPath, content: "if (process.argv[2] !== 'ready') { console.error('setup missing'); process.exit(2); } console.log('passed');" }],
    command: { executable: 'node', args: [testPath] },
  };
  let turn = 0;
  const client: SingleAgentModelClient = { async complete(messages) {
    turn++;
    if (turn === 1) return call('run_tests', submitted);
    if (turn === 2) {
      expect(JSON.parse(messages.at(-1)!.content).exitCode).toBe(2);
      return call('read_file', { side: 'target', path: testPath });
    }
    if (turn === 3) {
      expect(JSON.parse(messages.at(-1)!.content).content).toBe(submitted.files[0]!.content);
      return call('run_tests', { ...submitted, command: { executable: 'node', args: [testPath, 'ready'] } });
    }
    const evidence = JSON.parse(messages.at(-1)!.content);
    expect(evidence.exitCode).toBe(0);
    return call('submit_report', { outcome: 'passed', summary: 'passed', commandIds: [evidence.id], bugs: [] });
  } };
  const result = await createWorkspaceTestVerifier({ client })(input, new AbortController().signal);
  expect(result).toMatchObject({ status: 'passed', reportConsistent: true, cleanup: 'removed' });
  expect(result.commands.map(command => command.exitCode)).toEqual([2, 0]);
  expect(existsSync(join(input.workspaceRoot, testPath))).toBe(false);
  expect(result.suite?.command.args).toEqual([testPath, 'ready']);
});

it.each([false, true])(
  "keeps real failed evidence and cleans only new tests (lie=%s)",
  async (lie) => {
    const input = fixture(false),
      before = readFileSync(join(input.workspaceRoot, "target.mjs"), "utf8");
    const result = await createWorkspaceTestVerifier({
      client: reportingClient(suite, lie),
    })(input, new AbortController().signal);
    expect(result.status).toBe(lie ? "inconclusive" : "failed");
    expect(result.reportConsistent).toBe(!lie);
    expect(result.commands[0]?.tests?.failed).toBe(1);
    expect(existsSync(join(input.workspaceRoot, suite.files[0]!.path))).toBe(
      false,
    );
    expect(readFileSync(join(input.workspaceRoot, "target.mjs"), "utf8")).toBe(
      before,
    );
  },
);
it("rejects zero tests and incomplete TAP evidence", () => {
  expect(parseNodeTestCounts("1..1\nok 1 fake")).toBeUndefined();
  expect(
    parseNodeTestCounts(
      "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# todo 0\n# cancelled 0\n",
    ),
  ).toMatchObject({ total: 1, passed: 1 });
});
it("rejects symlink test directories without writing outside the worktree", async () => {
  const input = fixture(),
    outside = mkdtempSync(join(tmpdir(), "outside-tests-"));
  roots.push(outside);
  symlinkSync(outside, join(input.workspaceRoot, ".forexplore-tests"), "dir");
  const result = await createWorkspaceTestVerifier({
    client: reportingClient(suite),
  })(input, new AbortController().signal);
  expect(result.status).toBe("inconclusive");
  expect(existsSync(join(outside, "limit.test.mjs"))).toBe(false);
});
it("records cancellation and rolls back generated tests", async () => {
  const input = fixture();
  const controller = new AbortController();
  const slow = {
    ...suite,
    files: [
      {
        path: suite.files[0]!.path,
        content:
          "import test from 'node:test'; test('wait',async()=>new Promise(resolve=>setTimeout(resolve,60000)));",
      },
    ],
  };
  const verify = createWorkspaceTestVerifier({
    client: reportingClient(slow),
    onEvent: (event) => {
      if (event.type === "command.started")
        setTimeout(() => controller.abort(), 50);
    },
  });
  const result = await verify(input, controller.signal);
  expect(result.status).toBe("cancelled");
  expect(result.commands).toHaveLength(1);
  expect(existsSync(join(input.workspaceRoot, slow.files[0]!.path))).toBe(
    false,
  );
});
it("refuses to erase tests changed by execution", async () => {
  const input = fixture();
  const changed = {
    ...suite,
    files: [
      {
        path: suite.files[0]!.path,
        content:
          "import {writeFileSync} from 'node:fs'; writeFileSync(new URL(import.meta.url),'// changed');",
      },
    ],
  };
  const result = await createWorkspaceTestVerifier({
    client: reportingClient(changed),
  })(input, new AbortController().signal);
  expect(result).toMatchObject({ status: "inconclusive", cleanup: "conflict" });
  expect(
    readFileSync(join(input.workspaceRoot, changed.files[0]!.path), "utf8"),
  ).toBe("// changed");
});

it("does not mistake a file with no test cases for behavioral verification", async () => {
  const input = fixture();
  const empty = {
    ...suite,
    files: [
      { path: suite.files[0]!.path, content: 'console.log("no assertions");' },
    ],
  };
  const result = await createWorkspaceTestVerifier({
    client: reportingClient(empty),
  })(input, new AbortController().signal);
  expect(result.status).toBe("inconclusive");
  expect(result.commands[0]?.exitCode).toBe(0);
  expect(result.commands[0]?.tests).toBeUndefined();
});

it("does not require V8 coverage for a reported passing test", async () => {
  const input = fixture();
  const probe = {
    ...suite,
    files: [
      {
        path: suite.files[0]!.path,
        content:
          "import test from 'node:test';import assert from 'node:assert/strict';import {limit} from '../target.mjs';test('exports exist',()=>assert.equal(typeof limit,'function'));",
      },
    ],
  };
  const result = await createWorkspaceTestVerifier({
    client: reportingClient(probe),
  })(input, new AbortController().signal);
  expect(result.status).toBe("passed");
  expect(result.commands[0]?.tests?.passed).toBe(1);
  expect(result.commands[0]?.executedProductionFiles).toEqual([]);
  expect(existsSync(join(input.workspaceRoot, probe.files[0]!.path))).toBe(false);
  expect(result.suite).toEqual(probe);
});

it("does not claim ownership of a rejected pre-existing test", async () => {
  const input = fixture();
  mkdirSync(join(input.workspaceRoot, ".forexplore-tests"));
  writeFileSync(
    join(input.workspaceRoot, suite.files[0]!.path),
    suite.files[0]!.content,
  );
  const result = await createWorkspaceTestVerifier({
    client: reportingClient(suite),
  })(input, new AbortController().signal);
  expect(result.status).toBe("inconclusive");
  expect(result.suite).toBeUndefined();
  expect(
    readFileSync(join(input.workspaceRoot, suite.files[0]!.path), "utf8"),
  ).toBe(suite.files[0]!.content);
});
