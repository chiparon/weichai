# Code Indexer (Module 1)

Repository discovery, language parsing, symbol extraction, and functional-module
candidate construction for the ForeXplore pipeline.

## Supported languages

TypeScript, Python, Java, Rust, Go, C#

## Usage

```powershell
# CLI: extract symbols from corpus → JSON Lines
npx tsx src/cli.ts ../../fixtures/code-corpus

# Programmatic API
import {
  extractCorpus,
  extractModuleCorpus,
  extractSymbols,
  discoverRepositories,
} from '@forexplore/code-indexer';

const documents = await extractCorpus('./fixtures/code-corpus');
// documents: IndexedCodeDocument[]

const modules = await extractModuleCorpus('./fixtures/code-corpus');
// modules: IndexedModuleDocument[]
```

## Pipeline position

```
code-indexer (module 1) → retrieval-service (module 2) → adaptation-service (module 3)
```

Symbols remain the code-evidence and translation granularity. Modules are the
first-stage retrieval granularity. An approved
`.forexplore/module-summary.json` defines the module boundary; repositories
without one use a deterministic package/directory fallback. A module never
crosses a manifest repository boundary.
