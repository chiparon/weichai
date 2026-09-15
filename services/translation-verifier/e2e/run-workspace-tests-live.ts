import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "dotenv";
import { fileURLToPath } from "node:url";
import { WorkspaceTranslationRuntime } from "@forexplore/adaptation-service/workspace-translation-runtime";
import { createWorkspaceTranslationModelClient } from "@forexplore/adaptation-service/workspace-translation-agent";
import { createHttpServer } from "@forexplore/adaptation-service";
import type { WorkspaceTranslationRun } from "@forexplore/contracts";
import type { AddressInfo } from "node:net";
import { createWorkspaceTestVerifier } from "../src/workspace-test-verifier.js";

if (!process.argv.includes("--live"))
  throw new Error("Pass --live to authorize real DeepSeek calls.");
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const apiKey =
  process.env.DEEPSEEK_API_KEY ??
  parse(
    readFileSync(resolve(repositoryRoot, "services/adaptation-service/.env")),
  ).DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("DEEPSEEK_API_KEY is unavailable.");
const root = resolve(repositoryRoot, "e2e-runs/workspace-tests", randomUUID());
const repository = join(root, "repository"),
  worktree = join(root, "worktree");
mkdirSync(join(repository, "src"), { recursive: true });
const project: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "translation-worktree-e2e",
    private: true,
    type: "module",
    scripts: { build: "node compile.mjs" },
  }),
  ".gitignore": "dist/\n.forexplore/\n.forexplore-tests/\n",
  "compile.mjs": `import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs'; import { execFileSync } from 'node:child_process'; for (const file of ['limit.mjs','math.mjs']) execFileSync(process.execPath,['--check','src/'+file]); mkdirSync('dist',{recursive:true}); for (const file of ['limit.mjs','math.mjs']) copyFileSync('src/'+file,'dist/'+file); writeFileSync('dist/compiled.json',JSON.stringify({cwd:process.cwd(),at:Date.now()})); console.log('Compiled both modules.');\n`,
  "src/limit.mjs": "// Implement limit with the math helper.\n",
  "src/math.mjs": "// Implement increment.\n",
  "README.md":
    "Build using node compile.mjs. Production modules are copied to dist after syntax validation. Behavior tests must import dist/limit.mjs.\n",
};
for (const [path, content] of Object.entries(project))
  writeFileSync(join(repository, path), content);
const git = (args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], { stdio: "pipe" });
git(["init", "-q"]);
git(["add", "."]);
git([
  "-c",
  "user.name=E2E",
  "-c",
  "user.email=e2e@localhost",
  "commit",
  "-qm",
  "Full project baseline",
]);
git(["worktree", "add", "--detach", worktree, "HEAD"]);
const events: unknown[] = [];
const runtime = new WorkspaceTranslationRuntime({
  workspaceRoot: worktree,
  compileCommand: { executable: process.execPath, args: ["compile.mjs"] },
  client: createWorkspaceTranslationModelClient({
    apiKey: () => apiKey,
    temperature: 0,
  }),
  testVerifier: createWorkspaceTestVerifier({
    apiKey,
    timeoutMs: 240_000,
    onEvent: (event) => {
      events.push(event);
      console.log(JSON.stringify(event));
    },
  }),
  maxModelTurns: 40,
  maxTestRepairAttempts: 2,
  timeoutMs: 600_000,
});
const token = randomUUID();
const server = createHttpServer({
  adapter: {
    adapt: async () => {
      throw new Error("This fixture uses the workspace translation route.");
    },
  },
  workspaceTranslation: { runtime, bearerToken: token },
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/workspace-translations`;
const request = async (
  suffix: string,
  body?: unknown,
): Promise<WorkspaceTranslationRun> => {
  const response = await fetch(endpoint + suffix, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Workspace HTTP request failed: ${response.status}`);
  return (await response.json()) as WorkspaceTranslationRun;
};
console.log(
  JSON.stringify({
    artifactRoot: root,
    worktree,
    transport: "authenticated-http",
  }),
);
try {
  const started = await request("", {
    spec: 'Implement two real modules: src/math.mjs exports increment(value) returning value+1. src/limit.mjs imports increment and exports limit(value): for a negative number throw Error("negative"), for nonnegative numbers return increment(value). Preserve fractional values. Compile via host. Tests must import dist/limit.mjs, and verify dist/compiled.json cwd is the same worktree used for tests. Test normal, zero, negative and fractional cases.',
    sourceLanguage: "Python",
    targetLanguage: "JavaScript",
    workspaceFiles: Object.keys(project).filter(
      (path) => path !== ".gitignore",
    ),
    writeFiles: ["src/limit.mjs", "src/math.mjs"],
    context: [
      {
        id: "source",
        kind: "source",
        path: "limit.py",
        content:
          'def increment(value): return value + 1\ndef limit(value):\n    if value < 0: raise ValueError("negative")\n    return increment(value)\n',
      },
    ],
  });
  let run = await request(`/${started.id}`);
  while (
    ["analyzing", "translating", "compiling", "testing"].includes(run.status)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    run = await request(`/${started.id}`);
  }
  writeFileSync(join(root, "result.json"), JSON.stringify(run, null, 2));
  writeFileSync(join(root, "events.json"), JSON.stringify(events, null, 2));
  console.log(
    JSON.stringify({
      status: run.status,
      acceptance: run.acceptance,
      testRuns: run.testRuns?.map((test) => ({
        status: test.status,
        summary: test.summary,
        consistent: test.reportConsistent,
      })),
      error: run.error,
      artifactRoot: root,
    }),
  );
  if (
    run.status !== "completed" ||
    run.acceptance !== "behavior-verified" ||
    !run.testRuns?.length
  )
    process.exitCode = 1;
} finally {
  await runtime.shutdown();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
