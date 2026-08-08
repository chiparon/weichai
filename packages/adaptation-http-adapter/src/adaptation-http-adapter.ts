import type {
  AnalysisRequest,
  AnalysisResult,
  AdaptationRequest,
  AdaptationResult,
  ApplyResult,
  FilePatch,
} from '@forexplore/contracts';
import type {
  CodeAdaptationPort,
  CodeAnalysisPort,
  CodeBackfillPort,
  WorkflowPorts,
} from '@forexplore/workflow-core';

export interface AdaptationHttpOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function isAdaptationResult(value: unknown): value is AdaptationResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<AdaptationResult>;
  return (
    typeof result.generatedCode === 'string' &&
    typeof result.targetLanguage === 'string' &&
    typeof result.strategy === 'string' &&
    Array.isArray(result.interfaceMappings) &&
    Array.isArray(result.validation) &&
    Array.isArray(result.files)
  );
}

function isAnalysisResult(value: unknown): value is AnalysisResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<AnalysisResult>;
  return (
    typeof result.report === 'object' &&
    result.report !== null &&
    result.report.schemaVersion === '1.0' &&
    typeof result.context === 'object' &&
    result.context !== null &&
    typeof result.context.targetFile === 'string'
  );
}

function isApplyResult(value: unknown): value is ApplyResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<ApplyResult>;
  return (
    Array.isArray(result.appliedFiles) &&
    result.appliedFiles.every((path) => typeof path === 'string') &&
    typeof result.checkpointId === 'string'
  );
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error;
  } catch {
    // The status text below is more useful than a JSON parse failure.
  }
  return response.statusText || `HTTP ${response.status}`;
}

export class AdaptationHttpAdapter implements CodeAdaptationPort {
  private readonly adaptUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.adaptUrl = endpoint(options.baseUrl, '/v1/adapt');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async adapt(request: AdaptationRequest, signal?: AbortSignal): Promise<AdaptationResult> {
    const response = await this.request(this.adaptUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Adaptation failed: ${await responseError(response)}`);
    }

    const body: unknown = await response.json();
    if (!isAdaptationResult(body)) {
      throw new Error('Adaptation service returned an invalid response.');
    }
    return body;
  }
}

export class AnalysisHttpAdapter implements CodeAnalysisPort {
  private readonly analyzeUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.analyzeUrl = endpoint(options.baseUrl, '/v1/analyze');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResult> {
    const response = await this.request(this.analyzeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      throw new Error(`Analysis failed: ${await responseError(response)}`);
    }
    const body: unknown = await response.json();
    if (!isAnalysisResult(body)) {
      throw new Error('Adaptation service returned an invalid analysis response.');
    }
    return body;
  }
}

export class BackfillHttpAdapter implements CodeBackfillPort {
  private readonly backfillUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.backfillUrl = endpoint(options.baseUrl, '/v1/backfill');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult> {
    const response = await this.request(this.backfillUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(files),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Backfill failed: ${await responseError(response)}`);
    }

    const body: unknown = await response.json();
    if (!isApplyResult(body)) {
      throw new Error('Backfill service returned an invalid response.');
    }
    return body;
  }
}

export function withAdaptationService(
  ports: WorkflowPorts,
  options: AdaptationHttpOptions,
): WorkflowPorts {
  return {
    ...ports,
    adaptation: new AdaptationHttpAdapter(options),
    backfill: new BackfillHttpAdapter(options),
  };
}
