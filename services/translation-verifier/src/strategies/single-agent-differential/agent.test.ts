import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSingleAgentModelClient,
  generateTests,
  singleAgentTools,
  SingleAgentBlockerError,
  type Completion,
  type Message,
  type SingleAgentModelClient,
} from "./agent.js";
import { parseTestSubmission } from "./report.js";
import { buildSingleAgentPrompt, singleAgentSystemPrompt } from "./prompt.js";
import type { VerificationInput } from "../../schemas/verification-types.js";

const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const submission = {
  files: [
    {
      path: "tests/generated.cjs",
      content: "require('node:assert').equal(1,1)",
    },
  ],
  command: { executable: "node", args: ["tests/generated.cjs"] },
};
const call = (name: string, args: unknown, id = "call-1"): Completion => ({
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "test-generator-")));
  directories.push(root);
  const sourceRoot = join(root, "source"),
    targetRoot = join(root, "target");
  mkdirSync(sourceRoot);
  mkdirSync(targetRoot);
  writeFileSync(
    join(sourceRoot, "reference.py"),
    "def identity(x):\n    return x\n",
  );
  writeFileSync(
    join(targetRoot, "implementation.cjs"),
    "module.exports = x => x;\n",
  );
  const input = {
    request: {
      requirement: "Identity",
      sourceBundle: { files: [{ path: "reference.py", content: "source" }] },
      targetContext: {
        sourceFiles: [
          { path: "implementation.cjs", content: "old implementation" },
        ],
      },
    },
    analysisReport: { note: "reference evidence" },
    migrationPlan: {},
    translation: { files: [] },
  } as unknown as VerificationInput;
  return { input, workspace: { sourceRoot, targetRoot } };
}

describe("read-only test generation", () => {
  it("reads source, searches target and submits without offering execution or writing", async () => {
    const f = fixture();
    const received: Message[][] = [];
    const events: Record<string, unknown>[] = [];
    const responses = [
      call("read_file", {
        side: "source",
        path: "reference.py",
        startLine: 2,
        maxLines: 1,
      }),
      call("search_files", { side: "target", query: "exports" }),
      call("submit_tests", submission),
    ];
    const client: SingleAgentModelClient = {
      complete: async (messages, tools) => {
        received.push(structuredClone([...messages]));
        expect(tools.map((tool) => tool.name)).toEqual([
          "list_files",
          "search_files",
          "read_file",
          "submit_tests",
          "report_blocker",
        ]);
        return responses.shift()!;
      },
    };
    expect(
      await generateTests({
        ...f,
        client,
        maxTurns: 3,
        onEvent: (event) => events.push(event),
      }),
    ).toEqual(submission);
    expect(received[1]!.at(-1)?.content).toContain("return x");
    expect(received[2]!.at(-1)?.content).toContain(
      '"path":"implementation.cjs","line":1',
    );
    expect(
      events.filter((event) => event.type === "tool.completed"),
    ).toHaveLength(3);
  });
  it.each([
    ["read_file", { side: "target", path: "../source/reference.py" }],
    ["read_file", { side: "wrong", path: "implementation.cjs" }],
    ["read_file", { side: "target", path: "implementation.cjs", maxLines: -1 }],
    [
      "read_file",
      { side: "target", path: "implementation.cjs", command: "execute" },
    ],
    ["run_command", { executable: "node", args: [] }],
    ["write_file", { path: "implementation.cjs", content: "replacement" }],
  ])("returns a bounded tool error for %s %j", async (name, args) => {
    const f = fixture();
    let count = 0;
    const client: SingleAgentModelClient = {
      complete: async (messages) => {
        if (count++ === 0) return call(name, args);
        expect(messages.at(-1)?.content).toContain("error");
        return call("submit_tests", submission);
      },
    };
    await expect(generateTests({ ...f, client, maxTurns: 2 })).resolves.toEqual(
      submission,
    );
  });
  it("excludes nested private files and refuses even in-root symlink reads", async () => {
    const f = fixture();
    mkdirSync(join(f.workspace.targetRoot, "nested"));
    mkdirSync(join(f.workspace.targetRoot, "nested/node_modules"));
    writeFileSync(join(f.workspace.targetRoot, "nested/.env"), "SECRET=hidden");
    writeFileSync(
      join(f.workspace.targetRoot, "nested/node_modules/secret.txt"),
      "hidden",
    );
    symlinkSync(
      join(f.workspace.targetRoot, "implementation.cjs"),
      join(f.workspace.targetRoot, "alias.cjs"),
    );
    const responses = [
      call("list_files", { side: "target" }),
      call("read_file", { side: "target", path: "alias.cjs" }),
      call("read_file", { side: "target", path: "nested/.env" }),
      call("submit_tests", submission),
    ];
    let turn = 0;
    const client: SingleAgentModelClient = {
      complete: async (messages) => {
        if (turn === 1) {
          expect(messages.at(-1)?.content).toContain("implementation.cjs");
          expect(messages.at(-1)?.content).not.toMatch(/secret|alias|\.env/);
        }
        if (turn >= 2) expect(messages.at(-1)?.content).toContain("error");
        return responses[turn++]!;
      },
    };
    await expect(generateTests({ ...f, client, maxTurns: 4 })).resolves.toEqual(
      submission,
    );
  });
  it("reports truncation and can read a later line range", async () => {
    const f = fixture();
    writeFileSync(
      join(f.workspace.targetRoot, "long.txt"),
      Array.from({ length: 600 }, (_, index) => `line${index + 1}`).join("\n"),
    );
    let turn = 0;
    const client: SingleAgentModelClient = {
      complete: async (messages) => {
        if (turn++ === 0)
          return call("read_file", {
            side: "target",
            path: "long.txt",
            startLine: 501,
            maxLines: 20,
          });
        const result = JSON.parse(messages.at(-1)!.content);
        expect(result).toMatchObject({
          startLine: 501,
          totalLines: 600,
          truncated: true,
        });
        expect(result.content).toContain("line520");
        return call("submit_tests", submission);
      },
    };
    await generateTests({ ...f, client, maxTurns: 2 });
  });
  it("terminates on a blocker and records the terminal tool event", async () => {
    const f = fixture();
    const events: Record<string, unknown>[] = [];
    await expect(
      generateTests({
        ...f,
        maxTurns: 2,
        client: {
          complete: async () =>
            call("report_blocker", { reason: "Missing test framework" }),
        },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toBeInstanceOf(SingleAgentBlockerError);
    expect(events.at(-1)).toMatchObject({
      type: "tool.failed",
      toolName: "report_blocker",
    });
  });
  it("does not accept a terminal submission alongside another tool call", async () => {
    const f = fixture();
    const result = {
      toolCalls: [
        ...call("submit_tests", submission).toolCalls!,
        ...call(
          "read_file",
          { side: "target", path: "implementation.cjs" },
          "second",
        ).toolCalls!,
      ],
    };
    await expect(
      generateTests({
        ...f,
        maxTurns: 1,
        client: { complete: async () => result },
      }),
    ).rejects.toThrow("only call");
  });
  it("bounds plain-text loops and stops before a model call after cancellation", async () => {
    const f = fixture();
    const complete = vi.fn(async () => ({ content: "thinking about tests" }));
    await expect(
      generateTests({ ...f, maxTurns: 2, client: { complete } }),
    ).rejects.toThrow("2-turn");
    expect(complete).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      generateTests({
        ...f,
        maxTurns: 2,
        client: { complete },
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it("rejects ambiguous test bundles and unsupported command fields", () => {
    expect(() =>
      parseTestSubmission({
        ...submission,
        files: [...submission.files, ...submission.files],
      }),
    ).toThrow("Duplicate");
    expect(() =>
      parseTestSubmission({
        ...submission,
        command: { ...submission.command, cwd: "/tmp" },
      }),
    ).toThrow("Invalid");
    expect(() =>
      parseTestSubmission({
        ...submission,
        files: [{ path: "../implementation.cjs", content: "changed" }],
      }),
    ).toThrow("path");
  });
  it("supplies selected paths and read-only instructions without the obsolete freeze/proxy protocol", () => {
    const f = fixture();
    const text = buildSingleAgentPrompt(f.input, {
      ...f.workspace,
      writeDirectories: ["tests"],
    });
    expect(text).toContain("reference.py");
    expect(text).toContain("implementation.cjs");
    expect(text).not.toContain("old implementation");
    expect(singleAgentSystemPrompt).toContain("submit_tests");
    expect(singleAgentSystemPrompt).not.toMatch(
      /freeze_plan|FOREXPLORE_COMMAND_ID|Host source proxy/,
    );
  });
});

describe("direct DeepSeek tool client", () => {
  it("maps tools and tool results to the HTTP protocol and preserves caller cancellation", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(
        body.tools.find(
          (tool: { function: { name: string } }) =>
            tool.function.name === "submit_tests",
        ).function.parameters.required,
      ).toEqual(["files", "command"]);
      expect(body.messages[0].tool_calls[0].function.name).toBe("list_files");
      expect(body.messages[1].tool_call_id).toBe("call-1");
      expect(init?.signal).toBe(controller.signal);
      expect(init?.redirect).toBe("error");
      return Response.json({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "submit",
                  type: "function",
                  function: {
                    name: "submit_tests",
                    arguments: JSON.stringify(submission),
                  },
                },
              ],
            },
          },
        ],
      });
    });
    const client = createSingleAgentModelClient({
      apiKey: "test-only",
      model: "deepseek-v4-flash",
      request,
    });
    const result = await client.complete(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: call("list_files", { side: "target" }).toolCalls,
        },
        { role: "tool", content: "[]", toolCallId: "call-1" },
      ],
      singleAgentTools,
      controller.signal,
    );
    expect(result.toolCalls?.[0]).toMatchObject({
      id: "submit",
      name: "submit_tests",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(["length", "content_filter", "insufficient_system_resource"])(
    "rejects incomplete model output (%s)",
    async (reason) => {
      const client = createSingleAgentModelClient({
        apiKey: "test-only",
        request: async () =>
          Response.json({
            choices: [
              { finish_reason: reason, message: { content: "partial" } },
            ],
          }),
      });
      await expect(client.complete([], singleAgentTools)).rejects.toThrow(
        reason,
      );
    },
  );
  it("rejects empty credentials before issuing a request", () => {
    const request = vi.fn<typeof fetch>();
    expect(() => createSingleAgentModelClient({ apiKey: "", request })).toThrow(
      "API key",
    );
    expect(request).not.toHaveBeenCalled();
  });
});
