# AssetUpgradeGateway

This is a fresh .NET target project for the enterprise asset-upgrade benchmark.
It is intentionally a scaffold: the public surface and invariants are fixed,
while the implementation is left for an agent under evaluation.

The module receives enterprise asset events and coordinates tenant checks,
attachment quarantine, workflow dispatch, retryable delivery, scheduled
reconciliation, and idempotent audit records.
