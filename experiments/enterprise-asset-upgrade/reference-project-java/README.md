# Asset Upgrade Gateway — Java reference implementation

This project is the completed Java reference for the same four requirements
implemented by the C# target scaffold:

1. attachment quarantine;
2. workflow event delivery;
3. scheduled reconciliation;
4. order plugin bridge.

It is intentionally a standalone implementation. It does not import Apache
Camel, Flowable, Keycloak, BullMQ, APScheduler or nopCommerce. Those projects
are historical evidence sources for the benchmark; this project translates the
same ideas into a new domain model and ports.

The reference uses in-memory adapters so tests are deterministic. Production
adapters can replace the ports without changing the application services.

## Reference size and coverage

The reference is deliberately large enough to model a real migration slice,
rather than a single happy-path method. It currently contains four application
boundaries, 24 domain/policy/application types, 23 ports and adapters, a
scenario catalog, and 14 JUnit test classes. The checked-in implementation,
fixtures, and tests are about **3,100 lines of Java** (roughly 2,350
production lines and 750 test lines). A normal completion of the C# scaffold
should land in the same **3,000–4,000 line** range once its policies,
adapters, and acceptance tests are implemented.

The scenario catalog is intentionally explicit so an experiment can report
which requirement passed and what evidence was observed. The four areas are
attachment quarantine, workflow delivery, scheduled reconciliation, and order
plugin bridging. The in-memory composition root in `ReferenceApplication`
keeps the reference runnable without a database, broker, scanner service, or
identity provider.

The C# target has matching contracts but unfinished application methods. The
reference implementation is evaluator-owned and must never be copied into the
Agent workspace during a run.
