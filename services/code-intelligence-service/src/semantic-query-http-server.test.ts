import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { SemanticQueryPort } from '@forexplore/workflow-core';
import { createSemanticQueryHttpServer } from './semantic-query-http-server.js';
import { SemanticQueryArgumentError } from './semantic-query-service.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

describe('semantic query HTTP transport', () => {
  async function listenQuery(queryPort: SemanticQueryPort): Promise<string> {
    const server = createSemanticQueryHttpServer({ queryPort });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP address.');
    return `http://127.0.0.1:${address.port}/v1/semantic-query/getFileStructure`;
  }
  const scope = { repositoryId: 'repository', analysisRevision: 'revision' };

  it('relays a rejected argument so the caller can correct it', async () => {
    const url = await listenQuery({ getFileStructure: async () => {
      throw new SemanticQueryArgumentError('get_file_structure requires an existing repository-relative file path; the repository root is not a file.');
    } } as unknown as SemanticQueryPort);
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...scope, relativePath: '' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: expect.stringContaining('repository root is not a file') } });
  });

  it('never leaks host detail when the index itself fails', async () => {
    const url = await listenQuery({ getFileStructure: async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:2881 for C:/host-only/index');
    } } as unknown as SemanticQueryPort);
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ ...scope, relativePath: 'src/first.ts' }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'Semantic index query failed.' } });
  });
});
