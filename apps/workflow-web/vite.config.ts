import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { csharpWorkspaceTree } from '../../packages/workspace-adapters/src/csharp-workspace.ts';
import { scanCSharpWorkspaceTree } from './build/target-module-tree';

const virtualModuleId = 'virtual:target-module-tree';
const resolvedVirtualModuleId = `\0${virtualModuleId}`;
const targetWorkspace = fileURLToPath(
  new URL(
    '../../fixtures/target-system/forexplore-csharp-workspace',
    import.meta.url,
  ),
);
const normalizedTargetWorkspace = targetWorkspace.replaceAll('\\', '/');

function targetModuleTreePlugin(): Plugin {
  return {
    name: 'forexplore-target-module-tree',
    resolveId(id) {
      return id === virtualModuleId ? resolvedVirtualModuleId : undefined;
    },
    async load(id) {
      if (id !== resolvedVirtualModuleId) return undefined;
      const moduleTree = await scanCSharpWorkspaceTree(
        targetWorkspace,
        csharpWorkspaceTree,
      );
      return `export const moduleTree = ${JSON.stringify(moduleTree)};`;
    },
    configureServer(server) {
      server.watcher.add(targetWorkspace);
      server.watcher.on('all', (_event, changedPath) => {
        const normalizedChangedPath = changedPath.replaceAll('\\', '/');
        if (
          !(
            normalizedChangedPath === normalizedTargetWorkspace ||
            normalizedChangedPath.startsWith(`${normalizedTargetWorkspace}/`)
          ) ||
          !['.cs', '.csproj'].includes(
            normalizedChangedPath.slice(normalizedChangedPath.lastIndexOf('.')),
          )
        ) {
          return;
        }
        const virtualModule = server.moduleGraph.getModuleById(resolvedVirtualModuleId);
        if (virtualModule) server.moduleGraph.invalidateModule(virtualModule);
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

export default defineConfig({
  plugins: [targetModuleTreePlugin(), react()],
  test: {
    environment: 'jsdom',
  },
  server: {
    port: 4173,
    strictPort: true,
  },
});
