namespace AssetUpgradeGateway;

public sealed class AssetUpgradeService
{
    private const string AuditAction = "asset.submit";

    private readonly ITenantAuthorizer authorizer;
    private readonly IAttachmentQuarantine quarantine;
    private readonly IWorkflowDispatcher dispatcher;
    private readonly IIdempotencyStore idempotency;
    private readonly IAuditSink audit;

    public AssetUpgradeService(
        ITenantAuthorizer authorizer,
        IAttachmentQuarantine quarantine,
        IWorkflowDispatcher dispatcher,
        IIdempotencyStore idempotency,
        IAuditSink audit)
    {
        this.authorizer = authorizer;
        this.quarantine = quarantine;
        this.dispatcher = dispatcher;
        this.idempotency = idempotency;
        this.audit = audit;
    }

    public async Task<DeliveryResult> SubmitAsync(
        string actorId,
        AssetEvent assetEvent,
        AttachmentInput? attachment,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(assetEvent);

        if (string.IsNullOrWhiteSpace(assetEvent.TenantId)
            || string.IsNullOrWhiteSpace(assetEvent.AssetId)
            || string.IsNullOrWhiteSpace(assetEvent.EventId))
        {
            return Reject(assetEvent, DeliveryStatus.Rejected, "Asset event must carry tenant, asset and event identifiers.");
        }

        if (!authorizer.CanAccess(assetEvent.TenantId, actorId))
        {
            return Reject(assetEvent, DeliveryStatus.Rejected, "Actor is not authorized for tenant.");
        }

        if (idempotency.HasCompleted(assetEvent.TenantId, assetEvent.EventId))
        {
            return Reject(assetEvent, DeliveryStatus.Duplicate, "Event already delivered.");
        }

        if (attachment is not null)
        {
            if (!string.Equals(attachment.TenantId, assetEvent.TenantId, StringComparison.Ordinal))
            {
                return Reject(assetEvent, DeliveryStatus.Quarantined, "Attachment tenant mismatch.");
            }

            if (!quarantine.IsSafe(attachment))
            {
                return Reject(assetEvent, DeliveryStatus.Quarantined, "Attachment has not passed scanning.");
            }
        }

        DeliveryResult outcome;
        try
        {
            outcome = await dispatcher.DispatchAsync(assetEvent, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            outcome = new DeliveryResult(false, DeliveryStatus.Retryable, ex.Message);
        }

        if (outcome.Status == DeliveryStatus.Accepted)
        {
            idempotency.MarkCompleted(assetEvent.TenantId, assetEvent.EventId);
        }

        RecordAudit(assetEvent, outcome.Status);
        return outcome;
    }

    private DeliveryResult Reject(AssetEvent assetEvent, DeliveryStatus status, string? detail)
    {
        RecordAudit(assetEvent, status);
        return new DeliveryResult(status == DeliveryStatus.Accepted, status, detail);
    }

    private void RecordAudit(AssetEvent assetEvent, DeliveryStatus status)
    {
        var auditStatus = status == DeliveryStatus.Accepted
            ? WorkflowState.Completed.ToString().ToLowerInvariant()
            : status.ToString().ToLowerInvariant();
        audit.Record(new AuditRecord(assetEvent.TenantId, assetEvent.EventId, AuditAction, auditStatus, DateTimeOffset.UtcNow));
    }
}
