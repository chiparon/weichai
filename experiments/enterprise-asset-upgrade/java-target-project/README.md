# Asset Upgrade Gateway — Java target skeleton

This directory is the Java target project for the enterprise asset-upgrade
benchmark. It has the same four requirements as the C# target:

* tenant-aware attachment intake and quarantine;
* approved workflow-event delivery with retry and idempotency;
* scheduled, tenant-isolated reconciliation;
* an order-plugin bridge with inventory reservation, audit, and rollback.

The source tree is a production-shaped skeleton. It contains domain records and
enums, command/result contracts, application seams, typed ports, repository
interfaces, adapter boundaries, configuration, web DTOs, messaging, persistence,
security, and telemetry surfaces. The typed constructors and ports define where
dependencies are injected, while production methods that require a design
decision throw `UnsupportedOperationException`. No workflow algorithm,
validation policy, transaction, persistence, or provider behavior is supplied.
The Agent must implement those decisions.

The intended completed implementation is approximately **10,000–20,000 Java
production lines** (target 14,800), with integration tests and adapter wiring
added by the implementation Agent. The current skeleton is intentionally much
smaller and contains contracts only; its size is not a claim about the final
implementation. Do not add generated filler to meet the target range.

The history checkout is outside this directory and is never copied or made
visible to the implementation Agent. The capability mapping is recorded
in `docs/history-coverage.md` using concepts from Apache Camel, APScheduler,
BullMQ, Commons FileUpload, Flowable, Keycloak, and nopCommerce.

Build with JDK 21 and Maven:

```bash
mvn -q -DskipTests package
```

The current evaluation environment may not have a JDK or Maven installed; in
that case use the static manifest checks and run the build in a Java-enabled
worker.
