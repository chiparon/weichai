# AssetUpgradeGateway

This is a fresh .NET target project for the enterprise asset-upgrade benchmark.
It is intentionally a scaffold: the public surface and invariants are fixed,
while the implementation is left for an agent under evaluation.

The module receives enterprise asset events and coordinates tenant checks,
attachment quarantine, workflow dispatch, retryable delivery, scheduled
reconciliation, and idempotent audit records.

## Target boundaries

The target is intentionally organized around ports. `AssetUpgradeService` owns
attachment intake and workflow submission; `ReconciliationService` owns due
retry processing; `OrderPluginBridge` owns validation, inventory reservation
and the atomic commit boundary. `Contracts.cs` contains only target-facing
data and status values. `Ports.cs` contains replaceable identity, queue,
workflow, inventory, persistence and audit dependencies.

The implementation bodies are left unfinished for the evaluated Agent. The
historical projects are evidence sources, not dependencies of this project.
The Agent must adapt their ideas to these new C# contracts instead of importing
their APIs or changing the historical repositories.

## Current scaffold size

The production scaffold keeps the four benchmark entry points unfinished while
exposing the public seams needed by a larger implementation. Supporting layers
now cover attachment policy and scanning, workflow envelopes and retry state,
order pricing and inventory, tenant quotas, reconciliation leases/checkpoints,
plugin registration, in-memory adapters, telemetry, and scenario fixtures. The
C# target currently contains about **3,000 lines across 30+ source and test
files**; a completed benchmark implementation is expected to stay in the
**3,000–4,000 line** band and add behavior at these seams rather than filler. The target deliberately
has no completed reference implementation: its evidence comes from the mixed
history repositories and the acceptance conditions.

The size is a planning guardrail for a realistic upgrade task. Behavior is
still graded by the acceptance conditions and hidden tests: generated filler
that does not enforce tenant isolation, quarantine, retry, idempotency, or
atomic order commit does not satisfy the benchmark.
