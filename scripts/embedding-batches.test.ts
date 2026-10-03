import { expect, it } from 'vitest';
import { embeddingBatches } from './embedding-batches.mjs';

it('isolates long fragments, groups short inputs, and preserves source indices', () => {
  const inputs = ['x'.repeat(12000), 'short', 'y'.repeat(12000), 'brief', '中'.repeat(1000)];
  const batches = embeddingBatches(inputs);
  expect(batches.map(batch => batch.map(entry => entry.index))).toEqual([[1, 3], [4], [0], [2]]);
  const restored = new Array(inputs.length);
  for (const batch of batches) for (const entry of batch) restored[entry.index] = entry.text;
  expect(restored).toEqual(inputs);
  expect(embeddingBatches(Array.from({ length: 16 }, () => 'x'.repeat(12000)))).toHaveLength(16);
  expect(embeddingBatches(Array.from({ length: 16 }, () => 'short'))).toHaveLength(1);
});
