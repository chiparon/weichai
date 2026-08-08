/**
 * CodeAdaptationPort 实现 — 核心编排
 *
 * 流程: LLM翻译 → 独立编译 → 自动修复(最多3轮) → 集成编译 → 生成结果
 */

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AnalysisReport,
  AnalysisRequest,
  AnalysisResult,
  AnalyzerRequest,
  AdaptationRequest,
  AdaptationResult,
  FilePatch,
  InterfaceMapping,
  Language,
  TargetModuleContext,
  ValidatorHandoff,
} from "@forexplore/contracts";
import type { CodeAdaptationPort, CodeAnalysisPort } from "@forexplore/workflow-core";
import { translateJavaToCSharp, fixCompileErrors } from "./translator";
import type { TranslateRequest } from "./translator";
import { analyzeModule } from "./analyzer";
import { ContextCollector } from "./context-collector";
import {
  compileIntegrated,
  compileStandalone,
  isCompilerUnavailable,
} from "./compiler";
import type { CompileResult } from "./compiler";

const MAX_RETRIES = 3;

export interface AdaptationAdapterOptions {
  /** DeepSeek API key */
  apiKey: string;
  /** C# skeleton 项目根目录（可选，有则启用集成编译） */
  skeletonProjectPath?: string;
  /** 目标项目根目录（可选，有则生成定点 context patch 而非全量替换） */
  projectRoot?: string;
  /** Analyzer 注入点，测试和替换模型时使用。 */
  analyze?: AnalyzerFunction;
  /** 目标上下文收集器注入点。 */
  contextCollector?: Pick<ContextCollector, "collect">;
  /** Translator 注入点，验证两阶段交接或替换实现时使用。 */
  translate?: TranslatorFunction;
  /** 编译器和修复器注入点，用于无外部工具的编排测试。 */
  compileStandalone?: StandaloneCompilerFunction;
  compileIntegrated?: IntegratedCompilerFunction;
  repair?: RepairFunction;
  maxRetries?: number;
}

export type AnalyzerFunction = (
  request: AnalyzerRequest,
  signal?: AbortSignal,
) => Promise<AnalysisReport>;

export type TranslatorFunction = (
  request: TranslateRequest,
  apiKey: string,
  signal?: AbortSignal,
) => Promise<string>;

export type StandaloneCompilerFunction = (code: string, className: string) => CompileResult;
export type IntegratedCompilerFunction = (
  code: string,
  projectPath: string,
  targetFilePath: string,
) => CompileResult;
export type RepairFunction = typeof fixCompileErrors;

export class AdaptationAdapter implements CodeAdaptationPort, CodeAnalysisPort {
  #apiKey: string;
  #skeletonProjectPath?: string;
  #projectRoot?: string;
  #analyze: AnalyzerFunction;
  #contextCollector: Pick<ContextCollector, "collect">;
  #translate: TranslatorFunction;
  #compileStandalone: StandaloneCompilerFunction;
  #compileIntegrated: IntegratedCompilerFunction;
  #repair: RepairFunction;
  #maxRetries: number;

  constructor(options: AdaptationAdapterOptions) {
    this.#apiKey = options.apiKey;
    this.#skeletonProjectPath = options.skeletonProjectPath;
    this.#projectRoot = options.projectRoot;
    this.#analyze = options.analyze ?? ((request, signal) =>
      analyzeModule(request, { apiKey: this.#apiKey }, signal));
    this.#contextCollector = options.contextCollector ?? new ContextCollector({
      projectRoot: options.projectRoot,
    });
    this.#translate = options.translate ?? translateJavaToCSharp;
    this.#compileStandalone = options.compileStandalone ?? compileStandalone;
    this.#compileIntegrated = options.compileIntegrated ?? compileIntegrated;
    this.#repair = options.repair ?? fixCompileErrors;
    this.#maxRetries = Math.max(0, Math.min(options.maxRetries ?? MAX_RETRIES, MAX_RETRIES));
  }

  async adapt(
    request: AdaptationRequest,
    signal?: AbortSignal,
  ): Promise<AdaptationResult> {
    assertSupportedTranslation(request);
    const { context: targetContext, report: analysisReport } = await this.analyze(
      request,
      signal,
    );
    if (analysisReport.applicability.level === "reject" || analysisReport.blockingIssues.length > 0) {
      throw new Error(
        `Analyzer blocked candidate "${request.candidate.id}": ${[
          ...analysisReport.applicability.reasons,
          ...analysisReport.blockingIssues,
        ].join("; ")}`,
      );
    }
    const matchType = analysisMatchType(analysisReport, request);

    // ===== Step 1: LLM 翻译 =====
    let csharpCode = await this.#translate(
      {
        javaSource: request.candidate.preview,
        csharpSignature: request.target.signature,
        requirement: request.requirement,
        matchType,
        analysisReport,
        targetContext,
      },
      this.#apiKey,
      signal,
    );

    // ===== Step 2: 编译 + 自动修复 =====
    let standaloneResult = this.#compileStandalone(csharpCode, request.target.name);
    let integratedResult = this.#skeletonProjectPath
      ? this.#compileIntegrated(csharpCode, this.#skeletonProjectPath, request.target.path)
      : null;
    let retries = 0;
    let repairResult = integratedResult ?? standaloneResult;

    while (
      !repairResult.success &&
      !isCompilerUnavailable(repairResult) &&
      retries < this.#maxRetries
    ) {
      csharpCode = await this.#repair(
        csharpCode,
        repairResult.errors,
        request.target.signature,
        request.requirement,
        this.#apiKey,
        signal,
      );
      standaloneResult = this.#compileStandalone(csharpCode, request.target.name);
      integratedResult = this.#skeletonProjectPath
        ? this.#compileIntegrated(csharpCode, this.#skeletonProjectPath, request.target.path)
        : null;
      repairResult = integratedResult ?? standaloneResult;
      retries++;
    }

    // ===== Step 3: 生成映射 =====
    const mappings = buildMappings(request.candidate.preview, csharpCode, analysisReport);

    // ===== Step 4: 生成 FilePatch =====
    const originalContent = readOriginalIfAvailable(
      this.#projectRoot,
      request.target.path,
    );
    const patch = buildFilePatch(
      request.target.path,
      csharpCode,
      originalContent,
      request.target.line,
    );

    const validation = [
      {
        label: "独立编译",
        status: standaloneResult.success ? "pass" as const : "warn" as const,
        detail: standaloneResult.success
          ? "编译通过"
          : standaloneResult.errors.slice(0, 3).join("; "),
      },
      {
        label: "集成编译",
        status: integratedResult?.success ? "pass" as const : "warn" as const,
        detail: integratedResult
          ? integratedResult.success
            ? "编译通过"
            : integratedResult.errors.slice(0, 3).join("; ")
          : "未执行（需 skeleton 项目路径）",
      },
    ];
    const validatorHandoff: ValidatorHandoff = {
      schemaVersion: "1.0",
      traceId: randomUUID(),
      target: request.target,
      candidate: {
        id: request.candidate.id,
        repository: request.candidate.repository,
        path: request.candidate.path,
        language: request.candidate.language,
        signature: request.candidate.signature,
      },
      requirement: request.requirement,
      analysisReport,
      generatedCode: csharpCode,
      interfaceMappings: mappings,
      preValidation: validation,
      files: [patch],
    };

    return {
      strategy: request.strategy,
      targetLanguage: "C#" as Language,
      generatedCode: csharpCode,
      interfaceMappings: mappings,
      analysisReport,
      validation,
      files: [patch],
      validatorHandoff,
    };
  }

  async analyze(
    request: AnalysisRequest,
    signal?: AbortSignal,
  ): Promise<AnalysisResult> {
    assertSupportedLanguagePair(request);
    const context = this.#contextCollector.collect(request.target);
    const report = await this.#analyze(
      {
        target: request.target,
        candidate: request.candidate,
        requirement: request.requirement,
        context,
      },
      signal,
    );
    return { report, context };
  }
}

// ---- helpers ----

function assertSupportedTranslation(request: AdaptationRequest): void {
  if (request.strategy !== "translate") {
    throw new Error(
      `AdaptationAdapter only supports the "translate" strategy; received "${request.strategy}".`,
    );
  }
  assertSupportedLanguagePair(request);
}

function assertSupportedLanguagePair(request: AnalysisRequest): void {
  if (request.candidate.language !== "Java" || request.target.language !== "C#") {
    throw new Error(
      `Unsupported adaptation language pair: ${request.candidate.language} -> ${request.target.language}. Expected Java -> C#.`,
    );
  }
}

function inferMatchType(request: AdaptationRequest): "exact" | "partial" | "different" {
  const notes = request.decisionNotes.toLowerCase();
  if (notes.includes("partial") || notes.includes("部分")) return "partial";
  if (notes.includes("different") || notes.includes("不同")) return "different";
  return "exact";
}

function analysisMatchType(
  report: AnalysisReport,
  request: AdaptationRequest,
): "exact" | "partial" | "different" {
  if (report.applicability.level === "direct") return "exact";
  if (report.applicability.level === "adapt") return "partial";
  if (report.applicability.level === "reference") return "different";
  return inferMatchType(request);
}

/** 从 Java 源码和 C# 代码中推断类型映射 */
function buildMappings(
  _javaSource: string,
  _csharpCode: string,
  analysisReport?: AnalysisReport,
): InterfaceMapping[] {
  if (analysisReport?.contractMapping.length) {
    return analysisReport.contractMapping.map((mapping) => ({ ...mapping }));
  }
  const rules: Array<[string, string, InterfaceMapping["action"]]> = [
    ["double", "decimal", "convert"],
    ["List<", "List<", "preserve"],
    ["boolean", "bool", "convert"],
    ["String", "string", "convert"],
    ["Map<", "Dictionary<", "convert"],
    ["public class", "public class", "preserve"],
  ];

  return rules
    .filter(([java]) => _javaSource.includes(java))
    .map(([source, target, action]) => ({
      source,
      target,
      action,
      note: typeMapNote(action, source, target),
    }));
}

function typeMapNote(
  action: InterfaceMapping["action"],
  source: string,
  target: string,
): string {
  switch (action) {
    case "convert":
      return `${source} -> ${target} 类型转换`;
    case "preserve":
      return `${source} 保持一致`;
    default:
      return `${source} -> ${target}`;
  }
}

function readOriginalIfAvailable(
  projectRoot: string | undefined,
  filePath: string,
): string | null {
  if (!projectRoot) return null;
  const fullPath = join(projectRoot, filePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;
}

function buildFilePatch(
  filePath: string,
  newCode: string,
  originalContent: string | null,
  targetLine?: number,
): FilePatch {
  const newLines = newCode.split("\n");

  // 无法做定点 patch 时回退到全量替换
  if (!originalContent || targetLine == null) {
    return {
      path: filePath,
      status: "modified",
      additions: newLines.length,
      deletions: 0,
      hunks: [
        {
          header: `@@ -0,0 +1,${newLines.length} @@`,
          lines: newLines.map((content) => ({
            type: "add" as const,
            content,
          })),
        },
      ],
    };
  }

  // 定点 patch：用括号匹配找到原方法体范围
  const originalLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  const startIdx = Math.max(0, targetLine - 1);

  // 找到方法体的闭合大括号
  const endIdx = findMethodEnd(originalLines, startIdx);
  const removedLines = originalLines.slice(startIdx, endIdx + 1);

  // 用原方法签名作为 context 行来定位
  const contextBefore = startIdx > 0 ? originalLines[startIdx - 1] : null;
  const contextAfter =
    endIdx < originalLines.length - 1 ? originalLines[endIdx + 1] : null;

  const hunkLines: FilePatch["hunks"][number]["lines"] = [];

  // 前置 context：方法体前一行（通常是类声明或空行）
  if (contextBefore) {
    hunkLines.push({ type: "context", content: contextBefore });
  }

  // 原方法所有行标记为 remove
  for (const line of removedLines) {
    hunkLines.push({ type: "remove", content: line });
  }

  // 新方法所有行标记为 add
  for (const line of newLines) {
    hunkLines.push({ type: "add", content: line });
  }

  // 后置 context：方法体后一行
  if (contextAfter) {
    hunkLines.push({ type: "context", content: contextAfter });
  }

  return {
    path: filePath,
    status: "modified",
    additions: newLines.length,
    deletions: removedLines.length,
    hunks: [{ header: `@@ -${startIdx + 1},${removedLines.length} +${startIdx + 1},${newLines.length} @@`, lines: hunkLines }],
  };
}

/** 从 startIdx 开始，用括号深度匹配找到方法/代码块的结束行（0-based 索引） */
function findMethodEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth === 0) {
      return i;
    }
  }
  // 未找到匹配括号时回退到文件末尾
  return lines.length - 1;
}

/** @internal 暴露给测试 */
export { buildFilePatch as _buildFilePatch };
