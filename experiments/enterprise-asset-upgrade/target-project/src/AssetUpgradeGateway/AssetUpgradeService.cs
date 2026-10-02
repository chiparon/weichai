namespace AssetUpgradeGateway;

public sealed class AssetUpgradeService(
    ITenantAuthorizer authorizer,
    IAttachmentQuarantine quarantine,
    IWorkflowDispatcher dispatcher,
    IIdempotencyStore idempotency,
    IAuditSink audit)
{
    public Task<DeliveryResult> SubmitAsync(
        string actorId,
        AssetEvent assetEvent,
        AttachmentInput? attachment,
        CancellationToken cancellationToken = default)
    {
        return Task.FromException<DeliveryResult>(
            new NotImplementedException("The benchmark agent must implement attachment and workflow submission."));
    }
}
