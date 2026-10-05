import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { VerificationFunction, TargetFunctionCoverage } from "../types.js";
import { readProjectFile, resolveSafePath, type TargetCoverageResult, type TestSummary } from "./tools/common.js";

const JACOCO = "org.jacoco:jacoco-maven-plugin:0.8.13";
export const MAVEN_COVERAGE_GOALS = [`${JACOCO}:prepare-agent`, "test", `${JACOCO}:report`] as const;
const REPORT_PATH = "target/site/jacoco/jacoco.xml";
const TEST_REPORTS = "target/surefire-reports";
const MAX_REPORT_BYTES = 16_000_000;

export type MavenCoverageRun = { args: string[]; dataDirectory: string };

/** Use fresh reports and a unique execution-data file; never reuse previous coverage. */
export async function prepareMavenCoverage(root: string): Promise<MavenCoverageRun> {
  const report = resolveSafePath(root, REPORT_PATH);
  const testReports = resolveSafePath(root, TEST_REPORTS);
  const dataDirectory = resolveSafePath(root, `target/translation-verifier-coverage/${randomUUID()}`);
  await rm(report, { force: true });
  await rm(testReports, { recursive: true, force: true });
  await mkdir(dataDirectory, { recursive: true });
  const dataFile = join(dataDirectory, "jacoco.exec");
  return {
    dataDirectory,
    args: [
      `-Djacoco.destFile=${dataFile}`, `-Djacoco.dataFile=${dataFile}`,
      "-Djacoco.append=false", "-DfailIfNoTests=true",
    ],
  };
}

export async function collectMavenCoverage(
  root: string, subject: VerificationFunction,
): Promise<{ tests?: TestSummary; coverage: TargetCoverageResult }> {
  let tests: TestSummary | undefined;
  try {
    const directory = resolveSafePath(root, TEST_REPORTS);
    const names = (await readdir(directory)).filter((name) => /^TEST-.*\.xml$/.test(name));
    if (names.length === 0) throw new Error("No Surefire test reports were produced.");
    tests = { executed: 0, passed: 0, failed: 0, skipped: 0 };
    for (const name of names) {
      const summary = parseSurefireReport(await readReport(resolveSafePath(root, `${TEST_REPORTS}/${name}`)));
      for (const key of ["executed", "passed", "failed", "skipped"] as const) tests[key] += summary[key];
    }
    const source = await readProjectFile(root, subject.path);
    const xml = await readReport(resolveSafePath(root, REPORT_PATH));
    return { tests, coverage: { status: "available", targetFunction: parseJacocoReport(xml, subject, source) } };
  } catch (error) {
    return {
      ...(tests ? { tests } : {}),
      coverage: { status: "unavailable", reason: error instanceof Error ? error.message : "Could not collect Maven coverage." },
    };
  }
}

type XmlNode = Record<string, any>;
function parseXml(xml: string): XmlNode {
  if (Buffer.byteLength(xml) > MAX_REPORT_BYTES) throw new Error("Coverage report exceeds the size limit.");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid XML test or coverage report.");
  return new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false,
    parseAttributeValue: false, processEntities: false,
    isArray: (name) => ["package", "class", "method", "counter", "testsuite", "testcase"].includes(name),
  }).parse(xml);
}

function count(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid report counter.");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid report counter.");
  return number;
}

export function parseSurefireReport(xml: string): TestSummary {
  const suites: XmlNode[] = parseXml(xml).testsuite ?? [];
  if (suites.length !== 1) throw new Error("Expected one Surefire test suite.");
  const suite = suites[0];
  const total = count(suite.tests);
  const skipped = count(suite.skipped);
  const failed = count(suite.failures) + count(suite.errors);
  if (skipped + failed > total) throw new Error("Inconsistent test counts.");
  return { executed: total - skipped, passed: total - skipped - failed, failed, skipped };
}

export function parseJacocoReport(
  xml: string, subject: VerificationFunction, source: string,
): TargetFunctionCoverage {
  const report = parseXml(xml).report;
  if (!report) throw new Error("Missing JaCoCo report.");
  const packageName = source.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1]?.replaceAll(".", "/") ?? "";
  const candidates: XmlNode[] = [];
  for (const pkg of report.package ?? []) {
    if (pkg.name !== packageName) continue;
    for (const cls of pkg.class ?? []) {
      if (cls.sourcefilename !== basename(subject.path)) continue;
      for (const method of cls.method ?? []) {
        if (method.name === subject.name) candidates.push(method);
      }
    }
  }
  const matching = subject.signature
    ? candidates.filter((method) => matchesSignature(method.desc, subject.signature!, subject.name))
    : candidates;
  if (matching.length !== 1) {
    throw new Error(`Cannot uniquely locate target function ${subject.name} in JaCoCo coverage (${matching.length} matches).`);
  }
  const counters: XmlNode[] = matching[0].counter ?? [];
  const method = counters.find((value) => value.type === "METHOD");
  if (!method || count(method.covered) + count(method.missed) !== 1) throw new Error("Missing or invalid method coverage counter.");
  return {
    name: subject.name,
    executed: count(method.covered) === 1,
    lineCoverage: percentage(counters, "LINE"),
    branchCoverage: percentage(counters, "BRANCH"),
  };
}

function percentage(counters: XmlNode[], type: string): number | null {
  const counter = counters.find((value) => value.type === type);
  if (!counter) return null;
  const covered = count(counter.covered), missed = count(counter.missed);
  return covered + missed === 0 ? null : Math.round(covered / (covered + missed) * 10_000) / 100;
}

/** Match JVM descriptors or ordinary Java signatures; ambiguous matches stay unavailable. */
function matchesSignature(descriptor: string, signature: string, name: string): boolean {
  if (signature.startsWith("(")) return descriptor === signature;
  const namePosition = signature.indexOf(`${name}(`);
  if (namePosition < 0) return false;
  const parameters = signature.slice(namePosition + name.length + 1).split(")")[0];
  if (parameters.includes("<")) return false;
  const requested = parameters.trim() === "" ? [] : parameters.split(",").map((value) =>
    value.trim().replace(/^final\s+/, "").replace(/\s+[\w$]+$/, "").replaceAll("...", "[]"),
  );
  const actual = descriptorParameters(descriptor);
  return requested.length === actual.length && requested.every((type, index) =>
    type === actual[index] || (!type.includes(".") && type === actual[index].split(".").pop()),
  );
}

function descriptorParameters(descriptor: string): string[] {
  const input = descriptor.slice(1, descriptor.indexOf(")"));
  const names: Record<string, string> = { B: "byte", C: "char", D: "double", F: "float", I: "int", J: "long", S: "short", Z: "boolean" };
  const result: string[] = [];
  for (let index = 0; index < input.length;) {
    let suffix = "";
    while (input[index] === "[") { suffix += "[]"; index++; }
    let type: string;
    if (input[index] === "L") {
      const end = input.indexOf(";", index);
      if (end < 0) throw new Error("Invalid JVM descriptor.");
      type = input.slice(index + 1, end).replaceAll("/", ".").replaceAll("$", ".");
      index = end + 1;
    } else {
      type = names[input[index++]];
      if (!type) throw new Error("Invalid JVM descriptor.");
    }
    result.push(type + suffix);
  }
  return result;
}

async function readReport(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_REPORT_BYTES) throw new Error("Coverage report exceeds the size limit.");
  return bytes.toString("utf8");
}
