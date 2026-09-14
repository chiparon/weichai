// Local cross-encoder rerank server.
//
// Mirrors scripts/serve-local-embeddings.mjs: a separate process, so the
// intelligence service keeps no model dependency and the provider can be swapped
// per deployment. task-reranker.ts calls POST /rerank with the requirement and the
// candidate passages, and receives one score per passage.
//
// Provider selection matters more than the model choice. transformers.js in Node
// supports `dml`, `webgpu` and `cpu` — NOT `cuda`. Measured on the project
// workstation (RTX 4060 Laptop), 12 pairs of the size retrieval sends:
//
//   bge-reranker-base (278M, zh+en)  dml  58-66 ms   cpu 1444 ms
//
// On a host without DirectX 12 the same model on CPU is *slower* than the LLM
// reranker it is meant to replace, which is why the device is chosen here and
// reported by /health rather than hard-coded in the caller.
//
// Environment:
//   FOREXPLORE_RERANK_PORT       default 4022
//   FOREXPLORE_RERANK_MODEL      default Xenova/bge-reranker-base
//   FOREXPLORE_RERANK_DEVICE     default: probe dml, then webgpu, then cpu
//   FOREXPLORE_EMBEDDING_TOOLS   directory holding @huggingface/transformers
//   FOREXPLORE_MODEL_CACHE       model cache directory

import { createServer } from 'node:http';

const port = Number(process.env.FOREXPLORE_RERANK_PORT ?? 4022);
const modelId = process.env.FOREXPLORE_RERANK_MODEL ?? 'Xenova/bge-reranker-base';
const moduleDir = process.env.FOREXPLORE_EMBEDDING_TOOLS;
if (!moduleDir) throw new Error('Set FOREXPLORE_EMBEDDING_TOOLS to the directory holding @huggingface/transformers.');
const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(
  `file://${moduleDir.replaceAll('\\', '/')}/node_modules/@huggingface/transformers/dist/transformers.node.mjs`);
env.cacheDir = process.env.FOREXPLORE_MODEL_CACHE ?? env.cacheDir;

const tokenizer = await AutoTokenizer.from_pretrained(modelId);
const requested = process.env.FOREXPLORE_RERANK_DEVICE?.trim();
const candidates = requested ? [requested] : ['dml', 'webgpu', 'cpu'];
let device = 'cpu';
let model;
for (const candidate of candidates) {
  try {
    model = await AutoModelForSequenceClassification.from_pretrained(modelId, { device: candidate });
    device = candidate;
    break;
  } catch (error) {
    console.error(JSON.stringify({ stage: 'device-failed', device: candidate, message: error instanceof Error ? error.message : String(error) }));
  }
}
if (!model) throw new Error(`No usable execution provider among ${candidates.join(', ')}.`);

/** One score per passage; a two-class reranker contributes its positive-class logit. */
async function score(query, passages) {
  const inputs = tokenizer(Array.from({ length: passages.length }, () => query), { text_pair: passages, padding: true, truncation: true });
  const output = await model(inputs);
  const [rows, columns] = output.logits.dims;
  const data = output.logits.data;
  const scores = [];
  for (let row = 0; row < rows; row += 1) {
    let best = data[row * columns];
    for (let column = 1; column < columns; column += 1) {
      const value = data[row * columns + column];
      if (value > best) best = value;
    }
    scores.push(best);
  }
  return scores;
}

const server = createServer((request, response) => {
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && request.url === '/health') return send(200, { model: modelId, device });
  if (request.method !== 'POST' || request.url !== '/rerank') return send(404, { error: 'Not found.' });
  let body = '';
  request.on('data', (chunk) => { body += chunk; if (body.length > 4_000_000) request.destroy(); });
  request.on('end', async () => {
    try {
      const { query, passages } = JSON.parse(body);
      if (typeof query !== 'string' || !Array.isArray(passages) || !passages.length || passages.some((item) => typeof item !== 'string')) {
        return send(400, { error: 'Expected { query: string, passages: string[] }.' });
      }
      const started = Date.now();
      const scores = await score(query, passages);
      send(200, { scores, latencyMs: Date.now() - started });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, model: modelId, device })));
