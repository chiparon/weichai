import { stat } from "node:fs/promises";
import {
  assertTestPath,
  relativePath,
  resolveSafePath,
  type HostTool,
  type HostToolFactory,
  type ToolContext,
  type TargetTestResult,
} from "./common.js";

export type RunTargetTestsInput = {
  path: string;
};

function parseRunTargetTestsInput(value: unknown): RunTargetTestsInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("path" in value)
  ) {
    throw new Error("run_target_tests requires only path.");
  }
  return {
    path: relativePath((value as { path: unknown }).path, "test path"),
  };
}

function rootsDescription(testRoots: readonly string[]): string {
  return testRoots.length > 0 ? testRoots.join(", ") : "(none)";
}

export function createRunTargetTestsTool(): HostToolFactory {
  return (context: ToolContext): HostTool<RunTargetTestsInput, TargetTestResult> => {
    const testRoots = context.runtime.testRoots.map((root) =>
      relativePath(root, "test root"),
    );
    if (testRoots.length === 0) {
      throw new Error("run_target_tests requires at least one test root.");
    }

    return {
      name: "run_target_tests",
      description: `Run one ${context.runtime.targetLanguage} target test under these project-relative test roots: ${rootsDescription(testRoots)}. Use the fixed Host-selected ${context.runtime.testRunner} command and its output as verification evidence.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      parse: parseRunTargetTestsInput,
      async execute(input) {
        context.budget?.assertActive();
        context.state.lastTargetTest = undefined;
        const result = await runTargetTests(context, testRoots, input.path);
        context.budget?.assertActive();
        context.state.lastTargetTest = result;
        return result;
      },
    };
  };
}

async function runTargetTests(
  context: ToolContext,
  testRoots: readonly string[],
  testPath: string,
): Promise<TargetTestResult> {
  assertTestPath(testPath, testRoots);
  const absoluteTestPath = resolveSafePath(
    context.runtime.targetProjectPath,
    testPath,
  );
  let testStat: Awaited<ReturnType<typeof stat>>;
  try {
    testStat = await stat(absoluteTestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Test file does not exist: ${testPath}`);
    }
    throw error;
  }
  if (!testStat.isFile()) {
    throw new Error(`Test path is not a file: ${testPath}`);
  }

  return context.runner.run(testPath);
}
