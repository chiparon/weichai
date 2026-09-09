/** Public model configuration. Credentials must never be included here. */
export const LLM_PRESETS = {
  deepseek: { label: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
  openai: { label: 'OpenAI', apiBase: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  anthropic: { label: 'Anthropic / Claude', apiBase: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6' },
  gemini: { label: 'Google Gemini', apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  qwen: { label: '通义千问', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  custom: { label: '自定义 OpenAI 兼容接口', apiBase: 'http://127.0.0.1:11434/v1', model: 'qwen3' },
} as const;
export type LlmProvider = keyof typeof LLM_PRESETS;
export const OUTPUT_TOKEN_LIMITS = [1024, 2048, 4096, 8192, 16384, 32768] as const;
export interface LlmSettings {
  provider: LlmProvider;
  apiBase: string;
  model: string;
  maxOutputTokens: number;
}
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: 'deepseek', apiBase: LLM_PRESETS.deepseek.apiBase,
  model: LLM_PRESETS.deepseek.model, maxOutputTokens: 8192,
};

export function parseLlmSettings(value: unknown): LlmSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 配置格式无效。');
  const s = value as Record<string, unknown>;
  if (Object.keys(s).length !== 4 || !Object.keys(s).every(k => ['provider', 'apiBase', 'model', 'maxOutputTokens'].includes(k)) ||
      typeof s.provider !== 'string' || !Object.hasOwn(LLM_PRESETS, s.provider) ||
      typeof s.apiBase !== 'string' || s.apiBase.length > 1000 ||
      typeof s.model !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(s.model.trim()) ||
      !OUTPUT_TOKEN_LIMITS.includes(s.maxOutputTokens as typeof OUTPUT_TOKEN_LIMITS[number])) {
    throw new Error('请选择有效的 AI 服务、模型和输出 Token 上限。');
  }
  let url: URL;
  try { url = new URL(s.apiBase.trim()); } catch { throw new Error('API 地址无效。'); }
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('API 地址须使用 HTTPS（本机服务可用 HTTP），且不能包含密钥、查询参数或片段。');
  }
  return { provider: s.provider as LlmProvider, apiBase: url.href.replace(/\/+$/, ''), model: s.model.trim(), maxOutputTokens: s.maxOutputTokens as number };
}
