import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface DeepSeekCodexHomeOptions {
  /** A preconfigured home can be supplied when the key is managed elsewhere. */
  explicitHome?: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

export interface CodexHomeHandle {
  path: string;
  generated: boolean;
  cleanup(): Promise<void>;
}

/**
 * Give an experiment its own Codex provider configuration. This prevents the
 * user's interactive Codex provider/model from affecting RECAST translation.
 */
export async function prepareDeepSeekCodexHome(options: DeepSeekCodexHomeOptions): Promise<CodexHomeHandle> {
  if (options.explicitHome?.trim()) {
    return { path: options.explicitHome.trim(), generated: false, cleanup: async () => undefined };
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to create the isolated experiment Codex configuration.");
  }
  const model = options.model.trim();
  if (!model) throw new Error("The isolated experiment Codex model cannot be empty.");
  const baseUrl = (options.baseUrl?.trim() || "https://api.deepseek.com/").replace(/\s/g, "");
  let parsed: URL;
  try { parsed = new URL(baseUrl); }
  catch { throw new Error("ADAPTATION_CODEX_BASE_URL must be a valid HTTP(S) URL."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ADAPTATION_CODEX_BASE_URL must be a valid HTTP(S) URL.");
  }

  const home = await mkdtemp(join(tmpdir(), "forexplore-codex-home-"));
  try {
    await chmod(home, 0o700);
    const config = [
      'model_provider = "deepseek"',
      `model = ${tomlString(model)}`,
      "",
      "[model_providers.deepseek]",
      'name = "deepseek"',
      `base_url = ${tomlString(baseUrl)}`,
      'wire_api = "responses"',
      `experimental_bearer_token = ${tomlString(apiKey)}`,
      "",
    ].join("\n");
    await writeFile(join(home, "config.toml"), config, { mode: 0o600 });
    return { path: home, generated: true, cleanup: async () => { await rm(home, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
