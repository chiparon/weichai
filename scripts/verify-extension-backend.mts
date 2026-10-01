import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { BackendProcess } from '../apps/vscode-extension/src/backend-process';
import { createServer as createHttpServer } from 'node:http';
import { ConfiguredModelReranker } from '../apps/vscode-extension/src/model-reranker';
import { createModelCredentialProvider } from '../apps/vscode-extension/src/model-credential';
import { setModelCredentialProvider } from '../apps/vscode-extension/src/local-fetch';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recast-packaged-backend-')));
const server = createServer();
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
await new Promise<void>(r => server.close(() => r()));
const extensionPath = path.resolve('apps/vscode-extension');
const url = `http://127.0.0.1:${port}`;
let childExited: Promise<void> | undefined;
const launch: typeof spawn = ((...args: Parameters<typeof spawn>) => {
  const child = spawn(...args); childExited = new Promise<void>(resolve => child.once('exit', () => resolve())); return child;
}) as typeof spawn;
const backend = new BackendProcess(() => ({ extensionPath, workspaceRoot: root, url, trusted: true, autoStart: true, semanticPort: 8790 }), console.log, launch);
try {
  await writeFile(path.join(root, 'target.py'), 'def check():\n    return 1\n');
  const ready = await backend.ensure();
  assert.equal(ready.workspaceRoot, root); assert.equal(ready.retrievalRerank, true); assert.equal(ready.workspaceTranslation, true);
  const response = await fetch(`${url}/v1/workspace-translations/configuration`, { headers: { authorization: `Bearer ${backend.translationToken}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).behavioralVerification, false);
  const exit = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(extensionPath, 'dist/extension/workspace-compile.cjs')], { cwd: root, windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    child.once('error', reject); child.once('exit', resolve);
  });
  assert.equal(exit, 0);
  const modelServer = createHttpServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-test-key');
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(JSON.parse(body).model, 'synthetic-test-model');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: '["b","a"]' } }] }));
    });
  });
  await new Promise<void>(r => modelServer.listen(0, '127.0.0.1', r));
  const modelPort = (modelServer.address() as { port: number }).port;
  setModelCredentialProvider(createModelCredentialProvider({ get: async () => 'synthetic-test-key', store: async () => {}, delete: async () => {} }, () => url,
    () => ({ provider: 'custom', apiBase: `http://127.0.0.1:${modelPort}/v1`, model: 'synthetic-test-model', maxOutputTokens: 1024 })));
  try {
    const reranker = new ConfiguredModelReranker(() => url, () => backend.ensure());
    const order = await reranker.rerank('upload', ['a', 'b'].map(id => ({ id, name: id, granularity: 'function', relativePath: 'target.py' })));
    assert.deepEqual(order.map(item => item.id), ['b', 'a']);
    console.log('Host credential -> packaged backend -> synthetic model -> reranking passed (no user key used).');
  } finally { setModelCredentialProvider(undefined); await new Promise<void>(r => modelServer.close(() => r())); }
  console.log('Packaged backend startup, capability/authentication, and Python compile checks passed.');
} finally {
  backend.dispose();
  let stopped = false;
  for (let i = 0; i < 40; i++) {
    if (!await backend.capabilities(url)) { stopped = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(stopped, true, 'Owned backend did not stop');
  if (childExited) await Promise.race([childExited, new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Child did not exit')), 8000); timer.unref();
  })]);
  await rm(root, { recursive: true, force: true });
  console.log('Owned backend stopped; temporary workspace removed.');
}
