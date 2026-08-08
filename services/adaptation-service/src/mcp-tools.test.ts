import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMcpToolHost } from './mcp-tools';
import { createMcpMessageHandler } from './mcp-server';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('ReCodeAgent-compatible MCP tools', () => {
  it('exposes project analyzer and language-server-compatible read tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-mcp-'));
    roots.push(root);
    writeFileSync(join(root, 'Rate.cs'), 'using System;\npublic class Rate { public decimal GetRate() { return 1m; } }');
    const host = createLocalMcpToolHost(root);
    expect(host.listTools().map((tool) => tool.name)).toEqual([
      'get_directory_tree', 'get_file_structure', 'definition', 'references', 'read_file', 'get_target_context',
    ]);
    const structure = await host.callTool('get_file_structure', { language: 'csharp', file_path: 'Rate.cs' });
    expect(JSON.parse(structure.content[0]!.text).skeleton.classes[0].name).toBe('Rate');
    const definition = await host.callTool('definition', { symbolName: 'GetRate' });
    expect(JSON.parse(definition.content[0]!.text).source).toContain('GetRate');
    const tree = await host.callTool('get_directory_tree', { path: '.', print_dirs_only: false });
    expect(tree.content[0]!.text).toContain('Rate.cs');
  });

  it('resolves qualified symbol names and returns complete Python definitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-mcp-'));
    roots.push(root);
    writeFileSync(join(root, 'rates.py'), [
      'class Rate:',
      '    def get_rate(self, value: int) -> int:',
      '        adjusted = value + 1',
      '        return adjusted',
      '',
      'def consume():',
      '    return Rate().get_rate(2)',
      '',
    ].join('\n'));
    const host = createLocalMcpToolHost(root);

    const structure = await host.callTool('get_file_structure', { language: 'python', file_path: 'rates.py' });
    const skeleton = JSON.parse(structure.content[0]!.text).skeleton;
    expect(skeleton.classes[0].methods[0]).toMatchObject({ name: 'get_rate', end_line: 4 });

    const definition = await host.callTool('definition', { symbolName: 'Rate.get_rate' });
    expect(JSON.parse(definition.content[0]!.text).source).toContain('return adjusted');

    const references = await host.callTool('references', { symbolName: 'Rate.get_rate' });
    expect(JSON.parse(references.content[0]!.text)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'rates.py', line: 2 }),
      expect.objectContaining({ path: 'rates.py', line: 7 }),
    ]));
  });

  it('rejects project escape through paths and symbolic links', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-mcp-'));
    const outside = mkdtempSync(join(tmpdir(), 'forexplore-mcp-outside-'));
    roots.push(root, outside);
    writeFileSync(join(outside, 'secret.cs'), 'public class Secret {}');
    symlinkSync(join(outside, 'secret.cs'), join(root, 'linked.cs'));
    const host = createLocalMcpToolHost(root);

    const parentEscape = await host.callTool('read_file', { path: '../secret.cs' });
    expect(parentEscape).toMatchObject({ isError: true });
    const linkEscape = await host.callTool('read_file', { path: 'linked.cs' });
    expect(linkEscape).toMatchObject({ isError: true });
    expect(linkEscape.content[0]!.text).toContain('project root');
  });

  it('enforces ReCodeAgent required arguments and supported languages', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-mcp-'));
    roots.push(root);
    writeFileSync(join(root, 'Rate.cs'), 'public class Rate {}');
    const host = createLocalMcpToolHost(root);

    expect(await host.callTool('get_directory_tree', { path: '.' })).toMatchObject({ isError: true });
    expect(await host.callTool('get_file_structure', { language: 'brainfuck', file_path: 'Rate.cs' })).toMatchObject({ isError: true });
    expect(await host.callTool('get_file_structure', { language: 'python', file_path: 'Rate.cs' })).toMatchObject({ isError: true });
    expect(await host.callTool('get_target_context', { target: { path: 'Rate.cs' } })).toMatchObject({ isError: true });
  });

  it('serves MCP JSON-RPC initialize, list, and call operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-mcp-'));
    roots.push(root);
    const handle = createMcpMessageHandler(createLocalMcpToolHost(root));
    expect((await handle({ jsonrpc: '2.0', id: 0, method: 'tools/list' }))?.error).toMatchObject({ code: -32002 });
    expect((await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }))?.result).toMatchObject({ serverInfo: { name: 'forexplore-analysis-tools' } });
    expect((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))?.result).toHaveProperty('tools');
    const response = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_directory_tree', arguments: { path: '.', print_dirs_only: false } } });
    expect(response?.error).toBeUndefined();
    expect(await handle({ jsonrpc: '2.0', method: 'unknown/notification' })).toBeNull();
  });

  it('negotiates unsupported MCP versions and rejects malformed initialize requests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forexplore-mcp-'));
    roots.push(root);
    const missingVersion = createMcpMessageHandler(createLocalMcpToolHost(root));
    expect((await missingVersion({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))?.error).toMatchObject({ code: -32602 });

    const unsupportedVersion = createMcpMessageHandler(createLocalMcpToolHost(root));
    expect((await unsupportedVersion({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }))?.result)
      .toMatchObject({ protocolVersion: '2026-07-28' });

    const earlyNotification = createMcpMessageHandler(createLocalMcpToolHost(root));
    expect(await earlyNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await earlyNotification({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2026-07-28' } }))?.result)
      .toMatchObject({ protocolVersion: '2026-07-28' });
    expect((await earlyNotification({ jsonrpc: '2.0', id: true, method: 'ping' }))?.error)
      .toMatchObject({ code: -32600 });
  });
});
