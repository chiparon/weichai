import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { parseLlmSettings, type LlmSettings } from '@forexplore/contracts';

export const modelSettingsScope = new AsyncLocalStorage<LlmSettings | undefined>();

export function isLocalIdeRequest(request: IncomingMessage): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(request.headers.host ?? '') && request.headers.origin === undefined;
}

export function requestModelSettings(request: IncomingMessage): LlmSettings | undefined {
  const value = request.headers['x-recast-model-config'];
  if (value === undefined) return undefined;
  if (!isLocalIdeRequest(request) || typeof value !== 'string' || value.length > 6000) throw new Error('Invalid local IDE model configuration.');
  return parseLlmSettings(JSON.parse(decodeURIComponent(value)));
}
