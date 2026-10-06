import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindTestRunner } from "./test-runner.js";
import { MAX_TEST_OUTPUT_CHARS, type ToolRuntimeContext } from "./tools/common.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(script: string, timeoutMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), "verifier-runner-"));
  roots.push(root);
  await writeFile(join(root, "fake-runner.cjs"), script);
  const runtime: ToolRuntimeContext = {
    sourceLanguage: "Java", targetLanguage: "Java", sourceProjectPath: root, targetProjectPath: root,
    sourcePath: "src/Order.java", targetPath: "src/Order.java",
    targetFunction: { path: "src/Order.java", name: "calculatePrice" },
    sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "maven",
    targetTest: { executable: process.execPath, args: ["fake-runner.cjs"], timeoutMs },
  };
  return { root, runtime, runner: bindTestRunner({ runtime }) };
}

async function expectClean(root: string) {
  expect(await readdir(join(root, "target/translation-verifier-coverage"))).toEqual([]);
}

describe("bound test runner", () => {
  it("clears old Maven reports, isolates execution data and cleans each completed run", async () => {
    const { root, runtime, runner } = await fixture("process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    await mkdir(join(root, "target/site/jacoco"), { recursive: true });
    await mkdir(join(root, "target/surefire-reports"), { recursive: true });
    const oldReport = join(root, "target/site/jacoco/jacoco.xml");
    await writeFile(oldReport, "old coverage");
    await writeFile(join(root, "target/surefire-reports/TEST-old.xml"), '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
    // Changes to the caller's command cannot replace an already-bound runner.
    runtime.targetTest.executable = "invalid-after-binding";
    runtime.targetTest.args = [];
    const first = await runner.run("tests/OrderTest.java");
    const second = await runner.run("tests/OrderTest.java");
    expect(first).toMatchObject({ status: "success", coverage: { status: "unavailable" } });
    expect(first.tests).toBeUndefined();
    await expect(readFile(oldReport)).rejects.toMatchObject({ code: "ENOENT" });
    const firstArgs: string[] = JSON.parse(first.stdout), secondArgs: string[] = JSON.parse(second.stdout);
    expect(firstArgs).toContain("-Dtest=OrderTest");
    expect(firstArgs).toContain("-Djacoco.append=false");
    const dataFile = (args: string[]) => args.find(arg => arg.startsWith("-Djacoco.destFile="))!.split("=")[1];
    expect(dataFile(firstArgs)).not.toBe(dataFile(secondArgs));
    await expect(readdir(dirname(dataFile(firstArgs)))).rejects.toMatchObject({ code: "ENOENT" });
    await expectClean(root);
  });

  it("cleans a failed preparation and an invalid Host command", async () => {
    const { root, runtime, runner } = await fixture("");
    await expect(runner.run("tests/OrderTest.txt")).rejects.toThrow("Java test selector");
    await expectClean(root);
    runtime.targetTest.executable = "";
    await expect(bindTestRunner({ runtime }).run("tests/OrderTest.java")).rejects.toThrow("Host target test command is invalid");
    await expectClean(root);
  });

  it("returns process launch errors and nonzero exits as failures and cleans the run", async () => {
    const { root, runtime, runner } = await fixture("process.stderr.write('assertion failed'); process.exitCode = 1");
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({ status: "failure", exitCode: 1, stderr: "assertion failed" });
    await expectClean(root);
    runtime.targetTest.executable = join(root, "missing-executable");
    expect(await bindTestRunner({ runtime }).run("tests/OrderTest.java")).toMatchObject({ status: "failure", exitCode: null, timedOut: false });
    await expectClean(root);
  });

  it("retains timeout and output limits inside the runner", async () => {
    const { root, runner } = await fixture("process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)", 300);
    const result = await runner.run("tests/OrderTest.java");
    expect(result).toMatchObject({ status: "failure", timedOut: true });
    expect(result.stdout).toHaveLength(MAX_TEST_OUTPUT_CHARS);
    await expectClean(root);
  });

  it("retains failed test counts when fresh coverage is unavailable, even with exit code zero", async () => {
    const { root, runner } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite tests="2" failures="1" errors="0" skipped="0"/>');`);
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({
      status: "failure", exitCode: 0, tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
      coverage: { status: "unavailable" },
    });
    await expectClean(root);
  });
});
