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

The production scaffold currently keeps behavior unfinished while exposing the
public seams needed by a larger implementation. It now contains the original
service contracts plus workflow state, policy, scanning, repository,
transaction, dead-letter, metrics, and history ports in `ExtendedContracts.cs`.
A completed benchmark implementation
is now expected to grow to roughly **35–50 classes, 90–130 methods and
3,000–4,000 lines of C#**, including policy objects, state transitions,
replaceable adapters, telemetry, and acceptance tests. The Java reference in
`../reference-project-java` is intentionally in that same size band.

The size is a planning guardrail for a realistic upgrade task. Behavior is
still graded by the acceptance conditions and hidden tests: generated filler
that does not enforce tenant isolation, quarantine, retry, idempotency, or
atomic order commit does not satisfy the benchmark.
