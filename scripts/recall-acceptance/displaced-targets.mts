/**
 * Sanity probe for the flat symbol ranking: candidates displaced from the
 * `FileUploadBase` / `parseRequest` result must be recoverable for their own
 * targets. A candidate that only ever appeared because its module was recalled is
 * expected to disappear from an unrelated target's result - and to rank first for
 * the target it actually implements.
 */
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import type { ModuleTarget } from '@forexplore/contracts';
import { ModuleImplementationSearchService, SeekDbIndexStore } from '@forexplore/code-intelligence-service';

const database = process.argv[2] ?? 'forexplore_javafileupload_flow_20260913';
const pool = mysql.createPool({ host: '127.0.0.1', port: 2881, user: 'root', password: '', database, connectionLimit: 8 });
const store = new SeekDbIndexStore({
  host: '127.0.0.1', port: 2881, user: 'root', password: '', database, vectorDimension: 384,
  embedding: { url: 'http://127.0.0.1:4021/v1/embeddings', apiKey: '',
    model: 'Xenova/multilingual-e5-small@761b726dd34fb83930e26aab4e9ac3899aa1fa78', queryPrefix: 'query: ', documentPrefix: 'passage: ' },
}, pool);
const search = new ModuleImplementationSearchService(store);
const repositories = await store.listRepositories();
const history = repositories.filter((repository) => repository.role === 'history' && repository.activeRevision);
const byName = new Map(repositories.map((repository) => [repository.displayName, repository]));

const index = await store.getStructuralIndex({ repositoryId: byName.get('commons-fileupload-csharp')!.repositoryId, analysisRevision: byName.get('commons-fileupload-csharp')!.activeRevision! });
assert(index, 'The C# repository has no structural index.');
const targets = ['DiskFileItemFactory', 'QuotedPrintableDecoder', 'MultipartStream'];
for (const name of targets) {
  const symbol = index.symbols.find((candidate) => candidate.name === name && ['class', 'interface', 'record', 'struct'].includes(candidate.kind))
    ?? index.symbols.find((candidate) => candidate.qualifiedName?.endsWith(`.${name}`) && ['class', 'interface', 'record', 'struct'].includes(candidate.kind));
  assert(symbol, `Symbol ${name} was not found in the C# index.`);
  const target: ModuleTarget = { id: `symbol://${symbol.symbolId}`, name: symbol.name, kind: 'class', path: symbol.relativePath,
    language: 'C#', signature: symbol.signature ?? symbol.name };
  const candidates = await search.search({ target, requirement: '恢复 multipart 分段流读取实现', topK: 5,
    repositoryIds: history.map((repository) => repository.repositoryId) }, AbortSignal.timeout(120_000));
  console.log(`\n=== ${name} (${symbol.relativePath}) ===`);
  candidates.forEach((candidate, rank) => console.log(
    `#${rank} ${candidate.score.overall.toFixed(4)} ${candidate.repository.replace('commons-fileupload-', '')} :: ${candidate.title}`));
  const self = candidates.findIndex((candidate) => candidate.title.includes(name));
  console.log(`self-rank: ${self < 0 ? 'absent' : `#${self}`} | candidates: ${candidates.length}`);
}
await store.close();
