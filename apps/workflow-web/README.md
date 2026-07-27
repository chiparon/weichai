# Workflow Web

The React/Vite user interface for the ForeXplore workflow. This package owns
presentation and user interaction only. Shared contracts come from
`@forexplore/contracts`, workflow transitions come from
`@forexplore/workflow-core`, and runtime implementations are injected through
adapter packages.

Set `VITE_RETRIEVAL_API_URL` to use the SeekDB search HTTP API and
`VITE_ADAPTATION_API_URL` to use the real adaptation HTTP API. With the example
configuration, the visible demo path is:

```text
Web -> POST /v1/adapt -> DeepSeek -> temporary C# skeleton build
    -> at most three repair rounds -> AdaptationResult -> patch preview
```

Only public service URLs belong in the Web `.env`; keep `DEEPSEEK_API_KEY` in
`services/adaptation-service/.env`.

Feature directories correspond to visible workflow stages. They must not
implement repository indexing, candidate ranking, code translation, or direct
workspace mutation.

The initial screen is a source-completion dashboard. At Vite build/dev time it
scans the delivered C# target workspace for `TODO`, `FIXME`, `HACK`, `XXX`,
`NotImplementedException`, and `NotSupportedException`, then attaches each
finding to the narrowest known symbol. `REQ:` comments remain visible as
contracts but are not counted as incomplete work. Clicking an actionable
finding opens that function directly in the existing retrieval/adaptation
workflow.
