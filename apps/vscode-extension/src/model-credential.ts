export interface CredentialStorage {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export function modelCredentialId(endpoint: string): string {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('API Key 设置仅支持本地 AI 后端，请检查 forexplore.adaptationApiUrl。');
  }
  return `recast.modelKey:${url.origin}`;
}

/** Endpoint is supplied by the trusted host, never by a Webview message. */
export function createModelCredentialProvider(storage: CredentialStorage, endpoint: () => string) {
  return async (url: URL): Promise<string | undefined> => {
    const configured = endpoint();
    let id: string;
    try { id = modelCredentialId(configured); } catch { return undefined; }
    const base = new URL(configured);
    const prefix = base.pathname.replace(/\/+$/, '');
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(`${prefix}/`)) return undefined;
    const route = url.pathname.slice(prefix.length);
    if (!/^\/(?:module-hierarchy\/decision|v1\/(?:adapt|module-plan|semantic-module-plan|workspace-translations(?:\/[a-f0-9-]{36}(?:\/(?:resume|cancel|rollback))?)?))$/.test(route)) return undefined;
    return storage.get(id);
  };
}

export function validateModelKey(value: string): string | undefined {
  return /^[\x21-\x7e]{1,512}$/.test(value.trim()) ? undefined : '请输入有效 API Key（不能含空格或换行）。';
}
