# Workspace test verification

The production workspace translation runtime can invoke a test agent after the translator completes its plan and the host compiler succeeds. Translation, compilation, testing and repairs use the same complete workspace. The module-wave preparer keeps its detached Git worktree alive until these phases finish.

## Enable the production path

Alongside the existing workspace translation configuration, set:

```dotenv
ADAPTATION_WORKSPACE_TEST_AGENT_ENABLED=true
ADAPTATION_WORKSPACE_TEST_REPAIR_ATTEMPTS=2
```

The generated-suite runner accepts an executable and arguments for the project's language and installed tools, including Maven, Java, Python and Node. The agent should inspect and reuse the existing build and dependency configuration, and explicitly run the new tests.

The test agent receives the specification, source evidence, file inventory and latest compiler output. It can read project files and submit complete new tests/helpers at any safe project-relative path, without overwriting existing files. `run_tests` writes and executes the submission through the host. Up to three executions allow the agent to correct setup failures before reporting; a supplied suite from a translator repair executes once, unchanged. The host records every command and validates the report against the final command ID, output and exit status.

For runners without parsed test counters, exit code zero plus an agent `passed` report is sufficient. V8 coverage and Node test counters are supplementary evidence, not requirements for other languages. Missing or contradictory reports remain inconclusive. This deliberately does not independently prove that assertions executed.

A consistent behavioral failure is sent back to the translator with its command evidence. The translator keeps its original production write scope. After repair the host requires a new compilation and reruns the same suite without regenerating its expected behavior. Repair counts persist across resume. Generated tests and their command are preserved in the result; newly created unchanged files are removed from the worktree after verification and materialized again for replay, keeping production snapshots stable.

`WorkspaceTranslationRun.testRuns` and `testFeedback` carry the history through the existing authenticated HTTP route to the VS Code test-results panel. Module-wave runs archive their test records under the repository's Git common directory at `.forexplore/workspace-translations/` before disposable worktree cleanup.

## Real model end-to-end run

From the repository root:

```sh
npm run e2e:workspace-tests --workspace @forexplore/translation-verifier -- --live
```

The command uses `DEEPSEEK_API_KEY`, falling back to the adaptation service's local `.env`. It creates a complete two-module project and a detached Git worktree, starts the production HTTP handler, and performs real Analyzer, Translator and test-agent model calls. The host compiles the modules and the generated suite checks both the compiled behavior and the compiler's worktree marker. No source-side tests execute.

Results, model/command timing events, the baseline repository and the worktree are retained under `e2e-runs/workspace-tests/<run-id>/`. This live run covers the generated Node runner. The deterministic integration tests additionally exercise real assertion failures, host-routed repairs, budget exhaustion, cancellation, report mismatch and cleanup conflicts.

The older standalone verification JSON envelope remains available. Its retired upstream request/hash dependencies now live in the verifier's local compatibility module; the new production handoff uses `WorkspaceTestInput` directly.
