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
});
