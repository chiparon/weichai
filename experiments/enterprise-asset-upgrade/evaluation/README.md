# External acceptance evaluation

The hidden evaluator is intentionally outside `target-project`. The baseline
runner copies only `target-project` and `requirements` into the Coding Agent
workspace, then runs this evaluator after the Agent process exits.

The evaluator has two layers:

* 20 requirement checks, one for each acceptance condition in the task
  manifest. These exercise tenant boundaries, quarantine gates, retry state,
  idempotency, audit evidence, atomic order processing, and port abstraction.
* 4 quality guards for dispatcher exceptions in workflow and reconciliation,
  commit rollback, and audit failure. These expose failure paths that a happy
  path implementation can miss.

Run it against any completed result copy:

```bash
experiments/enterprise-asset-upgrade/evaluation/run-hidden-evaluation.sh \
  --target experiments/enterprise-asset-upgrade/results/<run-id>/target-project \
  --output experiments/enterprise-asset-upgrade/results/<run-id>/hidden-evaluation.json
```

The report contains per-case results, requirement score, and quality-guard
score. A nonzero evaluator exit code means at least one hidden case failed; it
does not change the Coding Agent process exit code recorded by the baseline
runner.
