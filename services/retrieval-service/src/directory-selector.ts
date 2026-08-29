import type { SearchRequest } from '@forexplore/contracts';
import type {
  DirectorySelectionConfig,
  EmbeddingProvider,
  RepositoryDirectory,
} from './types.js';
import { overlap } from './text-analysis.js';

/**
 * Stage-1 coarse retrieval: pick which corpus directories (repositories) to
 * search before running the fine-grained character-precise retrieval inside
 * them. Directories are matched by repository name against the query text
 * using a hybrid of lexical token overlap and vector cosine similarity.
 */

export const DEFAULT_DIRECTORY_SELECTION: DirectorySelectionConfig = {
  enabled: true,
  topM: 3,
  minScore: 0.05,
};

const LEXICAL_WEIGHT = 0.5;
const VECTOR_WEIGHT = 0.5;

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

export function directoryScore(
  queryText: string,
  name: string,
  directoryEmbedding: number[] | undefined,
  queryEmbedding: number[],
): number {
  const lexical = overlap(queryText, name);
  const vector = directoryEmbedding ? cosine(queryEmbedding, directoryEmbedding) : 0;
  return clamp(LEXICAL_WEIGHT * lexical + VECTOR_WEIGHT * vector);
}

export async function selectDirectories(
  directories: RepositoryDirectory[],
  request: SearchRequest,
  authorizedRepositories: readonly string[],
  embeddings: EmbeddingProvider,
  queryEmbedding: number[],
  queryText: string,
  config: DirectorySelectionConfig,
): Promise<string[]> {
  const authorized = new Set(authorizedRepositories);
  let candidates = directories.filter((directory) => authorized.has(directory.repository));

  // Nothing indexed under the authorized scope: search it unchanged (zero hits).
  if (candidates.length === 0) return [...authorizedRepositories];

  const languages = new Set(request.candidateLanguages ?? []);
  if (languages.size > 0) {
    candidates = candidates.filter((directory) => languages.has(directory.language));
    // No directory in the requested language: let the stage-2 language filter
    // return an empty result rather than searching every language.
    if (candidates.length === 0) return [...authorizedRepositories];
  }

  // A single candidate needs no scoring, and an empty pool must fall back to
  // the full authorized scope to keep the downstream SQL filter non-empty.
  if (candidates.length <= 1) return candidates.map((directory) => directory.repository);

  const directoryEmbeddings = await embeddings.embed(
    candidates.map((directory) => directory.repository),
  );
  const scored = candidates
    .map((directory, index) => ({
      repository: directory.repository,
      score: directoryScore(
        queryText,
        directory.repository,
        directoryEmbeddings[index],
        queryEmbedding,
      ),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  // No directory confidently matches: fall back to the full authorized scope to
  // preserve recall rather than returning an empty result.
  if (!best || best.score < config.minScore) return [...authorizedRepositories];

  return scored
    .slice(0, Math.max(1, config.topM))
    .map((entry) => entry.repository);
}

export const directorySelectionInternals = {
  cosine,
  directoryScore,
  DEFAULT_DIRECTORY_SELECTION,
};
