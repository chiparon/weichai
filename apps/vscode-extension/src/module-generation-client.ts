import type { WorkspaceTranslationModelClient } from '@forexplore/adaptation-service/module-patch-preparer';
import { localFetch } from './local-fetch';

/**
 * Module generation runs in the trusted extension host, which owns the
 * repository, the isolated worktrees and the compiler. Only the model turn
 * itself is delegated to the local adaptation service, which already holds the
 * credential plumbing; no path, file or command ever crosses this boundary.
 */
export interface ModuleGenerationEndpoint {
  /** Base URL of the local adaptation service. */
  url: string;
  /** Bearer token configured for the service's module-generation route. */
  token?: string | undefined;
}

export function createModuleGenerationModelClient(
  configuration: () => ModuleGenerationEndpoint,
): WorkspaceTranslationModelClient {
  return {
    async complete(messages, tools, signal) {
      const { url, token } = configuration();
      if (!token || !token.trim()) {
        throw new Error('模块生成需要配置 ADAPTATION_MODULE_GENERATION_TOKEN，并在后端启用模块生成。');
      }
      const endpoint = new URL(url);
      endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/v1/module-generation/turn`;
      endpoint.search = '';
      endpoint.hash = '';
      const response = await localFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages, tools }),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let detail = text.slice(0, 300);
        try {
          const parsed = JSON.parse(text) as { error?: string };
          detail = parsed.error ?? detail;
        } catch {
          // A non-JSON error body is reported verbatim above.
        }
        throw new Error(`模块生成模型调用失败（HTTP ${response.status}）：${detail}`);
      }
      const completion = JSON.parse(text) as { content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> };
      return {
        content: completion.content ?? '',
        ...(completion.toolCalls ? { toolCalls: completion.toolCalls } : {}),
      };
    },
  };
}
