# Adaptation Service (Module 3)

Language-neutral code adaptation: Analyzer report → Translator generation →
target-language compilation → protected patch generation.

## Current V2 capability boundary

Java → C# is a historical regression baseline, not the product direction or
the upper bound of the service. Formal execution is authorized only by a
materialized exact `sourceLanguageId × targetLanguageId × strategy` route
and its validation policy:

- `GET /v2/runtime-capabilities` always returns the validated, server-owned
  capability snapshot, including unavailable routes and structured reasons.
- `POST /v2/adapt` consumes a validated `AdaptationRequestV2`, the complete
  `SourceImplementationBundleV2`, and neutral `TargetContextSnapshotV2` facts.
  It never converts them to V1 `ModuleTarget`, `SearchCandidate`, or
  `TargetModuleContext` objects.
- The explicit translate inventory currently contains Java → C# (historical
  regression), TypeScript → Python, and Python → TypeScript. Registering a
  compiler or a target engineering adapter does not create a Cartesian product
  of routes and does not make a listed route executable.
- A trusted Host may compose only Host-owned source/target analysis and
  workspace apply/rollback stages. Core validation keeps all service-owned
  providers, versions, stage capabilities, route policy, and lineage immutable.
- Required `fail` or `unverified` validation evidence blocks the result gate;
  compilation alone never proves behavioral correctness.

The production HTTP composition runs the `single-agent-differential@1.0.0` strategy with `local-process` behavior execution. Processes run on the adaptation-service host and are not isolated, so this is not a production-safe sandbox boundary. The server owns the default strategy; clients cannot select one. Configure `ADAPTATION_VERIFICATION_WORKSPACE_ROOT` (default `<os.tmpdir()>/forexplore-verification-workspaces`), `ADAPTATION_VERIFICATION_ARTIFACT_ROOT` (default `<projectRoot>/.forexplore/verification-artifacts`), and `ADAPTATION_VERIFICATION_TIMEOUT_MS` (default `300000`). Repair is limited to at most two rounds. Repository analysis and workspace apply/rollback remain disabled in the HTTP runtime.

Comprehensive multi-language development is the current engineering direction;
it is not a claim that every language pair is available. Unknown routes,
missing adapters, unavailable required stages, and invalid artifact lineage are
rejected rather than bridged or silently downgraded.

## Deprecated V1 compatibility pipeline

`POST /v1/adapt`, `AdaptationAdapter`, `ModuleTarget`, `SearchCandidate`,
`TargetModuleContext`, and the adaptation MCP tools are deprecated legacy
surfaces retained for compatibility and regression testing. V2 does not call
them, and their successful use is not evidence that a current exact route is
available.

The legacy Translator has a structured member-C entry point:

```ts
const result = await translateWithAnalysis(
  {
    candidateSource,
    targetContext,
    requirement,
    analysisReport,
  },
  { apiKey },
  signal,
);
```

`AnalyzerAgent` and `TranslatorAgent` are independent, stateless DeepSeek
agents. The Analyzer receives the target facts, requirement, and candidate and
returns `AnalysisReport v1`. The Translator starts a fresh model interaction;
it receives its own target prompt plus that validated report, never Analyzer
messages or conversation history. Its response is parsed as a structured
`TranslationResult` containing generated code, completed plan steps, and
unresolved items. The legacy `interfaceMappings` response field is retained
for compatibility but is not required or used as a completion attestation.

Runtime guards reject unresolved dependencies, changed target signatures, omitted
plan steps, and output that escapes the requested method or class scope
with imports, namespaces, or extra types. When Analyzer marks only the selected
candidate as `reject`, the adapter drops that candidate and runs a target-only
generation path; the result carries a non-blocking warning for developer review
before write-back. The HTTP adapter runs the
integrated sequence:

```text
collectTargetContext -> AnalyzerAgent.analyze -> AnalysisReport artifact
  -> TranslatorAgent.translate
  -> compile validation
  -> differential verification -> modification plan
  -> repairTranslation (at most two rounds) -> recompile/reverify
```

`AnalysisReport` comes from `@forexplore/contracts`; the Translator no longer
owns a duplicate report schema. The collected `TargetModuleContext` is reduced
to a prompt-oriented view by `projectTargetContext()` without discarding the
immutable target signature, dependencies, callers, or constraints.

Validator integration uses the reserved repair entry point:

```ts
const repaired = await repairTranslation(
  {
    ...translationInput,
    previousResult,
    validationFeedback,
  },
  { apiKey },
  signal,
);
```

A passing feedback result is idempotent and performs no model request. Failed
feedback must contain structured syntax, contract, dependency, or behavior
issues. Fixed member-C samples live in `testdata/translator-*.json`.

The legacy `AdaptationAdapter` accepts all source and target languages
represented by the closed V1 `Language` contract. It selects context collection,
method-boundary patching, and standalone/integrated compiler validation from a
language registry for TypeScript, Python, Java, C#, Rust, and Go. This broad V1
input shape is not authorization for arbitrary language pairs; formal V2 route
availability remains exact-pair and fail-closed.

When `skeletonProjectPath` is configured, integration validation copies the
target project to a temporary directory and replaces only the requested target
method or complete target class.
The registry uses `tsc`, `python -m py_compile`, `javac`, `dotnet build`,
`rustc`/`cargo check`, or `go test` for the target language. The real workspace
is never modified during validation.

The DeepSeek endpoint and model name are loaded by `src/model-config.ts` so the
agents do not own provider configuration. `DEEPSEEK_MODEL` defaults to
`deepseek-v4-flash`; `DEEPSEEK_API_BASE` can override the compatible endpoint.
`AdaptationAdapter` accepts a key or a lazy key getter. The server resolves the
credential when a model request begins, so it can start before a key is configured.

The VS Code plugin's **Settings → DeepSeek API Key** entry stores a credential in
SecretStorage and sends it only to the configured loopback backend on model routes.
The backend accepts `x-recast-model-key` only from a loopback peer with a loopback
Host and no browser Origin. AsyncLocalStorage isolates concurrent requests; no key
is persisted or returned to the UI. Requests without this header use
`DEEPSEEK_API_KEY` from the backend environment. Workspace translation still
requires its separate authorization token. Provider error bodies are not exposed.

## Extension service quick start

The DeepSeek key stays in this Node process; it is never included in the Vite
environment or browser bundle. A client should discover V2 facts through
`GET /v2/runtime-capabilities`; it must not infer route availability from the
configured compiler, target file extension, or a successful V1 request.

```bash
cp services/adaptation-service/.env.example services/adaptation-service/.env
# Edit the copied file and set DEEPSEEK_API_KEY.

# Make the selected target compiler available on PATH, for example:
javac --version

npm install
npm run dev:adaptation
```

In another terminal, start retrieval and the VS Code extension:

```bash
npm run dev:extension
```

Verify the adaptation service before the demo with:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v2/runtime-capabilities
```

The normal production server is expected to report unavailable required
stages. `POST /v2/adapt` succeeds only in a trusted composition that supplies
the authoritative artifact store, a valid Host-composed runtime snapshot, and
the required isolated verification evidence. Capability/composition failures
return structured `409`, invalid artifacts/results return structured `422`, and
an execution server without the V2 adapter or artifact store returns structured
`503`. `POST /v1/adapt` remains available only as the deprecated compatibility
endpoint and is never an internal fallback for V2.

`POST /v1/backfill` is intentionally disabled. A bare HTTP client is not an
approval authority; the VS Code extension host owns the selected target,
original hash, validation gate, user confirmation and recovery point before it
performs any local write.

## In-place workspace translation

The independent workspace workflow takes a development Spec and retrieved Context
(source, interfaces, call chains, configuration, dependencies, summaries). Analyzer
produces file/symbol mappings and ordered dependency steps. Translator reads current
workspace files, writes multiple files, compiles the configured project and repairs
compiler diagnostics. It can return to Analyzer to revise mappings or dependencies.
This milestone accepts compilation only; it does not generate or run behavior tests.

Enable `ADAPTATION_WORKSPACE_TRANSLATION_ENABLED=true`, set
`ADAPTATION_PROJECT_ROOT`, and configure `ADAPTATION_WORKSPACE_TRANSLATION_TOKEN`
(at least 32 characters) and `ADAPTATION_WORKSPACE_COMPILE_COMMAND`. The latter is a
JSON object with `executable`, `args`, optional workspace-relative `cwd`, and optional
`timeoutMs`. Use a compilation command such as `dotnet build --no-restore`, `tsc --noEmit`,
`cargo check`, or a project-specific `javac` argument list. Dependencies must already
be available. The compiler is launched with an argument array, without a shell.
Neither HTTP requests nor model tools select the workspace root or compiler command.

All routes below require `Authorization: Bearer <configured token>`:

| Method | Path | Result |
| --- | --- | --- |
| POST | `/v1/workspace-translations` | Start a task, return its run record and ID (202) |
| GET | `/v1/workspace-translations/:id` | Read status, plan, before/after changes and compiler results |
| POST | `/v1/workspace-translations/:id/cancel` | Cancel execution and preserve changes |
| POST | `/v1/workspace-translations/:id/resume` | Resume a failed, cancelled or interrupted task (202) |
| POST | `/v1/workspace-translations/:id/rollback` | Restore original files or remove task-created files |

The start request has this shape:

```json
{
  "spec": "Translate the supplied payment gateway and service into the target project, preserving its interfaces.",
  "sourceLanguage": "Java",
  "targetLanguage": "C#",
  "context": [
    {
      "id": "gateway-contract",
      "kind": "interface",
      "content": "public interface PaymentGateway { String charge(long cents); }",
      "path": "src/PaymentGateway.java",
      "repository": "payments-reference",
      "revision": "reference-revision"
    }
  ],
  "workspaceFiles": ["Payments.csproj", "AuthManager.cs"],
  "writeFiles": ["PaymentGateway.cs", "PaymentService.cs"]
}
```

Supply the actual retrieved implementation and Spec for a real translation. Context
remains immutable evidence; `workspaceFiles` and `writeFiles` are exact relative
paths for live reads, with writes restricted to `writeFiles` and the accepted plan.
There is no glob expansion. A file must be read before it can be written, and its
content hash must still match. Symbolic links, hard-linked files and paths outside
the workspace are rejected. The service writes directly into the selected workspace.

Records are persisted under `.forexplore/workspace-translations/<id>.json`, including
original file contents. Resume checks those contents against disk and requires a
fresh compilation before completion. Rollback checks all changes before restoring
them and stops on subsequent user edits. The default execution budget is 80 model
turns and 30 minutes per start/resume; exhaustion preserves the task for continuation.
Use one adaptation service instance per workspace. Query the returned ID until a
terminal status is reached; dropping the start HTTP connection does not cancel it.
`completed` requires all steps plus a successful compiler exit after the latest
changes, and the record explicitly reports `acceptance: "compilation-only"`.

The same runtime can be embedded through the exported `WorkspaceTranslationRuntime`
and `createWorkspaceTranslationModelClient` APIs. This backend does not yet connect
the new flow to the module picker or SeekDB task persistence.

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
      V2 source bundle + target context + exact route/policy → DeepSeek → adapter-owned patch
```

## Architecture

| File | Role |
|------|------|
| `src/translator.ts` | Independent TranslatorAgent, AnalysisReport handoff, contract guards, structured output and repair |
| `src/translator.test.ts` | Translator parsing, rejection, contract, planning and repair tests |
| `testdata/translator-*.json` | direct/adapt/reject member-C fixtures |
| `src/context-collector.ts` | Collects bounded target-module facts and direct dependencies |
| `src/analyzer.ts` | Independent Analyzer Agent that returns validated `AnalysisReport` JSON |
| `src/compiler.ts` | Open canonical `LanguageId` compiler registry; built-ins cover TypeScript, Python, Java, C#, Rust, and Go without treating compiler presence as route authorization |
| `src/model-config.ts` | Isolated temporary model provider configuration |
| `src/runtime-capability-snapshot.ts` | Exact-pair route inventory, provider/version descriptors, policies, stage availability and structured reason codes |
| `src/adaptation-adapter-v2.ts` | Formal V2 port: validates full source/context lineage, runs route-owned agents, delegates patching to the target adapter and materializes `AdaptationResultV2` |
| `src/http-server.ts` | V2 capability/adaptation endpoints, authoritative artifact lookup, Host composition validation and structured fail-closed responses |
| `src/adaptation-adapter.ts` | Deprecated V1 compatibility adapter; V2 never calls it |
| `src/adaptation-adapter-v2.ts` verifier port | Accepts the server-owned local differential verifier in the default HTTP composition; it executes on the adaptation-service host and is not sandboxed |
| `src/backfill-adapter.ts` | Backfill results into corpus |
| `poc/translate_poc.py` | Standalone POC with 5 test cases |
| `poc/e2e_pipeline.py` | End-to-end: calls retrieval-service /v1/search |

## Deprecated V1 Analyzer boundary

`collectTargetContext({ projectRoot, target })` reads the selected target file,
its containing type, direct dependency definitions, relevant callers, and
explicit `REQ:` constraints. It returns a bounded `TargetModuleContext`; paths
inside the context are project-relative and the collector rejects traversal
outside `projectRoot`.

`new AnalyzerAgent({ apiKey }).analyze(request)` makes a separate DeepSeek call
with target facts, the user requirement, and one retrieval candidate. The
response must be `AnalysisReport` schema version `1.0`; markdown fences are
accepted for compatibility, but every field and enum is validated before the
report is returned. Analyzer does not generate code, compile it, or run
behavior tests. Those remain Translator and Validator responsibilities.
