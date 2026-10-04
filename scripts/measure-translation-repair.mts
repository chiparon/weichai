/**
 * Measures what an anchored edit tool changes about a real translation repair.
 *
 * Both arms start from the same wrong-but-plausible draft, run the same task
 * against the same model, and obey the same host rules — plan scope, read hashes,
 * protected criteria files, host-owned compiler and behaviour suite. The only
 * difference is how a repair reaches the file: one arm offers only the whole-file
 * write that shipped before, the other also offers edit_file. Every run is a real
 * model conversation; nothing is scripted.
 *
 *   npx tsx scripts/measure-translation-repair.mts --runs 3
 *
 * Measured: turns, repair rounds, wall clock, prompt/completion tokens, the write
 * payload each repair actually sent, the tool mix, and whether the suite passed.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { WorkspaceTranslationRun } from '@forexplore/contracts';
import { WorkspaceTranslationRuntime } from '../services/adaptation-service/src/workspace-translation-runtime.js';
import type { WorkspaceTranslationModelClient } from '../services/adaptation-service/src/workspace-translation-agent.js';
import type { DeepSeekToolCall, DeepSeekToolCompletion, DeepSeekToolDefinition, DeepSeekToolMessage } from '../services/adaptation-service/src/deepseek-client.js';

type Arm = 'whole-file' | 'anchored';

const argument = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
};
const runs = Number(argument('runs', '3'));
const arms = argument('arms', 'whole-file,anchored').split(',').map((value) => value.trim()) as Arm[];
const maxModelTurns = Number(argument('max-turns', '30'));
const outputRoot = resolve(argument('out', 'results/translation-edit-ab'));

function credential(): { apiKey: string; model: string; apiBase: string } {
  const file = resolve('services/adaptation-service/.env');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* the key may come from the environment */ }
  const fromFile = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, 'm'))?.[1]?.trim();
  const apiKey = process.env.DEEPSEEK_API_KEY ?? fromFile('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required (environment or services/adaptation-service/.env).');
  return {
    apiKey,
    model: argument('model', process.env.DEEPSEEK_MODEL ?? fromFile('DEEPSEEK_MODEL') ?? 'deepseek-v4-flash'),
    apiBase: (process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
  };
}

/** The reference implementation the task has to reproduce. */
const reference = `public final class UploadLimits {
  public static int limit(int value) {
    if (value < 0) throw new IllegalArgumentException("negative");
    return value + 1;
  }

  public static int clampWindow(int start, int size, int total) {
    if (size < 0) throw new IllegalArgumentException("negative size");
    if (size > total) return 0;
    if (start < 0) return 0;
    if (start + size > total) return total - size;
    return start;
  }

  public static String parseBoundary(String header) {
    if (header == null) throw new IllegalArgumentException("missing header");
    Matcher matcher = Pattern.compile("boundary=\\"?([^\\";]+)\\"?", Pattern.CASE_INSENSITIVE).matcher(header);
    if (!matcher.find()) throw new IllegalArgumentException("missing boundary");
    return matcher.group(1);
  }

  public static String formatBoundary(String value) {
    if (value.isEmpty()) throw new IllegalArgumentException("empty boundary");
    return "boundary=\\"" + value + "\\"";
  }
}`;

const spec = `Translate UploadLimits to JavaScript, preserving behaviour exactly. The draft in src/limits.mjs and
src/boundary.mjs is a first attempt and is known to be wrong; make the behaviour match the reference.
- limit(value): a negative input raises Error("negative"); otherwise it returns value + 1.
- clampWindow(start, size, total): a negative size raises Error("negative size"); a size larger than total
  returns 0; a negative start returns 0; a window that would overflow returns total - size; otherwise start.
- parseBoundary(headerLine): finds the boundary parameter case-insensitively in a multipart header line,
  accepts an optional double-quoted value, stops at the following semicolon, and raises
  Error("missing boundary") when the parameter is absent.
- formatBoundary(value): raises Error("empty boundary") for an empty value, otherwise returns boundary="value".
Keep the existing exported names and the helper functions. The suite in verify.mjs is the acceptance criterion.`;

const compileScript = `import { spawnSync } from "node:child_process";
const targets = ["src/limits.mjs", "src/boundary.mjs"];
let failed = false;
for (const file of targets) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { failed = true; console.log(file + ": " + (result.stderr || "").trim()); }
}
if (failed) process.exit(1);
console.log("compiled");
`;

const suiteScript = `import assert from "node:assert/strict";
import { limit, clampWindow, describeWindow, windowFor } from "./src/limits.mjs";
import { parseBoundary, formatBoundary } from "./src/boundary.mjs";
assert.equal(limit(0), 1);
assert.equal(limit(9), 10);
assert.throws(() => limit(-1), /negative/);
assert.equal(clampWindow(0, 4, 10), 0);
assert.equal(clampWindow(3, 4, 10), 3);
assert.equal(clampWindow(8, 4, 10), 6);
assert.equal(clampWindow(-2, 4, 10), 0);
assert.equal(clampWindow(2, 20, 10), 0);
assert.throws(() => clampWindow(0, -1, 10), /negative size/);
assert.equal(describeWindow(clampWindow(3, 4, 10), 4), "3+4");
assert.equal(windowFor(1, 4, 10), 0);
assert.equal(windowFor(3, 4, 10), 6);
assert.equal(parseBoundary("multipart/form-data; boundary=abc"), "abc");
assert.equal(parseBoundary('multipart/form-data; BOUNDARY="a b"'), "a b");
assert.equal(parseBoundary("multipart/form-data; boundary=abc; charset=utf-8"), "abc");
assert.throws(() => parseBoundary("multipart/form-data"), /missing boundary/);
// Host-only contracts: the suite is not readable by the agent, so these two rules
// are the repair the model can only discover from a failing run.
assert.equal(parseBoundary("multipart/form-data; boundary= abc "), "abc");
assert.throws(() => parseBoundary("multipart/form-data; boundary="), /missing boundary/);
assert.equal(formatBoundary("abc"), 'boundary="abc"');
assert.throws(() => formatBoundary(""), /empty boundary/);
console.log("suite ok");
`;

/** A plausible first attempt with planted deviations, sized like a real module. */
const draftLimits = `// UploadLimits translated from the Java reference. First attempt: behaviour is
// close but the window rules were guessed instead of read from the reference.
const DEFAULT_WINDOW = 4;
const MAX_WINDOW = 4096;

/** Formats a window for logs and error messages. */
export function describeWindow(start, size) {
  if (typeof start !== "number" || typeof size !== "number") {
    throw new Error("describeWindow expects numbers");
  }
  return start + "+" + size;
}

/** Rejects negative inputs before they reach the arithmetic helpers. */
function assertNonNegative(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(label + " must be a number");
  }
  if (value < 0) throw new Error("negative " + label);
  return value;
}

/** One-based page offset used by the upload listing. */
export function windowOffset(page, pageSize) {
  assertNonNegative(page, "page");
  assertNonNegative(pageSize, "page size");
  if (pageSize === 0) return 0;
  return (page - 1) * pageSize;
}

/**
 * Absolute offset of the window that holds page \`page\` of \`total\` items.
 */
export function windowFor(page, size, total) {
  assertNonNegative(total, "total");
  return clampWindow(windowOffset(page, size), size, total);
}

/** Increments a non-negative counter. */
export function limit(value) {
  assertNonNegative(value, "value");
  return value + 1;
}

/**
 * Clamps a window so it stays inside the total length.
 * Negative sizes are rejected because they cannot be laid out.
 */
export function clampWindow(start, size, total) {
  assertNonNegative(size, "size");
  if (start < 0) return 0;
  return start;
}

export const limits = {
  defaultWindow: DEFAULT_WINDOW,
  maxWindow: MAX_WINDOW,
  windowOffset,
  windowFor,
};
`;

const draftBoundary = `// Multipart boundary helpers translated from the Java reference. First attempt:
// the parameter lookup was written by hand and missed the header rules.
const BOUNDARY_PARAMETER = "boundary=";
const QUOTE = String.fromCharCode(34);

/** Splits a header line into its parameters. */
export function splitParameters(headerLine) {
  return headerLine.split(";").map((part) => part.trim()).filter(Boolean);
}

/** True when the value is wrapped in double quotes. */
export function isQuoted(value) {
  return value.length >= 2 && value.startsWith(QUOTE) && value.endsWith(QUOTE);
}

/** Removes one layer of double quotes. */
export function unquote(value) {
  return isQuoted(value) ? value.slice(1, -1) : value;
}

/**
 * Reads the boundary parameter from a multipart content-type header line.
 */
export function parseBoundary(headerLine) {
  if (headerLine === null || headerLine === undefined) {
    throw new Error("missing header");
  }
  const index = headerLine.indexOf(BOUNDARY_PARAMETER);
  if (index < 0) throw new Error("missing boundary");
  return unquote(headerLine.slice(index + BOUNDARY_PARAMETER.length));
}

/** Formats a boundary parameter for a request header. */
export function formatBoundary(value) {
  if (!value) throw new Error("empty boundary");
  return BOUNDARY_PARAMETER + QUOTE + value + QUOTE;
}

export const boundaries = {
  parameter: BOUNDARY_PARAMETER,
  splitParameters,
  isQuoted,
};
`;

const request = {
  spec,
  sourceLanguage: 'Java',
  targetLanguage: 'JavaScript',
  context: [{ id: 'reference', kind: 'source' as const, content: reference }],
  // verify.mjs stays out of the readable scope on purpose: the host owns the suite
  // and the agent only sees what a failing run reports, exactly like production.
  workspaceFiles: ['src/limits.mjs', 'src/boundary.mjs', 'compile.mjs'],
  writeFiles: ['src/limits.mjs', 'src/boundary.mjs'],
};

/** The same files with the planted deviations corrected: the fixture must be solvable. */
const fixedLimits = draftLimits.replace(
  `export function clampWindow(start, size, total) {
  assertNonNegative(size, "size");
  if (start < 0) return 0;
  return start;
}`,
  `export function clampWindow(start, size, total) {
  assertNonNegative(size, "size");
  if (size > total) return 0;
  if (start < 0) return 0;
  if (start + size > total) return total - size;
  return start;
}`,
);
const fixedBoundary = draftBoundary.replace(
  `  const index = headerLine.indexOf(BOUNDARY_PARAMETER);
  if (index < 0) throw new Error("missing boundary");
  return unquote(headerLine.slice(index + BOUNDARY_PARAMETER.length));`,
  `  const match = /boundary="?([^";]+)"?/i.exec(headerLine);
  if (!match) throw new Error("missing boundary");
  return match[1];`,
);

/** The reference-faithful files plus the two host-only contracts: the fixture must be solvable. */
const solutionBoundary = fixedBoundary.replace(
  `  const match = /boundary="?([^";]+)"?/i.exec(headerLine);
  if (!match) throw new Error("missing boundary");
  return match[1];`,
  `  const match = /boundary="?([^";]+)"?/i.exec(headerLine);
  if (!match || !match[1].trim()) throw new Error("missing boundary");
  return match[1].trim();`,
);

/** Writes one fixture variant and reports what the host compiler and suite say about it. */
async function checkFixture(label: string, limitsText: string, boundaryText: string): Promise<boolean> {
  const root = join(outputRoot, '_fixture-check', label);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'compile.mjs'), compileScript);
  await writeFile(join(root, 'verify.mjs'), suiteScript);
  await writeFile(join(root, 'src', 'limits.mjs'), limitsText);
  await writeFile(join(root, 'src', 'boundary.mjs'), boundaryText);
  const compiled = spawnSync(process.execPath, ['compile.mjs'], { cwd: root, encoding: 'utf8' });
  const verified = spawnSync(process.execPath, ['verify.mjs'], { cwd: root, encoding: 'utf8' });
  const compiledOk = compiled.status === 0;
  const verifiedOk = verified.status === 0;
  const firstFailure = (verified.stderr || verified.stdout).split('\n').find((line) => /AssertionError|Error:/.test(line)) ?? '';
  console.log(`  ${label.padEnd(6)} compile=${compiledOk ? 'ok' : 'fail'} suite=${verifiedOk ? 'pass' : 'fail'}  ${firstFailure.trim().slice(0, 110)}`);
  return compiledOk && !verifiedOk;
}

if (process.argv.includes('--fixture-check')) {
  console.log('fixture check: the draft must fail the suite, the solution must pass it\n');
  const draftFails = await checkFixture('draft', draftLimits, draftBoundary);
  const fixedFails = await checkFixture('reference-faithful', fixedLimits, fixedBoundary);
  const solutionPasses = !(await checkFixture('solution', fixedLimits, solutionBoundary));
  console.log(`\n${draftFails ? 'ok' : 'PROBLEM'}: 初稿让套件失败（需要修复）`);
  console.log(`${fixedFails ? 'ok' : 'PROBLEM'}: 只照抄参考实现仍然失败（隐藏契约必须靠失败回合发现）`);
  console.log(`${solutionPasses ? 'ok' : 'PROBLEM'}: 满足隐藏契约的版本通过（题目可解）`);
  process.exit(draftFails && fixedFails && solutionPasses ? 0 : 1);
}

interface Usage { prompt: number; completion: number; cached: number }
interface RunMetrics {
  arm: Arm; index: number; status: string; acceptance: string | undefined; error?: string;
  turns: number; compilations: number; failedCompilations: number; verificationRuns: number; failedVerificationRuns: number;
  repairRounds: number; wallMs: number; usage: Usage; toolCalls: Record<string, number>;
  wholeFilePayloadChars: number; editPayloadChars: number; suitePassed: boolean;
}

/** A measured client: the production request shape plus usage, payload and tool tallies. */
function measuredClient(options: { apiKey: string; apiBase: string; model: string; exposeEditFile: boolean }) {
  const usage: Usage = { prompt: 0, completion: 0, cached: 0 };
  const toolCalls: Record<string, number> = {};
  let wholeFilePayloadChars = 0;
  let editPayloadChars = 0;
  const serialize = (message: DeepSeekToolMessage): Record<string, unknown> => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    if (message.role === 'assistant') {
      return {
        role: 'assistant', content: message.content || null,
        ...(message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
        } : {}),
      };
    }
    return { role: message.role, content: message.content };
  };
  const client: WorkspaceTranslationModelClient & {
    usage: Usage; toolCalls: Record<string, number>;
    payload: { wholeFilePayloadChars: number; editPayloadChars: number };
  } = {
    usage, toolCalls,
    payload: {
      get wholeFilePayloadChars() { return wholeFilePayloadChars; },
      get editPayloadChars() { return editPayloadChars; },
    },
    async complete(messages, tools: readonly DeepSeekToolDefinition[], signal): Promise<DeepSeekToolCompletion> {
      // The whole-file arm sees exactly the tool surface that shipped before this change.
      const offered = tools.filter((tool) => options.exposeEditFile || tool.name !== 'edit_file');
      const response = await fetch(`${options.apiBase}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: messages.map(serialize),
          max_tokens: 8192,
          thinking: { type: 'disabled' },
          ...(offered.length ? {
            tools: offered.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
            tool_choice: 'auto',
          } : {}),
        }),
      });
      if (!response.ok) throw new Error(`DeepSeek API error ${response.status}: ${(await response.text()).slice(0, 200)}`);
      const data = await response.json() as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
      };
      usage.prompt += data.usage?.prompt_tokens ?? 0;
      usage.completion += data.usage?.completion_tokens ?? 0;
      usage.cached += data.usage?.prompt_cache_hit_tokens ?? 0;
      const choice = data.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('模型输出达到 Token 上限。');
      const calls: DeepSeekToolCall[] = (choice?.message?.tool_calls ?? []).map((call) => ({
        id: call.id, name: call.function.name, arguments: call.function.arguments,
      }));
      for (const call of calls) {
        toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
        // The payload a repair sends is the mechanism under test: a whole file versus a hunk.
        try {
          const parsed = JSON.parse(call.arguments) as { content?: unknown; edits?: unknown };
          if (call.name === 'write_file' && typeof parsed.content === 'string') wholeFilePayloadChars += parsed.content.length;
          if (call.name === 'edit_file') editPayloadChars += JSON.stringify(parsed.edits ?? []).length;
        } catch { /* a malformed call is the runtime's problem, not the measurement's */ }
      }
      const content = typeof choice?.message?.content === 'string' && choice.message.content.trim() ? choice.message.content.trim() : undefined;
      if (!content && !calls.length) throw new Error('DeepSeek API returned neither content nor a tool call.');
      return { ...(content ? { content } : {}), ...(calls.length ? { toolCalls: calls } : {}) };
    },
  };
  return client;
}

async function runOnce(arm: Arm, index: number, configuration: { apiKey: string; apiBase: string; model: string }): Promise<RunMetrics> {
  const root = join(outputRoot, `${arm}-${index}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'compile.mjs'), compileScript);
  await writeFile(join(root, 'verify.mjs'), suiteScript);
  await writeFile(join(root, 'src', 'limits.mjs'), draftLimits);
  await writeFile(join(root, 'src', 'boundary.mjs'), draftBoundary);

  const client = measuredClient({ ...configuration, exposeEditFile: arm === 'anchored' });
  const runtime = new WorkspaceTranslationRuntime({
    workspaceRoot: root,
    compileCommand: { executable: process.execPath, args: ['compile.mjs'], timeoutMs: 120_000 },
    verification: { command: { executable: process.execPath, args: ['verify.mjs'], timeoutMs: 120_000 }, protectedFiles: ['compile.mjs', 'verify.mjs'] },
    client,
    maxModelTurns,
    timeoutMs: 1_500_000,
  });
  const started = Date.now();
  let finished: WorkspaceTranslationRun;
  try {
    const run = runtime.start(request);
    let terminal: WorkspaceTranslationRun | undefined;
    for (let attempt = 0; attempt < 1800; attempt++) {
      const current = runtime.get(run.id);
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) { terminal = current; break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (!terminal) throw new Error('Run did not reach a terminal status.');
    finished = terminal;
  } finally {
    await runtime.shutdown();
  }
  const wallMs = Date.now() - started;
  const compilations = finished.compilations ?? [];
  const failedCompilations = compilations.filter((item) => !item.success).length;
  const verificationRuns = finished.verification?.runs.length ?? 0;
  const failedVerificationRuns = finished.verification?.runs.filter((item) => !item.success).length ?? 0;
  return {
    arm, index,
    status: finished.status,
    acceptance: finished.acceptance,
    ...(finished.error ? { error: finished.error } : {}),
    turns: finished.modelTurns,
    compilations: compilations.length,
    failedCompilations,
    verificationRuns,
    failedVerificationRuns,
    repairRounds: failedCompilations + failedVerificationRuns,
    wallMs,
    usage: { ...client.usage },
    toolCalls: { ...client.toolCalls },
    wholeFilePayloadChars: client.payload.wholeFilePayloadChars,
    editPayloadChars: client.payload.editPayloadChars,
    suitePassed: finished.status === 'completed' && finished.acceptance === 'behavior-verified',
  };
}

const total = (list: number[]) => list.reduce((sum, value) => sum + value, 0);
const mean = (list: number[]) => list.length ? Math.round(total(list) / list.length) : 0;

const configuration = credential();
console.log(`model=${configuration.model} runs=${runs} arms=${arms.join(',')} turns<=${maxModelTurns}\n`);
const results: RunMetrics[] = [];
for (let index = 1; index <= runs; index++) {
  for (const arm of arms) {
    process.stdout.write(`  ${arm} #${index} … `);
    try {
      const metrics = await runOnce(arm, index, configuration);
      results.push(metrics);
      console.log(`${metrics.status}/${metrics.acceptance ?? '-'} turns=${metrics.turns} repairs=${metrics.repairRounds} ` +
        `tokens=${metrics.usage.prompt}+${metrics.usage.completion} payload=${metrics.wholeFilePayloadChars}w/${metrics.editPayloadChars}e ` +
        `${(metrics.wallMs / 1000).toFixed(0)}s`);
    } catch (error) {
      console.log(`ERROR ${(error as Error).message}`);
      results.push({
        arm, index, status: 'error', acceptance: undefined, error: (error as Error).message,
        turns: 0, compilations: 0, failedCompilations: 0, verificationRuns: 0, failedVerificationRuns: 0,
        repairRounds: 0, wallMs: 0, usage: { prompt: 0, completion: 0, cached: 0 }, toolCalls: {},
        wholeFilePayloadChars: 0, editPayloadChars: 0, suitePassed: false,
      });
    }
  }
}

await mkdir(outputRoot, { recursive: true });
await writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify({ configuration, maxModelTurns, results }, null, 2)}\n`);

const header = ['arm', 'runs', 'passed', 'turns', 'repairs', 'completion tok', 'write chars', 'edit chars', 'wall s', 'edit_file calls'];
console.log(`\n${header.map((value, at) => value.padEnd([11, 5, 7, 7, 8, 15, 12, 11, 7, 14][at]!)).join('')}`);
for (const arm of arms) {
  const subset = results.filter((item) => item.arm === arm);
  const cells = [
    arm, String(subset.length), String(subset.filter((item) => item.suitePassed).length),
    String(mean(subset.map((item) => item.turns))), String(mean(subset.map((item) => item.repairRounds))),
    String(mean(subset.map((item) => item.usage.completion))), String(mean(subset.map((item) => item.wholeFilePayloadChars))),
    String(mean(subset.map((item) => item.editPayloadChars))), String(mean(subset.map((item) => Math.round(item.wallMs / 1000)))),
    String(total(subset.map((item) => item.toolCalls.edit_file ?? 0))),
  ];
  console.log(cells.map((value, at) => value.padEnd([11, 5, 7, 7, 8, 15, 12, 11, 7, 14][at]!)).join(''));
}
console.log(`\n详细结果：${join(outputRoot, 'summary.json')}`);
