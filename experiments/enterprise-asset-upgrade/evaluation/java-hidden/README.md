# Java hidden acceptance tests

These tests live outside `java-target-project` and are mounted only by the
evaluator. They are therefore unavailable to an implementation Agent. The
suite is split by requirement module:

* `AttachmentHiddenTest`: tenant ownership, filename and signature checks,
  quarantine state, duplicate intake, and release gating;
* `WorkflowHiddenTest`: approved-state gate, tenant boundary, retry and dead
  letter outcomes, audit/idempotency behavior, and duplicate side effects;
* `ReconciliationHiddenTests`: due windows, tenant-scoped lease/checkpoint,
  retry queue closure and reruns, empty-run audit, and typed service wiring;
* `OrderHiddenTests`: validation, plugin and tenant identity, inventory
  reservation, commit/audit rollback, duplicate idempotency, and port
  abstraction.

The module suite currently contains 25 JUnit cases (6 attachment, 6 workflow,
7 reconciliation, and 6 order). Behavior cases use injected in-memory fakes;
the skeleton is expected to fail them until its placeholder methods are
implemented.

The tests use the typed constructors and ports declared by the target skeleton.
They provide in-memory fakes and never import the history repositories.

Run with JDK 21 and Maven:

```bash
JAVA_HOME=/path/to/jdk-21 \
MAVEN_BIN=/path/to/mvn \
./run-hidden-tests.sh
```

The current skeleton intentionally has placeholder methods, so behavior tests
fail until an Agent supplies the implementation. Compilation of the hidden
suite itself is the first gate.
