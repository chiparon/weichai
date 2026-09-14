import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageRoot,
  VERIFIER_COMMAND_ENTRY,
} from "./test-execution-config.js";

describe("smoke helper paths", () => {
  it("resolves package and verifier-command paths", () => {
    expect(basename(packageRoot)).toBe("translation-verifier");
    expect(basename(dirname(packageRoot))).toBe("services");
    expect(VERIFIER_COMMAND_ENTRY).toBe(
      join(
        packageRoot,
        "src",
        "strategies",
        "smoke-differential",
        "controlled-test-command.ts",
      ),
    );
  });
});
