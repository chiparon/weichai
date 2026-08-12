import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextCollector } from './context-collector';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('ContextCollector', () => {
  it('collects imports, target fragment, containing type, neighbors, and references', () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-context-'));
    roots.push(root);
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    const targetPath = join(src, 'Rate.cs');
    const consumerPath = join(src, 'Consumer.cs');
    writeFileSync(targetPath, [
      'using System;',
      'namespace Demo {',
      '  public class RateService {',
      '    public decimal GetRate(string pair)',
      '    {',
      '      throw new NotImplementedException();',
      '    }',
      '  }',
      '}',
    ].join('\n'));
    writeFileSync(consumerPath, 'class Consumer { void Run() { new RateService().GetRate("USD"); } }');

    const context = new ContextCollector({ projectRoot: root }).collect({
      id: 'rate', name: 'GetRate', kind: 'function', path: 'src/Rate.cs', language: 'C#',
      signature: 'public decimal GetRate(string pair)', line: 4,
    });
    expect(context.imports).toEqual(['using System;']);
    expect(context.targetFragment).toContain('GetRate');
    expect(context.containingType).toBe('RateService');
    expect(context.containingTypeSource).toContain('class RateService');
    expect(context.neighboringFiles.map((file) => file.path)).toEqual(['src/Consumer.cs']);
    expect(context.references.some((reference) => reference.path === 'src/Consumer.cs')).toBe(true);
  });

  it('does not read paths outside the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-context-'));
    roots.push(root);
    expect(() => new ContextCollector({ projectRoot: root }).collect({
      id: 'bad', name: 'Bad', kind: 'function', path: '../secret.cs', language: 'C#', signature: 'void Bad()',
    })).toThrow('inside the project root');
  });

  it('does not follow target or reference symlinks outside the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-context-'));
    const outside = mkdtempSync(join(tmpdir(), 'forexplore-context-outside-'));
    roots.push(root, outside);
    writeFileSync(join(outside, 'Secret.cs'), 'public class Secret { public void GetRate() {} }');
    symlinkSync(join(outside, 'Secret.cs'), join(root, 'Linked.cs'));
    const collector = new ContextCollector({ projectRoot: root });

    expect(() => collector.collect({
      id: 'linked', name: 'GetRate', kind: 'function', path: 'Linked.cs', language: 'C#', signature: 'void GetRate()',
    })).toThrow('inside the project root');
  });

  it('returns structured facts and respects the rich context budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-context-'));
    roots.push(root);
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'Service.cs'), [
      'public sealed class Service {',
      '  private readonly IStore store;',
      '  public Service(IStore store) { this.store = store; }',
      '  // REQ: preserve cancellation',
      '  public async Task<int> RunAsync(CancellationToken cancellationToken) { return await store.RunAsync(cancellationToken); }',
      '}',
    ].join('\n'));
    writeFileSync(join(src, 'IStore.cs'), 'public interface IStore { Task<int> RunAsync(CancellationToken cancellationToken); }');

    const target = {
      id: 'run', name: 'RunAsync', kind: 'function' as const, path: 'src/Service.cs', language: 'C#' as const,
      signature: 'public async Task<int> RunAsync(CancellationToken cancellationToken)', line: 5,
    };
    const context = new ContextCollector({ projectRoot: root, maxChars: 3000 }).collect(target);

    expect(context.schemaVersion).toBe('1.0');
    expect(context.source?.fields).toContain('private readonly IStore store;');
    expect(context.source?.constructor).toContain('Service(IStore store)');
    expect(context.dependencies?.map((dependency) => dependency.name)).toContain('IStore');
    expect(context.relatedTypes?.map((type) => type.name)).toContain('IStore');
    expect(context.constraints).toContain('REQ: preserve cancellation');
    expect(context.collection?.actualChars).toBeLessThanOrEqual(3000);
  });

  it('fails clearly for missing files, missing symbols, and cancelled collection', () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-context-'));
    roots.push(root);
    const src = join(root, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'Service.cs'), 'public class Service { public void Run() { } }');
    const base = {
      id: 'run', name: 'Run', kind: 'function' as const, path: 'src/Service.cs', language: 'C#' as const,
      signature: 'public void Run()',
    };
    expect(() => new ContextCollector({ projectRoot: root }).collect({ ...base, path: 'src/Missing.cs' })).toThrow('Target file does not exist');
    expect(() => new ContextCollector({ projectRoot: root }).collect({ ...base, name: 'Missing', signature: 'public void Missing()' })).toThrow('was not found');
    const controller = new AbortController();
    controller.abort();
    expect(() => new ContextCollector({ projectRoot: root }).collect(base, controller.signal)).toThrow();
  });
});
