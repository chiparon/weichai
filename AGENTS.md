# Windows and WSL development

This checkout has separate Windows and WSL workspaces. The machine-local
`.recast-platforms.json` maps their paths; it contains no credentials.

- Use the workspace assigned to the current Node platform for installs, builds,
  tests and experiment drivers. Never run Linux `npm ci` or `npm install` in the
  mapped Windows directory, or Windows installs in the WSL directory.
- Run `npm run workspace:check` before using the toolchain. The check itself
  uses only Node built-ins, so it also works with a broken dependency tree.
- Before switching platforms, synchronize current source with
  `npm run workspace:sync -- --to wsl` or `--to windows`. The sync command never
  copies `node_modules`, build output, local credentials or experiment results.
  A conflict must be resolved in source before retrying; do not force overwrite
  either workspace or delete its synchronization baseline.
- Synchronization requires the same Git HEAD in both worktrees. Synchronize
  committed changes with Git first. Local changes remain uncommitted.
- If dependency manifests change, run `npm ci` in the destination platform's
  directory. Inference tools belong in the separate runtime directory used by
  `scripts/start-recast-services.mjs`, not the repository dependency tree.

Each platform owns its `node_modules`, extension `dist` and runtime caches.
Docker SeekDB can be shared; do not remove its data volume during setup.
