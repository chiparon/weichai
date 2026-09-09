import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

export type ModelApiKey = string | (() => string);
export const modelCredentialScope = new AsyncLocalStorage<string | undefined>();

export function resolveModelApiKey(fallback: ModelApiKey): string {
  const key = (modelCredentialScope.getStore() ?? (typeof fallback === 'function' ? fallback() : fallback)).trim();
  if (!key) throw new Error('请在 RECAST 设置面板配置 DeepSeek API Key，或设置后端 DEEPSEEK_API_KEY。');
  return key;
}

/** Browser requests cannot supply a credential; never persist or share it across requests. */
export function requestModelCredential(request: IncomingMessage): string | undefined {
  const value = request.headers['x-recast-model-key'];
  if (value === undefined) return undefined;
  const peer = request.socket.remoteAddress;
  const localPeer = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? '');
  if (!localPeer || !localHost || request.headers.origin !== undefined ||
      typeof value !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(value)) {
    throw new Error('API Key 仅支持来自本机 IDE 的有效请求。');
  }
  return value;
}
