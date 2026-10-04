# AssetUpgradeGateway

This .NET 8 solution is a complete project skeleton for the enterprise asset
upgrade benchmark. It preserves the target-facing data types, ports, services,
policies, application layer, domain layer, adapter layer, telemetry surface,
and solution file.

Production files define the project structure and API contracts only. Method
bodies are intentionally unimplemented; there is no working attachment,
workflow, reconciliation, order, policy, or adapter behavior for the Agent to
reuse. Constructors may wire dependencies and initialize data structures, but
must not make business decisions.

## Implementation scope

Implement all four requirements in `requirements/`:

* `AssetUpgradeService` handles attachment intake and approved workflow event
delivery.
* `ReconciliationService` handles scheduled retries for due events.
* `OrderPluginBridge` validates and commits an order through the declared
ports.

The existing namespaces and files provide seams, not a prescribed algorithm.
Implement the behavior in cohesive layers and add production components where
needed. Keep infrastructure vendor-neutral and do not change the historical
repositories.

The completed target is expected to contain roughly **3,000–4,000 production
C# lines**. Treat this as a scope check: meet it through real validation, state
handling, retry and compensation behavior, and adapters. Do not add generated
filler or duplicate abstractions to reach a line count. Evaluation is based on
behavior and code quality.

## Run locally

```bash
dotnet build AssetUpgradeGateway.sln
```

Hidden acceptance tests are stored outside this project and run after the
Coding Agent finishes.
