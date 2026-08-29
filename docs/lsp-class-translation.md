# LSP class translation architecture

The VS Code extension is the only interactive entry point for class translation.
It owns editor state, model credentials, language-provider calls, progress,
patch review, and Validator handoff. The Webview can send intent only.

## Runtime flow

1. `vscode.executeDocumentSymbolProvider` resolves the deepest class, record,
   or interface containing the cursor. Interfaces are contract-only and cannot
   be selected as a writable target.
2. Retrieval is constrained to class candidates. A local candidate file is
   opened when it is inside an authorized `forexplore.repositoryPaths` root;
   otherwise its complete indexed preview is opened as an in-memory document.
3. The active language provider resolves the target definition and references.
   These normalized locations and the complete class snapshot enter Analyzer.
4. Translator returns exactly one complete target class. It cannot add imports,
   namespaces, packages, or sibling top-level types.
5. The extension captures baseline diagnostics, asks the language provider to
   diagnose an in-memory candidate document, and feeds only new or changed
   class-scoped errors to Translator repair.
6. Model calls and LSP waits share one deadline. The default is 120 seconds,
   configurable from 30 to 300 seconds. At most four diagnostic attempts run.
7. A class patch and `ValidatorHandoff` are created only after the LSP gate
   passes. LSP success does not attest to behavior.
8. The extension invokes `forexplore.validator.validateHandoff` when that
   command is provided by a Validator extension. Write-back remains blocked
   until matching structured Validator feedback reports `pass`.

## Language intelligence boundary

`LanguageIntelligencePort` is exported by `@forexplore/workflow-core` and uses
only contracts from `@forexplore/contracts`:

```ts
interface LanguageIntelligencePort {
  resolveContainingClass(target: EditorTarget, signal?: AbortSignal): Promise<ClassSnapshot>;
  definitions(request: SymbolRequest, signal?: AbortSignal): Promise<SourceLocation[]>;
  references(request: SymbolRequest, signal?: AbortSignal): Promise<SourceLocation[]>;
  diagnose(request: DiagnosticRequest, signal?: AbortSignal): Promise<DiagnosticDelta>;
}
```

Raw VS Code and JSON-RPC types do not cross this boundary. The generic VS Code
adapter works with any installed Java or C# extension that implements the
standard document-symbol, definition, reference, and diagnostics providers.
No extension ID is hard-coded.

The MCP tools `definition`, `references`, and
`forexplore_resolve_containing_class` call an injected
`LanguageIntelligencePort`. A standalone MCP process has no editor language
provider and therefore returns `lsp_unavailable`; it never scans text as a
fallback.

## Diagnostic gate

Diagnostics are normalized by URI, source, code, severity, range, message, and
document version. The gate compares candidate diagnostics against the original
class baseline:

- existing target errors are ignored;
- errors outside the candidate class are ignored;
- warnings, information, and hints are shown but do not enter repair;
- new errors and changed errors inside the class enter repair;
- no diagnostic event is `lsp_unavailable`, not an empty successful result.

Terminal states are `passed`, `cancelled`, `timed_out`, `max_attempts`, and
`lsp_unavailable`. Every attempt records its index, start time, duration,
normalized diagnostics, and outcome.

## Context budget

The class prompt budget is 64,000 characters. When a class exceeds it, context
keeps the class declaration, fields, constructors, properties, method
declarations, inheritance, interfaces, generic constraints, and LSP locations.
Member bodies are included by priority while budget remains; arbitrary string
truncation is not used. The full LSP snapshots remain in the Validator handoff.

## Credentials and settings

The model key is stored only under `forexplore.modelApiKey` in VS Code
`SecretStorage`. Configure it with **ForeXplore: Configure model key**. It is
never sent to the Webview, settings JSON, or logs.

```json
{
  "forexplore.retrievalApiUrl": "http://127.0.0.1:8787",
  "forexplore.modelApiUrl": "https://api.deepseek.com/v1",
  "forexplore.model": "deepseek-v4-flash",
  "forexplore.translationTimeoutSeconds": 120,
  "forexplore.maxTranslationAttempts": 4,
  "forexplore.repositoryPaths": ["/absolute/path/to/code-corpus"]
}
```

`forexplore.adaptationApiUrl` remains only for the separate read-only module
planning workflow.

## Migration from compiler-gated translation

- `POST /v1/adapt` returns HTTP 410.
- MCP no longer exposes `forexplore_validate_translation` or
  `forexplore_adapt_translation`.
- `AdaptationAdapter` and `src/compiler.ts` remain deprecated offline POC
  baselines; the extension and production service composition do not call them.
- Method-selection targeting remains available only as compatibility helpers;
  the extension command always creates a class target from LSP document symbols.
- HTTP backfill remains disabled. The Extension Host still owns SHA-256,
  class-range, hunk, approval, and checkpoint gates.
