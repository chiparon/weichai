import type {
  AnalysisReport,
  AnalyzerRequest,
  ContractMapping,
  DependencyPlan,
} from '@forexplore/contracts';
import { adaptationModelConfig } from './model-config.js';

export interface AnalyzerOptions {
  apiKey: string;
  apiBase?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
}

const ANALYZER_SYSTEM_PROMPT = `你是一个面向已有代码仓库的跨语言代码分析器。你的工作范围是一个目标模块，不是生成整个项目。
请比较目标契约、需求和检索到的候选实现，识别候选可复用的行为、必须改写的差异、缺失行为和冲突。
所有判断必须基于输入证据；不确定的内容放进 assumptions 或 unresolved，不要编造依赖和调用关系。
只返回一个 JSON 对象，不要 markdown，不要解释。JSON 必须严格符合给定字段和枚举。`;

export async function analyzeModule(
  request: AnalyzerRequest,
  options: AnalyzerOptions,
  signal?: AbortSignal,
): Promise<AnalysisReport> {
  validateAnalyzerRequest(request);
  const prompt = buildAnalyzerPrompt(request);
  const response = await callAnalyzerModel(prompt, options, signal);
  return parseAnalysisReport(response);
}

export function buildAnalyzerPrompt(request: AnalyzerRequest): string {
  validateAnalyzerRequest(request);
  return `请输出以下结构的 JSON：
{
  "schemaVersion": "1.0",
  "applicability": { "level": "direct|adapt|reference|reject", "confidence": 0, "reasons": [] },
  "behaviorMapping": [{ "requirement": "", "status": "covered|partial|missing|conflict", "candidateEvidence": [], "targetAction": "" }],
  "contractMapping": [{ "source": "", "target": "", "action": "preserve|rename|convert|inject|replace", "note": "" }],
  "dependencyPlan": [{ "sourceDependency": "", "targetDependency": "", "action": "reuse-existing|adapt|inline|unresolved" }],
  "implementationPlan": [],
  "risks": [],
  "assumptions": [],
  "unresolved": [],
  "blockingIssues": []
}

【目标模块】
${JSON.stringify(request.target, null, 2)}

【功能需求】
${request.requirement}

【目标代码上下文】
${JSON.stringify(request.context, null, 2)}

【检索候选】
${JSON.stringify(request.candidate, null, 2)}

约束：目标方法签名、可见性、返回类型、异步/取消约定和现有依赖是不可变契约；候选与目标不一致时必须记录差异并以目标为准。implementationPlan 只列本目标模块的实施步骤，不生成测试和项目骨架。只有会导致错误实现、且 Translator 无法从当前上下文自行解决的问题才放入 blockingIssues；普通不确定项放 unresolved。`;
}

async function callAnalyzerModel(
  prompt: string,
  options: AnalyzerOptions,
  signal?: AbortSignal,
): Promise<string> {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const apiBase = (options.apiBase ?? adaptationModelConfig.apiBase).replace(/\/+$/, '');
  const model = options.model ?? adaptationModelConfig.model;
  const body = {
    model,
    messages: [
      { role: 'system', content: ANALYZER_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    thinking: { type: 'disabled' },
    temperature: 0,
  };
  let response = await request(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({ ...body, response_format: { type: 'json_object' } }),
    signal,
  });
  if (response.status === 400) {
    response = await request(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  }
  if (!response.ok) throw new Error(`Analyzer model error ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('Analyzer model returned an empty report.');
  return content;
}

export function parseAnalysisReport(raw: string): AnalysisReport {
  const jsonText = extractJson(raw);
  let value: unknown;
  try {
    value = JSON.parse(jsonText) as unknown;
  } catch (error) {
    throw new Error(`Analyzer returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateAnalysisReport(value);
}

export function validateAnalysisReport(value: unknown): AnalysisReport {
  if (!isRecord(value)) throw new Error('AnalysisReport must be a JSON object.');
  if (value.schemaVersion !== '1.0') throw new Error('AnalysisReport.schemaVersion must be "1.0".');
  if (!isRecord(value.applicability)) throw new Error('AnalysisReport.applicability is required.');
  const level = value.applicability.level;
  if (!isEnum(level, ['direct', 'adapt', 'reference', 'reject'])) throw new Error('Invalid AnalysisReport applicability level.');
  const confidence = value.applicability.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('AnalysisReport confidence must be between 0 and 1.');
  const report: AnalysisReport = {
    schemaVersion: '1.0',
    applicability: {
      level,
      confidence,
      reasons: nonEmptyStringArray(value.applicability.reasons, 'applicability.reasons'),
    },
    behaviorMapping: behaviorMappings(value.behaviorMapping),
    contractMapping: contractMappings(value.contractMapping),
    dependencyPlan: dependencyPlans(value.dependencyPlan),
    implementationPlan: stringArray(value.implementationPlan, 'implementationPlan'),
    risks: stringArray(value.risks, 'risks'),
    assumptions: stringArray(value.assumptions, 'assumptions'),
    unresolved: stringArray(value.unresolved, 'unresolved'),
    // Reports produced before schema 1.0.1 did not have this field. Treat a
    // missing list as empty so the Analyzer remains compatible with fixtures
    // and cached model responses from the first rollout.
    blockingIssues: stringArray(value.blockingIssues ?? [], 'blockingIssues'),
  };
  if (report.applicability.level === 'reject' && report.implementationPlan.length > 0) {
    throw new Error('Rejected analysis must not contain an implementation plan.');
  }
  if (report.applicability.level !== 'reject' && report.implementationPlan.length === 0) {
    throw new Error('Non-rejected analysis requires an implementation plan.');
  }
  return report;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function behaviorMappings(value: unknown): AnalysisReport['behaviorMapping'] {
  if (!Array.isArray(value)) throw new Error('behaviorMapping must be an array.');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.requirement !== 'string' || !item.requirement.trim() || !isEnum(item.status, ['covered', 'partial', 'missing', 'conflict']) || typeof item.targetAction !== 'string' || !item.targetAction.trim()) throw new Error(`Invalid behaviorMapping[${index}].`);
    const candidateEvidence = stringArray(item.candidateEvidence, `behaviorMapping[${index}].candidateEvidence`);
    if (item.status !== 'missing' && candidateEvidence.length === 0) throw new Error(`Invalid behaviorMapping[${index}]: candidate evidence is required unless status is missing.`);
    return { requirement: item.requirement.trim(), status: item.status, candidateEvidence, targetAction: item.targetAction.trim() };
  });
}

function contractMappings(value: unknown): ContractMapping[] {
  if (!Array.isArray(value)) throw new Error('contractMapping must be an array.');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.source !== 'string' || !item.source.trim() || typeof item.target !== 'string' || !item.target.trim() || !isEnum(item.action, ['preserve', 'rename', 'convert', 'inject', 'replace']) || typeof item.note !== 'string' || !item.note.trim()) throw new Error(`Invalid contractMapping[${index}].`);
    return { source: item.source.trim(), target: item.target.trim(), action: item.action, note: item.note.trim() };
  });
}

function dependencyPlans(value: unknown): DependencyPlan[] {
  if (!Array.isArray(value)) throw new Error('dependencyPlan must be an array.');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.sourceDependency !== 'string' || !item.sourceDependency.trim() || !isEnum(item.action, ['reuse-existing', 'adapt', 'inline', 'unresolved']) || (item.targetDependency !== undefined && (typeof item.targetDependency !== 'string' || !item.targetDependency.trim()))) throw new Error(`Invalid dependencyPlan[${index}].`);
    return { sourceDependency: item.sourceDependency.trim(), ...(item.targetDependency === undefined ? {} : { targetDependency: item.targetDependency.trim() }), action: item.action };
  });
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${label} must be an array of strings.`);
  if (value.some((item) => !item.trim())) throw new Error(`${label} must not contain blank strings.`);
  return value.map((item) => item.trim());
}

function nonEmptyStringArray(value: unknown, label: string): string[] {
  const result = stringArray(value, label);
  if (result.length === 0) throw new Error(`${label} must contain at least one item.`);
  return result;
}

function validateAnalyzerRequest(request: AnalyzerRequest): void {
  if (!isRecord(request)) throw new Error('AnalyzerRequest must be an object.');
  if (typeof request.requirement !== 'string' || !request.requirement.trim()) {
    throw new Error('AnalyzerRequest.requirement must not be empty.');
  }
  if (!isRecord(request.target) || typeof request.target.path !== 'string' || typeof request.target.name !== 'string') {
    throw new Error('AnalyzerRequest.target must contain a target name and path.');
  }
  if (!isRecord(request.candidate) || typeof request.candidate.preview !== 'string') {
    throw new Error('AnalyzerRequest.candidate must contain a source preview.');
  }
  if (!isRecord(request.context)) throw new Error('AnalyzerRequest.context is required.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
