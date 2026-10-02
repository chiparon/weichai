namespace AssetUpgradeGateway;

public sealed class ReconciliationService(
    ITenantAuthorizer authorizer,
    IRetryableEventStore eventStore,
    IWorkflowDispatcher dispatcher,
    IIdempotencyStore idempotency,
    IAuditSink audit)
{
    public Task<ReconciliationReport> RunAsync(
        string actorId,
        DateTimeOffset now,
        int limit,
        CancellationToken cancellationToken = default)
    {
        return Task.FromException<ReconciliationReport>(
            new NotImplementedException("The benchmark agent must implement scheduled reconciliation."));
    }
}
