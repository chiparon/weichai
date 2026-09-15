import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyHunksStrict } from "@forexplore/workflow-core";
import { buildModuleMigrationPlan, recordModulePlanDecision } from "@forexplore/workflow-core";
import { analyzeRepository } from "@forexplore/code-indexer";
import {
  moduleMigrationSchemaVersion,
  type FunctionalModule,
  type ModuleMigrationProposal,
} from "@forexplore/contracts";
import type { DeepSeekToolCompletion } from "./deepseek-client";
import type { WorkspaceTranslationModelClient } from "./workspace-translation-agent";
import { ModuleWavePreparationRunner } from "./module-wave-preparation-runner";
import { WorkspaceModulePatchPreparer } from "./module-patch-preparer";

const roots: string[] = [];
const now = "2026-09-12T00:00:00.000Z";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const call = (name: string, args: Record<string, unknown> = {}): DeepSeekToolCompletion =>
  ({ content: "", toolCalls: [{ id: `tool-${name}`, name, arguments: JSON.stringify(args) }] });

const project = [
  "<Project Sdk=\"Microsoft.NET.Sdk\">",
  "  <PropertyGroup>",
  "    <OutputType>Exe</OutputType>",
  "    <TargetFramework>net8.0</TargetFramework>",
  "    <Nullable>enable</Nullable>",
  "    <ImplicitUsings>disable</ImplicitUsings>",
  "    <AssemblyName>Fixture</AssemblyName>",
  "    <RootNamespace>Fixture</RootNamespace>",
  "  </PropertyGroup>",
  "</Project>",
  "",
].join("\n");
const harness = [
  "using System;",
  "",
  "namespace Fixture",
  "{",
  "    public static class Harness",
  "    {",
  "        public static int Main()",
  "        {",
  "            if (Limit.Increment(0) != 1)",
  "            {",
  "                Console.Error.WriteLine(\"increment(0) must be 1\");",
  "                return 1;",
  "            }",
  "            try",
  "            {",
  "                Limit.Increment(-1);",
  "                Console.Error.WriteLine(\"negative input must be rejected\");",
  "                return 1;",
  "            }",
  "            catch (ArgumentOutOfRangeException)",
  "            {",
  "            }",
  "            Console.WriteLine(\"limit behavior verified\");",
  "            return 0;",
  "        }",
  "    }",
  "}",
  "",
].join("\n");
const stub = [
  "namespace Fixture",
  "{",
  "    public static class Limit",
  "    {",
  "        public static int Increment(int value)",
  "        {",
  "            return value + 1;",
  "        }",
  "    }",
  "}",
  "",
].join("\n");
const broken = stub.replace("return value + 1;", "return value + 1");
const good = [
  "using System;",
  "",
  "namespace Fixture",
  "{",
  "    public static class Limit",
  "    {",
  "        public static int Increment(int value)",
  "        {",
  "            if (value < 0)",
  "            {",
  "                throw new ArgumentOutOfRangeException(nameof(value), \"value must not be negative\");",
  "            }",
  "            return value + 1;",
  "        }",
  "    }",
  "}",
  "",
].join("\n");

const compileCommand = { executable: "dotnet", args: ["build", "Fixture.csproj", "--nologo", "-v", "q"], timeoutMs: 300_000 };
const verification = {
  command: { executable: "dotnet", args: ["exec", "bin/Debug/net8.0/Fixture.dll"], timeoutMs: 120_000 },
  protectedFiles: ["Program.cs"],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "forexplore-module-preparer-"));
  roots.push(root);
  const files: Record<string, string> = {
    ".gitignore": "bin/\nobj/\n",
    "Fixture.csproj": project,
    "Program.cs": harness,
    "src/Limit.cs": stub,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  git(root, ["init"]);
  git(root, ["config", "user.email", "forexplore@example.test"]);
  git(root, ["config", "user.name", "ForeXplore Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function limitModule(): FunctionalModule {
  return {
    id: "limit",
    name: "limit",
    kind: "feature",
    description: "Boundary-checked increment",
    purpose: "Increment a nonnegative value and reject negative input.",
    coreApis: ["Limit.Increment(int)"],
    sourceFiles: ["Program.cs", "src/Limit.cs"],
    symbolIds: [],
    dependsOn: [],
    writeSet: ["src/Limit.cs"],
    resourceLocks: [],
    evidenceIds: [],
  };
}

async function planFor(root: string, module: FunctionalModule) {
  const analysis = await analyzeRepository({ root, createdAt: now });
  const proposal: ModuleMigrationProposal = {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: analysis.snapshotId,
    objective: "Prepare the limit module",
    modules: [module],
    fileAssignments: [
      { path: "Program.cs", kind: "module", moduleId: module.id },
      { path: "src/Limit.cs", kind: "module", moduleId: module.id },
      { path: "Fixture.csproj", kind: "excluded", reason: "Project configuration is not migrated in this MVP." },
    ],
  };
  const plan = buildModuleMigrationPlan(analysis, proposal, { now });
  return {
    analysis,
    plan: recordModulePlanDecision(plan, {
      id: "plan-approval",
      kind: "plan-approval",
      status: "approved",
      snapshotId: plan.snapshotId,
      planHash: plan.planHash,
      actor: "reviewer",
      decidedAt: now,
    }, analysis.snapshotId, now),
  };
}

function scripted(steps: DeepSeekToolCompletion[]): WorkspaceTranslationModelClient {
  let turn = 0;
  return {
    complete: async () => {
      const next = steps[turn++];
      if (!next) throw new Error("Unexpected model turn");
      return next;
    },
  };
}

const singleStepPlan = {
  summary: "Reject negative input before incrementing",
  mappings: [{ source: "Limit.Increment", targetPath: "src/Limit.cs", targetSymbol: "Limit.Increment" }],
  dependencies: [],
  steps: [{ id: "limit", description: "Implement the boundary check", files: ["src/Limit.cs"], dependsOn: [] }],
};

describe("WorkspaceModulePatchPreparer", () => {
  it("prepares a module patch through compile, repair, behavioral acceptance, and restores its worktree", async () => {
    const root = await repository();
    const { analysis, plan } = await planFor(root, limitModule());
    const events: string[] = [];
    const runner = new ModuleWavePreparationRunner(new WorkspaceModulePatchPreparer({
      client: scripted([
        call("submit_plan", singleStepPlan),
        call("read_file", { path: "src/Limit.cs" }),
        call("write_file", { path: "src/Limit.cs", expectedHash: hash(stub), content: broken }),
        call("compile"),
        call("read_file", { path: "src/Limit.cs" }),
        call("write_file", { path: "src/Limit.cs", expectedHash: hash(broken), content: good }),
        call("complete_step", { stepId: "limit" }),
        call("compile"),
        call("run_tests"),
        call("finish"),
      ]),
      compileCommand,
      verification,
      maxModelTurns: 20,
      observe: (event) => events.push(event.phase),
    }));

    const prepared = await runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    });

    expect(prepared).toHaveLength(1);
    const module = prepared[0]!;
    expect(module.moduleId).toBe("limit");
    expect(module.files.map((file) => [file.path, file.status])).toEqual([["src/Limit.cs", "modified"]]);

    const patch = module.files[0]!;
    if (patch.status !== "modified") throw new Error("expected a modified-file patch");
    // The returned evidence reproduces the generated content exactly.
    expect(applyHunksStrict(stub, patch.hunks)).toBe(good);
    expect(patch.expectedOriginalSha256).toBe(hash(stub));

    // In-module evidence is explicitly non-required and non-authoritative.
    expect(module.validation.every((record) => record.required === false)).toBe(true);
    expect(module.validation.some((record) => record.id === "module-compile" && record.status === "pass")).toBe(true);
    expect(module.validation.some((record) => record.id === "module-behavior" && record.status === "pass")).toBe(true);
    expect(module.validation.some((record) => record.status === "fail")).toBe(false);
    expect(module.validation.some((record) => record.id === "module-evidence-scope")).toBe(true);

    // The source checkout is untouched, its worktree is restored and removed.
    expect(await readFile(path.join(root, "src", "Limit.cs"), "utf8")).toBe(stub);
    expect(git(root, ["status", "--porcelain"])).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain("forexplore-module-prepare-");
    expect(events).toEqual(["started", "restored"]);
  }, 300_000);

  it("fails the module instead of returning a partial patch when the model writes outside the write set", async () => {
    const root = await repository();
    const { analysis, plan } = await planFor(root, limitModule());
    const runner = new ModuleWavePreparationRunner(new WorkspaceModulePatchPreparer({
      client: scripted([
        call("submit_plan", singleStepPlan),
        call("read_file", { path: "src/Limit.cs" }),
        call("write_file", { path: "src/Escape.cs", expectedHash: null, content: good }),
        call("write_file", { path: "src/Limit.cs", expectedHash: hash(stub), content: good }),
        call("compile"),
        call("finish"),
      ]),
      compileCommand,
      verification,
      maxModelTurns: 8,
    }));

    await expect(runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    })).rejects.toThrow(/ended as failed/);

    expect(await readFile(path.join(root, "src", "Limit.cs"), "utf8")).toBe(stub);
    expect(git(root, ["status", "--porcelain"])).toBe("");
  }, 300_000);

  it("fails the module when the model exhausts its turn budget without finishing", async () => {
    const root = await repository();
    const { analysis, plan } = await planFor(root, limitModule());
    const runner = new ModuleWavePreparationRunner(new WorkspaceModulePatchPreparer({
      client: scripted([
        call("submit_plan", singleStepPlan),
        call("read_file", { path: "src/Limit.cs" }),
        call("write_file", { path: "src/Limit.cs", expectedHash: hash(stub), content: good }),
      ]),
      compileCommand,
      verification,
      maxModelTurns: 6,
    }));

    await expect(runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    })).rejects.toThrow(/ended as failed|exhausted its \d+-turn budget/);
  }, 300_000);
});


it('keeps the compiled full worktree through testing and preserves failed evidence outside it', async () => {
  const root = await repository();
  const { analysis, plan } = await planFor(root, limitModule());
  let observedRoot = '';
  const runner = new ModuleWavePreparationRunner(new WorkspaceModulePatchPreparer({
    client: scripted([call('submit_plan', singleStepPlan), call('read_file', { path: 'src/Limit.cs' }),
      call('write_file', { path: 'src/Limit.cs', expectedHash: hash(stub), content: good }),
      call('complete_step', { stepId: 'limit' }), call('compile'), call('finish')]),
    compileCommand,
    testVerifier: async input => {
      observedRoot = input.workspaceRoot;
      expect(input.compilation.success).toBe(true);
      expect(await readFile(path.join(observedRoot, 'src/Limit.cs'), 'utf8')).toBe(good);
      expect((await readFile(path.join(observedRoot, 'bin/Debug/net8.0/Fixture.dll'))).length).toBeGreaterThan(0);
      return { id: 'failed-tests', translationRunId: input.translationRunId, status: 'inconclusive', summary: 'fixture test environment unavailable',
        sourceSnapshot: '', reportConsistent: false, commands: [], cleanup: 'not-needed' };
    },
  }));
  await expect(runner.prepare({ repositoryRoot: root, analysis, plan, waveId: plan.executionWaves[0]!.id })).rejects.toThrow('fixture test environment unavailable');
  await expect(readFile(path.join(observedRoot, 'src/Limit.cs'))).rejects.toMatchObject({ code: 'ENOENT' });
  const directory = path.join(root, '.git', '.forexplore', 'workspace-translations');
  const records = await readdir(directory);
  expect(records).toHaveLength(1);
  expect(JSON.parse(await readFile(path.join(directory, records[0]!), 'utf8')).testRuns[0].summary).toBe('fixture test environment unavailable');
  expect(git(root, ['status', '--porcelain'])).toBe('');
});
