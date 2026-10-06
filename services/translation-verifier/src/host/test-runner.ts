import { randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { parseJacocoReport, parseSurefireReport, parseCobertura, parseIstanbul, parseJUnit, parseNodeTests, parsePythonCoverage, parseTrx, jsonReport, type PythonFunction } from "./coverage-reports.js";
import { MAX_TEST_OUTPUT_CHARS, readProjectFile, resolveSafePath, type FunctionGroupTestRun, type FunctionGroupTestRunner, type ToolContext, type TargetTestResult, type TargetCoverageResult, type TestSummary } from "./tools/common.js";

const JACOCO = "org.jacoco:jacoco-maven-plugin:0.8.13";
export const MAVEN_COVERAGE_GOALS = [`${JACOCO}:prepare-agent`, "test", `${JACOCO}:report`] as const;
const MAVEN_REPORT_PATH = "target/site/jacoco/jacoco.xml";
const MAVEN_TEST_REPORTS = "target/surefire-reports";
type CoverageRun = { dataDirectory: string; args: string[]; env?: Record<string, string>; pythonFunctions?: PythonFunction[] };
type RunnerContext = Omit<ToolContext, "runner" | "state">;
export type BoundTestRunner = {
  run(testPath: string): Promise<TargetTestResult>;
};

/** Bind the command and framework capabilities before exposing tools to the Agent. */
export function bindTestRunner(context: RunnerContext): BoundTestRunner {
  const boundContext: RunnerContext = {
    budget: context.budget,
    runtime: {
      ...context.runtime,
      targetFunction: { ...context.runtime.targetFunction },
      targetTest: { ...context.runtime.targetTest, args: [...context.runtime.targetTest.args] },
    },
  };
  return { run: (testPath) => runTests(boundContext, testPath) };
}

/** Bind the same Host-controlled runner to every target function in a group. */
export function bindFunctionGroupTestRunner(context: RunnerContext): FunctionGroupTestRunner {
  const functions = context.runtime.functionGroup?.functions ?? [];
  return {
    run: async (testPaths) => {
      if (functions.length === 0) throw new Error("Function-group verification requires at least one target function.");
      if (testPaths.length === 0) throw new Error("Function-group verification requires at least one test path.");
      const results: Array<{ target: (typeof functions)[number]["target"]; result: TargetTestResult }> = [];
      for (const mapping of functions) {
        const targetContext: RunnerContext = {
          ...context,
          runtime: {
            ...context.runtime,
            targetPath: mapping.target.path,
            targetFunction: { ...mapping.target },
          },
        };
        for (const testPath of testPaths) {
          results.push({ target: mapping.target, result: await runTests(targetContext, testPath) });
        }
      }
      const first = results[0]?.result;
      const functionsResult = functions.map((mapping) => {
        const matching = results.filter((item) => item.target.path === mapping.target.path && item.target.name === mapping.target.name).map((item) => item.result);
        const coverage = matching.map((item) => item.coverage).find((item) => item?.status === "available");
        const failed = matching.some((item) => item.status === "failure");
        const executed = matching.some((item) => item.coverage?.status === "available" && item.coverage.targetFunction.executed);
        return {
          source: { ...mapping.source },
          target: { ...mapping.target },
          status: failed ? "failed" as const : executed ? "passed" as const : "unverified" as const,
          executed,
          lineCoverage: coverage?.status === "available" ? coverage.targetFunction.lineCoverage : null,
          branchCoverage: coverage?.status === "available" ? coverage.targetFunction.branchCoverage : null,
        };
      });
      const tests = first?.tests ?? { executed: 0, passed: 0, failed: 0, skipped: 0 };
      const status = results.some(({ result }) => result.status === "failure") ? "failure" as const : "success" as const;
      return {
        status,
        testPaths: [...testPaths],
        tests,
        functions: functionsResult,
        stdout: results.map(({ result }) => result.stdout).filter(Boolean).join("\n"),
        stderr: results.map(({ result }) => result.stderr).filter(Boolean).join("\n"),
        exitCode: results.find(({ result }) => result.exitCode !== 0)?.result.exitCode ?? 0,
      } satisfies FunctionGroupTestRun;
    },
  };
}

async function runTests(context: RunnerContext, testPath: string): Promise<TargetTestResult> {
  context.budget?.assertActive();
  const coverageRun = await prepareCoverage(context, testPath);
  try {
    const { executable } = context.runtime.targetTest;
    const args = [...context.runtime.targetTest.args, ...coverageRun.args];
    const timeoutMs = Math.min(
      context.runtime.targetTest.timeoutMs ?? 300_000,
      context.budget?.remainingMs() ?? Number.POSITIVE_INFINITY,
    );
    if (
      !executable ||
      executable.includes("\0") ||
      args.some((arg) => arg.includes("\0")) ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new Error("Host target test command is invalid.");
    }

    const startedAt = Date.now();
    const result = await new Promise<{
      exitCode: number | null;
      signal?: string;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve) => {
      const child = spawn(executable, args, {
        cwd: context.runtime.targetProjectPath,
        shell: false,
        env: { ...process.env, ...coverageRun.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const append = (current: string, chunk: Buffer | string): string => {
        const next = current + chunk.toString();
        return next.length <= MAX_TEST_OUTPUT_CHARS
          ? next
          : next.slice(0, MAX_TEST_OUTPUT_CHARS);
      };
      const finish = (value: { exitCode: number | null; signal?: string }) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({ ...value, stdout, stderr, timedOut });
      };

      child.stdout?.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => {
        stderr = append(stderr, error.message);
        finish({ exitCode: null });
      });
      child.once("close", (exitCode, signal) => {
        finish({ exitCode, signal: signal ?? undefined });
      });
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
    });

    const evidence = await collectCoverage(context, coverageRun);

    return {
      ...evidence,
      status: result.timedOut || result.exitCode !== 0 || ("tests" in evidence && (evidence.tests?.failed ?? 0) > 0) ? "failure" : "success",
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await rm(coverageRun.dataDirectory, { recursive: true, force: true });
  }
}

const runFile = promisify(execFile);
const PYTHON_FUNCTIONS = `import ast,json,sys
source=open(sys.argv[1],encoding='utf-8').read()
tree=ast.parse(source)
result=[]
def visit(node,prefix=''):
 for child in ast.iter_child_nodes(node):
  if isinstance(child,(ast.FunctionDef,ast.AsyncFunctionDef)):
   name=prefix+child.name
   nested=[{'start':n.lineno,'end':n.end_lineno} for n in ast.walk(child) if n is not child and isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef))]
   result.append({'name':name,'start':child.lineno,'end':child.end_lineno,'bodyStart':child.body[0].lineno,'nested':nested})
   visit(child,name+'.')
  elif isinstance(child,ast.ClassDef):
   visit(child,prefix+child.name+'.')
  else:
   visit(child,prefix)
visit(tree)
print(json.dumps(result))
`;

async function prepareCoverage(context: RunnerContext, testPath: string): Promise<CoverageRun> {
  const { targetProjectPath: root, testRunner: runner } = context.runtime;
  const directory = runner === "maven" ? "target/translation-verifier-coverage" : ".translation-verifier-coverage";
  const dataDirectory = resolveSafePath(root, `${directory}/${randomUUID()}`);
  await mkdir(dataDirectory, { recursive: true });
  try {
    return await configureRunnerCoverage(context, testPath, dataDirectory);
  } catch (error) {
    await rm(dataDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function configureRunnerCoverage(context: RunnerContext, testPath: string, dataDirectory: string): Promise<CoverageRun> {
  const { targetProjectPath: root, testRunner: runner, targetFunction: subject } = context.runtime;
  if (runner === "maven") {
    if (!/\.(?:java|kt)$/i.test(testPath)) throw new Error(`Java test selector requires a .java or .kt file: ${testPath}`);
    const className = testPath.slice(testPath.lastIndexOf("/") + 1).replace(/\.(?:java|kt)$/i, "");
    await rm(resolveSafePath(root, MAVEN_REPORT_PATH), { force: true });
    await rm(resolveSafePath(root, MAVEN_TEST_REPORTS), { recursive: true, force: true });
    const dataFile = join(dataDirectory, "jacoco.exec");
    return { dataDirectory, args: [
      `-Djacoco.destFile=${dataFile}`, `-Djacoco.dataFile=${dataFile}`,
      "-Djacoco.append=false", "-DfailIfNoTests=true", `-Dtest=${className}`,
    ] };
  }
  const tests = join(dataDirectory, "tests.json");
  if (runner === "jest") return { dataDirectory, args: ["--runTestsByPath", testPath, `--roots=${await realpath(root)}`, "--coverage", `--collectCoverageFrom=${subject.path}`, "--coverageReporters=json", `--coverageDirectory=${dataDirectory}`, "--json", `--outputFile=${tests}`] };
  if (runner === "vitest") return { dataDirectory, args: ["--run", testPath, "--coverage", `--coverage.include=${subject.path}`, "--coverage.reporter=json", `--coverage.reportsDirectory=${dataDirectory}`, "--reporter=json", `--outputFile=${tests}`] };
  if (runner === "pytest") {
    const { stdout } = await runFile(context.runtime.targetTest.executable, ["-c", PYTHON_FUNCTIONS, resolveSafePath(root, subject.path)], { cwd: root, timeout: Math.min(10_000, context.budget?.remainingMs() ?? 10_000), maxBuffer: 1_000_000 });
    return { dataDirectory, pythonFunctions: jsonReport(stdout), env: { COVERAGE_FILE: join(dataDirectory, ".coverage") },
      args: [testPath, `--cov=${root}`, "--cov-branch", `--cov-report=json:${join(dataDirectory, "coverage.json")}`, `--junitxml=${join(dataDirectory, "tests.xml")}`] };
  }
  if (runner === "gradle") {
    const script = join(dataDirectory, "coverage.gradle");
    const quoted = (path: string) => JSON.stringify(path);
    await writeFile(script, `allprojects { p ->
  p.afterEvaluate {
    if (p == rootProject && p.plugins.hasPlugin('java')) {
      p.apply plugin: 'jacoco'
      p.jacoco.toolVersion = '0.8.13'
      p.tasks.named('test') {
        jacoco.destinationFile = p.file(${quoted(join(dataDirectory, "jacoco.exec"))})
        reports.junitXml.outputLocation.set(p.file(${quoted(join(dataDirectory, "tests"))}))
      }
      p.tasks.named('jacocoTestReport') {
        executionData.setFrom(p.file(${quoted(join(dataDirectory, "jacoco.exec"))}))
        reports.xml.required.set(true)
        reports.xml.outputLocation.set(p.file(${quoted(join(dataDirectory, "jacoco.xml"))}))
        reports.html.required.set(false)
        reports.csv.required.set(false)
      }
    }
  }
}
`);
    if (!/\.(java|kt)$/.test(testPath)) throw new Error("Gradle selector requires a Java/Kotlin test file.");
    const name = testPath.split("/").pop()!.replace(/\.(java|kt)$/, "");
    return { dataDirectory, args: ["--tests", `*.${name}`, "jacocoTestReport", "--init-script", script, "--rerun-tasks", "--no-build-cache"] };
  }
  if (runner === "dotnet") {
    const projects = context.runtime.targetTest.args.filter(arg => arg.endsWith(".csproj"));
    if (projects.length !== 1 || !testPath.startsWith(`${projects[0].slice(0, projects[0].lastIndexOf("/"))}/`)) throw new Error("C# test file does not belong to the bound test project.");
    const source = await readProjectFile(root, testPath);
    const namespaces = [...source.matchAll(/\bnamespace\s+([\w.]+)/g)];
    const classes = [...source.matchAll(/\bclass\s+(\w+)/g)];
    if (classes.length !== 1 || namespaces.length > 1) throw new Error("C# test selector requires one test class and at most one namespace.");
    const className = [namespaces[0]?.[1], classes[0][1]].filter(Boolean).join(".");
    return { dataDirectory, args: ["--filter", `FullyQualifiedName~${className}.`, "--collect:XPlat Code Coverage", "--results-directory", dataDirectory, "--logger", "trx;LogFileName=tests.trx"] };
  }
  throw new Error(`Unsupported coverage runner: ${runner}`);
}

async function report(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.length > 16_000_000) throw new Error("Report exceeds the size limit.");
  return bytes.toString("utf8");
}
async function collectCoverage(context: RunnerContext, run: CoverageRun): Promise<{ tests?: TestSummary; coverage: TargetCoverageResult }> {
  let tests: TestSummary | undefined;
  const { testRunner: runner, targetFunction: subject, targetProjectPath: root } = context.runtime;
  const canonicalRoot = await realpath(root);
  const reportDirectory = relative(canonicalRoot, run.dataDirectory);
  const read = (path: string) => report(resolveSafePath(root, `${reportDirectory}/${path}`));
  try {
    let targetFunction;
    if (runner === "jest" || runner === "vitest") {
      tests = parseNodeTests(await read("tests.json"));
      targetFunction = parseIstanbul(await read("coverage-final.json"), canonicalRoot, subject, await readProjectFile(root, subject.path));
    } else if (runner === "pytest") {
      tests = parseJUnit(await read("tests.xml"));
      targetFunction = parsePythonCoverage(await read("coverage.json"), canonicalRoot, subject, run.pythonFunctions!);
    } else if (runner === "maven" || runner === "gradle") {
      const testDirectory = runner === "maven" ? resolveSafePath(root, MAVEN_TEST_REPORTS) : join(run.dataDirectory, "tests");
      const names = (await readdir(testDirectory)).filter(name => /^TEST-.*\.xml$/.test(name));
      if (names.length === 0) throw new Error(`Missing ${runner} test reports.`);
      tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
      for (const name of names) {
        const xml = runner === "maven" ? await report(resolveSafePath(root, `${MAVEN_TEST_REPORTS}/${name}`)) : await read(`tests/${name}`);
        const value = runner === "maven" ? parseSurefireReport(xml) : parseJUnit(xml);
        for (const key of ["executed", "passed", "failed", "skipped"] as const) tests[key] += value[key];
      }
      const xml = runner === "maven" ? await report(resolveSafePath(root, MAVEN_REPORT_PATH)) : await read("jacoco.xml");
      targetFunction = parseJacocoReport(xml, subject, await readProjectFile(root, subject.path));
    } else if (runner === "dotnet") {
      tests = parseTrx(await read("tests.trx"));
      const names = await readdir(run.dataDirectory, { recursive: true });
      const coverage = names.filter(name => /^[0-9a-f-]{36}[\\/]coverage\.cobertura\.xml$/i.test(name));
      if (coverage.length !== 1) throw new Error("Expected one Coverlet Cobertura report in a VSTest run directory.");
      targetFunction = parseCobertura(await read(coverage[0]), subject, canonicalRoot);
    } else throw new Error(`Unsupported coverage runner: ${runner}`);
    return { tests, coverage: { status: "available", targetFunction } };
  } catch (error) {
    return { ...(tests ? { tests } : {}), coverage: { status: "unavailable", reason: error instanceof Error ? error.message : "Could not collect coverage." } };
  }
}
