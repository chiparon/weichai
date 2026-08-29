import type { SearchRequest } from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DIRECTORY_SELECTION,
  cosine,
  directoryScore,
  selectDirectories,
} from './directory-selector.js';
import type { EmbeddingProvider, RepositoryDirectory } from './types.js';

const target = {
  id: 'target',
  name: 'uploadCoordinator',
  kind: 'class' as const,
  path: 'src/UploadCoordinator.java',
  language: 'Java' as const,
  signature: 'class UploadCoordinator',
};

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    target,
    requirement: '',
    topK: 4,
    repositoryScopes: ['alpha', 'beta', 'gamma', 'delta'],
    ...overrides,
  };
}

function embeddingsFor(vectors: Record<string, number[]>): EmbeddingProvider {
  return {
    dimension: 2,
    embed: vi.fn(async (texts: string[]) => texts.map((text) => vectors[text] ?? [])),
  };
}

describe('cosine', () => {
  it('measures identical vectors as 1 and orthogonal as 0', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('returns 0 for a zero vector or mismatched lengths', () => {
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('directoryScore', () => {
  it('blends lexical overlap and vector cosine into [0, 1]', () => {
    // lexical: "fileupload" is shared -> overlap = 1/sqrt(3*3) ≈ 0.333
    // vector: cosine([1,0],[1,0]) = 1
    const score = directoryScore('upload coordinator fileupload', 'commons-fileupload-ts', [1, 0], [1, 0]);
    expect(score).toBeGreaterThan(0.6);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('treats a missing directory embedding as zero vector contribution', () => {
    expect(directoryScore('fileupload', 'commons-fileupload-ts', undefined, [1, 0]))
      .toBeGreaterThan(0);
    expect(directoryScore('unrelated', 'commons-fileupload-ts', undefined, [1, 0])).toBe(0);
  });
});

describe('selectDirectories', () => {
  const directories: RepositoryDirectory[] = [
    { repository: 'alpha', language: 'Python' },
    { repository: 'beta', language: 'Python' },
    { repository: 'gamma', language: 'Go' },
    { repository: 'delta', language: 'Go' },
  ];

  it('selects the top-M directories by hybrid score', async () => {
    const embeddings = embeddingsFor({
      alpha: [1, 0],
      beta: [0.6, 0.8],
      gamma: [0, 1],
      delta: [-1, 0],
    });
    const selected = await selectDirectories(
      directories,
      request(),
      ['alpha', 'beta', 'gamma', 'delta'],
      embeddings,
      [1, 0],
      'totally unrelated',
      { enabled: true, topM: 2, minScore: 0.05 },
    );
    expect(selected).toEqual(['alpha', 'beta']);
  });

  it('short-circuits to the sole candidate without embedding', async () => {
    const embeddings = embeddingsFor({ alpha: [1, 0] });
    const selected = await selectDirectories(
      directories,
      request(),
      ['alpha'],
      embeddings,
      [1, 0],
      'unrelated',
      DEFAULT_DIRECTORY_SELECTION,
    );
    expect(selected).toEqual(['alpha']);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it('falls back to the authorized scope when no directory matches', async () => {
    const embeddings = embeddingsFor({
      alpha: [0, 1],
      beta: [0, -1],
      gamma: [0, 1],
      delta: [0, -1],
    });
    const selected = await selectDirectories(
      directories,
      request(),
      ['alpha', 'beta'],
      embeddings,
      [1, 0],
      'unrelated',
      { enabled: true, topM: 2, minScore: 0.05 },
    );
    expect(selected).toEqual(['alpha', 'beta']);
  });

  it('returns the authorized scope when nothing is indexed under it', async () => {
    const embeddings = embeddingsFor({ alpha: [1, 0] });
    const selected = await selectDirectories(
      directories,
      request(),
      ['unindexed-repo'],
      embeddings,
      [1, 0],
      'unrelated',
      DEFAULT_DIRECTORY_SELECTION,
    );
    expect(selected).toEqual(['unindexed-repo']);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });

  it('hard-filters directories by candidate language before scoring', async () => {
    const embeddings = embeddingsFor({ gamma: [1, 0], delta: [0.6, 0.8] });
    const selected = await selectDirectories(
      directories,
      request({ candidateLanguages: ['Go'] }),
      ['alpha', 'gamma', 'delta'],
      embeddings,
      [1, 0],
      'unrelated',
      { enabled: true, topM: 1, minScore: 0.05 },
    );
    expect(selected).toEqual(['gamma']);
  });

  it('falls back to the authorized scope when no directory matches the language', async () => {
    const embeddings = embeddingsFor({ alpha: [1, 0] });
    const selected = await selectDirectories(
      directories,
      request({ candidateLanguages: ['Java'] }),
      ['alpha', 'beta'],
      embeddings,
      [1, 0],
      'unrelated',
      DEFAULT_DIRECTORY_SELECTION,
    );
    expect(selected).toEqual(['alpha', 'beta']);
    expect(embeddings.embed).not.toHaveBeenCalled();
  });
});
