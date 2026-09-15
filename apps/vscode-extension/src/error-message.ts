/**
 * A user-facing error line.
 *
 * `TypeError: fetch failed` is what a refused connection looks like from the
 * Webview, and the actionable part (`ECONNREFUSED 127.0.0.1:4021`) is hidden in
 * `error.cause`. Reporting only "检索失败：fetch failed" cost a debugging round
 * trip, so the cause chain is unwound here.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const detail = describeCause(error);
  return `${fallback}：${error.message}${detail ? `（${detail}）` : ''}`;
}

/** Reads the code/address/port that a failed fetch hides one or two levels down. */
export function describeCause(error: unknown, depth = 0): string {
  if (depth > 3 || typeof error !== 'object' || error === null) return '';
  const value = error as { code?: unknown; address?: unknown; port?: unknown; syscall?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof value.code === 'string') parts.push(value.code);
  if (typeof value.syscall === 'string') parts.push(value.syscall);
  if (typeof value.address === 'string') parts.push(value.port === undefined ? value.address : `${value.address}:${String(value.port)}`);
  if (parts.length > 0) return parts.join(' ');
  // undici reports a refused connection as an AggregateError of per-address errors.
  if (Array.isArray(value.errors)) {
    const nested = value.errors.map((item) => describeCause(item, depth + 1)).filter(Boolean);
    if (nested.length > 0) return [...new Set(nested)].join(', ');
  }
  return describeCause(value.cause, depth + 1);
}
