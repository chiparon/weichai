import { describe, expect, it } from 'vitest';
import { ModuleSearchConcurrencyGate } from './module-matching.js';
import { compactLexicalQuery } from './seekdb-index-store.js';

describe('retrieval optimizations', () => {
  it('keeps high-signal terms while removing repeated metadata from full-text queries', () => {
    const query = [
      'Web 接口层',
      'Web 接口层',
      'Web 接口层包含请求/响应 DTO、错误模型以及端点映射接口。',
      '目标语言：Java',
      '目标工程：pom',
    ].join('\n');
    const lexical = compactLexicalQuery(query);
    expect(lexical).toContain('Web');
    expect(lexical).toContain('DTO');
    expect(lexical).toContain('错误模型');
    expect(lexical).not.toContain('Java');
    expect(lexical).not.toContain('pom');
    expect(lexical.match(/Web/g)?.length).toBe(1);
  });

  it('removes declaration boilerplate while retaining Java behavior identifiers', () => {
    const lexical = compactLexicalQuery([
      'public final class IdempotencyCoordinator',
      'public Object execute(Object input)',
      'package com.example.assetupgrade.retry;',
      '负责请求幂等性保障与重试协调。',
    ].join('\n'));
    expect(lexical).toContain('IdempotencyCoordinator');
    expect(lexical).toContain('execute');
    expect(lexical).toContain('幂等性');
    expect(lexical).not.toMatch(/\bpublic\b/i);
    expect(lexical).not.toMatch(/\b(?:class|package|Object|input)\b/);
  });

  it('limits active searches across callers instead of only within one request', async () => {
    const gate = new ModuleSearchConcurrencyGate(1);
    const firstRelease = await gate.acquire();
    let secondEntered = false;
    const second = gate.acquire().then((release) => {
      secondEntered = true;
      release();
    });
    await Promise.resolve();
    expect(gate.active).toBe(1);
    expect(gate.queued).toBe(1);
    expect(secondEntered).toBe(false);
    firstRelease();
    await second;
    expect(secondEntered).toBe(true);
    expect(gate.active).toBe(0);
  });

  it('removes an aborted waiter without consuming a later permit', async () => {
    const gate = new ModuleSearchConcurrencyGate(1);
    const firstRelease = await gate.acquire();
    const controller = new AbortController();
    const waiting = gate.acquire(controller.signal);
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    expect(gate.queued).toBe(0);
    firstRelease();
    const release = await gate.acquire();
    release();
    expect(gate.active).toBe(0);
  });
});
