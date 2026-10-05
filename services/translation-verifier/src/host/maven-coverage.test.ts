import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseJacocoReport, parseSurefireReport, prepareMavenCoverage, collectMavenCoverage } from "./maven-coverage.js";

const subject = { path: "src/main/java/example/Order.java", name: "calculatePrice", signature: "public int calculatePrice(int quantity)" };
const source = "package example; public class Order {}";
function method(descriptor = "(I)I", executed = true, branches = true): string {
  return `<method name="calculatePrice" desc="${descriptor}"><counter type="METHOD" missed="${executed ? 0 : 1}" covered="${executed ? 1 : 0}"/><counter type="LINE" missed="${executed ? 2 : 8}" covered="${executed ? 6 : 0}"/>${branches ? '<counter type="BRANCH" missed="1" covered="3"/>' : ''}</method>`;
}
function report(methods = method()): string {
  return `<report name="test"><package name="example"><class name="example/Order" sourcefilename="Order.java">${methods}</class></package></report>`;
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Maven function coverage", () => {
  it("extracts method counters, not the class-wide counters", () => {
    expect(parseJacocoReport(report(), subject, source)).toEqual({
      name: "calculatePrice", executed: true, lineCoverage: 75, branchCoverage: 75,
    });
  });
  it("distinguishes an unexecuted method and a method with no branches", () => {
    expect(parseJacocoReport(report(method("(I)I", false, false)), subject, source)).toEqual({
      name: "calculatePrice", executed: false, lineCoverage: 0, branchCoverage: null,
    });
  });
  it("uses the signature to distinguish overloads and refuses ambiguous identities", () => {
    const xml = report(method() + method("(Ljava/lang/String;)I"));
    expect(parseJacocoReport(xml, subject, source).executed).toBe(true);
    expect(() => parseJacocoReport(xml, { ...subject, signature: undefined }, source)).toThrow("uniquely locate");
    expect(() => parseJacocoReport(xml, { ...subject, signature: "int calculatePrice(boolean value)" }, source)).toThrow("0 matches");
  });
  it("matches arrays, reference types and explicit JVM signatures", () => {
    const xml = report(method("([Ljava/lang/String;I)I"));
    expect(parseJacocoReport(xml, { ...subject, signature: "int calculatePrice(String[] values, int count)" }, source).executed).toBe(true);
    expect(parseJacocoReport(xml, { ...subject, signature: "([Ljava/lang/String;I)I" }, source).executed).toBe(true);
  });
  it("refuses other source files, packages, malformed XML and invalid counters", () => {
    expect(() => parseJacocoReport(report(), { ...subject, path: "src/Other.java" }, source)).toThrow("0 matches");
    expect(() => parseJacocoReport(report(), subject, "package other;")).toThrow("0 matches");
    expect(() => parseJacocoReport("<report>", subject, source)).toThrow("Invalid XML");
    expect(() => parseJacocoReport(report().replace('covered="6"', 'covered="NaN"'), subject, source)).toThrow("Invalid report counter");
  });
  it("does not count skipped tests as executed and includes execution errors as failures", () => {
    expect(parseSurefireReport('<testsuite tests="5" failures="1" errors="1" skipped="1"/>')).toEqual({
      executed: 4, passed: 2, failed: 2, skipped: 1,
    });
    expect(() => parseSurefireReport('<testsuite tests="1" failures="2" errors="0" skipped="0"/>')).toThrow("Inconsistent");
  });
  it("clears old reports and uses different execution data for each run", async () => {
    const root = await mkdtemp(join(tmpdir(), "verifier-coverage-")); roots.push(root);
    await mkdir(join(root, "target/site/jacoco"), { recursive: true });
    await mkdir(join(root, "target/surefire-reports"), { recursive: true });
    await writeFile(join(root, "target/site/jacoco/jacoco.xml"), report());
    await writeFile(join(root, "target/surefire-reports/TEST-old.xml"), '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
    const first = await prepareMavenCoverage(root), second = await prepareMavenCoverage(root);
    expect(first.dataDirectory).not.toBe(second.dataDirectory);
    await expect(readFile(join(root, "target/site/jacoco/jacoco.xml"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await collectMavenCoverage(root, subject)).coverage.status).toBe("unavailable");
  });
});
