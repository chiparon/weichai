import { describe, expect, it } from 'vitest';
import { describeCause, errorMessage } from './error-message';

describe('errorMessage', () => {
  it('reports a refused fetch with the address that refused it', () => {
    // undici hides ECONNREFUSED 127.0.0.1:4021 inside an AggregateError cause;
    // "检索失败：fetch failed" alone is not enough to act on.
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4021'), {
      code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 4021,
    });
    const failure = new TypeError('fetch failed', { cause: new AggregateError([refused], '') });

    expect(errorMessage(failure, '检索失败')).toBe('检索失败：fetch failed（ECONNREFUSED connect 127.0.0.1:4021）');
  });

  it('falls back to a plain message and never loses the fallback prefix', () => {
    expect(errorMessage(new Error('boom'), '检索失败')).toBe('检索失败：boom');
    expect(errorMessage(new Error('fetch failed'), '检索失败')).toBe('检索失败：fetch failed');
    expect(errorMessage('not an error', '检索失败')).toBe('检索失败');
    expect(errorMessage(undefined, '检索失败')).toBe('检索失败');
  });

  it('unwinds a nested cause only as far as it needs to', () => {
    const root = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const middle = new Error('request failed', { cause: root });
    expect(describeCause(middle)).toBe('ECONNRESET');
    expect(describeCause(new Error('loop', { cause: middle }))).toBe('ECONNRESET');
  });
});
