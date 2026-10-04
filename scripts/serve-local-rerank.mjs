// Local cross-encoder reranker used by module candidate retrieval.
import { createServer } from 'node:http';

const port = Number(process.env.FOREXPLORE_RERANK_PORT ?? 4022);
const modelId = process.env.FOREXPLORE_RERANK_MODEL ?? 'Xenova/bge-reranker-base';
const moduleDir = process.env.FOREXPLORE_EMBEDDING_TOOLS;
if (!moduleDir) throw new Error('Set FOREXPLORE_EMBEDDING_TOOLS to the directory holding @huggingface/transformers.');
const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import(`file://${moduleDir.replaceAll('\\', '/')}/node_modules/@huggingface/transformers/dist/transformers.node.mjs`);
env.cacheDir = process.env.FOREXPLORE_MODEL_CACHE ?? env.cacheDir;
if (process.env.FOREXPLORE_MODEL_HOST) env.remoteHost = process.env.FOREXPLORE_MODEL_HOST;
const tokenizer = await AutoTokenizer.from_pretrained(modelId);
const requested = process.env.FOREXPLORE_RERANK_DEVICE?.trim();
let model; let device = requested ?? 'cpu';
for (const candidate of (requested ? [requested] : ['dml', 'webgpu', 'cpu'])) {
  try { model = await AutoModelForSequenceClassification.from_pretrained(modelId, { device: candidate }); device = candidate; break; }
  catch (error) { console.error(JSON.stringify({ stage: 'device-failed', device: candidate, message: error instanceof Error ? error.message : String(error) })); }
}
if (!model) throw new Error('No usable reranker execution provider.');
async function score(query, passages) {
  const inputs = tokenizer(Array.from({ length: passages.length }, () => query), { text_pair: passages, padding: true, truncation: true });
  const output = await model(inputs); const [rows, columns] = output.logits.dims; const data = output.logits.data;
  return Array.from({ length: rows }, (_, row) => Math.max(...Array.from({ length: columns }, (_, column) => data[row * columns + column])));
}
const server = createServer((request, response) => {
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && request.url === '/health') return send(200, { model: modelId, device });
  if (request.method !== 'POST' || request.url !== '/rerank') return send(404, { error: 'Not found.' });
  let body = ''; request.on('data', chunk => { body += chunk; if (body.length > 4_000_000) request.destroy(); });
  request.on('end', async () => { try {
    const { query, documents, passages } = JSON.parse(body); const values = passages ?? documents;
    if (typeof query !== 'string' || !Array.isArray(values) || !values.length || values.some(item => typeof item !== 'string')) return send(400, { error: 'Expected { query: string, documents: string[] }.' });
    const started = Date.now(); const scores = await score(query, values);
    if (documents) return send(200, { results: scores.map((relevance_score, index) => ({ index, relevance_score })).sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index), latencyMs: Date.now() - started });
    return send(200, { scores, latencyMs: Date.now() - started });
  } catch (error) { send(500, { error: error instanceof Error ? error.message : String(error) }); } });
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}`, model: modelId, device })));
