# Adaptation Service (Module 3)

Java → C# code adaptation: target-context analysis → planned translation → compile validation → auto-fix → backfill.

## Analyzer workflow

The service now runs two model stages. `ContextCollector` first reads a bounded,
repository-scoped view of the C# target file, containing type, imports, sibling
files, and textual references. `analyzer.ts` compares that context with the Java
candidate and produces a schema-validated `AnalysisReport`. The translator then
receives that report and must follow its implementation plan while preserving the
target contract.

The analyzer can be called independently. It only needs `target`, `candidate`,
and `requirement`; `strategy` and `decisionNotes` remain translation concerns:

```bash
curl -X POST http://127.0.0.1:8788/v1/analyze \
  -H 'content-type: application/json' \
  --data @adaptation-request.json
```

The response contains both `report` and the collected `context`. Candidates marked
`reject` are returned by `/v1/analyze`, but `/v1/adapt` stops before translation.

## ReCodeAgent MCP migration

The repository includes a read-only stdio MCP server rewritten from the useful
subset of the MIT-licensed
[Intelligent-CAT-Lab/ReCodeAgent](https://github.com/Intelligent-CAT-Lab/ReCodeAgent)
at commit `cd20f3a893bcaef40c7f56ea1090ac7867ea17ea`. It keeps the public tool names and argument conventions that
are useful for this module-level task:

- `get_directory_tree(path, print_dirs_only, max_depth)`
- `get_file_structure(language, file_path)`
- `definition(symbolName)`
- `references(symbolName, maxResults)`
- `read_file(path, maxChars)`
- `get_target_context(target)`

ReCodeAgent's original project analyzer relies on Tree-sitter parsers but does not
support C#. Its language-server MCP also requires per-language LSP processes and a
large Docker toolchain. This port reimplements the read-only subset in TypeScript,
adds Java/C# support, enforces project-root path confinement, and omits editing,
rename, diagnostics, and test-runner tools because those belong to the Translator
and Validator responsibilities in ForeXplore. It is source-oriented rather than a
full LSP replacement, so overload resolution and generated symbols remain Analyzer
uncertainties rather than hard facts.

Build before starting the MCP server:

```bash
npm run build:adaptation
npm run mcp --workspace @forexplore/adaptation-service -- \
  fixtures/target-system/forexplore-csharp-workspace
```

Example client configuration:

```json
{
  "mcpServers": {
    "forexplore-analysis": {
      "command": "node",
      "args": [
        "/absolute/path/to/weichai/services/adaptation-service/dist/mcp-server.js",
        "/absolute/path/to/weichai/fixtures/target-system/forexplore-csharp-workspace"
      ]
    }
  }
}
```

`AdaptationAdapter` accepts only the `translate` strategy with a Java candidate
and a `C#` target. Unsupported language pairs are rejected before any LLM
request is made.

When `skeletonProjectPath` is configured, integration validation copies the
delivered C# skeleton to a temporary directory, replaces only the target
method, and runs `dotnet build`. The real workspace is never modified during
validation. Compiler errors drive at most three model repair attempts; a
missing compiler stops the repair loop and is reported as a warning.

The model endpoint and model name are loaded by `src/model-config.ts` so the
translator does not own provider configuration. `DEEPSEEK_MODEL` defaults to
`deepseek-v4-flash`; `DEEPSEEK_API_BASE` can override the compatible endpoint.
Callers must still pass the API key to `AdaptationAdapter`.

## Web demo quick start

The browser calls this service through `POST /v1/adapt`. The DeepSeek key stays
in this Node process; it is never included in the Vite environment or browser
bundle.

```bash
cp services/adaptation-service/.env.example services/adaptation-service/.env
# Edit the copied file and set DEEPSEEK_API_KEY.

# Required for real standalone and integrated C# validation. Under WSL the
# service also auto-detects C:\Program Files\dotnet\dotnet.exe.
dotnet --version || '/mnt/c/Program Files/dotnet/dotnet.exe' --version

npm install
npm run dev:adaptation
```

In another terminal, start retrieval and Web together:

```bash
npm run dev
```

The checked-in Web environment example points to `http://127.0.0.1:8788`.
Verify the adaptation service before the demo with:

```bash
curl http://127.0.0.1:8788/health
```

The Web demo uses the real service only for Java method → C# method translation.
Backfill remains the Mock port, so clicking the final backfill action does not
change the delivered skeleton.

## Python POC

```powershell
# 5 hardcoded test cases
pip install openai
$env:DEEPSEEK_API_KEY = "sk-..."
python poc/translate_poc.py

# End-to-end: search API → translate → compile
python poc/e2e_pipeline.py
```

## Pipeline position

```
code-indexer (module 1) → retrieval-service (module 2) → adaptation-service (module 3)
                                                              ↑
                                              /v1/search → candidates → LLM → C#
```

## Architecture

| File | Role |
|------|------|
| `src/translator.ts` | LLM Java→C# translation |
| `src/context-collector.ts` | Bounded target repository context collection |
| `src/analyzer.ts` | Schema-validated Analyzer Agent and module plan |
| `src/mcp-tools.ts` | ReCodeAgent-compatible read-only project tools |
| `src/mcp-server.ts` | stdio JSON-RPC MCP server |
| `src/compiler.ts` | C# compile check (dotnet build) |
| `src/model-config.ts` | Isolated temporary model provider configuration |
| `src/adaptation-adapter.ts` | Main adapter, orchestrates translate→compile→fix |
| `src/backfill-adapter.ts` | Backfill results into corpus |
| `poc/translate_poc.py` | Standalone POC with 5 test cases |
| `poc/e2e_pipeline.py` | End-to-end: calls retrieval-service /v1/search |
