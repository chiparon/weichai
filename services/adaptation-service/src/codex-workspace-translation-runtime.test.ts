import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { CodexWorkspaceTranslationRuntime } from "./codex-workspace-translation-runtime";

async function eventually<T>(read: () => T, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (done(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return read();
}

describe("CodexWorkspaceTranslationRuntime", () => {
  it("copies only the history module, rejects out-of-scope edits, and keeps hidden criteria out of staging", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
    const history = await mkdtemp(join(tmpdir(), "forexplore-history-view-"));
    const scripts = await mkdtemp(join(tmpdir(), "codex-script-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      await writeFile(join(root, "visible.txt"), "visible\n");
      await writeFile(join(root, "hidden.txt"), "secret criteria\n");
      await mkdir(join(history, "source"));
      await writeFile(join(history, "source", "Legacy.cs"), "class Legacy { public int Answer() => 42; }\n");
      const historyContent = await readFile(join(history, "source", "Legacy.cs"));
      const manifestHash = createHash("sha256").update(JSON.stringify([["Legacy.cs", createHash("sha256").update(historyContent).digest("hex")]])).digest("hex");
      await writeFile(join(history, "manifest.json"), JSON.stringify({ repositoryId: "history", analysisRevision: "rev-1", moduleId: "legacy", runId: "00000000-0000-0000-0000-000000000001", files: [{ path: "Legacy.cs", sha256: createHash("sha256").update(historyContent).digest("hex") }] }));
      const codex = join(scripts, "fake-codex.mjs");
      await writeFile(codex, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const history = readFileSync('history-view/Legacy.cs', 'utf8');
const hiddenWasVisible = existsSync('target/hidden.txt');
const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
if (!existsSync('CODEX_IMPLEMENTATION_PLAN.json')) {
  writeFileSync(output, JSON.stringify({ summary:'implement answer', mappings:[{source:'Legacy.Answer',targetPath:'src.cs',targetSymbol:'Answer'}], dependencies:[], steps:[{id:'answer',description:'implement answer',files:['src.cs'],dependsOn:[]}] }));
} else {
  writeFileSync('target/src.cs', 'class Target { public int Answer() => ' + (history.includes('42') && !hiddenWasVisible ? '42' : '0') + '; }\\n');
  writeFileSync(output, 'done');
}
`);
      await chmod(codex, 0o755);
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        verification: { command: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 }, protectedFiles: ["hidden.txt"] },
        codexCommand: codex,
        maxModelTurns: 2,
        timeoutMs: 30_000,
      });
      const run = runtime.start({
        spec: "Implement Answer using the selected history implementation.", sourceLanguage: "C#", targetLanguage: "C#",
        context: [{ id: "candidate", kind: "summary", content: "Legacy module" }], workspaceFiles: ["src.cs"], writeFiles: ["src.cs"],
        historyView: { root: history, files: ["Legacy.cs"], repositoryId: "history", analysisRevision: "rev-1", moduleId: "legacy", runId: "00000000-0000-0000-0000-000000000001", manifestHash },
      });
      const completed = await eventually(() => runtime.get(run.id), value => ["completed", "failed", "cancelled"].includes(value.status));
      expect(completed.status).toBe("completed");
      expect(await readFile(join(root, "src.cs"), "utf8")).toContain("Answer() => 42");
      expect(completed.agent?.kind).toBe("codex");
      expect(completed.agent?.historyView?.files).toBe(1);
      expect(completed.plan?.steps.map(step => step.id)).toEqual(["answer"]);
      expect(completed.agent?.stages?.map(stage => [stage.stage, stage.sandbox])).toEqual([["analyzer", "read-only"], ["translator", "workspace-write"]]);
      expect(completed.agent?.stages?.every(stage => stage.readFiles?.includes("history-view/source/Legacy.cs"))).toBe(true);
      expect(completed.agent?.incrementalLines).toBeGreaterThan(0);
      await runtime.shutdown();
    } finally {
      await Promise.all([rm(root, { recursive: true, force: true }), rm(history, { recursive: true, force: true }), rm(scripts, { recursive: true, force: true })]);
    }
  });

  it("rejects traversal paths before a Codex process is started", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runtime-path-test-"));
    try {
      await writeFile(join(root, "src.cs"), "class Target { }\n");
      const runtime = new CodexWorkspaceTranslationRuntime({
        workspaceRoot: root,
        compileCommand: { executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        codexCommand: process.execPath,
      });
      expect(() => runtime.start({
        spec: "x", sourceLanguage: "C#", targetLanguage: "C#", context: [], workspaceFiles: ["src.cs"], writeFiles: ["../escape.cs"],
      })).toThrow(/Invalid workspace-relative file path/);
      await runtime.shutdown();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
