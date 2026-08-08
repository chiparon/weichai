import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { McpToolHost } from './mcp-tools.js';
import { createLocalMcpToolHost } from './mcp-tools.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const LATEST_PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

export const supportedMcpProtocolVersions = Object.freeze([...SUPPORTED_PROTOCOL_VERSIONS]);

export function createMcpMessageHandler(host: McpToolHost) {
  let initialized = false;
  return async (message: unknown): Promise<JsonRpcResponse | null> => {
    if (!isRequest(message)) return errorResponse(null, -32600, 'Invalid JSON-RPC request.');
    const notification = !Object.hasOwn(message, 'id');
    const id = message.id ?? null;
    if (message.method === 'notifications/initialized') return null;
    if (message.method === 'initialize') {
      if (notification) return null;
      if (initialized) return errorResponse(id, -32600, 'MCP server is already initialized.');
      const protocolVersion = requestedProtocolVersion(message.params);
      if (!protocolVersion) return errorResponse(id, -32602, 'initialize requires a protocolVersion string.');
      initialized = true;
      return response(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion) ? protocolVersion : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'forexplore-analysis-tools', version: '0.1.0' },
        instructions: 'Repository-scoped analysis tools adapted from the ReCodeAgent workflow for module-level translation.',
      });
    }
    if (notification) return null;
    if (!initialized) return errorResponse(id, -32002, 'MCP server is not initialized.');
    if (message.method === 'ping') return response(id, {});
    if (message.method === 'tools/list') return response(id, { tools: host.listTools() });
    if (message.method === 'tools/call') {
      const params = record(message.params);
      if (!params || typeof params.name !== 'string') return errorResponse(id, -32602, 'tools/call requires a tool name.');
      return response(id, await host.callTool(params.name, params.arguments ?? {}));
    }
    return errorResponse(id, -32601, `Method not found: ${message.method}`);
  };
}

export async function runMcpStdioServer(projectRoot: string): Promise<void> {
  const handle = createMcpMessageHandler(createLocalMcpToolHost(projectRoot));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      process.stdout.write(`${JSON.stringify(errorResponse(null, -32700, 'Parse error.'))}\n`);
      continue;
    }
    const result = await handle(message);
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

function requestedProtocolVersion(params: unknown): string {
  const value = record(params)?.protocolVersion;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isRequest(value: unknown): value is JsonRpcRequest {
  const item = record(value);
  if (item?.jsonrpc !== '2.0' || typeof item.method !== 'string') return false;
  if (!Object.hasOwn(item, 'id')) return true;
  return item.id === null || typeof item.id === 'string' || typeof item.id === 'number';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function response(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const projectRoot = process.argv[2]?.trim() || process.env.ADAPTATION_PROJECT_ROOT?.trim() || process.cwd();
  void runMcpStdioServer(projectRoot).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
