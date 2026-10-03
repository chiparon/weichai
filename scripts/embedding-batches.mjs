/** Short inputs no longer pad to the longest code fragment in a mixed request.
 * Preserve text, tokenizer semantics and response order. */
export function embeddingBatches(input, maxChars = 16_384) {
  const sorted = input.map((text, index) => ({ text, index })).sort((a, b) => a.text.length - b.text.length);
  const batches = [];
  let batch = [], chars = 0;
  for (const entry of sorted) {
    if (batch.length && (batch.length >= 16 || chars + entry.text.length > maxChars ||
        entry.text.length > Math.max(256, batch[0].text.length * 2))) {
      batches.push(batch); batch = []; chars = 0;
    }
    batch.push(entry); chars += entry.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
