import { modelSettingsScope } from './model-request';
import { resolveModelApiKey, type ModelApiKey } from './model-credential';
import { deepSeekModelConfig, type DeepSeekModelConfig } from "./model-config";

export interface DeepSeekMessage {
  role: "system" | "user";
  content: string;
}

export interface DeepSeekClientOptions {
  apiKey: ModelApiKey;
  modelConfig?: DeepSeekModelConfig;
  request?: typeof globalThis.fetch;
  temperature?: number;
  jsonMode?: boolean;
}

/** Minimal OpenAI-compatible function-tool shape used by the semantic planner. */
export interface DeepSeekToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DeepSeekToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface DeepSeekToolMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: readonly DeepSeekToolCall[];
  toolCallId?: string;
}

export interface DeepSeekToolCompletion {
  content?: string;
  toolCalls?: DeepSeekToolCall[];
}

/** Compatibility names retained for existing agents; routing is request-scoped. */
export async function completeWithDeepSeek(
  messages: readonly DeepSeekMessage[], options: DeepSeekClientOptions, signal?: AbortSignal,
): Promise<string> {
  const result = await complete(messages, [], options, signal);
  if (!result.content) throw new Error("Model API returned an empty completion.");
  return result.content;
}

export async function completeWithDeepSeekTools(
  messages: readonly DeepSeekToolMessage[], tools: readonly DeepSeekToolDefinition[],
  options: DeepSeekClientOptions, signal?: AbortSignal,
): Promise<DeepSeekToolCompletion> {
  return complete(messages, tools, options, signal);
}

async function complete(
  messages: readonly DeepSeekToolMessage[], tools: readonly DeepSeekToolDefinition[],
  options: DeepSeekClientOptions, signal?: AbortSignal,
): Promise<DeepSeekToolCompletion> {
  const apiKey = resolveModelApiKey(options.apiKey);
  const config = modelSettingsScope.getStore();
  const model = config ?? options.modelConfig ?? deepSeekModelConfig;
  const provider = config?.provider ?? 'deepseek';
  const maxTokens = config?.maxOutputTokens ?? 8192;
  const anthropic = provider === 'anthropic';
  const body = anthropic ? {
    model: model.model, max_tokens: maxTokens,
    system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') +
      (options.jsonMode ? '\nReturn only valid JSON without markdown fences.' : ''),
    messages: anthropicMessages(messages),
    ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  } : {
    model: model.model,
    messages: messages.map(deepSeekToolMessage),
    ...(provider === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    ...(tools.length ? {
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      tool_choice: 'auto',
    } : {}),
  };
  const request = options.request ?? globalThis.fetch.bind(globalThis);
  const response = await request(`${model.apiBase}/${anthropic ? 'messages' : 'chat/completions'}`, {
    method: 'POST', redirect: 'error',
    headers: anthropic
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body), signal,
  });
  const label = provider === 'deepseek' ? 'DeepSeek' : provider;
  if (!response.ok) throw new Error(`${label} API error ${response.status}`);
  let data: unknown;
  try { data = JSON.parse(await response.text()); }
  catch { throw new Error(`${label} API returned invalid JSON.`); }
  if (anthropic) return anthropicCompletion(data);
  if (isRecord(data) && Array.isArray(data.choices) && isRecord(data.choices[0]) && data.choices[0].finish_reason === 'length') {
    throw new Error('模型输出达到 Token 上限，请提高设置中的每次输出 Token 上限后重试。');
  }
  return toolCompletion(data);
}

function anthropicMessages(messages: readonly DeepSeekToolMessage[]): Record<string, unknown>[] {
  const result: { role: string; content: Record<string, unknown>[] }[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content: Record<string, unknown>[] = [];
    if (message.role === 'tool') {
      if (!message.toolCallId) throw new Error('Tool transcript entry requires a toolCallId.');
      content.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content });
    } else {
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) });
      }
    }
    const previous = result[result.length - 1];
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

function anthropicCompletion(value: unknown): DeepSeekToolCompletion {
  if (!isRecord(value) || !Array.isArray(value.content)) throw new Error('Anthropic API returned an invalid completion.');
  if (value.stop_reason === 'max_tokens') throw new Error('模型输出达到 Token 上限，请提高设置中的每次输出 Token 上限后重试。');
  const text: string[] = [];
  const toolCalls: DeepSeekToolCall[] = [];
  for (const block of value.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
    if (block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || !isRecord(block.input)) {
        throw new Error('Anthropic API returned an invalid tool call.');
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
    }
  }
  const content = text.join('\n').trim();
  if (!content && !toolCalls.length) throw new Error('Anthropic API returned an empty completion.');
  return { ...(content ? { content } : {}), ...(toolCalls.length ? { toolCalls } : {}) };
}

export function chatCompletionContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function deepSeekToolMessage(message: DeepSeekToolMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolCallId?.trim()) throw new Error("Tool transcript entry requires a toolCallId.");
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: toolCall.arguments },
        })),
      } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

function toolCompletion(value: unknown): DeepSeekToolCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new Error("DeepSeek API returned an invalid tool completion.");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error("DeepSeek API returned an invalid tool completion.");
  }
  const message = first.message;
  const content = typeof message.content === "string" && message.content.trim()
    ? message.content.trim()
    : undefined;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(parseToolCall)
    : [];
  if (!content && toolCalls.length === 0) {
    throw new Error("DeepSeek API returned neither content nor a tool call.");
  }
  return {
    ...(content ? { content } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function parseToolCall(value: unknown): DeepSeekToolCall {
  if (!isRecord(value) || !isRecord(value.function)) {
    throw new Error("DeepSeek API returned an invalid tool call.");
  }
  const id = value.id;
  const name = value.function.name;
  const argumentsValue = value.function.arguments;
  if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()) {
    throw new Error("DeepSeek API returned an invalid tool call.");
  }
  if (typeof argumentsValue !== "string") {
    throw new Error("DeepSeek API returned tool arguments that are not JSON text.");
  }
  return { id, name, arguments: argumentsValue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
