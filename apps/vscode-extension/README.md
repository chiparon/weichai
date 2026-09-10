# ForeXplore Code Migration for VS Code

ForeXplore is a VS Code workflow for evidence-based cross-language migration. It indexes existing repositories, lets a user select an approved source implementation, checks an exact source-language/target-language/strategy route, prepares a reviewed patch, and validates it before host-controlled write-back.

This extension is language-agnostic at the contract level. Java to C# is only a historical regression route. Executability is determined by the runtime `MigrationRouteDescriptor` and its validation policy. If the required route capability snapshot is missing or stale, the workflow fails closed.

## Quick start

From the repository root:

```bash
npm ci
npm run dev:extension
```

The development script starts SeekDB, the local retrieval and adaptation services, and a VS Code Extension Development Host. Open the migration panel to browse project analysis. To start migration, initialize and review the 01B target workspace and its module mapping as described below, then explicitly select an eligible callable from the approved directory. Project analysis alone does not make a callable eligible. Candidates are never selected automatically; a user must select one explicitly.

The extension uses the real retrieval and adaptation services. It reports an error when a required service is unavailable and does not silently fall back to sample data.

## Code-intelligence indexing

Historical repositories and the explicitly selected target workspace are registered in one versioned indexing pipeline:

```text
RepositoryRegistry -> AnalysisCoordinator -> native Tree-sitter structural index
                  -> revision store -> SemanticQueryPort
```

**ForeXplore: Refresh Code Intelligence Index** incrementally reuses unchanged files. **ForeXplore: Reindex Retrieval Repositories** checks all files. When content and parser versions are unchanged, the existing revision is retained; readers continue to use the previous active revision until a new revision is complete.

The index stores repository, revision, project, file, symbol, dependency-edge, module-artifact, and search-document records. Project metadata, file lists, static dependencies, and symbols are loaded first; source and additional index evidence are queried on demand. The Agent/MCP boundary exposes only the host-provided read-only `SemanticQueryPort`; it does not accept arbitrary absolute paths, start an LSP, or connect directly to SeekDB.

Structural evidence is not semantic proof. Compiler probes do not upgrade evidence to semantic evidence. A trusted language adapter may mark a precise edge as semantic evidence, but route availability and migration correctness remain separate decisions.

Automatic project/module summaries are code-understanding artifacts. They are not migration approval, route approval, behavioral verification, or permission to write source code. The separate 01A module-knowledge lifecycle has its own human review and publication controls.

### SeekDB configuration

Set these variables in the environment of the process that launches VS Code when persistent code intelligence is required:

```bash
export CODE_INTELLIGENCE_SEEKDB_DATABASE='forexplore'
export CODE_INTELLIGENCE_SEEKDB_HOST='127.0.0.1'       # optional; default shown
export CODE_INTELLIGENCE_SEEKDB_PORT='2881'            # optional; default shown
export CODE_INTELLIGENCE_SEEKDB_USER='root'            # optional; default shown
export CODE_INTELLIGENCE_SEEKDB_PASSWORD='...'
export CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION='384' # optional; default shown
```

Without `CODE_INTELLIGENCE_SEEKDB_DATABASE`, development/test hosts may use explicitly labelled in-memory storage. It is not persistent and is not accepted by a production code-intelligence host. The database name must be a valid SQL identifier.

The adaptation service also requires `DEEPSEEK_API_KEY`. For semantic project analysis, configure `ADAPTATION_SEMANTIC_INDEX_ENABLED=true`, `SEMANTIC_QUERY_PORT_URL` (default example: `http://127.0.0.1:8790`), and, when enabled, the same `SEMANTIC_QUERY_PORT_TOKEN` in both processes. Credentials remain in local process environments.

For the deprecated Legacy V1 integration-compile regression only, configure the historical skeleton project before starting the adaptation service:

```bash
export DEEPSEEK_API_KEY='...'
export ADAPTATION_PROJECT_ROOT='/absolute/path/to/commons-fileupload-java-skeleton'
export ADAPTATION_SKELETON_PROJECT_PATH="$ADAPTATION_PROJECT_ROOT"
npm run dev:adaptation
```

These V1 variables do not authorize or enable a V2 migration route.

## Approved module workflow

### 01A historical repositories

The historical repository flow uses an open `LanguageId` and registered language adapters. Its trusted lifecycle is:

1. **Index Module Migration Repository** fixes a workspace snapshot, produces analysis shards and a unified IR, and proposes module boundaries. Insufficient evidence remains partial and cannot be published.
2. **Review Repository Module Boundaries** is the first human review. It approves file, entity, API, and dependency ownership. Approval starts evidence collection; it does not publish knowledge.
3. **Generate Module Knowledge Summary Proposal** runs or retries the bounded Summary Agent. Each proposal is tied to an `EvidenceBundle`.
4. **Review and Publish Module Knowledge** is the second human review. Accepted modules are written to the local immutable knowledge store and staged/validated before activation in the independent module index.
5. **Withdraw Current Module Knowledge Publication** withdraws a ready publication and restores a prior generation when one exists. Historical artifacts are retained.

Module-index writes are disabled by default. Publishing requires matching `RETRIEVAL_MODULE_INDEX_TOKEN` (retrieval service) and `FOREXPLORE_MODULE_INDEX_WRITER_TOKEN` (extension host), plus server-side `RETRIEVAL_ALLOWED_REPOSITORIES` authorization. Tokens are read from process environments, never workspace settings. The publication scope is `(repositoryId, channel)`; the default channel is `branch:main`.

### 01B target workspace

The target flow reuses the static analysis, adapter registry, unified IR, module discovery, and first boundary review. After Gate 1, the host derives callable implementation states and aggregates them to class, file, module, and workspace:

- `implemented`: a non-placeholder implementation body was detected; this is not behavioral proof.
- `unimplemented`: a high-confidence explicit stub was detected.
- `partial`: TODOs, placeholder returns, or similar incomplete evidence was detected.
- `unknown`: evidence is insufficient or no detector exists for the language.
- `not-applicable`: interfaces, abstract/extern declarations, or explicitly excluded entities are outside the completion denominator.

Run **Initialize 01B Target Workspace**, **Review 01B Target Module Boundaries**, and **Open 01B Target Workspace** in that order. A callable with unknown implementation state or no executable route cannot enter migration. A body-only change can be remapped as `body-only-compatible`, but it still requires Gate 1 review and state re-detection; structural changes require rediscovery.

After write-back or recovery, the old 01B snapshot is invalid. The host rechecks snapshot, hash, and entity identity before later retrieval, adaptation, or write-back. 01B does not run the 01A Summary Agent or publish module knowledge.

### Mapping and execution Overlay

01A and 01B `RepositoryModuleCatalog` records approved through Gate 1 are the module-boundary facts. Cross-repository correspondence is represented by `ModuleMappingProposal -> ModuleMappingReview -> MigrationExecutionOverlay`, supporting 1:1, 1:N, and N:1 mappings.

The host accepts an Overlay only when the referenced catalog/review heads are current and a materialized runtime route capability snapshot exists. A target entity must have one current Overlay before migration starts. Any catalog, overlay, route, runtime, or policy change makes the binding stale. The UI may display a candidate or summary, but display state is not authorization.

The old `FunctionalModule` plan is not the default entry point. It is retained only by commands and identifiers explicitly marked **Legacy**, for compatibility with existing runs.

## Legacy migration waves

The Legacy wave flow is reviewed and committed in a controlled worktree:

1. Review the next wave and its dependency evidence.
2. Import a local patch bundle and prepare it in an isolated Git worktree. The host performs scope checks and local joint validation, then computes `preparedHash`.
3. Review the patch, validation records, and hash. Approval binds to that exact hash and publishes one atomic Git commit on `codex/forexplore-migration/<runId>`.

The current workspace is not partially modified. Patch bundles are untrusted input: Webview, browser, and HTTP requests cannot submit them; bundles cannot contain validation conclusions, source text, content hashes, or execution commands. The host reruns validation locally. Restarting the extension invalidates in-memory prepared state; recovery requires preparing and approving the wave again.

### Patch bundle schema

The imported file must be a strict JSON object containing only `schemaVersion`, `snapshotId`, `planId`, `planHash`, `waveId`, and `modules`. `schemaVersion` is `forexplore-module-wave-patch-bundle/v1`. IDs are safe identifiers. `planHash` is either `sha256:<64 lowercase hexadecimal characters>` or the same 64-character digest without the prefix; the host normalizes it.

```json
{
  "schemaVersion": "forexplore-module-wave-patch-bundle/v1",
  "snapshotId": "snapshot-20260827",
  "planId": "plan-20260827",
  "planHash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "waveId": "wave-01",
  "modules": [{
    "moduleId": "orders",
    "files": [{
      "path": "src/Orders/OrderService.cs",
      "status": "modified",
      "expectedOriginalSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "additions": 1,
      "deletions": 1,
      "hunks": [{
        "header": "@@ -1 +1 @@",
        "lines": [
          { "type": "remove", "content": "old implementation" },
          { "type": "add", "content": "new implementation" }
        ]
      }]
    }]
  }]
}
```

A file is either `modified` or `created`. Modified files require `expectedOriginalSha256`; created files require `expectedAbsent: true` instead. Every file requires a normalized relative `path`, `status`, `additions`, `deletions`, and non-empty `hunks`. Hunk lines contain only `type` (`context`, `add`, or `remove`) and single-line `content`; addition/deletion counts must match.

Paths must be canonical repository-relative POSIX paths. Absolute paths, `..`, empty segments, backslashes, duplicate module/write paths, and writes below `.forexplore/` are rejected. The bundle must exactly cover the selected next wave and each path must belong to the module's approved source, test, generated-file, or write set. Unknown fields, especially `validation`, `contentHash`, full source text, and execution instructions, are rejected. V1 does not support file deletion.

### Wave validation

`forexplore.moduleWaveValidationCommands` is a machine-scoped, user-level VS Code setting. It is not read from the patch bundle, Webview, or workspace `.vscode/settings.json`. Commands run only in the isolated worktree with `shell: false`; shell operators and expansion are unavailable. With no configured commands, the host records required `unverified` validation and blocks preparation.

```json
{
  "forexplore.moduleWaveValidationCommands": [
    {
      "id": "dotnet-test",
      "label": "Target tests",
      "executable": "dotnet",
      "args": ["test", "tests/Target.Tests/Target.Tests.csproj"],
      "cwd": ".",
      "required": true,
      "timeoutMs": 600000
    }
  ]
}
```

Only `id`, `label`, `executable`, `args`, `cwd`, `required`, and `timeoutMs` are accepted. At most 32 commands may be configured. `cwd` must be relative to the worktree; `executable` must be a PATH-resolved command name or a worktree-relative executable. Required failures or `unverified` results block preparation and approval. Compilation success is only an engineering check; it does not prove business behavior, concurrency, timeout, cancellation, or idempotency semantics.

## Configuration

The extension defaults to:

```json
{
  "forexplore.executionMode": "real",
  "forexplore.retrievalApiUrl": "http://127.0.0.1:8787",
  "forexplore.adaptationApiUrl": "http://127.0.0.1:8788",
  "forexplore.topK": 4,
  "forexplore.repositoryKnowledgeChannel": "branch:main",
  "forexplore.repositoryPaths": [],
  "forexplore.targetRepositoryPaths": []
}
```

The Settings view uses the host's native folder picker. Saving persists normalized repository paths and Top K; cancelling discards the draft. Registering or removing a path does not itself withdraw a publication. A target directory must be explicitly selected and must be within the current VS Code workspace; an opened workspace is only a candidate, not an implicit target.

## Write-back protection

- Webview messages express constrained intent; they cannot submit arbitrary target paths, write paths, candidates, patches, or source.
- The host stores the selected candidate, target language, original SHA-256 values, and adaptation result. Candidate selection is explicit.
- Only non-duplicate relative paths in the route-owned allowed write set are accepted. Traversal, absolute paths, symlink escape, dirty buffers, missing preconditions, and hash mismatches are rejected before writing.
- Multi-file writes use one `WorkspaceEdit` and a persistent transaction journal with prepared, committing, committed, and rolled-back states, plus an immutable manifest and recovery point.
- **ForeXplore: Restore Last Backfill** refuses to overwrite a file that changed after the transaction.
- HTTP `POST /v1/backfill` is disabled. Write-back is performed only by the confirmed VS Code host.

## Packaging and development

```bash
npm run typecheck --workspace forexplore-vscode
npm run test --workspace forexplore-vscode
npm run build:extension
npm run package:extension
```

The extension build keeps `vscode` and Tree-sitter runtime/grammar packages external. It copies `node-gyp-build`, `tree-sitter`, and the supported `tree-sitter-*` grammar packages into `dist/extension/node_modules` so their platform-native `.node` bindings resolve from their package directories. It also copies `node_modules/sql.js/dist/sql-wasm.wasm` to `dist/extension/sql-wasm.wasm`; the portable `sql.js` registry uses that WASM file and does not depend on an Electron native SQLite ABI.

VS Code integration tests require a graphical VS Code runtime:

```bash
npm run test:integration --workspace forexplore-vscode
```

## Message boundary

`PROJECT_EXPLORER` carries descriptive project results; `MODULE_EXPLORER` carries the reviewed migration directory. Switching project views must not replace an active V2 target, its catalog mapping, or its route authorization.

Webview-to-host messages include `READY`, repository/target selection, `START_SEARCH`, `SELECT_CANDIDATE`, `START_ADAPT`, `APPLY_CURRENT_RUN`, settings, indexing, and recovery intents. Host-to-Webview messages include `INIT`, module/revision status, target selection, settings, search/adaptation/apply results, service status, and errors. Messages carry host-issued IDs and snapshot/catalog hashes rather than arbitrary paths or source. The shared contracts and workflow state machine live in `@forexplore/contracts` and `@forexplore/workflow-core`.
