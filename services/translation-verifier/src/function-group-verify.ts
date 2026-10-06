import {
  createSingleAgentFunctionGroupStrategy,
  type SingleAgentFunctionGroupTerminalResult,
} from "./strategies/single-agent-function-group/strategy.js";
import type { AgentHost } from "./host/agent.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
  VerificationPhase,
} from "./types.js";

export type FunctionGroupVerificationRunner = (
  input: FunctionGroupVerificationInput,
  strategy: "single-agent-function-group",
  phase: VerificationPhase,
) => Promise<FunctionGroupVerificationResult>;

function validateFunctionGroupInput(input: FunctionGroupVerificationInput): void {
  if (input.schemaVersion !== "3.0") throw new Error("Unsupported function-group verification schema version.");
  if (!input.functions.length) throw new Error("Function-group verification requires at least one function.");
  const targets = new Set<string>();
  for (const mapping of input.functions) {
    if (!mapping.source.path || !mapping.source.name || !mapping.target.path || !mapping.target.name) {
      throw new Error("Function-group verification functions require source and target paths and names.");
    }
    const key = `${mapping.target.path}\0${mapping.target.name}\0${mapping.target.signature ?? ""}`;
    if (targets.has(key)) throw new Error(`Duplicate target function in function group: ${mapping.target.path}#${mapping.target.name}`);
    targets.add(key);
  }
  if (!input.translationRun.id) throw new Error("Function-group verification requires a translation run id.");
}

export function createFunctionGroupVerifier(
  host: AgentHost<SingleAgentFunctionGroupTerminalResult>,
): FunctionGroupVerificationRunner {
  const strategies: Readonly<
    Record<string, FunctionGroupVerificationStrategy<FunctionGroupVerificationResult>>
  > = {
    "single-agent-function-group": createSingleAgentFunctionGroupStrategy(host),
  };

  return async (input, strategyId, phase) => {
    validateFunctionGroupInput(input);
    const strategy = strategies[strategyId];
    if (strategy === undefined) {
      throw new Error(`Unknown function-group verification strategy: ${strategyId}`);
    }

    const handler = strategy[phase];
    if (handler === undefined) {
      throw new Error(
        `Function-group verification strategy ${strategyId} does not implement phase: ${phase}`,
      );
    }
    return handler(input);
  };
}
