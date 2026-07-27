/// <reference types="vite/client" />

declare module 'virtual:target-module-tree' {
  import type { ModuleNode } from '@forexplore/contracts';

  export const moduleTree: ModuleNode;
}

declare module '*.css';

declare module 'virtual:target-module-tree' {
  import type { ModuleNode } from '@forexplore/contracts';

  export const moduleTree: ModuleNode;
}
