/**
 * @forexplore/adaptation-service
 *
 * Java → C# 代码适配服务：
 *   LLM 翻译 → 编译校验 → 自动修复 → 回填
 */

export { AdaptationAdapter } from "./adaptation-adapter";
export type {
  AdaptationAdapterOptions,
  AnalyzerFunction,
  IntegratedCompilerFunction,
  RepairFunction,
  StandaloneCompilerFunction,
  TranslatorFunction,
} from "./adaptation-adapter";

export { BackfillAdapter } from "./backfill-adapter";
export type { BackfillAdapterOptions } from "./backfill-adapter";

export { translateJavaToCSharp, fixCompileErrors } from "./translator";
export type { TranslateRequest } from "./translator";

export { analyzeModule, buildAnalyzerPrompt, parseAnalysisReport, validateAnalysisReport } from "./analyzer";
export type { AnalyzerOptions } from "./analyzer";

export { ContextCollector, collectTargetContext } from "./context-collector";
export type { ContextCollectorOptions } from "./context-collector";

export { LocalMcpToolHost, createLocalMcpToolHost } from "./mcp-tools";
export type { McpToolDefinition, McpToolHost, McpToolResult } from "./mcp-tools";

export { createMcpMessageHandler, runMcpStdioServer } from "./mcp-server";

export { compileStandalone, compileIntegrated } from "./compiler";
export type { CompileResult } from "./compiler";

export { adaptationModelConfig, loadAdaptationModelConfig } from "./model-config";
export type { AdaptationModelConfig } from "./model-config";

export { loadConfig } from "./config";
export type { AdaptationServiceConfig } from "./config";

export { createHttpServer } from "./http-server";
export type { HttpServerOptions } from "./http-server";
