# Adaptation Service

This package owns the stateless Analyzer and Translator agents plus the
editor-facing class translation state machine.

## Production class translation

`ClassTranslationOrchestrator` is composed inside the VS Code Extension Host.
It consumes a real `LanguageIntelligencePort` and runs:

```text
LSP class snapshot + definitions + references
  -> AnalyzerAgent
  -> TranslatorAgent (complete class)
  -> baseline/candidate LSP diagnostic delta
  -> repairTranslation while deadline and attempts remain
  -> ValidatorHandoff after LSP pass
```

The default shared deadline is 120 seconds and may be configured from 30 to
300 seconds. A maximum of four diagnostic attempts is enforced as a secondary
bound. Cancellation, timeout, maximum attempts, and missing language-provider
support are returned as structured terminal states. No compiler fallback is
used.

The LSP gate handles only candidate-introduced class errors. Existing project
errors, diagnostics outside the class, and non-error severities do not enter
the repair prompt. A passing LSP result creates a protected class patch and a
`ValidatorHandoff`; it does not claim behavioral correctness.

## Agent boundary

`AnalyzerAgent` and `TranslatorAgent` are independent, stateless model calls.
Analyzer returns `AnalysisReport v1`. Translator receives that validated
artifact, target class context, requirement, and complete candidate class; it
does not receive Analyzer conversation history.

The Translator output contract permits exactly one complete target class or
record. It rejects changed declarations, imports, namespaces, packages,
additional top-level types, unresolved plan items, and incomplete Analyzer
steps. `repairTranslation` accepts normalized LSP or Validator feedback.

Model endpoint and model name are passed through `DeepSeekModelConfig`. In the
extension, the API key comes only from VS Code `SecretStorage`.

## HTTP and MCP migration

Interactive translation no longer runs through the HTTP service:

- `POST /v1/adapt` returns HTTP 410 with an Extension Host migration message.
- `POST /v1/backfill` remains disabled.
- `/v1/module-plan` remains available for the independent read-only module
  planning workflow.
- MCP keeps independent analysis/generation/repair tools. Definition,
  references, and containing-class tools require an injected real
  `LanguageIntelligencePort`; no text-scanning fallback exists.

`AdaptationAdapter` and `src/compiler.ts` are deprecated offline POC baselines.
They are not composed by `src/server.ts`, the VS Code extension, or the MCP
server. The scripts under `poc/` may still use local compilers for historical
comparison.

## Main files

| File | Role |
| --- | --- |
| `src/class-translation-orchestrator.ts` | Shared deadline, LSP repair loop, class patch, Validator handoff |
| `src/analyzer.ts` | Independent Analyzer Agent and `AnalysisReport` validation |
| `src/translator.ts` | Complete-class generation, scope guards, structured repair |
| `src/deepseek-client.ts` | Stateless model transport |
| `src/http-server.ts` | Health and read-only module-planning HTTP endpoints |
| `src/adaptation-adapter.ts` | Deprecated compiler-gated POC adapter |
| `src/compiler.ts` | Deprecated local compiler POC registry |

## Development

```bash
npm run build --workspace @forexplore/adaptation-service
npm run test --workspace @forexplore/adaptation-service
```

The focused state-machine tests use fake model and language ports; they do not
wait for a real model. The VS Code extension integration suite exercises Java
and C# document symbols, definitions, references, diagnostics, and the
`lsp_unavailable` path through registered language providers.
