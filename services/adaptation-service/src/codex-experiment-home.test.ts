import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { prepareDeepSeekCodexHome } from "./codex-experiment-home";

describe("isolated experiment Codex home", () => {
  it("writes a DeepSeek-only config and removes it on cleanup", async () => {
    const home = await prepareDeepSeekCodexHome({
      apiKey: "deepseek-test-key",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com/",
    });
    try {
      const config = await readFile(`${home.path}/config.toml`, "utf8");
      expect(home.generated).toBe(true);
      expect(config).toContain('model_provider = "deepseek"');
      expect(config).toContain('model = "deepseek-v4-pro"');
      expect(config).toContain('experimental_bearer_token = "deepseek-test-key"');
    } finally {
      await home.cleanup();
    }
    await expect(access(home.path)).rejects.toThrow();
  });

  it("does not require or modify a deliberately supplied home", async () => {
    const home = await prepareDeepSeekCodexHome({
      explicitHome: "/tmp/preconfigured-codex-home",
      model: "deepseek-v4-pro",
    });
    expect(home).toMatchObject({ path: "/tmp/preconfigured-codex-home", generated: false });
    await home.cleanup();
  });
});
