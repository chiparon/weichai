import type {
  AdaptationRequest,
  AnalysisReport,
  SearchCandidate,
  TargetModuleContext,
} from "@forexplore/contracts";
import { describe, expect, it, vi } from "vitest";
import { AdaptationAdapter, _buildFilePatch } from "./adaptation-adapter";

const javaCandidate: SearchCandidate = {
  id: "java-candidate",
  title: "calculate",
  repository: "fixture/java",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/Calculator.java",
  signature: "public double calculate()",
  summary: "Calculates a value.",
  score: { overall: 1, semantic: 1, symbol: 1, contract: 1 },
  preview: "public double calculate() { return 1.0; }",
  dependencies: [],
  compatibility: [],
  risks: [],
};

const request: AdaptationRequest = {
  target: {
    id: "target",
    name: "Calculate",
    kind: "function",
    path: "src/Calculator.cs",
    language: "C#",
    signature: "public decimal Calculate()",
  },
  candidate: javaCandidate,
  requirement: "Translate the calculation.",
  strategy: "translate",
  decisionNotes: "",
};

const context: TargetModuleContext = {
  targetFile: request.target.path,
  targetSource: "public decimal Calculate() { throw new NotImplementedException(); }",
  targetFragment: "public decimal Calculate() { throw new NotImplementedException(); }",
  imports: [],
  neighboringFiles: [],
  references: [],
  truncated: false,
};

const report: AnalysisReport = {
  schemaVersion: "1.0",
  applicability: { level: "adapt", confidence: 0.9, reasons: ["Return type conversion is required."] },
  behaviorMapping: [{ requirement: request.requirement, status: "covered", candidateEvidence: ["return 1.0"], targetAction: "Return decimal." }],
  contractMapping: [{ source: "double", target: "decimal", action: "convert", note: "Preserve the target contract." }],
  dependencyPlan: [],
  implementationPlan: ["Preserve the target signature.", "Translate the return value to decimal."],
  risks: [],
  assumptions: [],
  unresolved: [],
  blockingIssues: [],
};

describe("AdaptationAdapter language gate", () => {
  const adapter = new AdaptationAdapter({ apiKey: "not-used-by-gate-tests" });

  it("rejects non-Java candidates before invoking the translator", async () => {
    await expect(
      adapter.adapt({
        ...request,
        candidate: { ...javaCandidate, language: "Python" },
      }),
    ).rejects.toThrow(
      "Unsupported adaptation language pair: Python -> C#. Expected Java -> C#.",
    );
  });

  it("rejects non-C# targets before invoking the translator", async () => {
    await expect(
      adapter.adapt({
        ...request,
        target: { ...request.target, language: "TypeScript" },
      }),
    ).rejects.toThrow(
      "Unsupported adaptation language pair: Java -> TypeScript. Expected Java -> C#.",
    );
  });

  it("rejects strategies unsupported by the Java-to-C# adapter", async () => {
    await expect(adapter.adapt({ ...request, strategy: "wrap" })).rejects.toThrow(
      'AdaptationAdapter only supports the "translate" strategy; received "wrap".',
    );
  });
});

describe("AdaptationAdapter two-stage orchestration", () => {
  it("passes the analyzer report into translation and builds a Validator handoff", async () => {
    const analyze = vi.fn(async () => report);
    const translate = vi.fn(async () => "public decimal Calculate() { return 1.0m; }");
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      analyze,
      translate,
      contextCollector: { collect: () => context },
      compileStandalone: () => ({ success: true, errors: [], output: "ok" }),
      maxRetries: 0,
    });

    const result = await adapter.adapt(request);

    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ target: request.target, candidate: request.candidate, context }),
      undefined,
    );
    expect(translate).toHaveBeenCalledWith(
      expect.objectContaining({ analysisReport: report, targetContext: context, matchType: "partial" }),
      "test-key",
      undefined,
    );
    expect(result.analysisReport).toEqual(report);
    expect(result.interfaceMappings).toEqual(report.contractMapping);
    expect(result.validatorHandoff).toMatchObject({
      schemaVersion: "1.0",
      traceId: expect.any(String),
      target: request.target,
      candidate: { id: request.candidate.id },
      analysisReport: report,
      generatedCode: "public decimal Calculate() { return 1.0m; }",
    });
  });

  it("passes the analyzer report and target context to structured compiler repair", async () => {
    const analyze = vi.fn(async () => report);
    const repair = vi.fn(async () => "public decimal Calculate() { return 1.0m; }");
    let compileCalls = 0;
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      analyze,
      translate: async () => "public decimal Calculate() { return 1.0; }",
      repair,
      contextCollector: { collect: () => context },
      compileStandalone: () => {
        compileCalls += 1;
        return compileCalls === 1
          ? { success: false, errors: ["decimal literal requires m suffix"], output: "" }
          : { success: true, errors: [], output: "ok" };
      },
      maxRetries: 1,
    });

    await adapter.adapt(request);

    expect(repair).toHaveBeenCalledWith(
      expect.any(String),
      ["decimal literal requires m suffix"],
      request.target.signature,
      request.requirement,
      "test-key",
      undefined,
      expect.objectContaining({ analysisReport: report, targetContext: context }),
    );
  });

  it("stops before translation when the analyzer reports a blocking issue", async () => {
    const translate = vi.fn();
    const adapter = new AdaptationAdapter({
      apiKey: "test-key",
      analyze: async () => ({ ...report, blockingIssues: ["Target dependency is unresolved."] }),
      translate,
      contextCollector: { collect: () => context },
      compileStandalone: () => ({ success: true, errors: [], output: "ok" }),
    });

    await expect(adapter.adapt(request)).rejects.toThrow("Target dependency is unresolved");
    expect(translate).not.toHaveBeenCalled();
  });
});

describe("buildFilePatch", () => {
  const originalClass = [
    "using System;",
    "using System.Collections.Generic;",
    "",
    "namespace MyApp.Services",
    "{",
    "    public class RateQuoteService",
    "    {",
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            throw new NotImplementedException();",
    "        }",
    "",
    "        public void Initialize()",
    "        {",
    "            // setup",
    "        }",
    "    }",
    "}",
  ].join("\n");

  const newMethod = [
    "        public decimal GetRate(string currencyPair)",
    "        {",
    "            return 0.92m;",
    "        }",
  ].join("\n");

  it("produces a context-based hunk when originalContent and targetLine are provided", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, 8);

    expect(patch.status).toBe("modified");
    expect(patch.hunks).toHaveLength(1);

    const lines = patch.hunks[0].lines;
    const types = lines.map((l) => l.type);

    // 必须包含 context 行（用于定位）
    expect(types).toContain("context");
    // 必须包含 remove 行（旧方法代码被删除）
    expect(types).toContain("remove");
    // 必须包含 add 行（新方法代码被加入）
    expect(types).toContain("add");

    // context 行应该是原方法签名前的那一行
    const contextLines = lines.filter((l) => l.type === "context");
    expect(contextLines.some((l) => l.content.trim() === "{")).toBe(true);

    // remove 行应包含原方法的 throw 语句
    const removeLines = lines.filter((l) => l.type === "remove");
    expect(removeLines.some((l) => l.content.includes("throw new NotImplementedException"))).toBe(true);

    // add 行应包含新方法代码
    const addLines = lines.filter((l) => l.type === "add");
    expect(addLines.some((l) => l.content.includes("return 0.92m"))).toBe(true);
  });

  it("falls back to add-only patch when originalContent is null", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, null, 8);

    const lines = patch.hunks[0].lines;
    const types = [...new Set(lines.map((l) => l.type))];
    expect(types).toEqual(["add"]);
  });

  it("falls back to add-only patch when targetLine is undefined", () => {
    const patch = _buildFilePatch("src/Service.cs", newMethod, originalClass, undefined);

    const lines = patch.hunks[0].lines;
    const types = [...new Set(lines.map((l) => l.type))];
    expect(types).toEqual(["add"]);
  });
});
