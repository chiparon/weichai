# RECAST

RECAST is the competition-facing product name for the ForeXplore codebase. It
provides one module-based code reuse and migration workflow in the VS Code
extension, backed by shared offline repository indexes.

The [module translation guide](docs/module-pipeline-repair.zh-CN.md) covers selecting a reference module,
preparing its file scope, running translation and write-back, and reviewing or rolling back the changes.
The repository fixtures provide reusable reference projects for local module matching experiments.

## Repository layout

- `apps/vscode-extension`: primary VS Code extension application.
- `packages/contracts`: shared request, result, symbol, and patch types.
- `packages/workflow-core`: workflow state machine and implementation ports.
- `services/code-intelligence-service`: versioned SeekDB indexing, module modeling, and module candidate search.
- `services/adaptation-mcp-server`: local stdio MCP server for guarded translation tools.
- `services`: backend boundaries for indexing, code intelligence, and adaptation services.
- `fixtures`: target workspaces and cross-language code corpus fixtures.
- `tests`: repository-level contract, integration, and end-to-end tests.
- `docs`: architecture material, prototypes, reports, and historical work logs.
- `tooling`: repository-wide development and automation utilities.

## Local configuration

Run all commands below from the repository root. The full workflow requires
Node.js/npm, Docker with Compose for SeekDB, and the compiler for the selected
target language. The adaptation registry supports TypeScript (`tsc`), Python,
Java, C#, Rust, and Go.

Install the workspace dependencies and create local environment files:

```bash
npm install
cp services/adaptation-service/.env.example services/adaptation-service/.env
```

The checked-in examples use these local endpoints:

| Component | Address | Environment file |
| --- | --- | --- |
| Code-intelligence index | local extension host + SeekDB | `CODE_INTELLIGENCE_*` environment variables |
| Adaptation API | `http://127.0.0.1:8788` | `services/adaptation-service/.env` |
| SeekDB | `127.0.0.1:2881` | `services/code-intelligence-service/infra/docker-compose.yml` |

Embedding and DeepSeek API keys stay in server-side `.env` files and are never
exposed to the extension Webview.

### Configure code intelligence

Start the development SeekDB container. The extension creates and updates the
versioned structural and module-search projections when a target or reference
project is imported:

```bash
docker compose -f services/code-intelligence-service/infra/docker-compose.yml up -d
```

Configure the SeekDB and embedding variables before starting the extension:

```env
CODE_INTELLIGENCE_SEEKDB_DATABASE=forexplore
CODE_INTELLIGENCE_SEEKDB_VECTOR_DIMENSION=384
CODE_INTELLIGENCE_EMBEDDING_URL=http://127.0.0.1:4021/v1/embeddings
```

The code-intelligence service uses the configured embedding endpoint for module
summary, symbol, and source-fragment projections. Adaptation owns the optional
module cross-encoder reranking and translation model calls.

### Configure adaptation

Set the server-side key in `services/adaptation-service/.env`:

```env
DEEPSEEK_API_KEY=<server-side-key>
DEEPSEEK_MODEL=deepseek-v4-flash
# DEEPSEEK_API_BASE=https://api.deepseek.com/v1
```

The adaptation service selects validation from the target language: `tsc`,
`python -m py_compile`, `javac`, `dotnet build`, `rustc`/`cargo check`, or
`go test`. Make the selected compiler available on `PATH`.

### Configure the MCP translation server

The MCP server exposes context collection, analysis, generation, repair,
validation, and complete adaptation with patch preview. It does not expose file
write-back. Copy `services/adaptation-mcp-server/.env.example`, configure the
same DeepSeek and target-project variables, then run:

```bash
npm run dev:mcp
```

Claude Code loads the checked-in `.mcp.json` when run from this project. Set
`DEEPSEEK_API_KEY` in the shell, then start its outer agent with DeepSeek V4
Flash:

```bash
export DEEPSEEK_API_KEY=<server-side-key>
npm run claude:deepseek
```

For a candidate reranking session that validates the complete candidate-ID
contract through MCP, run `npm run claude:reranker`.

The launcher routes Claude Code's Anthropic-compatible model calls directly to
DeepSeek. The project MCP server keeps the Analyzer and Translator as separate,
stateless DeepSeek agents. See `services/adaptation-mcp-server/README.md` for
the tool boundary.

### Start the application

On Windows, Linux, or macOS, start SeekDB and the local embedding/reranking
dependencies, build the extension, and open the Extension Development Host:

```bash
npm run dev:extension
```

The cross-platform launcher is [`scripts/run-vscode-extension.mjs`](scripts/run-vscode-extension.mjs).
It assumes dependencies are already installed and does not run `npm install`.
The host opens only after SQL and model health checks pass. A listening TCP port
alone is not treated as a ready service. Use `--skip-services` for externally
managed dependencies, `--folder <path>` to choose the opened folder, or
`--skip-seek-db` when SeekDB is already running. `--help` lists every option.
The legacy PowerShell path remains a compatibility wrapper on Windows.

For an existing SeekDB, pass launcher flags after npm's `--` separator:

```bash
npm run dev:extension -- --skip-seek-db
```

Set `CODE_INTELLIGENCE_SEEKDB_HOST` and `CODE_INTELLIGENCE_SEEKDB_PORT` for an
external database. The launcher checks that endpoint without starting local Docker.

The extension alone starts its workspace-bound adaptation backend; do not also
prestart `dev:adaptation` on its port. The semantic query listener gets a free
loopback port per window, and its actual endpoint is passed to that backend.
Set `FOREXPLORE_SEMANTIC_QUERY_PORT` only when a fixed endpoint is needed by an
external client. Backend reuse requires matching workspace, query endpoint,
capabilities, and translation token; `/health` alone does not prove ownership.

VS Code keeps one Extension Development Host per extension path, so running the
launcher again while that window is open reloads the extension inside the existing
window instead of opening a new one. Close that window to get a fresh one.

`npm run dev` is an alias for `npm run dev:extension` and includes the
extension-managed adaptation backend.

To run the adaptation backend independently, use `npm run dev:adaptation`.
Verify the backend service:

```bash
curl http://127.0.0.1:8788/health
```

## Commands

```bash
npm run dev
npm run dev:adaptation
npm run dev:extension
npm run build
npm run build:adaptation
npm test
```

The primary entry point is the VS Code extension. Its current workspace UI
selects Java modules and defaults to
`fixtures/target-system/commons-fileupload-java-skeleton`; the adaptation
service and Claude Code workflow themselves are language-neutral.

## Development guide

See the complete Chinese handoff guide for the workspace, indexing,
and module-tree changes in `apps/vscode-extension/README.md`.
