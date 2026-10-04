# Code Indexer (Module 1)

Repository discovery, language parsing, symbol extraction for the ForeXplore pipeline.

## Supported languages

TypeScript, Python, Java, Rust, Go, C#

## Usage

```powershell
# CLI: extract symbols from corpus → JSON Lines
npx tsx src/cli.ts ../../fixtures/code-corpus

# Programmatic API
import { extractCorpus, extractSymbols, discoverRepositories } from '@forexplore/code-indexer';

const documents = await extractCorpus('./fixtures/code-corpus');
// documents: IndexedCodeDocument[]
```

## Pipeline position

```
code-indexer → code-intelligence-service（模块索引与候选检索）→ adaptation-service
```

Extracts symbols from source repositories and outputs `IndexedCodeDocument[]` for the versioned code-intelligence index.
