import { describe, expect, it } from 'vitest';
import { analyzeModule, parseAnalysisReport, validateAnalysisReport } from './analyzer';
import type { AnalyzerRequest } from '@forexplore/contracts';

const request: AnalyzerRequest = {
  target: {
    id: 'target', name: 'GetRate', kind: 'function', path: 'src/Rate.cs', language: 'C#',
    signature: 'public decimal GetRate(string pair)', line: 8,
  },
  candidate: {
    id: 'candidate', title: 'getRate', repository: 'fixture/java', license: 'MIT', language: 'Java', kind: 'function',
    path: 'src/Rate.java', signature: 'public double getRate(String pair)', summary: 'Gets a rate.', score: { overall: 0.8, semantic: 0.8, symbol: 0.8, contract: 0.7 },
    preview: 'public double getRate(String pair) { return 0.9; }', dependencies: [], compatibility: [], risks: [],
  },
  requirement: 'Return a quote for the pair and preserve the target decimal contract.',
  context: {
    targetFile: 'src/Rate.cs', targetSource: 'public decimal GetRate(string pair) { throw new NotImplementedException(); }',
    targetFragment: 'public decimal GetRate(string pair) { throw new NotImplementedException(); }', imports: ['using System;'],
    neighboringFiles: [], references: [], truncated: false,
  },
};

const validReport = {
  schemaVersion: '1.0',
  applicability: { level: 'adapt', confidence: 0.75, reasons: ['The behavior is similar but the return type differs.'] },
  behaviorMapping: [{ requirement: 'Return a quote', status: 'covered', candidateEvidence: ['return 0.9'], targetAction: 'Convert double to decimal.' }],
  contractMapping: [{ source: 'double', target: 'decimal', action: 'convert', note: 'Use decimal for the target contract.' }],
  dependencyPlan: [], implementationPlan: ['Preserve the C# signature.', 'Translate the numeric result to decimal.'],
  risks: [], assumptions: [], unresolved: [], blockingIssues: [],
};

describe('AnalysisReport validation', () => {
  it('extracts JSON from fenced model output', () => {
    expect(parseAnalysisReport(`Here is the report:\n\`\`\`json\n${JSON.stringify(validReport)}\n\`\`\``)).toEqual(validReport);
  });

  it('rejects contradictory reports', () => {
    expect(() => validateAnalysisReport({ ...validReport, applicability: { level: 'reject', confidence: 1, reasons: ['No match'] } })).toThrow('Rejected analysis');
    expect(() => validateAnalysisReport({ ...validReport, implementationPlan: [] })).toThrow('requires an implementation plan');
  });

  it('rejects invalid confidence and enum values', () => {
    expect(() => validateAnalysisReport({ ...validReport, applicability: { level: 'adapt', confidence: 2, reasons: [] } })).toThrow('confidence');
    expect(() => validateAnalysisReport({ ...validReport, applicability: { level: 'unknown', confidence: 0, reasons: [] } })).toThrow('applicability level');
  });
});

describe('Analyzer model adapter', () => {
  it('sends structured JSON mode and parses the report', async () => {
    const calls: RequestInit[] = [];
    const report = await analyzeModule(request, {
      apiKey: 'test-key',
      apiBase: 'https://example.test/v1',
      fetch: (async (_url, init) => {
        calls.push(init ?? {});
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReport) } }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(report).toEqual(validReport);
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({ response_format: { type: 'json_object' }, temperature: 0 });
  });

  it('falls back when an OpenAI-compatible endpoint rejects response_format', async () => {
    let count = 0;
    const report = await analyzeModule(request, {
      apiKey: 'test-key',
      fetch: (async () => {
        count += 1;
        if (count === 1) return new Response('unsupported', { status: 400 });
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validReport) } }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(count).toBe(2);
    expect(report.applicability.level).toBe('adapt');
  });
});
