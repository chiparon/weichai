import type { AnalysisRequest, AnalysisResult } from '@forexplore/contracts';

export interface CodeAnalysisPort {
  analyze(request: AnalysisRequest, signal?: AbortSignal): Promise<AnalysisResult>;
}
