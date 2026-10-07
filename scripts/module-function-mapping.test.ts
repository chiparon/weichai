import { describe, expect, it } from "vitest";
import type { ProjectModule } from "@forexplore/contracts";
import { buildModuleFunctionMapping, callableApiName } from "./module-function-mapping.js";

const target = (coreApis: string[], sourceFiles = ["src/OrderService.cs", "src/PriceRule.cs"]): ProjectModule => ({
  id: "target", name: "Orders", kind: "feature", description: "orders", sourceFiles, coreApis,
  symbolKeys: [], dependsOn: [], evidenceIds: [],
});

describe("module function mapping", () => {
  it("normalizes signatures and maps every unique API", () => {
    expect(callableApiName("public decimal OrderService::CalculatePrice(decimal amount)")).toBe("CalculatePrice");
    const result = buildModuleFunctionMapping(
      target(["OrderService.CalculatePrice(decimal)", "PriceRule.Apply(Order)"]),
      { sourceFiles: ["src/OrderService.cs", "src/PriceRule.cs"], coreApis: ["CalculatePrice(decimal)", "Apply(Order)"] },
    );
    expect(result.functions.map(({ target: item }) => item.name)).toEqual(["CalculatePrice", "Apply"]);
    expect(result.functions.map(({ target: item }) => item.path)).toEqual(["src/OrderService.cs", "src/PriceRule.cs"]);
    expect(result.unmatchedFunctions).toEqual([]);
  });

  it("keeps missing and ambiguous target APIs unmatched", () => {
    const result = buildModuleFunctionMapping(
      target(["OrderService.CalculatePrice", "OrderService.Missing", "PriceRule.Apply", "Other.Apply"]),
      { sourceFiles: ["src/OrderService.cs", "src/PriceRule.cs"], coreApis: ["CalculatePrice", "Apply"] },
    );
    expect(result.functions.map(({ target: item }) => item.name)).toEqual(["CalculatePrice"]);
    expect(result.unmatchedFunctions.map((item) => item.name)).toEqual(["Missing", "Apply", "Apply"]);
    expect(result.diagnostics.map((item) => item.reason)).toEqual(["no-source-api", "ambiguous-target-api", "ambiguous-target-api"]);
  });

  it("does not guess a file when several files are unrelated to the API qualifier", () => {
    const result = buildModuleFunctionMapping(
      target(["CalculatePrice"]),
      { sourceFiles: ["src/OrderService.cs", "src/PriceRule.cs"], coreApis: ["CalculatePrice"] },
    );
    expect(result.functions).toEqual([]);
    expect(result.unmatchedFunctions[0]?.path).toBe("src/OrderService.cs");
    expect(result.diagnostics[0]?.reason).toBe("source-file-ambiguous");
  });
});
