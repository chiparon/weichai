import type { AgentHost, AgentTask } from "../../host/agent.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createReportUncertainTool } from "../../host/tools/report-uncertain.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import { createRunFunctionGroupTestsTool } from "../../host/tools/run-function-group-tests.js";
import { createFinishFunctionGroupTool } from "../../host/tools/finish-function-group.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
} from "../../types.js";
import type { ReportUncertainResult } from "../../host/tools/report-uncertain.js";
import type { FinishFunctionGroupResult } from "../../host/tools/finish-function-group.js";

function formatFunction(path: string, name: string, signature?: string): string {
  return `${name}${signature ? ` (${signature})` : ""} in ${path}`;
}

export type SingleAgentFunctionGroupTerminalResult =
  | FinishFunctionGroupResult
  | Extract<ReportUncertainResult, { functionGroupTest: unknown }>;

function toVerificationResult(
  result: SingleAgentFunctionGroupTerminalResult,
): FunctionGroupVerificationResult {
  const test = result.functionGroupTest;
  return {
    status: "translationStatus" in result ? result.translationStatus : "failure",
    ...(result.issue ? { issue: result.issue } : {}),
    functions: test.functions,
  };
}

export function createSingleAgentFunctionGroupTask(
  input: FunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Function-group verification requires at least one function.");
  return {
    subject: {
      sourceFunction: first.source,
      targetFunction: first.target,
      requirement: input.requirement,
    },
    taskContext: {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.sourceProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: first.source.path,
      targetPath: first.target.path,
      targetFunction: { ...first.target },
      functionGroup: input,
    },
    functionGroup: input,
    systemPrompt: [
      "You are a translation verification agent for a group of target functions.",
      "Compare each source function with its mapped target function and determine whether the target preserves the required behavior.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "Create tests for the target function group in authorized target test roots, run run_function_group_tests, and use the Host result as the test status.",
      "The Host records a separate result for every target function; do not infer or invent coverage values.",
      "After the final test run, call finish_function_group with statuses matching the Host result.",
      "If the task cannot be verified reliably, call report_uncertain instead of guessing.",
      "A terminal tool call must be the only call in its turn.",
    ].join("\n"),
    userPrompt: [
      `Source language: ${input.sourceLanguage}`,
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.requirement}`,
      "Function mappings:",
      ...input.functions.map(({ source, target }) =>
        `- ${formatFunction(source.path, source.name, source.signature)} -> ${formatFunction(target.path, target.name, target.signature)}`,
      ),
      `Translation run: ${input.translationRun.id}`,
      `Translation evidence: ${JSON.stringify(input.translationRun)}`,
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
      createFinishFunctionGroupTool(),
      createReportUncertainTool(),
    ],
    terminalTools: ["finish_function_group", "report_uncertain"],
  };
}

export function createSingleAgentFunctionGroupStrategy(
  host: AgentHost<SingleAgentFunctionGroupTerminalResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(createSingleAgentFunctionGroupTask(input))),
  };
}
