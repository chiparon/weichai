import { describe, expect, it, vi } from 'vitest';
import {
  QUERY_EXPANSION_MAX_CHARS,
  QUERY_EXPANSION_MAX_TERMS,
  QUERY_EXPANSION_MIN_GROWTH_CHARS,
  expandQuery,
  queryExpansionFromEnvironment,
} from './query-expansion.js';
import { QUERY_LEXICON } from './query-lexicon-data.js';

const requirement = '检查上传文件名中的空字符，发现非法文件名时抛出异常。';

describe('offline query expansion', () => {
  it('maps Chinese requirement terms to English code word forms without any I/O', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('network access is forbidden in the query path'); });
    try {
      const result = expandQuery(requirement);
      expect(result.enabled).toBe(true);
      expect(result.version).toBe(QUERY_LEXICON.version);
      expect(result.lexiconSha256).toBe(QUERY_LEXICON.lexiconSha256);
      expect(result.matched).toContain('文件名');
      expect(result.matched).toContain('异常');
      expect(result.terms).toContain('fileName');
      expect(result.expanded.startsWith(requirement)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('is synchronous and returns a plain value, not a promise', () => {
    const result = expandQuery(requirement);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.expanded).toBe('string');
  });

  it('is deterministic across repeated calls', () => {
    const first = expandQuery(requirement);
    const second = expandQuery(requirement);
    expect(second).toEqual(first);
  });

  it('falls back to the exact requirement when nothing matches', () => {
    const unrelated = 'qzv 星际导航量子纠错与气象卫星轨道计算';
    const result = expandQuery(unrelated);
    expect(result.enabled).toBe(false);
    expect(result.terms).toEqual([]);
    expect(result.expanded).toBe(unrelated);
  });

  it('keeps the recall query inside the documented caps', () => {
    for (const item of [
      requirement,
      '读取 multipart 上传流中当前分段的请求头，遇到异常结束时报告错误。',
      '删除已上传文件的临时磁盘数据，并清理内存缓存。',
      'a'.repeat(400),
    ]) {
      const result = expandQuery(item);
      expect(result.terms.length).toBeLessThanOrEqual(QUERY_EXPANSION_MAX_TERMS);
      expect(result.expanded.length).toBeLessThanOrEqual(QUERY_EXPANSION_MAX_CHARS);
      expect(result.expanded.length).toBeLessThanOrEqual(Math.max(QUERY_EXPANSION_MIN_GROWTH_CHARS, item.length * 3));
    }
  });

  it('expands identifier word forms already present in the requirement', () => {
    const result = expandQuery('修复 parseRequest 的 multipart 解析问题');
    expect(result.terms.map((term) => term.toLowerCase())).toEqual(expect.arrayContaining(['parse', 'request']));
  });

  it('never injects a full multi-word evaluation identifier', () => {
    const forbidden = ['checkfilename', 'base64decoder', 'quotedprintabledecoder', 'readheaders', 'getcharset', 'setthreshold', 'getuniqueid'];
    for (const task of [requirement, '把上传项内容写出到指定文件', '为每个上传项生成唯一编号', '设置超过阈值的上传内容写到磁盘']) {
      for (const term of expandQuery(task).terms) {
        expect(forbidden).not.toContain(term.toLowerCase());
      }
    }
  });

  it('is enabled by default and can be switched off explicitly', () => {
    expect(queryExpansionFromEnvironment({})).not.toBeNull();
    expect(queryExpansionFromEnvironment({ RECAST_QUERY_EXPANSION: 'on' })).not.toBeNull();
    expect(queryExpansionFromEnvironment({ RECAST_QUERY_EXPANSION: 'off' })).toBeNull();
    expect(queryExpansionFromEnvironment({ RECAST_QUERY_EXPANSION: '0' })).toBeNull();
    expect(queryExpansionFromEnvironment({ RECAST_QUERY_EXPANSION: 'false' })).toBeNull();
    expect(queryExpansionFromEnvironment({ RECAST_QUERY_EXPANSION: 'disabled' })).toBeNull();
  });

  it('drops ultra-generic word forms that displace evidence', () => {
    const generic = ['put', 'send', 'set', 'get', 'code', 'item', 'value', 'data', 'err', 'doc', 'mem', 'obj'];
    const result = expandQuery('检查上传文件名中的空字符，发现非法文件名时抛出异常。');
    for (const term of result.terms) expect(generic).not.toContain(term.toLowerCase());
    expect(result.terms).toContain('fileName');
    expect(result.terms.length).toBeLessThanOrEqual(16);
  });

  it('declares a generated lexicon with a stable checksum', () => {
    expect(QUERY_LEXICON.entries.length).toBeGreaterThanOrEqual(200);
    expect(QUERY_LEXICON.lexiconSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(QUERY_LEXICON.entries.every((entry) => /^[\u4e00-\u9fff]{2,8}$/.test(entry.zh))).toBe(true);
    expect(QUERY_LEXICON.entries.every((entry) => entry.en.length >= 1 && entry.en.every((word) => /^[A-Za-z][A-Za-z0-9]{1,23}$/.test(word)))).toBe(true);
  });
});
