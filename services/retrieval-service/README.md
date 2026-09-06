# SeekDB Retrieval Service

This service is the production retrieval boundary for ForeXplore. It stores
both functional-module and code-symbol documents in
[SeekDB](https://github.com/oceanbase/seekdb). Module search is the first-stage
reuse workflow; symbol search remains available for compatibility and for the
second-stage drill-down inside a selected module.

It also owns a physically separate functional-module projection. Module Wiki
documents never enter the class/function table: they are staged by immutable
knowledge publication and generation, validated, then exposed only while that
generation is the active `(repositoryId, channel)` head.

## Hybrid retrieval

Symbol search runs vector and full-text queries in parallel. Module search runs
three parallel channels: semantic vectors, full text, and structural/API text.
Both pipelines use weighted reciprocal-rank fusion and deterministic scoring;
optional LLM reranking runs only after bounded recall.

Each query has one retrieval granularity. A class target retrieves only indexed
class documents; a function target retrieves only indexed function documents.
The kind restriction is pushed into both SeekDB queries and checked again after
hybrid fusion. Consequently, the broad-recall pool, reranker input, and final
Top-K list cannot mix classes and functions.

Module retrieval deliberately does not apply that class/function restriction.
It ranks a functional unit by purpose, API coverage, dependency shape,
adaptability, implementation evidence, and risk. The returned Top-N is
diversified so one repository or near-duplicate API surface does not crowd out
all alternatives. After a module is selected, `/v1/module-symbols` restores the
class/function restriction while searching only symbols owned by that module.

When LLM reranking is enabled, hybrid RRF produces exactly 20 same-granularity
candidates, the reranker scores those candidates, and the service returns the
requested final count (the UI default is 4).

The schema uses SeekDB's `VECTOR`, `VECTOR INDEX ... TYPE=hnsw`,
`FULLTEXT INDEX`, and `ORDER BY cosine_distance(...) APPROXIMATE` features.
All query values and filters are parameterized; only validated SQL identifiers
and generated vector hex literals are interpolated.

## Module knowledge projection

`SEEKDB_MODULE_KNOWLEDGE_TABLE` names the independent module-document table.
Two adjacent control tables retain immutable generations and the active head;
none of these tables aliases or clears `SEEKDB_TABLE`.

```text
reviewed staged publication
  -> embed and stage one document per module
  -> validate document count, module IDs and projection hash
  -> return RepositoryModuleIndexReceipt(status=validated)
  -> compare-and-swap active generation
  -> searchable
```

Queries join module documents to the active head and generation in SeekDB.
They also require reviewed boundary and narrative states plus an exact
repository/channel and deployment-authorized ACL scope. A staged, superseded,
withdrawn, or tombstoned generation therefore cannot leak into results.

Activation and withdrawal are idempotent for an outbox/reconciler. Withdrawal
is logical and restores the superseded generation when available. Tombstoning
is permitted only after a generation is inactive. There is deliberately no
module-index `clear()` operation; physical retention/cleanup is a separate
policy concern.

## Start locally

SeekDB's embedded library is currently available for Linux and Apple Silicon,
not native Windows. Docker or a remote SeekDB instance is therefore the
portable development option.

```text
docker compose -f services/retrieval-service/docker-compose.yml up -d
copy services\retrieval-service\.env.example services\retrieval-service\.env
npm install
npm run schema --workspace @forexplore/retrieval-service
npm run index:corpus --workspace @forexplore/retrieval-service -- --replace
npm run dev:retrieval
```

In another terminal:

```text
copy apps\workflow-web\.env.example apps\workflow-web\.env
npm run dev:web
```

The service listens on `http://127.0.0.1:8787` by default. Check both layers:

```text
curl http://127.0.0.1:8787/health
```

The sample Docker image is for development/testing. Use a managed or properly
operated SeekDB deployment for production.

## Embeddings

`SEEKDB_EMBEDDING_PROVIDER=hash` is the default. It performs deterministic
token and character-trigram feature hashing, needs no model download, and is
appropriate for integration smoke tests. It is not a replacement for a
semantic embedding model.

Set `SEEKDB_EMBEDDING_PROVIDER=openai` with an OpenAI-compatible embeddings URL,
API key, model, and matching `SEEKDB_VECTOR_DIMENSION` for production-quality
semantic retrieval. A table's vector dimension cannot be changed in place:
use a new table or rebuild it when changing models/dimensions.

When `SEEKDB_EMBEDDING_SUPPORTS_DIMENSIONS=true`, the provider passes a
`dimensions` parameter in the API request so the model returns a
truncated embedding matching `SEEKDB_VECTOR_DIMENSION` (supported by
OpenAI `text-embedding-3-*` and Qwen3). Leave it `false` when the model
always outputs its native dimension (BGE series, etc.).

## Reranking

When `RERANK_PROVIDER` is set to `deepseek`, the search pipeline
wraps the base search engine with an LLM-based reranking pass:

1. **Recall expansion** — the base search retrieves up to `min(250, max(50, topK × 5))`
   candidates so the reranker has a wider pool to select from.
2. **Behavioural-semantic scoring** — a chat/completions LLM call scores each
   candidate on behavioral pattern match (not just name similarity).
3. **Merge and truncate** — LLM scores are merged back into candidates (in
   `score.rerank` and `rerankReason` fields), then the result set is sorted
   and truncated to the original `topK`.
4. **Contract repair** — unknown, missing, or duplicate candidate IDs are
   returned to DeepSeek as structured feedback and reranked again. Exhausting
   those repairs fails the request; the service never presents an unverified
   hybrid ranking as a reranked result.

### Reranking providers

| Provider | Env vars | Notes |
|---|---|---|
| `none` (default) | — | No LLM reranking. |
| `deepseek` | `DEEPSEEK_API_BASE`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | Same DeepSeek model configuration used by the Claude Code and translation workflows. |

DeepSeek honours `RERANK_TIMEOUT_MS` (default 90 s), `RERANK_MAX_RETRIES`
(default 2 for transport failures), and `RERANK_VALIDATION_RETRIES` (default
2 for candidate-ID contract repairs).

Candidates are split into batches of 20 and sent concurrently to the LLM
when the expanded pool exceeds the batch size.

### Per-request opt-out

Set `"rerank": false` on `SearchRequest` to skip LLM reranking for a single
request even when a rerank provider is configured globally.

## Index input

By default, `index:corpus` scans `fixtures/code-corpus`. It extracts class,
method, and function symbols from TypeScript, Python, Java, C#, Rust, and Go,
then builds functional-module candidates over those symbols. Repositories with
either `manifest.json` or `dataset-manifest.json` are discovered. Target
workspaces under `fixtures/target-system` are not indexed by default.

An approved `.forexplore/module-summary.json` is authoritative. Otherwise the
indexer uses a deterministic fallback: it removes the common language/package
root and groups symbols by the next cohesive directory, falling back to one
`core` module when the repository has no deeper boundary. Repository identity
is always retained as the authorization and license boundary.

Pass `--replace` to clear the code-symbol and module tables first. The module
table name is the configured symbol table name plus `_modules`. To override
the defaults, pass one or more explicit corpus roots after `--`.
Incremental corpus indexing replaces module rows only for the repositories in
the current input, preventing obsolete module boundaries from remaining
searchable while leaving other authorized repositories intact.

The lower-level `index` command accepts UTF-8 JSON Lines. Each line follows this shape:

```json
{
  "id": "unique-symbol-id",
  "title": "Cache.getOrLoad",
  "repository": "owner/repository",
  "license": "Apache-2.0",
  "language": "TypeScript",
  "kind": "function",
  "path": "src/cache.ts",
  "signature": "getOrLoad(key: string): Promise<Value>",
  "summary": "TTL cache with request coalescing",
  "preview": "async function getOrLoad(...) { ... }",
  "dependencies": [],
  "compatibility": [],
  "risks": [],
  "content": "Optional additional searchable implementation text"
}
```

The indexer upserts documents in batches and calls
`dbms_index_manager.refresh()` so newly indexed vectors are immediately
searchable on supported SeekDB versions.

## HTTP API

- `GET /health` checks the SeekDB connection.
- `POST /v1/search` accepts `SearchRequest` from `@forexplore/contracts` and
  returns `{ "candidates": SearchCandidate[] }`.
- `POST /v1/module-knowledge/search` searches only the active reviewed module
  publication for one repository/channel and returns the shared
  `RepositoryModuleKnowledgeSearchResult` contract.
- `POST /v1/module-knowledge/generations/stage` embeds and validates a staged
  `RepositoryKnowledgePublication` projection.
- `POST /v1/module-knowledge/generations/validate` revalidates a persisted
  generation and returns its durable `RepositoryModuleIndexReceipt`.
- `POST /v1/module-knowledge/generations/head` reads the authenticated active
  head for a repository/channel, including its publication payload hash, so a
  coordinator can fail closed on local/remote drift.
- `POST /v1/module-knowledge/generations/activate` performs a generation CAS.
- `POST /v1/module-knowledge/generations/withdraw` logically withdraws the
  expected active generation and restores its predecessor when available.
- `POST /v1/module-knowledge/generations/tombstone` makes an inactive
  generation unavailable for future activation without deleting its rows.

Module-index lifecycle control endpoints (including head reads) require
`Authorization: Bearer $RETRIEVAL_MODULE_INDEX_TOKEN`. When the token is empty,
all control endpoints fail closed. Search still uses the deployment-owned
`RETRIEVAL_ALLOWED_REPOSITORIES` boundary. Staging has its own bounded request
limit (`RETRIEVAL_MODULE_INDEX_MAX_BODY_BYTES`, 16 MiB by default); ordinary
search requests remain capped at 1 MiB.

The VS Code publisher reads its credential only from
`FOREXPLORE_MODULE_INDEX_WRITER_TOKEN`; local deployments must set it to the
same value as `RETRIEVAL_MODULE_INDEX_TOKEN`. Neither side reads this authority
from workspace settings. An unset or mismatched token leaves accepted content
in `publishing-knowledge` instead of silently activating it.

The module query shape is independent from symbol matching:

```json
{
  "query": "order creation and status transitions",
  "repositoryId": "acme/orders",
  "channel": "branch:main",
  "repositoryScopes": ["acme/orders"],
  "topK": 5,
  "languageIds": ["typescript"],
  "capabilities": ["order management"]
}
```

`repositoryScopes` is required by the shared module-search contract and must be
a non-empty subset of the deployment-owned allow-list that includes
`repositoryId`; the HTTP boundary never invents client authority. A staged
publication, its request envelope, and every projected document must carry the
same canonical ACL. Results retain `publicationId`,
`publicationGeneration`, `channel`, narrative/boundary status, evidence
artifact IDs and content hashes so the next retrieval layer can trace every
module hit before performing symbol or implementation-slice recall.

Each durable index receipt also records a non-secret indexer identity in
`storeId`: module projection version, embedding provider/model/dimension, and a
configuration hash. That hash is included in the generation content hash (and
each document projection hash), so changing embedding or projection settings
cannot silently reuse an older generation. Credentials are never recorded.
The production runtime compares the active receipt with its current indexer
identity and fails search closed until an incompatible generation is rebuilt
and activated.

- `POST /v1/module-search` accepts `ModuleSearchRequest` and returns
  `{ "candidates": ModuleSearchCandidate[] }`.
- `POST /v1/module-symbols` accepts `ModuleSymbolSearchRequest` and returns
  the best `SearchCandidate[]` owned by one authorized module.

### Module retrieval

`ModuleSearchRequest.target` carries the target module purpose, domain, core
APIs, dependencies, and optional focus/incomplete symbols. Recall uses weighted
RRF (`0.45 semantic / 0.25 full text / 0.30 structural`) and then scores
behavioral coverage, API coverage, structure, semantic similarity,
cross-language adaptability, implementation evidence, lexical evidence, and
risk. DeepSeek, when enabled, receives only the deterministic Top-20 module
pool and must return every stable candidate ID exactly once. Invalid responses
receive bounded repair attempts; exhaustion falls back to the verified
deterministic module order.

`excludeRepositories` normally contains the current target repository. It is
an additional exclusion and never expands the deployment-owned repository
allow-list.

### SearchRequest fields

| Field | Type | Notes |
|---|---|---|
| `target` | `ModuleTarget` | The module to find candidates for; its `kind` is a mandatory candidate-kind filter. |
| `requirement` | `string` | Natural-language context; `""` searches by target metadata. |
| `topK` | `number` | Desired result count (1–50). Internally expanded for recall. |
| `repositoryScopes` | `string[]?` | Optional exact subset request. The HTTP service accepts it only when it is a non-empty subset of `RETRIEVAL_ALLOWED_REPOSITORIES`; UI clients normally omit it. |
| `candidateLanguages` | `Language[]?` | Hard source-language constraint. |
| `rerank` | `boolean?` | Set to `false` to skip LLM reranking for this request. |

### SearchCandidate scoring fields

When reranking is active, each candidate gains two extra fields:

| Field | Type | Notes |
|---|---|---|
| `score.rerank` | `number?` | LLM-assigned behavioural-semantic score (0–1). |
| `rerankReason` | `string?` | LLM-generated rationale for the rank position. |

Set `candidateLanguages` on `SearchRequest` only when a caller deliberately
wants to narrow retrieval. The constraint is applied in SeekDB and checked
again before candidates are returned. The language-neutral adaptation workflow
normally omits it so Analyzer can evaluate candidates across all indexed
languages.

Every HTTP search is constrained by the deployment-owned,
comma-separated `RETRIEVAL_ALLOWED_REPOSITORIES` setting. It defaults to an
empty list, so an unconfigured service returns an error instead of querying
every indexed repository. Configure exact IDs such as
`fixture/forexplore-reference-java,fixture/swift-cache-ts` for local development. Empty,
wildcard, malformed, or unauthorized request scopes are rejected; they never
fall back to an unscoped query.

Set `VITE_RETRIEVAL_API_URL` in the web app to activate the real adapter. If the
variable is absent, the original mock search adapter remains active.
