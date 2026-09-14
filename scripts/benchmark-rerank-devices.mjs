// Device and throughput benchmark for local cross-encoder reranking.
//
// The question this answers: can a cross-encoder replace the LLM reranker that
// services/code-intelligence-service/src/task-reranker.ts currently calls? The
// answer depends entirely on the execution provider, so measure it on the target
// machine instead of assuming.
//
// Measured on the project workstation (RTX 4060 Laptop, Windows, i7-14650HX),
// 12 query/passage pairs of the size task retrieval actually sends
// (~30-character Chinese requirement + ~240-character code preview):
//
//   Xenova/bge-reranker-base   (278M, zh+en)  cpu 1444 ms | dml  58 ms
//   Xenova/ms-marco-MiniLM-L-6 (22M,  en)     cpu  361 ms | dml  11 ms
//
// Two findings worth keeping:
//   1. `device: 'cuda'` is NOT valid in transformers.js for Node — the supported
//      set is `dml`, `webgpu`, `cpu`. On Windows the GPU path is DirectML.
//   2. DirectML is ~25x faster than CPU here, which is what makes a *bilingual*
//      cross-encoder (rather than a tiny English one) affordable.
//
// DirectML requires Windows with a DirectX 12 GPU; on a Linux server the same
// code falls back to `cpu` and the mid-size model becomes slower than the LLM.
// Any integration must therefore select the provider per deployment rather than
// hard-coding one.
//
// Run (needs @huggingface/transformers resolvable, see FOREXPLORE_EMBEDDING_TOOLS):
//   node scripts/benchmark-rerank-devices.mjs Xenova/bge-reranker-base dml

const modelId = process.argv[2] ?? 'Xenova/bge-reranker-base';
const device = process.argv[3] ?? 'cpu';
const moduleDir = process.env.FOREXPLORE_EMBEDDING_TOOLS;
if (!moduleDir) throw new Error('Set FOREXPLORE_EMBEDDING_TOOLS to the directory holding @huggingface/transformers.');
const transformersPath = `${moduleDir.replaceAll('\\', '/')}/node_modules/@huggingface/transformers`;
const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(`file://${transformersPath}/dist/transformers.node.mjs`);
env.cacheDir = process.env.FOREXPLORE_MODEL_CACHE ?? env.cacheDir;

const started = Date.now();
const tokenizer = await AutoTokenizer.from_pretrained(modelId);
const model = await AutoModelForSequenceClassification.from_pretrained(modelId, { device });
const loadMs = Date.now() - started;

// One requirement and one candidate shape, repeated: this measures provider
// throughput, not ranking quality.
const query = '把输入数据整体写入输出对象，并返回写入的字节数。';
const passages = Array.from({ length: 12 }, (_, index) =>
  (`static copy(input: Buffer, output?: { write(chunk: Buffer): void }): number {\n  // candidate ${index}\n  output?.write(input);\n  return input.length;\n}`).padEnd(240, ' '));

const score = async () => {
  const inputs = tokenizer(Array.from({ length: passages.length }, () => query), { text_pair: passages, padding: true, truncation: true });
  const output = await model(inputs);
  return Array.from(output.logits.data);
};
const t0 = Date.now();
await score();
const warmMs = Date.now() - t0;
const runs = [];
for (let index = 0; index < 5; index += 1) { const t = Date.now(); await score(); runs.push(Date.now() - t); }
runs.sort((left, right) => left - right);
console.log(JSON.stringify({ modelId, device, pairs: passages.length, loadMs, warmMs, medianMs: runs[2], minMs: runs[0], maxMs: runs.at(-1) }));
