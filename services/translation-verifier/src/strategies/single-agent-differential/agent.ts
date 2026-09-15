import { Ajv } from "ajv";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { VerificationInput } from "../../schemas/verification-types.js";
import {
  parseTestSubmission,
  testSubmissionSchema,
  validateTestPath,
  type TestSubmission,
} from "./report.js";
import { buildSingleAgentPrompt, singleAgentSystemPrompt } from "./prompt.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface Completion {
  content?: string;
  toolCalls?: ToolCall[];
}
export interface SingleAgentModelClient {
  complete(
    messages: readonly Message[],
    tools: readonly Tool[],
    signal?: AbortSignal,
  ): Promise<Completion>;
}
export interface SingleAgentModelClientOptions {
  apiKey: string;
  model?: string;
  request?: typeof fetch;
}
export class SingleAgentBlockerError extends Error {
  readonly name = "SingleAgentBlockerError";
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function parseCompletion(value: unknown): Completion {
  if (
    !object(value) ||
    !Array.isArray(value.choices) ||
    !object(value.choices[0])
  )
    throw new Error("DeepSeek API returned invalid completion.");
  const choice = value.choices[0];
  if (!["stop", "tool_calls"].includes(String(choice.finish_reason)))
    throw new Error(
      `DeepSeek completion stopped: ${String(choice.finish_reason)}`,
    );
  if (!object(choice.message))
    throw new Error("DeepSeek API returned invalid message.");
  const message = choice.message;
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls: ToolCall[] = [];
  const ids = new Set<string>();
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16)
      throw new Error("Invalid model tool calls.");
    for (const call of message.tool_calls) {
      if (
        !object(call) ||
        call.type !== "function" ||
        typeof call.id !== "string" ||
        !call.id ||
        ids.has(call.id) ||
        !object(call.function) ||
        typeof call.function.name !== "string" ||
        !call.function.name ||
        typeof call.function.arguments !== "string"
      ) {
        throw new Error("Invalid model tool call.");
      }
      ids.add(call.id);
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  if (!content.trim() && !toolCalls.length)
    throw new Error("DeepSeek API returned empty completion.");
  return { content, toolCalls };
}

export function createSingleAgentModelClient(
  options: SingleAgentModelClientOptions,
): SingleAgentModelClient {
  if (!options.apiKey.trim()) throw new Error("DeepSeek API key is required.");
  const request = options.request ?? fetch;
  return {
    async complete(messages, tools, signal) {
      signal?.throwIfAborted();
      const response = await request(
        "https://api.deepseek.com/chat/completions",
        {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model:
              options.model ??
              process.env.DEEPSEEK_MODEL ??
              "deepseek-v4-flash",
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
              ...(message.toolCalls?.length
                ? {
                    tool_calls: message.toolCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
              ...(message.toolCallId
                ? { tool_call_id: message.toolCallId }
                : {}),
            })),
            tools: tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
            tool_choice: "auto",
            thinking: { type: "disabled" },
            max_tokens: 8192,
          }),
          signal,
        },
      );
      if (!response.ok)
        throw new Error(`DeepSeek API error ${response.status}`);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new Error("DeepSeek API returned invalid JSON.");
      }
      return parseCompletion(value);
    },
  };
}

type Workspace = { sourceRoot: string; targetRoot: string };
const string = { type: "string", minLength: 1, maxLength: 1024 };
const side = { type: "string", enum: ["source", "target"] };
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
export const singleAgentTools: readonly Tool[] = [
  {
    name: "list_files",
    description:
      "List project-relative files under an optional directory. Generated and private files are excluded; results report truncation.",
    inputSchema: schema(
      {
        side,
        path: string,
        maxResults: { type: "integer", minimum: 1, maximum: 200 },
      },
      ["side"],
    ),
  },
  {
    name: "search_files",
    description:
      "Search literal text in bounded project files, returning paths and line numbers. Narrow path when results are truncated.",
    inputSchema: schema(
      {
        side,
        query: { type: "string", minLength: 1, maxLength: 500 },
        path: string,
        maxResults: { type: "integer", minimum: 1, maximum: 100 },
      },
      ["side", "query"],
    ),
  },
  {
    name: "read_file",
    description:
      "Read a range of UTF-8 lines from a project file; use returned line numbers to request further ranges.",
    inputSchema: schema(
      {
        side,
        path: string,
        startLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
        maxLines: { type: "integer", minimum: 1, maximum: 500 },
      },
      ["side", "path"],
    ),
  },
  {
    name: "submit_tests",
    description:
      "Finish generation by submitting complete new target test/helper files and one executable/args command. Must be the only tool call in this turn. The host writes and runs the tests after generation ends.",
    inputSchema: testSubmissionSchema,
  },
  {
    name: "report_blocker",
    description:
      "Stop generation with the concrete missing context or prerequisite. Must be the only tool call in this turn.",
    inputSchema: schema(
      {
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          pattern: "\\S",
        },
      },
      ["reason"],
    ),
  },
];
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(
  singleAgentTools.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);
const excluded =
  /^(?:\.git|\.forexplore|\.forexplore-tests|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh|\.aws|.*\.(?:pem|key)|node_modules|vendor|dependencies|generated|secrets|target|build|dist|out|coverage|\.venv|__pycache__|\.gradle)$/i;
const maxFileBytes = 256_000;

function readablePath(path: string): void {
  validateTestPath(path);
  if (path.split("/").some((part) => excluded.test(part)))
    throw new Error("Private or generated path is not readable.");
}
async function checkedPath(
  workspace: Workspace,
  side: "source" | "target",
  path?: string,
): Promise<string> {
  const supplied =
    side === "source" ? workspace.sourceRoot : workspace.targetRoot;
  const base = await realpath(supplied);
  let current = base;
  if (path !== undefined) {
    readablePath(path);
    for (const part of path.split("/")) {
      current = join(current, part);
      const entry = await lstat(current);
      if (
        entry.isSymbolicLink() ||
        (!entry.isFile() && !entry.isDirectory()) ||
        (entry.isFile() && entry.nlink !== 1)
      )
        throw new Error("Linked or special project files are not readable.");
    }
  }
  return current;
}
async function readText(
  workspace: Workspace,
  side: "source" | "target",
  path: string,
): Promise<string> {
  const full = await checkedPath(workspace, side, path);
  const handle = await open(full, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxFileBytes)
      throw new Error(
        `File is not supported text or exceeds ${maxFileBytes} bytes.`,
      );
    // A bounded read also handles a file growing after stat.
    const buffer = Buffer.alloc(maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxFileBytes)
      throw new Error("File grew beyond the read limit.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytesRead),
    );
    if (text.includes("\0")) throw new Error("Binary files are not readable.");
    return text;
  } finally {
    await handle.close();
  }
}
async function listFiles(
  workspace: Workspace,
  side: "source" | "target",
  path: string | undefined,
  limit: number,
  signal?: AbortSignal,
) {
  const start = await checkedPath(workspace, side, path);
  if ((await lstat(start)).isFile())
    return { files: [path!], truncated: false };
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = async (
    directory: string,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 20) {
      truncated = true;
      return;
    }
    for await (const entry of await opendir(directory)) {
      signal?.throwIfAborted();
      if (++visited > 2000 || files.length >= limit) {
        truncated = true;
        return;
      }
      if (excluded.test(entry.name) || entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await walk(join(directory, entry.name), name, depth + 1);
      else if (entry.isFile()) files.push(name);
      if (visited > 2000 || files.length >= limit) {
        truncated = true;
        return;
      }
    }
  };
  await walk(start, path ?? "", 0);
  return { files, truncated };
}
async function inspect(
  workspace: Workspace,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const side = input.side as "source" | "target";
  const path = input.path as string | undefined;
  signal?.throwIfAborted();
  if (name === "list_files")
    return listFiles(
      workspace,
      side,
      path,
      (input.maxResults as number | undefined) ?? 100,
      signal,
    );
  if (name === "read_file") {
    const lines = (await readText(workspace, side, path!)).split(/\r?\n/);
    const startLine = (input.startLine as number | undefined) ?? 1;
    const selected = lines.slice(
      startLine - 1,
      startLine - 1 + ((input.maxLines as number | undefined) ?? 200),
    );
    const full = selected.join("\n");
    return {
      path,
      startLine,
      totalLines: lines.length,
      content: full.slice(0, 32_000),
      truncated:
        full.length > 32_000 || startLine - 1 + selected.length < lines.length,
    };
  }
  const listed = await listFiles(workspace, side, path, 200, signal);
  const matches: { path: string; line: number; content: string }[] = [];
  const maxResults = (input.maxResults as number | undefined) ?? 50;
  let skippedFiles = 0;
  let charactersRead = 0;
  for (const file of listed.files) {
    signal?.throwIfAborted();
    let text: string;
    try {
      text = await readText(workspace, side, file);
    } catch {
      skippedFiles++;
      continue;
    }
    charactersRead += text.length;
    if (charactersRead > 1_000_000)
      return { matches, skippedFiles, truncated: true };
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.includes(input.query as string)) {
        matches.push({
          path: file,
          line: index + 1,
          content: lines[index]!.slice(0, 300),
        });
        if (matches.length >= maxResults)
          return { matches, skippedFiles, truncated: true };
      }
    }
  }
  return { matches, skippedFiles, truncated: listed.truncated };
}

export async function inspectTestWorkspace(
  root: string, name: string, input: unknown, signal?: AbortSignal,
): Promise<unknown> {
  const validate = validators.get(name);
  if (!["list_files", "search_files", "read_file"].includes(name) || !validate || !validate(input) || !object(input))
    throw new Error("Invalid read-only tool arguments.");
  return inspect({ sourceRoot: root, targetRoot: root }, name, input, signal);
}

export async function generateTests(args: {
  input: VerificationInput;
  workspace: Workspace;
  client: SingleAgentModelClient;
  maxTurns: number;
  signal?: AbortSignal;
  writeDirectories?: readonly string[];
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<TestSubmission> {
  if (
    !Number.isInteger(args.maxTurns) ||
    args.maxTurns < 1 ||
    args.maxTurns > 1000
  )
    throw new Error("maxTurns must be 1..1000.");
  const emit = args.onEvent ?? (() => {});
  const messages: Message[] = [
    { role: "system", content: singleAgentSystemPrompt },
    {
      role: "user",
      content: buildSingleAgentPrompt(args.input, {
        ...args.workspace,
        writeDirectories: args.writeDirectories,
      }),
    },
  ];
  for (let turn = 0; turn < args.maxTurns; turn++) {
    args.signal?.throwIfAborted();
    if (JSON.stringify(messages).length > 250_000)
      throw new Error("Agent context budget exceeded (250000 characters).");
    const started = Date.now();
    emit({ type: "model.started", turn, at: new Date(started).toISOString() });
    let result: Completion;
    try {
      result = await args.client.complete(
        messages,
        singleAgentTools,
        args.signal,
      );
      args.signal?.throwIfAborted();
      emit({ type: "model.completed", turn, durationMs: Date.now() - started });
    } catch (error) {
      emit({
        type: "model.failed",
        turn,
        durationMs: Date.now() - started,
        error: String(error),
      });
      throw error;
    }
    const calls = result.toolCalls ?? [];
    if (calls.length > 16 || JSON.stringify(result).length > 1_100_000)
      throw new Error("Model response exceeds budget.");
    if (new Set(calls.map((call) => call.id)).size !== calls.length)
      throw new Error("Duplicate tool call IDs.");
    messages.push({
      role: "assistant",
      content: result.content ?? "",
      toolCalls: calls,
    });
    if (!calls.length) {
      messages.push({
        role: "user",
        content:
          "Use the available read tools, or finish with exactly one submit_tests or report_blocker call. Text alone does not submit tests.",
      });
      continue;
    }
    if (
      calls.some((call) =>
        ["submit_tests", "report_blocker"].includes(call.name),
      ) &&
      calls.length !== 1
    )
      throw new Error("A terminal tool must be the only call in its turn.");
    for (const call of calls) {
      args.signal?.throwIfAborted();
      const toolStarted = Date.now();
      const event = { turn, toolName: call.name, id: call.id };
      emit({
        type: "tool.started",
        ...event,
        at: new Date(toolStarted).toISOString(),
      });
      let output: unknown;
      try {
        const validate = validators.get(call.name);
        if (!validate) throw new Error(`Tool is unavailable: ${call.name}`);
        const input: unknown = JSON.parse(call.arguments);
        if (!validate(input) || !object(input))
          throw new Error(
            `Invalid ${call.name} arguments: ${ajv.errorsText(validate.errors)}`,
          );
        if (call.name === "submit_tests") {
          const submission = parseTestSubmission(input);
          emit({
            type: "tool.completed",
            ...event,
            durationMs: Date.now() - toolStarted,
            fileCount: submission.files.length,
          });
          return submission;
        }
        if (call.name === "report_blocker")
          throw new SingleAgentBlockerError(input.reason as string);
        output = await inspect(args.workspace, call.name, input, args.signal);
        args.signal?.throwIfAborted();
        emit({
          type: "tool.completed",
          ...event,
          durationMs: Date.now() - toolStarted,
        });
      } catch (error) {
        emit({
          type: "tool.failed",
          ...event,
          durationMs: Date.now() - toolStarted,
          error: String(error),
        });
        args.signal?.throwIfAborted();
        if (error instanceof SingleAgentBlockerError) throw error;
        output = { error: String(error) };
      }
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(output),
      });
    }
  }
  throw new Error(`Single-agent exhausted its ${args.maxTurns}-turn budget.`);
}
